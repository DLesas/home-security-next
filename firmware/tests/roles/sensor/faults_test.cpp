// Faults (FW6, protocol section 4, design sections 3 and 4): a flash write that fails, a radio
// that refuses, and what the sensor does about each: nothing silently dropped, every failure
// logged with a sensor code, and the work done once the hardware recovers.

#include <cstring>
#include <limits>

#include "hsn/host/provisioning.hpp"
#include "sensor_bench.hpp"
#include "test_transmitter.hpp"

namespace hsn::test::sensor {
namespace {

using roles::sensor::sensor_log::radio_failed;
using roles::sensor::sensor_log::seal_failed;
using roles::sensor::sensor_log::settings_not_stored;

TEST_CASE("fault: the resume point's flash write fails: nothing is sent until it can be saved") {
  Bench bench;
  host::SimDevice& door = bench.add();
  door.board().storage.fail_writes = true;
  bench.sim.schedule(at_s(3), [&]() { door.board().storage.fail_writes = false; });
  bench.run_to(30);
  INFO(door.records().dump());
  // Counter 64 needs its resume point saved first (§4): the tries at 0 and ~2 s are refused.
  const auto started = sent(door, type::started);
  REQUIRE(started.size() == 1);
  CHECK(started[0].from > at_s(3));
  // The counter was kept for the try that went, not skipped.
  CHECK(started[0].label.counter == 64);
  CHECK(door.records()
            .kind(RecordKind::flash_write)
            .where([](const Record& r) { return r.flag; })
            .count() >= 2);
  CHECK(logged(door, seal_failed));
}

TEST_CASE("fault: the settings record cannot be written: the new settings are used, and logged") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  door.board().storage.fail_writes = true;
  host::SensorConfig longer;
  longer.countdown_seconds = 50;
  bench.hub.change_sensor("door", longer);
  bench.hub.arm();
  // The heartbeat's reply brings the new countdown; flash refuses it.
  bench.run_to(250);
  CHECK(retained_state(door).settings.countdown_seconds == 50);
  CHECK(logged(door, settings_not_stored));
  // With the hub out of reach, the local countdown uses the new 50 s.
  bench.sim.medium().cut(door.station(), bench.hub.station());
  door.set_input(Input::door, true, at_s(300));
  bench.run_to(400);
  const auto alarm = sound_times(door, Sound::alarm);
  REQUIRE(alarm.size() == 1);
  CHECK(alarm[0] == at_s(300.05 + 50));
}

TEST_CASE("fault: the radio refuses once: the try is logged and retried on schedule") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  bench.sim.schedule(at_s(30.02), [&]() { door.board().radio.fail_next = device::HalError::io; });
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(60);
  INFO(door.records().between(at_s(29), at_s(60)).dump());
  const auto reports = sent(door, type::door_changed);
  REQUIRE(reports.size() == 1);
  CHECK(reports[0].from >= at_s(30.05 + 2));
  CHECK(reports[0].from <= at_s(30.05 + 3.1));
  CHECK(logged(door, radio_failed));
  CHECK(retained_state(door).waiting == 0);
}

TEST_CASE("fault: the radio refuses the transmit after a clear channel check: retried, logged") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  // The check starts at 30.05 and ends at 30.053; the transmit that follows is refused.
  bench.sim.schedule(at_s(30.051), [&]() { door.board().radio.fail_next = device::HalError::io; });
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(60);
  INFO(door.records().between(at_s(29), at_s(60)).dump());
  const auto reports = sent(door, type::door_changed);
  REQUIRE(reports.size() == 1);
  CHECK(reports[0].from >= at_s(30.05 + 2));
  CHECK(logged(door, radio_failed));
  CHECK(retained_state(door).waiting == 0);
}

TEST_CASE("fault: a radio that refuses everything for a while: the report goes once it recovers") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  bench.sim.schedule(at_s(25), [&]() { door.board().radio.refuse_all = true; });
  bench.sim.schedule(at_s(50), [&]() { door.board().radio.refuse_all = false; });
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(200);
  const auto reports = sent(door, type::door_changed);
  REQUIRE(reports.size() == 1);
  CHECK(reports[0].from > at_s(50));
  CHECK(retained_state(door).waiting == 0);
  CHECK(logged(door, radio_failed));
  check_sleep_discipline(door);
}

