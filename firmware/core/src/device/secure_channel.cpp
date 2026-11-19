#include "hsn/device/services/secure_channel.hpp"

#include "hsn/protocol/checksum.hpp"

namespace hsn::device {
namespace {

using protocol::ByteView;
using protocol::Direction;
using protocol::Error;
using protocol::MutableByteView;

std::array<std::uint8_t, 4> le_bytes(std::uint32_t value) {
  return {static_cast<std::uint8_t>(value & 0xFFu), static_cast<std::uint8_t>((value >> 8) & 0xFFu),
          static_cast<std::uint8_t>((value >> 16) & 0xFFu),
          static_cast<std::uint8_t>((value >> 24) & 0xFFu)};
}

std::uint32_t get_u32(const std::uint8_t* bytes) {
  return static_cast<std::uint32_t>(bytes[0] | (bytes[1] << 8) | (bytes[2] << 16)) |
         (static_cast<std::uint32_t>(bytes[3]) << 24);
}

/** Reads a 4-byte little-endian record; 0 when it does not exist. */
HalResult<std::uint32_t> read_u32(Storage& storage, StoreKey key) {
  std::array<std::uint8_t, 4> bytes{};
  const auto read = storage.read(key, MutableByteView(bytes));
  if (!read.ok()) {
    return read.error() == HalError::not_found ? HalResult<std::uint32_t>(0u)
                                               : HalResult<std::uint32_t>(read.error());
  }
  if (read.value() != bytes.size()) {
    return HalError::invalid;
  }
  return get_u32(bytes.data());
}

/** The command counter record: the counter, then the check of its key (SecureChannel). */
constexpr std::size_t kCommandCounterSize = 4;
constexpr std::size_t kCommandRecordSize = 8;
/** Room for a longer record a later image may write, of which the first fields are read. */
constexpr std::size_t kCommandRecordRoom = 32;

/**
 * The check of a device key that a stored command counter carries: its CRC-32. It tells two keys
 * apart and nothing more; the record sits beside the pairing record, which holds the key itself.
 */
std::uint32_t key_check(const protocol::DeviceKey& key) {
  return protocol::crc32(ByteView(key));
}

/** Overwrites a key held on the stack, in a way the compiler keeps. */
void wipe_key(protocol::DeviceKey& key) {
  volatile std::uint8_t* bytes = key.data();
  for (std::size_t i = 0; i < key.size(); ++i) {
    bytes[i] = 0;
  }
}

/** A transmit request's fields before its carried packet (section 6): when, time, rate, power,
 * priority. */
constexpr std::size_t kTransmitRequestFieldsSize = 8;

/**
 * Checks that a body holds every field its type lists (section 3), by decoding it, so a short one
 * is dropped before any counter moves. Two cases pass to the caller: a type this version does not
 * list, which the receiver drops and logs (section 5), and a transmit request whose fields are
 * all there but whose carried packet is not 18 to 255 bytes, which the gateway answers "not
 * valid" (section 6).
 */
Error whole_body(std::uint8_t type, ByteView body) {
  if (type == protocol::message_type::transmit_request) {
    return body.size() < kTransmitRequestFieldsSize ? Error::truncated : Error::none;
  }
  if (!protocol::is_known_message_type(type)) {
    return Error::none;
  }
  return protocol::decode_message(type, body, [](const auto&) {});
}

}  // namespace

Status SecureChannel::start(std::uint32_t address, protocol::CounterStep step,
                            bool retained_valid) {
  started_ = false;
  key_check_known_ = false;
  if (!protocol::is_valid_address(address)) {
    return Status::refused;
  }
  address_ = address;
  step_ = step;
  if (retained_valid && state_.next != 0 && state_.resume_point != 0) {
    counter_ = protocol::SendCounter(step, state_.next, state_.resume_point);
  } else {
    const auto saved = read_u32(storage_, StoreKey::counter_resume);
    if (!saved.ok()) {
      return Status::storage_error;
    }
    counter_ = protocol::SendCounter::resumed(step, saved.value());
  }
  const auto command = read_command();
  if (!command.ok()) {
    return Status::storage_error;
  }
  std::uint32_t last_command = command.value().counter;
  if (command.value().has_check && last_command != 0) {
    if (!load_key_check()) {
      return Status::storage_error;
    }
    if (command.value().check != key_check_) {
      // Accepted under the key before a key change: the hub counts from 1 under this one.
      last_command = 0;
    }
  }
  command_rx_ = protocol::StrictlyHigherCounter(last_command);
  state_.next = counter_.next();
  state_.resume_point = counter_.resume_point();
  started_ = true;
  return Status::ok;
}

Outcome<Sealed> SecureChannel::seal_plaintext(ByteView plaintext, const protocol::Binding& binding,
                                              protocol::PacketLimit limit, MutableByteView out) {
  if (!started_ || !key_ready()) {
    return Outcome<Sealed>(Status::not_ready);
  }
  const protocol::SendCounter before = counter_;
  const auto taken = counter_.take();
  if (!taken.ok()) {
    return Outcome<Sealed>(Status::protocol_error, taken.error());
  }
  if (taken.value().save_resume_point) {
    const auto bytes = le_bytes(taken.value().resume_point);
    if (storage_.write(StoreKey::counter_resume, ByteView(bytes)) != HalError::none) {
      // Not sent: keep the counter, so the next try saves again before using it.
      counter_ = before;
      return Outcome<Sealed>(Status::storage_error);
    }
  }
  state_.next = counter_.next();
  state_.resume_point = counter_.resume_point();
  const protocol::PacketHeader header{Direction::to_hub, address_, taken.value().counter};
  const auto sealed = protocol::seal_packet(cipher_, header, binding, plaintext, limit, out);
  if (!sealed.ok()) {
    // The counter stays used: skipping one is always safe.
    return Outcome<Sealed>(Status::protocol_error, sealed.error());
  }
  last_counter_ = header.counter;
  return Sealed{sealed.value(), header.counter};
}

Outcome<protocol::PacketHeader> SecureChannel::header_for_me(ByteView packet,
                                                             protocol::PacketLimit limit) {
  if (!started_ || !key_ready()) {
    return Outcome<protocol::PacketHeader>(Status::not_ready);
  }
  const auto header = protocol::read_header(packet, Direction::from_hub, limit);
  if (!header.ok()) {
    return Outcome<protocol::PacketHeader>(Status::protocol_error, header.error());
  }
  if (header.value().address != address_) {
    return Outcome<protocol::PacketHeader>(Status::refused);
  }
  return header.value();
}

Outcome<BoundOpen> SecureChannel::open_bound(ByteView packet,
                                             protocol::Span<const std::uint32_t> candidates) {
  const auto header = header_for_me(packet, protocol::PacketLimit::radio);
  if (!header.ok()) {
    return Outcome<BoundOpen>(header.status(), header.detail());
  }
  const std::size_t count =
      candidates.size() < kMaxBoundCandidates ? candidates.size() : kMaxBoundCandidates;
  for (std::size_t i = 0; i < count; ++i) {
    const auto opened = protocol::open_packet(
        cipher_, packet, Direction::from_hub, protocol::Binding::sensor_packet(candidates[i]),
        protocol::PacketLimit::radio, MutableByteView(rx_plain_));
    if (opened.ok()) {
      return BoundOpen{opened.value(), candidates[i]};
    }
    if (opened.error() != Error::bad_tag) {
      // Any other failure does not depend on the binding.
      return Outcome<BoundOpen>(Status::protocol_error, opened.error());
    }
  }
  return Outcome<BoundOpen>(Status::protocol_error, Error::bad_tag);
}

Outcome<CommandOpen> SecureChannel::open_command(ByteView packet, protocol::PacketLimit limit) {
  const auto header = header_for_me(packet, limit);
  if (!header.ok()) {
    return Outcome<CommandOpen>(header.status(), header.detail());
  }
  const auto opened =
      protocol::open_packet(cipher_, packet, Direction::from_hub, protocol::Binding::none(), limit,
                            MutableByteView(rx_plain_));
  if (!opened.ok()) {
    return Outcome<CommandOpen>(Status::protocol_error, opened.error());
  }
  // The types a siren takes under this rule (protocol section 4).
  const std::uint8_t type = opened.value().type;
  if (type != protocol::message_type::siren_command &&
      type != protocol::message_type::siren_settings &&
      type != protocol::message_type::update_offer && type != protocol::message_type::key_change) {
    return Outcome<CommandOpen>(Status::refused);
  }
  // A body shorter than its type's fields is not valid (section 3): dropped before the counter is
  // judged, so it neither moves the counter nor writes flash, as if it never came.
  const Error body_error = whole_body(type, opened.value().body);
  if (body_error != Error::none) {
    return Outcome<CommandOpen>(Status::protocol_error, body_error);
  }
  CommandOpen result;
  result.packet = opened.value();
  switch (command_rx_.accept(opened.value().header.counter)) {
    case protocol::CounterVerdict::accepted: {
      result.verdict = CommandVerdict::new_command;
      result.saved = write_command(command_rx_.last_accepted()) == HalError::none;
      break;
    }
    case protocol::CounterVerdict::duplicate:
      result.verdict = CommandVerdict::repeat_of_latest;
      break;
    case protocol::CounterVerdict::too_old:
      result.verdict = CommandVerdict::too_old;
      break;
  }
  return result;
}

Outcome<protocol::OpenedPacket> SecureChannel::open_session(ByteView packet,
                                                            SessionState& session) {
  const auto header = header_for_me(packet, protocol::PacketLimit::link);
  if (!header.ok()) {
    return Outcome<protocol::OpenedPacket>(header.status(), header.detail());
  }
  const protocol::Binding binding =
      session.welcomed ? session.binding() : protocol::Binding::hello(session.gateway_random);
  const auto opened =
      protocol::open_packet(cipher_, packet, Direction::from_hub, binding,
                            protocol::PacketLimit::link, MutableByteView(rx_plain_));
  if (!opened.ok()) {
    return Outcome<protocol::OpenedPacket>(Status::protocol_error, opened.error());
  }
  // As for commands: a body short of its fields is dropped before the connection's counter moves.
  const Error body_error = whole_body(opened.value().type, opened.value().body);
  if (body_error != Error::none) {
    return Outcome<protocol::OpenedPacket>(Status::protocol_error, body_error);
  }
  const std::uint32_t counter = opened.value().header.counter;
  if (!session.welcomed) {
    if (opened.value().type == protocol::message_type::key_change) {
      // In place of the welcome (protocol section 4): the connection stays unwelcomed, and after
      // the key change the gateway says hello again.
      return opened.value();
    }
    protocol::Welcome welcome;
    if (opened.value().type != protocol::message_type::welcome) {
      return Outcome<protocol::OpenedPacket>(Status::refused);
    }
    const Error error = protocol::decode_body(opened.value().body, welcome);
    if (error != Error::none) {
      return Outcome<protocol::OpenedPacket>(Status::protocol_error, error);
    }
    // The first packet on a new connection may carry any counter.
    session.hub_random = welcome.hub_random;
    session.welcomed = true;
    session.last_accepted = counter;
    return opened.value();
  }
  protocol::StrictlyHigherCounter rule(session.last_accepted);
  if (rule.accept(counter) != protocol::CounterVerdict::accepted) {
    return Outcome<protocol::OpenedPacket>(Status::refused);
  }
  session.last_accepted = counter;
  return opened.value();
}

bool SecureChannel::key_ready() {
  if (!import_pending_) {
    return true;
  }
  // pairing_ holds the record change_key wrote: the new key, which the crypto must take before
  // anything is sealed or opened, since it still holds the old one.
  if (keys_ == nullptr || keys_->import_key(pairing_.get().key) != HalError::none) {
    return false;
  }
  import_pending_ = false;
  return true;
}

bool SecureChannel::load_key_check() {
  if (pairing_.load() != HalError::none) {
    return false;
  }
  key_check_ = key_check(pairing_.get().key);
  key_check_known_ = true;
  return true;
}

HalResult<SecureChannel::StoredCommand> SecureChannel::read_command() const {
  std::array<std::uint8_t, kCommandRecordRoom> bytes{};
  const auto read = storage_.read(StoreKey::command_counter, MutableByteView(bytes));
  if (!read.ok()) {
    return read.error() == HalError::not_found ? HalResult<StoredCommand>(StoredCommand{})
                                               : HalResult<StoredCommand>(read.error());
  }
  StoredCommand stored;
  if (read.value() == kCommandCounterSize) {
    stored.counter = get_u32(bytes.data());
    return stored;
  }
  if (read.value() < kCommandRecordSize) {
    return HalError::invalid;
  }
  stored.counter = get_u32(bytes.data());
  stored.has_check = true;
  stored.check = get_u32(bytes.data() + kCommandCounterSize);
  return stored;
}

HalError SecureChannel::write_command(std::uint32_t counter) {
  const auto value = le_bytes(counter);
  if (!key_check_known_ && !load_key_check()) {
    // No pairing record to name the key (a channel started without one): the counter alone,
    // which counts as the key held, as an older image's record does.
    return storage_.write(StoreKey::command_counter, ByteView(value));
  }
  const auto check = le_bytes(key_check_);
  std::array<std::uint8_t, kCommandRecordSize> bytes{};
  for (std::size_t i = 0; i < kCommandCounterSize; ++i) {
    bytes[i] = value[i];
    bytes[kCommandCounterSize + i] = check[i];
  }
  return storage_.write(StoreKey::command_counter, ByteView(bytes));
}

Status SecureChannel::write_pairing_key(const protocol::DeviceKey& key) {
  PairingRecord record = pairing_.get();
  record.key = key;
  const HalError error = pairing_.update(record);
  wipe_key(record.key);
  if (error != HalError::none) {
    // Whole or nothing: flash keeps the old record; so does pairing_ once read again.
    static_cast<void>(pairing_.load());
    return Status::storage_error;
  }
  return Status::ok;
}

void SecureChannel::log_failed_step(Instant now, std::int32_t step) {
  if (log_ != nullptr) {
    log_->add(now, LogLevel::error, log_code::key_change_failed, "key change failed", step);
  }
}

Status SecureChannel::change_key(const protocol::DeviceKey& key, Instant now) {
  // The steps' numbers in the log (secure_channel.hpp): 0 to start, then (1), (2) and (3).
  constexpr std::int32_t kCannotStart = 0;
  constexpr std::int32_t kPairingStep = 1;
  constexpr std::int32_t kResumeStep = 2;
  constexpr std::int32_t kImportStep = 3;
  if (keys_ == nullptr || !started_) {
    log_failed_step(now, kCannotStart);
    return Status::not_ready;
  }
  if (pairing_.load() != HalError::none) {
    log_failed_step(now, kPairingStep);
    return Status::storage_error;
  }
  if (pairing_.get().key == key) {
    // The key held already (a second Key change with the same key): starting its counters again
    // would repeat them.
    return Status::refused;
  }
  // A command counter stored by an older image names no key; it gets the old key's check first,
  // so that after (1) it counts for the old key only.
  const auto command = read_command();
  if (!command.ok()) {
    log_failed_step(now, kPairingStep);
    return Status::storage_error;
  }
  key_check_ = key_check(pairing_.get().key);
  key_check_known_ = true;
  if (!command.value().has_check && command.value().counter != 0 &&
      write_command(command.value().counter) != HalError::none) {
    log_failed_step(now, kPairingStep);
    return Status::storage_error;
  }

  // (1) The pairing record with the new key, whole or nothing.
  const Status written = write_pairing_key(key);
  if (written != Status::ok) {
    log_failed_step(now, kPairingStep);
    return written;
  }
  // From here the key has changed: nothing goes out or is opened under the old key, the counters
  // restart, and the role reports again under the new key.
  key_changed_ = true;
  import_pending_ = true;
  key_check_ = key_check(key);
  command_rx_ = protocol::StrictlyHigherCounter(0);
  if (log_ != nullptr) {
    log_->add(now, LogLevel::info, log_code::key_changed, "key changed");
  }
  Status result = Status::ok;

  // (2) The resume point as one step. Without it the counter goes on from where it was: under a
  // key never used, any counter is new, and flash still holds a resume point above it.
  const std::uint32_t step = static_cast<std::uint32_t>(step_);
  const auto resume = le_bytes(step);
  if (storage_.write(StoreKey::counter_resume, ByteView(resume)) == HalError::none) {
    counter_ = protocol::SendCounter::resumed(step_, step);
    state_.next = counter_.next();
    state_.resume_point = counter_.resume_point();
  } else {
    log_failed_step(now, kResumeStep);
    result = Status::storage_error;
  }

  // (3) The new key into the platform's crypto; until it takes it, nothing is sealed or opened.
  if (!key_ready()) {
    log_failed_step(now, kImportStep);
    result = Status::not_ready;
  }
  return result;
}

bool SecureChannel::take_key_change() {
  const bool changed = key_changed_;
  key_changed_ = false;
  return changed;
}

}  // namespace hsn::device
