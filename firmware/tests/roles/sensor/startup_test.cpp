// Start-up and wake (protocol section 6, Started; DS5, FW5, FW8, design section 5): which starts
// are start-ups, Started and its retries, the armed state across sleeps, resets and power loss,
// and the faults of the retained block: corrupted, or kept while the clock restarted.

#include <algorithm>
#include <array>
#include <cstring>
#include <limits>

#include "hsn/device/services/radio_plan.hpp"
#include "hsn/roles/sensor/data_rates.hpp"
#include "sensor_bench.hpp"

namespace hsn::test::sensor {
namespace {

constexpr double kInfinite = std::numeric_limits<double>::infinity();

/** Cuts both directions between the sensor and the hub's radio. */
void cut(Bench& bench, host::SimDevice& door) {
  bench.sim.medium().cut(door.station(), bench.hub.station());
}

/** Restores the default path loss. */
void mend(Bench& bench, host::SimDevice& door) {
  bench.sim.medium().set_path_loss(door.station(), bench.hub.station(), 100.0);
}

TEST_CASE("Started (section 6): a first power-on sends Started, which the hub answers") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  INFO(door.records().dump() << bench.hub.dump());
  CHECK(sent_names(door) == "started");
  const auto started = received<protocol::Started>(bench, "door");
  REQUIRE(started.size() == 1);
  CHECK(started[0].role == protocol::Role::sensor);
  // FW8: the firmware version; FW5: the raw reset cause, and no fatal error.
  const device::BuildInfo build = door.board().hal().build;
  CHECK(started[0].firmware_version.major == build.version.major);
  CHECK(started[0].firmware_version.minor == build.version.minor);
  CHECK(started[0].firmware_version.patch == build.version.patch);
  CHECK(started[0].reset_cause == door.records().kind(RecordKind::boot).records()[0].rssi_dbm);
  CHECK(started[0].last_fatal_error == 0);
  CHECK(started[0].settings_version == 0);
  // The hub always answers Started; the sensor then holds its version and sleeps deep.
  CHECK(bench.hub.sent_to("door", type::reply).size() == 1);
  CHECK(retained_state(door).settings_version == bench.hub.settings_version("door"));
  CHECK(door.state() == host::PowerState::deep_sleep);
  check_sleep_discipline(door);
}

TEST_CASE("Started (section 6): a deep-sleep wake with retained memory intact is not a start-up") {
  Bench bench;
  host::SimDevice& door = bench.add();
  door.set_input(Input::door, true, at_s(20));
  door.set_input(Input::door, false, at_s(40));
  bench.run_to(400);
  // Woken by the timer (heartbeats) and by the door: one Started only, at power-on.
  CHECK(sent(door, type::started).size() == 1);
  CHECK(door.records().kind(RecordKind::boot).count() >= 4);
  CHECK(sent(door, type::door_changed).size() == 2);
}

TEST_CASE("Started (section 6): retried like a door report until the hub answers") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.sim.schedule(at_s(0), [&]() { cut(bench, door); });
  bench.sim.schedule(at_s(40), [&]() { mend(bench, door); });
  bench.run_to(200);
  INFO(door.records().kind(RecordKind::transmission).dump());
  const auto tries = sent(door, type::started);
  // At about 0, 2, 5, 10 s and then 70 s after the boot: the 70 s try gets through.
  REQUIRE(tries.size() == 5);
  const Instant boot = at_s(0.05);
  const double offsets[] = {0, 2, 5, 10, 70};
  const double gaps[] = {0, 2, 3, 5, 60};
  for (std::size_t i = 0; i < tries.size(); ++i) {
    INFO("try " << i);
    CHECK(tries[i].from >=
          boot + device::microseconds(static_cast<std::int64_t>(offsets[i] * 1e6)));
    CHECK(tries[i].from <= boot + device::microseconds(static_cast<std::int64_t>(
                                      (offsets[i] + gaps[i] / 2 + 0.1) * 1e6)));
  }
  // The fifth try was answered, and nothing waits any more.
  const auto replies = bench.hub.sent_to("door", type::reply);
  REQUIRE_FALSE(replies.empty());
  CHECK(replies[0].at > tries[4].until);
  CHECK(retained_state(door).waiting == 0);
}

