// SecureChannel::change_key, the device side of the key change after a hub restore
// (m3-updates-design.md section 7, protocol section 7 "Key change after a restore"): the order of
// its writes (pairing record, resume point, then the crypto), the counters under the new key, what
// is opened under the old key afterwards, a siren's command counter, the receiving rules that let a
// siren and a gateway open a Key change, and every failure on the way. A power cut is played here
// by a write that does not happen followed by a restart from flash; the whole-device harness is
// tests/host/rekey_device_test.cpp.

#include <optional>
#include <set>
#include <string>
#include <vector>

#include "device_support.hpp"
#include "hsn/device/services.hpp"
#include "hsn/device/services/log_buffer.hpp"
#include "hsn/device/services/record.hpp"
#include "hsn/device/services/secure_channel.hpp"
#include "hsn/device/services/setup.hpp"
#include "hsn/host/host_board.hpp"
#include "hsn/protocol/checksum.hpp"

namespace hsn::test {
namespace {

using device::CommandVerdict;
using device::HalError;
using device::SecureChannel;
using device::Status;
using device::StoreKey;
using protocol::Binding;
using protocol::PacketLimit;

constexpr protocol::DeviceKey kNewKey{0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47,
                                      0x48, 0x49, 0x4A, 0x4B, 0x4C, 0x4D, 0x4E, 0x4F};
constexpr protocol::DeviceKey kThirdKey{0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77,
                                        0x78, 0x79, 0x7A, 0x7B, 0x7C, 0x7D, 0x7E, 0x7F};

/** Storage whose writes to chosen keys fail (whole or nothing, as NVS: the old value stays). */
class KeyedStorage final : public device::Storage {
public:
  explicit KeyedStorage(host::FakeStorage& flash) : flash_(flash) {}

  device::HalResult<std::size_t> read(StoreKey key, protocol::MutableByteView out) override {
    return flash_.read(key, out);
  }
  HalError write(StoreKey key, protocol::ByteView value) override {
    if (fail.count(key) != 0 || lose_all) {
      return HalError::io;
    }
    return flash_.write(key, value);
  }
  HalError erase(StoreKey key) override {
    return lose_all ? HalError::io : flash_.erase(key);
  }
  HalError erase_all_but_role() override {
    return lose_all ? HalError::io : flash_.erase_all_but_role();
  }

  /** Writes to these keys fail. */
  std::set<StoreKey> fail;
  /** Every write fails: the power is gone. */
  bool lose_all = false;

private:
  host::FakeStorage& flash_;
};

/** The board's key import, which can refuse, and which notes how many flash writes came first. */
class WatchedKeys final : public device::KeyImport {
public:
  explicit WatchedKeys(host::HostBoard& board) : board_(board) {}

  HalError import_key(const protocol::DeviceKey& key) override {
    writes_before.push_back(board_.storage.operations.size());
    if (refuse > 0) {
      refuse -= 1;
      return HalError::io;
    }
    return board_.key_import.import_key(key);
  }

  /** Refuse this many imports. */
  int refuse = 0;
  /** For each import asked, the flash operations made before it. */
  std::vector<std::size_t> writes_before;

private:
  host::HostBoard& board_;
};

/** A packet from the hub under `key`. */
template <typename Message>
Bytes from_hub(const protocol::DeviceKey& key, const Message& message, std::uint32_t counter,
               const Binding& binding, PacketLimit limit = PacketLimit::radio) {
  psa::PsaPacketCipher cipher;
  REQUIRE(cipher.set_key(key) == protocol::Error::none);
  Bytes plaintext(protocol::kMaxLinkPacketSize);
  const auto size = protocol::encode_plaintext(
      message, protocol::MutableByteView(plaintext.data(), plaintext.size()));
  REQUIRE(size.ok());
  Bytes out(protocol::kMaxLinkPacketSize);
  const auto sealed =
      protocol::seal_packet(cipher, {protocol::Direction::from_hub, kAddress, counter}, binding,
                            protocol::ByteView(plaintext.data(), size.value()), limit,
                            protocol::MutableByteView(out.data(), out.size()));
  REQUIRE(sealed.ok());
  out.resize(sealed.value());
  return out;
}

/** The counter of a device packet when it opens under `key`, else nothing. */
std::optional<std::uint32_t> opens_under(const protocol::DeviceKey& key, const Bytes& packet,
                                         const Binding& binding = Binding::none()) {
  psa::PsaPacketCipher cipher;
  REQUIRE(cipher.set_key(key) == protocol::Error::none);
  Bytes plaintext(protocol::kMaxLinkPacketSize);
  const auto opened = protocol::open_packet(
      cipher, view_of(packet), protocol::Direction::to_hub, binding, PacketLimit::link,
      protocol::MutableByteView(plaintext.data(), plaintext.size()));
  if (!opened.ok()) {
    return std::nullopt;
  }
  return opened.value().header.counter;
}

std::uint32_t u32_at(const Bytes& bytes, std::size_t at) {
  REQUIRE(bytes.size() >= at + 4);
  return static_cast<std::uint32_t>(bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) |
         (static_cast<std::uint32_t>(bytes[at + 3]) << 24);
}

Bytes u32_bytes(std::uint32_t value) {
  return {static_cast<std::uint8_t>(value & 0xFFu), static_cast<std::uint8_t>((value >> 8) & 0xFFu),
          static_cast<std::uint8_t>((value >> 16) & 0xFFu),
          static_cast<std::uint8_t>((value >> 24) & 0xFFu)};
}

std::uint32_t check_of(const protocol::DeviceKey& key) {
  return protocol::crc32(protocol::ByteView(key));
}

protocol::Heartbeat heartbeat(std::uint8_t mark = 0) {
  protocol::Heartbeat message;
  message.settings_version = 3;
  message.door_change_count = mark;
  return message;
}

protocol::SirenCommand command(std::uint8_t action = protocol::SirenAction::test) {
  protocol::SirenCommand message;
  message.action = action;
  message.sound_seconds = 5;
  return message;
}

protocol::KeyChange key_change(const protocol::DeviceKey& key) {
  protocol::KeyChange message;
  message.new_key = key;
  return message;
}

/** A paired board and a channel on it, restarted from flash as the platform restarts it. */
struct Rig {
  explicit Rig(std::uint8_t role_in = protocol::Role::sensor) : role(role_in) {
    pair_board(board, role);
    start();
  }