TEST_CASE("fault: the factory reset's erase fails: logged as critical, the sensor stays paired") {
  Bench bench;
  host::SimDevice& door = bench.add();
  door.hold_button(at_s(30), at_s(46));
  // Flash fails after action 4 has gone, just before the erase.
  bench.sim.schedule(at_s(46.2), [&]() { door.board().storage.fail_writes = true; });
  bench.run_to(60);
  CHECK(sent(door, type::button).size() == 1);
  CHECK(door.board().storage.has(device::StoreKey::pairing));
  CHECK(door.records().kind(RecordKind::restart).count() == 0);
  CHECK(logged(door, roles::sensor::sensor_log::factory_reset_failed));
  CHECK(retained_state(door).reset == roles::sensor::ResetPhase::none);
}

TEST_CASE("fault: Started is answered but the stored fatal code cannot be cleared: logged") {
  Bench bench;
  host::SimDevice& door = bench.add();
  const std::array<std::uint8_t, 2> code{0x01, 0x00};
  door.board().storage.records[device::StoreKey::fatal_error] =
      host::Bytes(code.begin(), code.end());
  // Started has gone; the settings write and the clearing erase both fail.
  bench.sim.schedule(at_s(0.12), [&]() { door.board().storage.fail_next_writes = 2; });
  bench.run_to(10);
  CHECK(door.board().storage.has(device::StoreKey::fatal_error));
  CHECK(logged(door, roles::sensor::sensor_log::fatal_not_cleared));
  CHECK(logged(door, settings_not_stored));
}

TEST_CASE("section 5: a hub packet of a type the sensor does not act on is dropped and logged") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(20);
  REQUIRE(door.state() == host::PowerState::deep_sleep);
  // A siren command, properly sealed with the sensor's key and bound to the door report it is
  // about to send, arrives in that report's window; the hub's own reply is lost.
  device::CoreRetained core;
  std::memcpy(&core, door.board().retained.contents().data() + device::kRetainedHeaderSize,
              sizeof(core));
  const host::Bytes& pairing = door.board().storage.records[device::StoreKey::pairing];
  REQUIRE(pairing.size() > 5);
  const std::uint32_t address = static_cast<std::uint32_t>(pairing[1]) |
                                (static_cast<std::uint32_t>(pairing[2]) << 8) |
                                (static_cast<std::uint32_t>(pairing[3]) << 16) |
                                (static_cast<std::uint32_t>(pairing[4]) << 24);
  protocol::SirenCommand command;
  command.action = protocol::SirenAction::sound_alarm;
  std::vector<std::uint8_t> plain(64);
  const auto size =
      protocol::encode_plaintext(command, protocol::MutableByteView(plain.data(), plain.size()));
  REQUIRE(size.ok());
  std::vector<std::uint8_t> packet(64);
  const auto sealed = protocol::seal_packet(
      door.board().cipher, {protocol::Direction::from_hub, address, 900},
      protocol::Binding::sensor_packet(core.counter.next),
      protocol::ByteView(plain.data(), size.value()), protocol::PacketLimit::radio,
      protocol::MutableByteView(packet.data(), packet.size()));
  REQUIRE(sealed.ok());
  packet.resize(sealed.value());
  bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(),
                                           std::numeric_limits<double>::infinity());
  TransmitterConfig sender;
  sender.channel = {device::kReplyFrequencyHz, 5};
  sender.packets = {packet};
  sender.start = at_s(30.4);
  sender.stop = at_s(31);
  add_transmitter(bench.sim, "forger", sender, 0x0BADBEEF);
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(31);
  CHECK(door.records().kind(RecordKind::reception).between(at_s(30), at_s(31)).count() == 1);
  CHECK(logged(door, roles::sensor::sensor_log::hub_message_ignored));
  // It did nothing else: the report is still waiting for a reply.
  CHECK(retained_state(door).waiting != 0);
}

TEST_CASE(
    "section 3: a pairing whose site channel is not listed: nothing is sent, and it is logged") {
  host::Simulation sim;
  host::DeviceSpec spec;
  spec.name = "door";
  spec.role = host::make_role<SensorRole>(&host::HostBoard::sensor_io);
  host::SimDevice& door = sim.add_device(spec);
  host::Provisioning pairing;
  pairing.role = protocol::Role::sensor;
  pairing.address = 0x1A2B3C4D;
  pairing.site_channel = 7;
  host::provision(door.board(), pairing);
  sim.run_until(at_s(700));
  CHECK(door.records().kind(RecordKind::transmission).count() == 0);
  CHECK(logged(door, roles::sensor::sensor_log::no_site_channel));
  check_sleep_discipline(door);
}

}  // namespace
}  // namespace hsn::test::sensor