TEST_CASE("Started (section 6), DS5: no retained memory counts as disarmed until the reply") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  bench.run_to(10);
  REQUIRE(retained_state(door).armed);
  // Power is lost: the retained block goes, and with it the armed state, which flash never
  // held. The hub cannot be reached when the sensor comes back.
  door.power_loss(at_s(20), seconds(1));
  bench.sim.schedule(at_s(20.5), [&]() { cut(bench, door); });
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(60);
  const roles::sensor::SensorState after = retained_state(door);
  CHECK_FALSE(after.armed);
  CHECK(after.settings_version == 0);
  // Believing itself disarmed, the unanswered opening does not set off the local alarm.
  CHECK(sound_times(door, Sound::countdown).empty());
  CHECK(sound_times(door, Sound::alarm).empty());
  // Back in reach, Started's retry is answered and the sensor learns it is armed.
  bench.sim.schedule(at_s(60), [&]() { mend(bench, door); });
  bench.run_to(200);
  CHECK(retained_state(door).armed);
  CHECK(sent(door, type::started).size() >= 2);
}

TEST_CASE("Started (section 6): a software restart is a start-up, and the armed state is kept") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  bench.run_to(10);
  const std::uint8_t held = retained_state(door).settings_version;
  REQUIRE(held != 0);
  door.restart(at_s(20));
  // The hub hears the second Started (sent at 20.053, heard at 20.115), then the link goes
  // before its reply can arrive.
  bench.sim.schedule(at_s(20.14), [&]() { cut(bench, door); });
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(40);
  const auto started = received<protocol::Started>(bench, "door");
  REQUIRE(started.size() == 2);
  // Started names the settings version still held in retained memory.
  CHECK(started[1].settings_version == held);
  const roles::sensor::SensorState after = retained_state(door);
  CHECK(after.armed);
  // Still armed after the restart, the unanswered opening starts the local countdown (DS6).
  CHECK(sound_times(door, Sound::countdown).size() == 1);
}

TEST_CASE("FW5: a stored fatal error is reported in Started and cleared once it is answered") {
  Bench bench;
  host::SimDevice& door = bench.add();
  const std::array<std::uint8_t, 2> code{0x02, 0x00};
  door.board().storage.records[device::StoreKey::fatal_error] =
      host::Bytes(code.begin(), code.end());
  bench.sim.schedule(at_s(0), [&]() { cut(bench, door); });
  bench.run_to(8);
  // Unanswered, the code stays stored.
  CHECK(door.board().storage.has(device::StoreKey::fatal_error));
  bench.sim.schedule(at_s(8), [&]() { mend(bench, door); });
  bench.run_to(60);
  const auto started = received<protocol::Started>(bench, "door");
  REQUIRE_FALSE(started.empty());
  CHECK(started[0].last_fatal_error == device::fatal_code::stuck_awake);
  CHECK_FALSE(door.board().storage.has(device::StoreKey::fatal_error));
}

TEST_CASE("fault: corrupted retained memory is a cold start: Started, disarmed until the reply") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  bench.run_to(10);
  REQUIRE(door.state() == host::PowerState::deep_sleep);
  REQUIRE(retained_state(door).armed);
  // One bit flips in RTC memory while the chip sleeps; the CRC catches it at the next wake.
  bench.sim.schedule(at_s(15), [&]() { door.board().retained.corrupt(700); });
  bench.sim.schedule(at_s(15), [&]() { cut(bench, door); });
  door.set_input(Input::door, true, at_s(20));
  bench.run_to(30);
  // The wake at 20 s finds the block bad: a start-up, so Started goes again at once.
  const auto started = sent(door, type::started);
  REQUIRE(started.size() >= 2);
  CHECK(started[1].from < at_s(20.1));
  CHECK_FALSE(retained_state(door).armed);
  // A cold start reads the door as it finds it: no change to report, and no local alarm.
  CHECK(sent(door, type::door_changed).empty());
  CHECK(sound_times(door, Sound::countdown).empty());
  bench.sim.schedule(at_s(30), [&]() { mend(bench, door); });
  bench.run_to(120);
  CHECK(retained_state(door).armed);
}