  protocol::CounterStep step() const {
    return device::counter_step(role);
  }

  std::uint32_t step_value() const {
    return static_cast<std::uint32_t>(step());
  }

  void start(bool retained = false) {
    channel.emplace(board.cipher, storage, state, &keys, &log);
    REQUIRE(channel->start(kAddress, step(), retained) == Status::ok);
  }

  /** A restart after a power loss: the platform imports the stored key, retained is lost. */
  void reboot() {
    storage.fail.clear();
    storage.lose_all = false;
    board.set_key(stored_pairing().key);
    state = device::CounterState{};
    start();
  }

  device::PairingRecord stored_pairing() {
    device::Record<device::PairingRecord> record(board.storage, StoreKey::pairing,
                                                 device::kPairingRecordVersion, {});
    REQUIRE(record.load() == HalError::none);
    return record.get();
  }

  std::uint32_t stored_resume() {
    return u32_at(board.storage.records.at(StoreKey::counter_resume), 0);
  }

  /** Seals a heartbeat; the packet, or nothing with the status in `refused`. */
  std::optional<Bytes> seal(std::uint8_t mark = 0) {
    Bytes out(protocol::kMaxLinkPacketSize);
    const auto sealed = channel->seal(heartbeat(mark), Binding::none(), PacketLimit::radio,
                                      protocol::MutableByteView(out.data(), out.size()));
    if (!sealed.ok()) {
      refused = sealed.status();
      return std::nullopt;
    }
    out.resize(sealed.value().size);
    return out;
  }

  std::uint32_t seal_counter(std::uint8_t mark = 0) {
    const auto packet = seal(mark);
    REQUIRE(packet.has_value());
    return channel->last_counter();
  }

