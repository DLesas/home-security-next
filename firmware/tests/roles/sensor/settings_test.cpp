// The settings a reply carries (protocol section 6; LR6, DS4, DS5, DS14, design section 5):
// every field is kept; flash is written only when a stored field changes; the armed state and
// the settings version never reach flash; a rate the sensor does not know, or the pairing does
// not allow, leaves the current one.

#include "sensor_bench.hpp"

namespace hsn::test::sensor {
namespace {

using roles::sensor::kSettingsKey;

std::size_t settings_writes(host::SimDevice& door) {
  return door.board().storage.write_count(kSettingsKey);
}

TEST_CASE("LR6, DS14: every setting in a reply is kept, and stored") {
  Bench bench;
  host::SensorConfig settings;
  settings.countdown_seconds = 77;
  settings.heartbeat_interval_units = 9;
  settings.link_check_every = 3;
  settings.send_data_rate = 2;
  settings.reply_data_rate = 4;
  settings.clock_correction_ten_ppm = -123;
  host::SimDevice& door = bench.add("door", settings);
  bench.hub.arm();
  bench.run_to(10);
  const roles::sensor::SensorState state = retained_state(door);
  CHECK(state.armed);
  CHECK(state.settings_version == bench.hub.settings_version("door"));
  CHECK(state.settings.countdown_seconds == 77);
  CHECK(state.settings.heartbeat_interval_units == 9);
  CHECK(state.settings.link_check_every == 3);
  CHECK(state.settings.send_data_rate == 2);
  CHECK(state.settings.reply_data_rate == 4);
  CHECK(state.settings.clock_correction_ten_ppm == -123);
  CHECK(state.send_rate == 2);
  // The record in flash: version byte, then those fields, and nothing about arming.
  const host::Bytes& record = door.board().storage.records[kSettingsKey];
  REQUIRE(record.size() == 1 + sizeof(roles::sensor::StoredSettings));
  CHECK(record[0] == roles::sensor::kSettingsRecordVersion);
}

TEST_CASE(
    "design section 5: arming and disarming never write flash; a changed setting writes once") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  CHECK(settings_writes(door) == 1);
  // Arm and disarm every 10 minutes for 2 hours: the version changes, the stored fields do not.
  for (int i = 1; i <= 12; ++i) {
    bench.sim.schedule(at_s(600 * i), [&bench, i]() {
      if (i % 2 == 1) {
        bench.hub.arm();
      } else {
        bench.hub.disarm();
      }
    });
  }
  bench.run_to(2 * 3600 + 300);
  CHECK(bench.hub.sent_to("door", type::reply).size() >= 12);
  CHECK(settings_writes(door) == 1);
  // DS5: the armed state is kept across deep sleeps, in retained memory only.
  CHECK(door.records().kind(RecordKind::deep_sleep).count() > 30);
  host::SensorConfig changed;
  changed.countdown_seconds = 45;
  bench.hub.change_sensor("door", changed);
  bench.run_to(3 * 3600);
  CHECK(settings_writes(door) == 2);
  CHECK(retained_state(door).settings.countdown_seconds == 45);
}

TEST_CASE("section 3: a data rate the pairing does not allow, or that is not listed, is ignored") {
  Bench bench;
  host::SensorConfig settings;
  settings.send_data_rate = 4;
  settings.reply_data_rate = 9;
  host::SimDevice& door = bench.add("door", settings);
  bench.run_to(10);
  const roles::sensor::SensorState state = retained_state(door);
  CHECK(state.send_rate == 5);
  CHECK(state.settings.send_data_rate == 5);
  CHECK(state.settings.reply_data_rate == 5);
  CHECK(logged(door, roles::sensor::sensor_log::setting_ignored));
}

}  // namespace
}  // namespace hsn::test::sensor
