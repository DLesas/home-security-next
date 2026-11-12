// The device end of protocol section 4: counters, resume points and the receiving rules.

#include <set>

#include "device/device_support.hpp"
#include "hsn/device/services/secure_channel.hpp"
#include "hsn/host/fake_clock.hpp"
#include "hsn/host/fake_random.hpp"
#include "hsn/host/fake_storage.hpp"

namespace hsn::test {
namespace {

using device::CommandVerdict;
using device::SecureChannel;
using device::Status;
using device::StoreKey;
using protocol::Binding;
using protocol::CounterStep;
using protocol::PacketLimit;

struct Fixture {
  Fixture() {
    REQUIRE(cipher.set_key(kKey) == protocol::Error::none);
  }

  std::uint32_t stored_resume() const {
    const auto found = storage.records.find(StoreKey::counter_resume);
    REQUIRE(found != storage.records.end());
    const Bytes& b = found->second;
    return static_cast<std::uint32_t>(b[0] | (b[1] << 8) | (b[2] << 16)) |
           (static_cast<std::uint32_t>(b[3]) << 24);
  }

  void store_resume(std::uint32_t value) {
    const std::uint8_t bytes[4] = {
        static_cast<std::uint8_t>(value & 0xFF), static_cast<std::uint8_t>((value >> 8) & 0xFF),
        static_cast<std::uint8_t>((value >> 16) & 0xFF), static_cast<std::uint8_t>(value >> 24)};
    storage.records[StoreKey::counter_resume] = Bytes(bytes, bytes + 4);
  }