  std::uint8_t role;
  host::HostBoard board;
  KeyedStorage storage{board.storage};
  WatchedKeys keys{board};
  device::CounterState state;
  device::LogState log_state;
  device::LogBuffer log{log_state};
  std::optional<SecureChannel> channel;
  Status refused = Status::ok;
};

/** One kept log entry, as a test reads it. */
struct Logged {
  std::uint16_t code = 0;
  device::LogLevel level = device::LogLevel::debug;
  std::string text;
  std::uint8_t repeats = 0;
};

/** The entries a log keeps, oldest first. */
std::vector<Logged> entries(const device::LogState& state) {
  std::vector<Logged> out;
  for (std::size_t i = 0; i < state.count; ++i) {
    const device::LogRecord& record = state.records[(state.start + i) % device::kLogCapacity];
    out.push_back(Logged{record.code, static_cast<device::LogLevel>(record.level),
                         std::string(record.text.begin(), record.text.begin() + record.text_size),
                         record.repeats});
  }
  return out;
}

/** The entries with the key change's two codes, in order, as "code:text" lines. */
std::vector<std::string> key_entries(const device::LogState& state) {
  std::vector<std::string> out;
  for (const Logged& entry : entries(state)) {
    if (entry.code == device::log_code::key_changed) {
      CHECK(entry.level == device::LogLevel::info);
      out.push_back("changed:" + entry.text);
    } else if (entry.code == device::log_code::key_change_failed) {
      CHECK(entry.level == device::LogLevel::error);
      out.push_back("failed:" + entry.text + " x" + std::to_string(entry.repeats));
    }
  }
  return out;
}

TEST_CASE(
    "change_key writes the pairing record, then the resume point, then gives the crypto "
    "the key") {
  for (const std::uint8_t role : {protocol::Role::sensor, protocol::Role::siren}) {
    CAPTURE(static_cast<int>(role));
    Rig rig(role);
    const std::uint32_t step = rig.step_value();
    for (int i = 0; i < 3; ++i) {
      static_cast<void>(rig.seal_counter());
    }
    CHECK(rig.channel->last_counter() == step + 2);
    const device::PairingRecord before = rig.stored_pairing();
    const std::size_t ops = rig.board.storage.operations.size();

    CHECK(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::ok);

    // Two writes, in this order, and only then the import.
    const auto& operations = rig.board.storage.operations;
    REQUIRE(operations.size() == ops + 2);
    CHECK(operations[ops].key == StoreKey::pairing);
    CHECK_FALSE(operations[ops].failed);
    CHECK(operations[ops + 1].key == StoreKey::counter_resume);
    CHECK(operations[ops + 1].value == u32_bytes(step));
    REQUIRE(rig.keys.writes_before.size() == 1);
    CHECK(rig.keys.writes_before[0] == ops + 2);
    // The record changed in its key only.
    device::PairingRecord expected = before;
    expected.key = kNewKey;
    const device::PairingRecord after = rig.stored_pairing();
    CHECK(std::memcmp(&after, &expected, sizeof(after)) == 0);
    CHECK(rig.board.key_import.key() == kNewKey);
    CHECK(rig.stored_resume() == step);
    // Device asks once, then the role reports again.
    CHECK(rig.channel->take_key_change());
    CHECK_FALSE(rig.channel->take_key_change());

    // Counters restart at one step under the new key, saving the next resume point first.
    const auto packet = rig.seal(7);
    REQUIRE(packet.has_value());
    CHECK(rig.channel->last_counter() == step);
    CHECK(rig.stored_resume() == 2 * step);
    CHECK(rig.state.next == step + 1);
    CHECK(rig.state.resume_point == 2 * step);
    CHECK(opens_under(kNewKey, *packet) == step);
    CHECK_FALSE(opens_under(kKey, *packet).has_value());
  }
}

TEST_CASE("after the change, a packet the hub sealed under the old key is refused") {
  Rig rig;
  const std::uint32_t sent = rig.seal_counter();
  const Bytes old_reply = from_hub(kKey, protocol::Reply{}, 900, Binding::sensor_packet(sent));
  const std::uint32_t candidates[] = {sent};
  REQUIRE(rig.channel->open_bound(view_of(old_reply), candidates).ok());
  REQUIRE(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::ok);

  // Replayed now, the recorded reply fails its tag: the device holds the new key only.
  const auto replayed = rig.channel->open_bound(view_of(old_reply), candidates);
  CHECK(replayed.status() == Status::protocol_error);
  CHECK(replayed.detail() == protocol::Error::bad_tag);
  // So does the Key change itself, replayed.
  const Bytes old_change = from_hub(kKey, key_change(kThirdKey), 901, Binding::sensor_packet(sent));
  CHECK(rig.channel->open_bound(view_of(old_change), candidates).detail() ==
        protocol::Error::bad_tag);
  // Under the new key the hub is heard, bound to the new counters.
  const std::uint32_t fresh = rig.seal_counter();
  const std::uint32_t fresh_candidates[] = {fresh};
  const Bytes new_reply = from_hub(kNewKey, protocol::Reply{}, 1, Binding::sensor_packet(fresh));
  CHECK(rig.channel->open_bound(view_of(new_reply), fresh_candidates).ok());
}

TEST_CASE("the key held already is refused, and nothing is written or restarted") {
  Rig rig;
  for (int i = 0; i < 3; ++i) {
    static_cast<void>(rig.seal_counter());
  }
  const std::size_t ops = rig.board.storage.operations.size();
  CHECK(rig.channel->change_key(kKey, rig.board.clock.now()) == Status::refused);
  CHECK(rig.board.storage.operations.size() == ops);
  CHECK(rig.keys.writes_before.empty());
  CHECK_FALSE(rig.channel->take_key_change());
  CHECK(rig.seal_counter() == 67);
}

TEST_CASE(
    "a second Key change while the first is in hand: the same key restarts nothing, a third "
    "key restarts under itself") {
  Rig rig;
  static_cast<void>(rig.seal_counter());
  REQUIRE(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::ok);
  CHECK(rig.seal_counter() == 64);
  CHECK(rig.seal_counter() == 65);
  // The same key again, before Device has asked: refused, and the counters go on.
  const std::size_t ops = rig.board.storage.operations.size();
  CHECK(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::refused);
  CHECK(rig.board.storage.operations.size() == ops);
  const auto next = rig.seal();
  REQUIRE(next.has_value());
  CHECK(opens_under(kNewKey, *next) == 66u);
  CHECK(rig.channel->take_key_change());
  CHECK_FALSE(rig.channel->take_key_change());
  // A different key: a key change of its own, counting again under that key alone.
  REQUIRE(rig.channel->change_key(kThirdKey, rig.board.clock.now()) == Status::ok);
  const auto third = rig.seal();
  REQUIRE(third.has_value());
  CHECK(opens_under(kThirdKey, *third) == 64u);
  CHECK_FALSE(opens_under(kNewKey, *third).has_value());
  CHECK(rig.channel->take_key_change());
}

TEST_CASE("the pairing record not written: nothing changes, and the old key goes on") {
  Rig rig;
  static_cast<void>(rig.seal_counter());
  static_cast<void>(rig.seal_counter());
  rig.storage.fail.insert(StoreKey::pairing);
  CHECK(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::storage_error);
  CHECK_FALSE(rig.channel->take_key_change());
  CHECK(rig.keys.writes_before.empty());
  CHECK(rig.stored_pairing().key == kKey);
  CHECK(rig.stored_resume() == 128);
  const auto packet = rig.seal();
  REQUIRE(packet.has_value());
  CHECK(opens_under(kKey, *packet) == 66u);
  // The next Key change, when the hub sends it again, goes through.
  rig.storage.fail.clear();
  CHECK(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::ok);
  CHECK(rig.channel->take_key_change());
  CHECK(rig.seal_counter() == 64);
}

TEST_CASE("the resume point not written: the new key is used, counting on from where it was") {
  Rig rig;
  for (int i = 0; i < 3; ++i) {
    static_cast<void>(rig.seal_counter());
  }
  rig.storage.fail.insert(StoreKey::counter_resume);
  CHECK(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::storage_error);
  CHECK(rig.channel->take_key_change());
  CHECK(rig.stored_pairing().key == kNewKey);
  CHECK(rig.stored_resume() == 128);
  REQUIRE(rig.keys.writes_before.size() == 1);
  rig.storage.fail.clear();
  const auto packet = rig.seal();
  REQUIRE(packet.has_value());
  CHECK(opens_under(kNewKey, *packet) == 67u);
  CHECK_FALSE(opens_under(kKey, *packet).has_value());
  // A restart from flash: the new key, from the resume point flash holds, above all of them.
  rig.reboot();
  const auto after = rig.seal();
  REQUIRE(after.has_value());
  CHECK(opens_under(kNewKey, *after) == 128u);
}

TEST_CASE("the crypto refusing the key: nothing is sealed or opened until it takes it") {
  Rig rig;
  const std::uint32_t sent = rig.seal_counter();
  const std::uint32_t candidates[] = {sent};
  const Bytes old_reply = from_hub(kKey, protocol::Reply{}, 900, Binding::sensor_packet(sent));
  rig.keys.refuse = 3;
  CHECK(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::not_ready);
  // The key changed in flash: the role still reports again, once the crypto has it.
  CHECK(rig.channel->take_key_change());
  CHECK(rig.stored_pairing().key == kNewKey);
  CHECK(rig.stored_resume() == 64);
  // The cipher still holds the old key, yet nothing goes out or comes in under it.
  const std::size_t ops = rig.board.storage.operations.size();
  CHECK_FALSE(rig.seal().has_value());
  CHECK(rig.refused == Status::not_ready);
  CHECK(rig.board.storage.operations.size() == ops);
  CHECK(rig.channel->open_bound(view_of(old_reply), candidates).status() == Status::not_ready);
  // Each try imports again; the third refusal is the last.
  CHECK(rig.keys.writes_before.size() == 3);
  const auto packet = rig.seal();
  REQUIRE(packet.has_value());
  CHECK(rig.keys.writes_before.size() == 4);
  CHECK(opens_under(kNewKey, *packet) == 64u);
  CHECK(rig.board.key_import.key() == kNewKey);
  CHECK(rig.channel->open_bound(view_of(old_reply), candidates).detail() ==
        protocol::Error::bad_tag);
  CHECK(rig.keys.writes_before.size() == 4);
}

TEST_CASE(
    "a cut before the pairing record keeps the old key and its counters; a cut after it "
    "skips counters under the new key") {
  SUBCASE("before") {
    Rig rig;
    for (int i = 0; i < 5; ++i) {
      static_cast<void>(rig.seal_counter());
    }
    rig.storage.lose_all = true;
    CHECK(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::storage_error);
    rig.reboot();
    const auto packet = rig.seal();
    REQUIRE(packet.has_value());
    // Under the old key, past everything it sent (64 to 68).
    CHECK(opens_under(kKey, *packet) == 128u);
  }
  SUBCASE("between the pairing record and the resume point") {
    Rig rig;
    for (int i = 0; i < 5; ++i) {
      static_cast<void>(rig.seal_counter());
    }
    rig.storage.fail.insert(StoreKey::counter_resume);
    static_cast<void>(rig.channel->change_key(kNewKey, rig.board.clock.now()));
    rig.reboot();
    const auto packet = rig.seal();
    REQUIRE(packet.has_value());
    CHECK(opens_under(kNewKey, *packet) == 128u);
  }
  SUBCASE("after the resume point") {
    Rig rig;
    for (int i = 0; i < 5; ++i) {
      static_cast<void>(rig.seal_counter());
    }
    rig.keys.refuse = 1;
    static_cast<void>(rig.channel->change_key(kNewKey, rig.board.clock.now()));
    rig.reboot();
    const auto packet = rig.seal();
    REQUIRE(packet.has_value());
    CHECK(opens_under(kNewKey, *packet) == 64u);
  }
}

TEST_CASE("a deep-sleep wake after the change goes on with the new key's counters") {
  Rig rig;
  for (int i = 0; i < 4; ++i) {
    static_cast<void>(rig.seal_counter());
  }
  REQUIRE(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::ok);
  // The retained counter is the new key's at once: a wake before anything was sealed starts at
  // one step, not at 68 (64 to 67 went under the old key).
  CHECK(rig.state.next == 64);
  CHECK(rig.state.resume_point == 64);
  rig.board.set_key(kNewKey);
  rig.start(true);
  CHECK(rig.seal_counter() == 64);
  // And after one packet, the next.
  rig.start(true);
  const auto packet = rig.seal();
  REQUIRE(packet.has_value());
  CHECK(opens_under(kNewKey, *packet) == 65u);
}

TEST_CASE("change_key needs a started channel, a key import and a pairing record") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  device::CounterState state;
  SecureChannel without_import(board.cipher, board.storage, state);
  REQUIRE(without_import.start(kAddress, protocol::CounterStep::sensor, false) == Status::ok);
  CHECK(without_import.change_key(kNewKey, board.clock.now()) == Status::not_ready);
  WatchedKeys keys(board);
  SecureChannel not_started(board.cipher, board.storage, state, &keys);
  CHECK(not_started.change_key(kNewKey, board.clock.now()) == Status::not_ready);
  board.storage.records.erase(StoreKey::pairing);
  SecureChannel unpaired(board.cipher, board.storage, state, &keys);
  REQUIRE(unpaired.start(kAddress, protocol::CounterStep::sensor, false) == Status::ok);
  const std::size_t ops = board.storage.operations.size();
  CHECK(unpaired.change_key(kNewKey, board.clock.now()) == Status::storage_error);
  CHECK(board.storage.operations.size() == ops);
  CHECK_FALSE(unpaired.take_key_change());
  CHECK(keys.writes_before.empty());
}

TEST_CASE("change_key logs what it did: the change, and each step that failed with its number") {
  using Lines = std::vector<std::string>;
  SUBCASE("a change that went through: one entry, at info") {
    Rig rig;
    REQUIRE(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::ok);
    CHECK(key_entries(rig.log_state) == Lines{"changed:key changed"});
  }
  SUBCASE("the pairing record not written: step 1, and no change") {
    Rig rig;
    rig.storage.fail.insert(StoreKey::pairing);
    REQUIRE(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::storage_error);
    CHECK(key_entries(rig.log_state) == Lines{"failed:key change failed 1 x1"});
  }
  SUBCASE("the pairing record unreadable: step 1") {
    Rig rig;
    rig.board.storage.records.erase(StoreKey::pairing);
    REQUIRE(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::storage_error);
    CHECK(key_entries(rig.log_state) == Lines{"failed:key change failed 1 x1"});
  }
  SUBCASE("a siren's old command record not rewritten: step 1") {
    Rig rig(protocol::Role::siren);
    rig.board.storage.records[StoreKey::command_counter] = u32_bytes(500);
    rig.reboot();
    rig.storage.fail.insert(StoreKey::command_counter);
    REQUIRE(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::storage_error);
    CHECK(key_entries(rig.log_state) == Lines{"failed:key change failed 1 x1"});
  }
  SUBCASE("the resume point not written: changed, then step 2") {
    Rig rig;
    rig.storage.fail.insert(StoreKey::counter_resume);
    REQUIRE(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::storage_error);
    CHECK(key_entries(rig.log_state) ==
          Lines{"changed:key changed", "failed:key change failed 2 x1"});
  }
  SUBCASE("the import refused: changed, then step 3; the later retries add nothing") {
    Rig rig;
    rig.keys.refuse = 2;
    REQUIRE(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::not_ready);
    CHECK(key_entries(rig.log_state) ==
          Lines{"changed:key changed", "failed:key change failed 3 x1"});
    CHECK_FALSE(rig.seal().has_value());
    CHECK(rig.seal().has_value());
    CHECK(key_entries(rig.log_state).size() == 2);
  }
  SUBCASE("the resume point and the import both failing: one entry, step 2, counted twice") {
    Rig rig;
    rig.storage.fail.insert(StoreKey::counter_resume);
    rig.keys.refuse = 1;
    REQUIRE(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::not_ready);
    // The log merges a repeat of its newest code (LogBuffer): the first failing step names it.
    CHECK(key_entries(rig.log_state) ==
          Lines{"changed:key changed", "failed:key change failed 2 x2"});
  }
  SUBCASE("the key held already: refused without a word") {
    Rig rig;
    REQUIRE(rig.channel->change_key(kKey, rig.board.clock.now()) == Status::refused);
    CHECK(key_entries(rig.log_state).empty());
  }
  SUBCASE("no key import, or not started: step 0") {
    host::HostBoard board;
    pair_board(board, protocol::Role::sensor);
    device::CounterState state;
    device::LogState log_state;
    device::LogBuffer log(log_state);
    SecureChannel without_import(board.cipher, board.storage, state, nullptr, &log);
    REQUIRE(without_import.start(kAddress, protocol::CounterStep::sensor, false) == Status::ok);
    CHECK(without_import.change_key(kNewKey, board.clock.now()) == Status::not_ready);
    WatchedKeys keys(board);
    SecureChannel not_started(board.cipher, board.storage, state, &keys, &log);
    CHECK(not_started.change_key(kNewKey, board.clock.now()) == Status::not_ready);
    CHECK(key_entries(log_state) == Lines{"failed:key change failed 0 x2"});
  }
  SUBCASE("without a log, nothing is recorded and the change still goes through") {
    Rig rig;
    rig.channel.emplace(rig.board.cipher, rig.storage, rig.state, &rig.keys);
    REQUIRE(rig.channel->start(kAddress, rig.step(), false) == Status::ok);
    REQUIRE(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::ok);
    CHECK(rig.log_state.count == 0);
  }
}

TEST_CASE("Services gives its channel its own log, so a role's key change is recorded") {
  host::HostBoard board;
  pair_board(board, protocol::Role::siren);
  device::Services services(board.hal());
  REQUIRE(services.channel.start(kAddress, protocol::CounterStep::siren_or_gateway, false) ==
          Status::ok);
  REQUIRE(services.channel.change_key(kNewKey, board.clock.now()) == Status::ok);
  CHECK(key_entries(services.core.log) == std::vector<std::string>{"changed:key changed"});
  REQUIRE(services.channel.change_key(kThirdKey, board.clock.now()) == Status::ok);
  board.storage.fail_writes = true;
  CHECK(services.channel.change_key(kNewKey, board.clock.now()) == Status::storage_error);
  // The second change repeats the first entry's code, which the log counts (LogBuffer).
  CHECK(key_entries(services.core.log) ==
        std::vector<std::string>{"changed:key changed", "failed:key change failed 1 x1"});
}

// ---- A siren: its command counter and its receiving rule ----

device::Outcome<device::CommandOpen> open(Rig& rig, const Bytes& packet,
                                          PacketLimit limit = PacketLimit::radio) {
  return rig.channel->open_command(view_of(packet), limit);
}

TEST_CASE(
    "a siren takes a Key change, an update offer, a command and settings under its rule, and "
    "nothing else") {
  Rig rig(protocol::Role::siren);
  const auto change = open(rig, from_hub(kKey, key_change(kNewKey), 10, Binding::none()));
  REQUIRE(change.ok());
  CHECK(change.value().verdict == CommandVerdict::new_command);
  CHECK(change.value().packet.type == protocol::message_type::key_change);
  CHECK(change.value().saved);
  CHECK(u32_at(rig.board.storage.records.at(StoreKey::command_counter), 0) == 10);
  CHECK(open(rig, from_hub(kKey, key_change(kNewKey), 10, Binding::none())).value().verdict ==
        CommandVerdict::repeat_of_latest);
  CHECK(open(rig, from_hub(kKey, key_change(kNewKey), 9, Binding::none())).value().verdict ==
        CommandVerdict::too_old);
  protocol::UpdateOffer offer;
  offer.action = protocol::UpdateAction::fetch;
  const auto offered = open(rig, from_hub(kKey, offer, 11, Binding::none()));
  REQUIRE(offered.ok());
  CHECK(offered.value().verdict == CommandVerdict::new_command);
  CHECK(open(rig, from_hub(kKey, command(), 12, Binding::none())).value().verdict ==
        CommandVerdict::new_command);
  CHECK(open(rig, from_hub(kKey, protocol::SirenSettings{}, 13, Binding::none())).value().verdict ==
        CommandVerdict::new_command);
  // A reply is a sensor's: refused, the counter untouched.
  const std::size_t writes = rig.board.storage.write_count(StoreKey::command_counter);
  CHECK(open(rig, from_hub(kKey, protocol::Reply{}, 14, Binding::none())).status() ==
        Status::refused);
  CHECK(rig.board.storage.write_count(StoreKey::command_counter) == writes);
  CHECK(rig.channel->last_command() == 13);
}

TEST_CASE("a siren's command counter is stored with its key's check and restarts with the key") {
  Rig rig(protocol::Role::siren);
  REQUIRE(open(rig, from_hub(kKey, command(), 500, Binding::none())).value().verdict ==
          CommandVerdict::new_command);
  const Bytes stored = rig.board.storage.records.at(StoreKey::command_counter);
  REQUIRE(stored.size() == 8);
  CHECK(u32_at(stored, 0) == 500);
  CHECK(u32_at(stored, 4) == check_of(kKey));
  const Bytes old_command = from_hub(kKey, command(), 501, Binding::none());

  REQUIRE(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::ok);
  CHECK(rig.channel->last_command() == 0);
  // The hub counts from 1 under the new key; its first command is new.
  const auto first = open(rig, from_hub(kNewKey, command(), 1, Binding::none()));
  REQUIRE(first.ok());
  CHECK(first.value().verdict == CommandVerdict::new_command);
  const Bytes now_stored = rig.board.storage.records.at(StoreKey::command_counter);
  CHECK(u32_at(now_stored, 0) == 1);
  CHECK(u32_at(now_stored, 4) == check_of(kNewKey));
  // A command recorded under the old key, replayed: a bad tag, nothing written.
  const std::size_t writes = rig.board.storage.write_count(StoreKey::command_counter);
  const auto replayed = open(rig, old_command);
  CHECK(replayed.detail() == protocol::Error::bad_tag);
  CHECK(rig.board.storage.write_count(StoreKey::command_counter) == writes);
  // After a restart the counter is the new key's.
  rig.reboot();
  CHECK(rig.channel->last_command() == 1);
  CHECK(open(rig, from_hub(kNewKey, command(), 1, Binding::none())).value().verdict ==
        CommandVerdict::repeat_of_latest);
}

TEST_CASE(
    "a cut anywhere in a siren's key change leaves its command counter right for the key "
    "it holds") {
  SUBCASE("before the pairing record: the old key keeps its counter, so old commands stay old") {
    Rig rig(protocol::Role::siren);
    REQUIRE(open(rig, from_hub(kKey, command(), 500, Binding::none())).ok());
    rig.storage.lose_all = true;
    static_cast<void>(rig.channel->change_key(kNewKey, rig.board.clock.now()));
    rig.reboot();
    CHECK(rig.channel->last_command() == 500);
    CHECK(open(rig, from_hub(kKey, command(), 499, Binding::none())).value().verdict ==
          CommandVerdict::too_old);
    CHECK(open(rig, from_hub(kKey, command(), 500, Binding::none())).value().verdict ==
          CommandVerdict::repeat_of_latest);
  }
  SUBCASE("after the pairing record: the new key starts from 0, so the hub's 1 is heard") {
    Rig rig(protocol::Role::siren);
    REQUIRE(open(rig, from_hub(kKey, command(), 500, Binding::none())).ok());
    rig.storage.fail.insert(StoreKey::counter_resume);
    static_cast<void>(rig.channel->change_key(kNewKey, rig.board.clock.now()));
    rig.reboot();
    CHECK(rig.channel->last_command() == 0);
    CHECK(open(rig, from_hub(kNewKey, command(), 1, Binding::none())).value().verdict ==
          CommandVerdict::new_command);
  }
}

TEST_CASE(
    "a command counter an older image stored (4 bytes) belongs to the key held, and gets "
    "that key's check before a key change") {
  Rig rig(protocol::Role::siren);
  rig.board.storage.records[StoreKey::command_counter] = u32_bytes(500);
  rig.reboot();
  CHECK(rig.channel->last_command() == 500);
  const std::size_t ops = rig.board.storage.operations.size();
  // A cut right after the pairing record must not leave 500 to the new key.
  rig.storage.fail.insert(StoreKey::counter_resume);
  static_cast<void>(rig.channel->change_key(kNewKey, rig.board.clock.now()));
  const auto& operations = rig.board.storage.operations;
  REQUIRE(operations.size() == ops + 2);
  CHECK(operations[ops].key == StoreKey::command_counter);
  CHECK(operations[ops].value.size() == 8);
  CHECK(u32_at(operations[ops].value, 0) == 500);
  CHECK(u32_at(operations[ops].value, 4) == check_of(kKey));
  CHECK(operations[ops + 1].key == StoreKey::pairing);
  rig.reboot();
  CHECK(rig.channel->last_command() == 0);
  SUBCASE("and when that rewrite fails, nothing changes") {
    Rig other(protocol::Role::siren);
    other.board.storage.records[StoreKey::command_counter] = u32_bytes(500);
    other.reboot();
    other.storage.fail.insert(StoreKey::command_counter);
    CHECK(other.channel->change_key(kNewKey, other.board.clock.now()) == Status::storage_error);
    CHECK(other.stored_pairing().key == kKey);
    CHECK_FALSE(other.channel->take_key_change());
  }
}

TEST_CASE(
    "the command counter record: 4 bytes, 8, or longer read by its first fields; other "
    "lengths are not valid") {
  Rig rig(protocol::Role::siren);
  Bytes longer = u32_bytes(77);
  const Bytes check = u32_bytes(check_of(kKey));
  longer.insert(longer.end(), check.begin(), check.end());
  longer.insert(longer.end(), {1, 2, 3, 4});
  rig.board.storage.records[StoreKey::command_counter] = longer;
  rig.reboot();
  CHECK(rig.channel->last_command() == 77);
  // Another key's check: 0.
  Bytes other = u32_bytes(77);
  const Bytes other_check = u32_bytes(check_of(kNewKey));
  other.insert(other.end(), other_check.begin(), other_check.end());
  rig.board.storage.records[StoreKey::command_counter] = other;
  rig.reboot();
  CHECK(rig.channel->last_command() == 0);
  for (const std::size_t size : {std::size_t{3}, std::size_t{5}, std::size_t{7}}) {
    CAPTURE(size);
    rig.board.storage.records[StoreKey::command_counter] = Bytes(size, 0x01);
    rig.channel.emplace(rig.board.cipher, rig.storage, rig.state, &rig.keys);
    CHECK(rig.channel->start(kAddress, rig.step(), false) == Status::storage_error);
  }
  // Without a pairing record to name the key, the counter alone is written.
  host::HostBoard bare;
  device::CounterState state;
  SecureChannel channel(bare.cipher, bare.storage, state);
  REQUIRE(bare.cipher.set_key(kKey) == protocol::Error::none);
  REQUIRE(channel.start(kAddress, protocol::CounterStep::siren_or_gateway, false) == Status::ok);
  REQUIRE(
      channel
          .open_command(view_of(from_hub(kKey, command(), 5, Binding::none())), PacketLimit::radio)
          .ok());
  CHECK(bare.storage.records.at(StoreKey::command_counter) == u32_bytes(5));
}

// ---- A gateway: a Key change in place of the welcome ----

TEST_CASE("a gateway opens a Key change bound to its hello's random, in place of the welcome") {
  Rig rig(protocol::Role::gateway);
  device::SessionState session;
  const protocol::RandomValue random{1, 2, 3, 4, 5, 6, 7, 8};
  session.begin(random);
  const Bytes change =
      from_hub(kKey, key_change(kNewKey), 40, Binding::hello(random), PacketLimit::link);
  const auto opened = rig.channel->open_session(view_of(change), session);
  REQUIRE(opened.ok());
  CHECK(opened.value().type == protocol::message_type::key_change);
  // The connection is as it was: not welcomed, no counter taken.
  CHECK_FALSE(session.welcomed);
  CHECK(session.last_accepted == 0);
  CHECK(session.gateway_random == random);
  // Bound to another hello's random: a bad tag.
  const protocol::RandomValue other{9, 9, 9, 9, 9, 9, 9, 9};
  CHECK(rig.channel
            ->open_session(view_of(from_hub(kKey, key_change(kNewKey), 41, Binding::hello(other),
                                            PacketLimit::link)),
                           session)
            .detail() == protocol::Error::bad_tag);
  // The gateway changes its key and says hello again; the welcome under the new key is heard.
  REQUIRE(rig.channel->change_key(kNewKey, rig.board.clock.now()) == Status::ok);
  const protocol::RandomValue again{7, 7, 7, 7, 7, 7, 7, 7};
  session.begin(again);
  CHECK(rig.channel->open_session(view_of(change), session).detail() == protocol::Error::bad_tag);
  protocol::Welcome welcome;
  welcome.hub_random = {5, 5, 5, 5, 5, 5, 5, 5};
  const auto welcomed = rig.channel->open_session(
      view_of(from_hub(kNewKey, welcome, 1, Binding::hello(again), PacketLimit::link)), session);
  REQUIRE(welcomed.ok());
  CHECK(session.welcomed);
}

}  // namespace
}  // namespace hsn::test
