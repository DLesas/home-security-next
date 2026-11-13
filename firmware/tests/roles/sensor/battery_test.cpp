// Telemetry and the battery (DS10, DS11, D109): battery, charging, USB power and chip
// temperature in every status packet; the voltage read before the radio sends, never while it
// does; a low-battery chirp at the provisional threshold, at most once in 12 hours.

#include <memory>

#include "sensor_bench.hpp"

namespace hsn::test::sensor {
namespace {

TEST_CASE("DS10: battery, charging, USB power and chip temperature in every status packet") {
  Bench bench;
  host::SimDevice& door = bench.add();
  door.board().sensor_io.battery_mv = 3876;
  door.board().sensor_io.temperature_c = -7;
  door.board().sensor_io.charge = true;
  door.set_input(Input::external_power, true, at_s(1));
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(400);
  const auto doors = received<protocol::DoorChanged>(bench, "door");
  const auto beats = received<protocol::Heartbeat>(bench, "door");
  REQUIRE(doors.size() == 1);
  REQUIRE(beats.size() >= 1);
  for (const protocol::SensorStatus& status : {static_cast<protocol::SensorStatus>(doors[0]),
                                               static_cast<protocol::SensorStatus>(beats[0])}) {
    // (3,876 − 2,500) ÷ 10 = 137.6, rounded to 138 (§3, battery byte).
    CHECK(status.battery_code == 138);
    CHECK(status.temperature_celsius == -7);
    CHECK(status.flags.charging);
    CHECK(status.flags.usb_power);
  }
}

TEST_CASE("D109: the voltage is read before the radio sends, never while it is sending") {
  Bench bench;
  std::unique_ptr<WatchedIo> io;
  host::SimDevice& door =
      bench.add_with("door", [&io](device::Services& services, host::HostBoard& board) {
        if (!io) {
          io = std::make_unique<WatchedIo>(board);
        }
        return host::box_role<SensorRole>(services, *io);
      });
  bench.hub.arm();
  // Changes that land while a report is on the air, and heartbeats, over half an hour.
  for (int i = 0; i < 12; ++i) {
    door.set_input(Input::door, i % 2 == 0, at_s(30 + 120 * i));
    door.set_input(Input::cover, i % 2 == 0, at_s(30 + 120 * i + 0.08));
  }
  bench.run_to(1800);
  REQUIRE(io != nullptr);
  const std::size_t status_packets = sent(door, type::door_changed).size() +
                                     sent(door, type::cover_changed).size() +
                                     sent(door, type::heartbeat).size();
  // One reading per status packet, none while transmitting or checking the channel.
  CHECK(io->modes_at_battery_read.size() == status_packets);
  for (const host::RadioMode mode : io->modes_at_battery_read) {
    CHECK(mode != host::RadioMode::transmitting);
    CHECK(mode != host::RadioMode::detecting);
  }
}

TEST_CASE("DS11: a low-battery chirp at the threshold, at most once in 12 hours, and logged") {
  Bench bench;
  host::SimDevice& door = bench.add();
  door.board().sensor_io.battery_mv = 3600;
  bench.run_to(1000);
  CHECK(sound_times(door, Sound::low_battery).empty());
  door.board().sensor_io.battery_mv = roles::sensor::kLowBatteryMillivolts;
  bench.run_to(3600 * 13);
  const auto chirps = sound_times(door, Sound::low_battery);
  REQUIRE(chirps.size() == 2);
  CHECK(chirps[1] - chirps[0] >= seconds(12 * 3600));
  CHECK(chirps[1] - chirps[0] <= seconds(12 * 3600 + 200));
  // The hub hears of it twice: the battery byte in every packet, and the warning (D110).
  CHECK(sensor_logs(bench, "door", roles::sensor::sensor_log::low_battery).size() == 2);
  CHECK(received<protocol::Heartbeat>(bench, "door").back().battery_code == 100);
}

TEST_CASE("DS11: no chirp while charging on USB") {
  Bench bench;
  host::SimDevice& door = bench.add();
  door.board().sensor_io.battery_mv = 3300;
  door.set_input(Input::external_power, true, at_s(1));
  bench.run_to(1000);
  CHECK(sound_times(door, Sound::low_battery).empty());
}

}  // namespace
}  // namespace hsn::test::sensor
