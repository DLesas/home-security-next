#include "hsn/device/services/secure_channel.hpp"

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
  return static_cast<std::uint32_t>(bytes[0] | (bytes[1] << 8) | (bytes[2] << 16)) |
         (static_cast<std::uint32_t>(bytes[3]) << 24);
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
  if (!protocol::is_valid_address(address)) {
    return Status::refused;
  }
  address_ = address;
  if (retained_valid && state_.next != 0 && state_.resume_point != 0) {
    counter_ = protocol::SendCounter(step, state_.next, state_.resume_point);
  } else {
    const auto saved = read_u32(storage_, StoreKey::counter_resume);
    if (!saved.ok()) {
      return Status::storage_error;
    }
    counter_ = protocol::SendCounter::resumed(step, saved.value());
  }
  const auto command = read_u32(storage_, StoreKey::command_counter);
  if (!command.ok()) {
    return Status::storage_error;
  }
  command_rx_ = protocol::StrictlyHigherCounter(command.value());
  state_.next = counter_.next();
  state_.resume_point = counter_.resume_point();
  started_ = true;
  return Status::ok;
}

Outcome<Sealed> SecureChannel::seal_plaintext(ByteView plaintext, const protocol::Binding& binding,
                                              protocol::PacketLimit limit, MutableByteView out) {
  if (!started_) {
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
                                                             protocol::PacketLimit limit) const {
  if (!started_) {
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
  const std::uint8_t type = opened.value().type;
  if (type != protocol::message_type::siren_command &&
      type != protocol::message_type::siren_settings) {
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
      const auto bytes = le_bytes(command_rx_.last_accepted());
      result.saved = storage_.write(StoreKey::command_counter, ByteView(bytes)) == HalError::none;
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

}  // namespace hsn::device