TEST_CASE("fault: a clock that restarted under an intact retained block rebases every timer") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  door.set_input(Input::door, true, at_s(100));
  bench.run_to(110);
  // The RTC restarts at zero while RTC memory survives (a brown-out, say): the retained block
  // is put back after the power loss garbled it, before the chip boots.
  std::array<std::uint8_t, device::kRetainedBlockSize> kept{};
  bench.sim.schedule(at_s(200), [&]() { kept = door.board().retained.contents(); });
  door.power_loss(at_s(200), seconds(1));
  bench.sim.schedule(at_s(200.5), [&]() {
    std::memcpy(door.board().retained.block().data(), kept.data(), kept.size());
  });
  bench.run_to(260);
  INFO(door.records().between(at_s(200), at_s(260)).dump() << bench.hub.dump());
  // A start-up: Started goes; the armed state and the change count are kept.
  CHECK(sent(door, type::started).size() == 2);
  const roles::sensor::SensorState after = retained_state(door);
  CHECK(after.armed);
  CHECK(after.change_count == 1);
  // The next heartbeat is planned from the new clock: the interval ±10% after the boot, on the
  // board's own clock, which restarted at zero.
  const Instant next = after.timers.at(roles::sensor::SensorTimer::next_heartbeat);
  CHECK(next <= Instant{} + seconds(199));
  CHECK(next >= Instant{} + seconds(162));
  // Nothing is left due in the past: the sensor sleeps deep, not in a busy loop.
  CHECK(door.state() == host::PowerState::deep_sleep);
  check_sleep_discipline(door);
}

TEST_CASE("fault: a clock reset with a report waiting sends it again at once, after Started") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  bench.sim.schedule(at_s(15), [&]() { cut(bench, door); });
  door.set_input(Input::door, true, at_s(20));
  bench.run_to(40);
  REQUIRE(retained_state(door).waiting != 0);
  std::array<std::uint8_t, device::kRetainedBlockSize> kept{};
  bench.sim.schedule(at_s(40), [&]() { kept = door.board().retained.contents(); });
  door.power_loss(at_s(40), seconds(1));
  bench.sim.schedule(at_s(40.5), [&]() {
    std::memcpy(door.board().retained.block().data(), kept.data(), kept.size());
  });
  bench.run_to(50);
  // Booted at 41.05: the waiting door report goes again at once, then Started when its window
  // ends, both as new changes rather than as retries of a run the old clock timed.
  const auto doors = sent(door, type::door_changed);
  const auto it = std::find_if(doors.begin(), doors.end(),
                               [](const Record& record) { return record.from > at_s(41); });
  REQUIRE(it != doors.end());
  // After its channel check, at the rate it fell back to during the cut.
  const device::Duration check = device::cad_duration(it->data_rate).value();
  CHECK(it->from == at_s(41.05) + check);
  const auto started = sent(door, type::started);
  REQUIRE(started.size() == 2);
  CHECK(started[1].from ==
        it->until + heard_until(roles::sensor::event_listen_time(it->data_rate), it->data_rate) +
            check);
}

TEST_CASE("fault: power lost in the middle of an exchange never repeats a counter") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  // Replies are lost, so the door's tries go on; the power goes between two of them.
  bench.sim.schedule(at_s(50), [&]() {
    bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(), kInfinite);
  });
  door.set_input(Input::door, true, at_s(60));
  door.power_loss(at_s(64), seconds(2));
  bench.sim.schedule(at_s(100), [&]() { mend(bench, door); });
  bench.run_to(300);
  INFO(door.records().kind(RecordKind::transmission).dump() << bench.hub.dump());
  const auto heard = all_received(bench, "door");
  REQUIRE(heard.size() >= 4);
  // Every packet the hub heard was new to it: the counter resumed past every one used.
  for (const host::HubPacket& packet : heard) {
    CHECK(packet.verdict == host::HubVerdict::accepted);
  }
  for (std::size_t i = 1; i < heard.size(); ++i) {
    CHECK(heard[i].counter > heard[i - 1].counter);
  }
  CHECK(sent(door, type::started).size() >= 2);
}

}  // namespace
}  // namespace hsn::test::sensor