  host::FakeClock clock;
  host::FakeStorage storage{clock};
  psa::PsaPacketCipher cipher;
  device::CounterState state;
  Bytes out = Bytes(protocol::kMaxLinkPacketSize);
};

protocol::Heartbeat heartbeat() {
  protocol::Heartbeat message;
  message.settings_version = 3;
  message.battery_code = 120;
  return message;
}

device::Outcome<device::Sealed> seal(SecureChannel& channel, Fixture& f) {
  return channel.seal(heartbeat(), Binding::none(), PacketLimit::radio,
                      protocol::MutableByteView(f.out.data(), f.out.size()));
}

TEST_CASE("the resume point is written before the packet whose counter is a multiple of the step") {
  Fixture f;
  f.store_resume(64);  // as at pairing
  SecureChannel channel(f.cipher, f.storage, f.state);
  REQUIRE(channel.start(kAddress, CounterStep::sensor, false) == Status::ok);
  const auto first = seal(channel, f);
  REQUIRE(first.ok());
  CHECK(first.value().counter == 64);
  CHECK(f.stored_resume() == 128);
  const HubOpened opened = hub_open(protocol::ByteView(f.out.data(), first.value().size),
                                    Binding::none(), PacketLimit::radio);
  CHECK(opened.error == protocol::Error::none);
  CHECK(opened.header.counter == 64);
  CHECK(opened.header.address == kAddress);
  CHECK(opened.type == protocol::message_type::heartbeat);
  for (int i = 0; i < 200; ++i) {
    REQUIRE(seal(channel, f).ok());
  }
  CHECK(channel.last_counter() == 264);
  // Saves at 64, 128, 192 and 256 only.
  CHECK(f.storage.write_count(StoreKey::counter_resume) == 4);
  CHECK(f.state.next == 265);
  CHECK(f.state.resume_point == 320);
}

TEST_CASE("a failed save sends nothing and saves again before using that counter") {
  Fixture f;
  f.store_resume(64);
  SecureChannel channel(f.cipher, f.storage, f.state);
  REQUIRE(channel.start(kAddress, CounterStep::sensor, false) == Status::ok);
  f.storage.fail_next_writes = 1;
  CHECK(seal(channel, f).status() == Status::storage_error);
  const auto retried = seal(channel, f);
  REQUIRE(retried.ok());
  CHECK(retried.value().counter == 64);
  CHECK(f.stored_resume() == 128);
}

TEST_CASE("across random wakes, resets and power losses, no counter is ever sent twice") {
  Fixture f;
  f.store_resume(64);
  host::FakeRandom hardware(5);
  device::RandomSource random(hardware);
  std::set<std::uint32_t> sent;
  std::uint32_t highest = 0;
  bool retained_valid = false;
  for (int boot = 0; boot < 400; ++boot) {
    SecureChannel channel(f.cipher, f.storage, f.state);
    REQUIRE(channel.start(kAddress, CounterStep::sensor, retained_valid) == Status::ok);
    const std::uint32_t packets = random.below(150);
    for (std::uint32_t i = 0; i < packets; ++i) {
      const auto sealed = seal(channel, f);
      REQUIRE(sealed.ok());
      CHECK(sent.insert(sealed.value().counter).second);
      CHECK(sealed.value().counter > highest);
      highest = sealed.value().counter;
    }
    // Deep sleep keeps the retained counter; a power loss turns it into garbage.
    switch (random.below(3)) {
      case 0:
        retained_valid = true;
        break;
      case 1:
        retained_valid = false;
        f.state = device::CounterState{random.next_u32(), random.next_u32()};
        break;
      default:
        retained_valid = false;
        break;
    }
  }
  CHECK(sent.size() > 10000);
}

TEST_CASE("a sensor accepts a hub packet bound to any of its event's counters, up to 16") {
  Fixture f;
  f.store_resume(64);
  SecureChannel channel(f.cipher, f.storage, f.state);
  REQUIRE(channel.start(kAddress, CounterStep::sensor, false) == Status::ok);
  const std::vector<std::uint32_t> counters = {90, 89, 88, 87, 86, 85, 84, 83, 82,
                                               81, 80, 79, 78, 77, 76, 75, 74};
  const protocol::DisarmedNotice notice;
  const Bytes second = hub_packet(notice, 500, Binding::sensor_packet(89));
  const auto opened = channel.open_bound(view_of(second), {counters.data(), counters.size()});
  REQUIRE(opened.ok());
  CHECK(opened.value().answered == 89);
  CHECK(opened.value().packet.type == protocol::message_type::disarmed_notice);
  // The 17th candidate is never tried.
  const Bytes oldest = hub_packet(notice, 501, Binding::sensor_packet(74));
  const auto refused = channel.open_bound(view_of(oldest), {counters.data(), counters.size()});
  CHECK(refused.status() == Status::protocol_error);
  CHECK(refused.detail() == protocol::Error::bad_tag);
  // Another device's packet is refused before any key is used.
  const Bytes other = hub_packet(notice, 502, Binding::sensor_packet(90), kAddress + 1);
  CHECK(channel.open_bound(view_of(other), {counters.data(), counters.size()}).status() ==
        Status::refused);
  const Bytes garbage(10, 0x18);
  CHECK(channel.open_bound(view_of(garbage), {counters.data(), counters.size()}).status() ==
        Status::protocol_error);
}

TEST_CASE("a siren acts on higher command counters, answers a repeat, and ignores older ones") {
  Fixture f;
  f.store_resume(1024);
  protocol::SirenCommand command;
  command.action = protocol::SirenAction::sound_alarm;
  command.sound_seconds = 300;
  {
    SecureChannel channel(f.cipher, f.storage, f.state);
    REQUIRE(channel.start(kAddress, CounterStep::siren_or_gateway, false) == Status::ok);
    const Bytes first = hub_packet(command, 40, Binding::none());
    const auto opened = channel.open_command(view_of(first), PacketLimit::radio);
    REQUIRE(opened.ok());
    CHECK(opened.value().verdict == CommandVerdict::new_command);
    CHECK(opened.value().saved);
    CHECK(f.storage.write_count(StoreKey::command_counter) == 1);
    // The same packet over the other path.
    const auto repeat = channel.open_command(view_of(first), PacketLimit::link);
    REQUIRE(repeat.ok());
    CHECK(repeat.value().verdict == CommandVerdict::repeat_of_latest);
    CHECK(f.storage.write_count(StoreKey::command_counter) == 1);
    const Bytes older = hub_packet(command, 39, Binding::none());
    CHECK(channel.open_command(view_of(older), PacketLimit::radio).value().verdict ==
          CommandVerdict::too_old);
    // A reply type is not a command and does not move the counter.
    const Bytes reply = hub_packet(protocol::Reply{}, 41, Binding::none());
    CHECK(channel.open_command(view_of(reply), PacketLimit::radio).status() == Status::refused);
    CHECK(channel.last_command() == 40);
    f.storage.fail_next_writes = 1;
    const Bytes next = hub_packet(protocol::SirenSettings{}, 41, Binding::none());
    const auto unsaved = channel.open_command(view_of(next), PacketLimit::radio);
    REQUIRE(unsaved.ok());
    CHECK(unsaved.value().verdict == CommandVerdict::new_command);
    CHECK_FALSE(unsaved.value().saved);
  }
  // After a restart the counter comes back from flash: 40 is the last saved one.
  SecureChannel restarted(f.cipher, f.storage, f.state);
  REQUIRE(restarted.start(kAddress, CounterStep::siren_or_gateway, false) == Status::ok);
  CHECK(restarted.last_command() == 40);
}

TEST_CASE("a gateway accepts a welcome bound to its hello, then strictly higher session packets") {
  Fixture f;
  f.store_resume(1024);
  SecureChannel channel(f.cipher, f.storage, f.state);
  REQUIRE(channel.start(kAddress, CounterStep::siren_or_gateway, false) == Status::ok);
  device::SessionState session;
  session.begin(protocol::RandomValue{1, 2, 3, 4, 5, 6, 7, 8});
  protocol::Welcome welcome;
  welcome.hub_random = {9, 9, 9, 9, 8, 8, 8, 8};
  // A welcome from an old connection carries another hello's binding.
  const Bytes stale = hub_packet(welcome, 700, Binding::hello(protocol::RandomValue{}), kAddress,
                                 PacketLimit::link);
  CHECK(channel.open_session(view_of(stale), session).detail() == protocol::Error::bad_tag);
  const Bytes good =
      hub_packet(welcome, 700, Binding::hello(session.gateway_random), kAddress, PacketLimit::link);
  REQUIRE(channel.open_session(view_of(good), session).ok());
  CHECK(session.welcomed);
  CHECK(session.hub_random == welcome.hub_random);
  const Bytes settings =
      hub_packet(protocol::GatewaySettings{}, 701, session.binding(), kAddress, PacketLimit::link);
  CHECK(channel.open_session(view_of(settings), session).ok());
  CHECK(channel.open_session(view_of(settings), session).status() == Status::refused);
  const Bytes old =
      hub_packet(protocol::GatewaySettings{}, 650, session.binding(), kAddress, PacketLimit::link);
  CHECK(channel.open_session(view_of(old), session).status() == Status::refused);
  // The gateway's own packets carry the session binding.
  const auto sealed = channel.seal(protocol::GatewayStatus{}, session.binding(), PacketLimit::link,
                                   protocol::MutableByteView(f.out.data(), f.out.size()));
  REQUIRE(sealed.ok());
  CHECK(hub_open(protocol::ByteView(f.out.data(), sealed.value().size), session.binding()).error ==
        protocol::Error::none);
}

TEST_CASE("a channel refuses to work before it is started or with an invalid address") {
  Fixture f;
  SecureChannel channel(f.cipher, f.storage, f.state);
  CHECK(seal(channel, f).status() == Status::not_ready);
  CHECK(channel.start(0, CounterStep::sensor, false) == Status::refused);
  f.storage.fail_reads = true;
  CHECK(channel.start(kAddress, CounterStep::sensor, false) == Status::storage_error);
}

}  // namespace
}  // namespace hsn::test
