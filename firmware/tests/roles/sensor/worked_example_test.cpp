// The worked example of firmware-design.md section 2, step by step: an armed door opens with the
// sensor in deep sleep, the hub answers with "countdown started", the sensor buzzes and listens,
// the user disarms, the first disarmed notice stops it, the second is not heard, and it sleeps
// deep. Then the example's last paragraph: the same opening with no reply.

#include <cstring>

#include "hsn/device/services/radio_plan.hpp"
#include "sensor_bench.hpp"

namespace hsn::test::sensor {
namespace {

/** The example's settings: armed, countdown 30 s, sending at DR3, replies at DR5, 868.3 MHz. */
host::SensorConfig example_settings() {
  host::SensorConfig settings;
  settings.countdown_seconds = 30;
  settings.send_data_rate = 3;
  settings.reply_data_rate = 5;
  return settings;
}

/** A site that allows DR5, DR3 and DR2, so the example's DR3 is allowed. */
host::HubOptions example_site() {
  host::HubOptions options;
  options.allowed_data_rate_mask = 0x2C;
  return options;
}

/** The send counter kept in the retained block, read from the board. */
std::uint32_t next_counter(host::SimDevice& device) {
  device::CoreRetained core;
  std::memcpy(&core, device.board().retained.contents().data() + device::kRetainedHeaderSize,
              sizeof(core));
  return core.counter.next;
}

/**
 * Runs until the sensor sleeps deep with 1024 as its next counter, as the example has it, and
 * returns that true instant. The resume point is set so that 1024 comes after a few heartbeats.
 */
Instant sleep_with_counter_1024(Bench& bench, host::SimDevice& door) {
  for (int step = 0; step < 2000; ++step) {
    bench.sim.run_for(seconds(10));
    if (door.state() == host::PowerState::deep_sleep && next_counter(door) == 1024) {
      return bench.sim.now();
    }
  }
  FAIL("the sensor never reached counter 1024 asleep");
  return Instant{};
}

TEST_CASE("worked example (design section 2): armed door, countdown, disarmed notice") {
  Bench bench(example_site());
  host::SimDevice& door = bench.add("door", example_settings());
  // Resume from 1,024 − 64: Started and heartbeats bring the next counter to 1,024.
  const std::array<std::uint8_t, 4> resume{0xC0, 0x03, 0x00, 0x00};
  door.board().storage.records[device::StoreKey::counter_resume] =
      host::Bytes(resume.begin(), resume.end());
  bench.hub.arm();
  const Instant t0 = sleep_with_counter_1024(bench, door) + seconds(5);
  door.set_input(Input::door, true, t0);
  bench.sim.schedule(t0 + milliseconds(12300), [&]() { bench.hub.disarm(); });
  bench.sim.run_until(t0 + seconds(40));
  INFO(door.records().between(t0, t0 + seconds(40)).dump() << bench.hub.dump());
  const auto during = [&](RecordKind kind) {
    return door.records().between(t0, t0 + seconds(40)).kind(kind).records();
  };

  // t = 0: the reed switch wakes the chip from deep sleep; it boots 50 ms later as a wake, not
  // a start-up, so no Started.
  const auto boots = during(RecordKind::boot);
  REQUIRE(boots.size() == 1);
  CHECK(boots[0].at == t0 + milliseconds(50));
  CHECK(boots[0].value == static_cast<std::uint32_t>(device::BootKind::deep_sleep_wake));
  CHECK_FALSE(boots[0].flag);

  // ≈0.05: counter 1024 is a multiple of 64, so 1088 is written first; then the channel check
  // at SF9 on 868.3 MHz.
  const auto writes = during(RecordKind::flash_write);
  REQUIRE(writes.size() == 1);
  CHECK(writes[0].value == static_cast<std::uint32_t>(device::StoreKey::counter_resume));
  CHECK(writes[0].at == t0 + milliseconds(50));
  CHECK(door.board().storage.records[device::StoreKey::counter_resume] ==
        host::Bytes{0x40, 0x04, 0x00, 0x00});
  const auto checks = during(RecordKind::channel_check);
  REQUIRE(checks.size() == 1);
  CHECK(checks[0].frequency_hz == 868300000u);
  CHECK(checks[0].data_rate == 3);
  CHECK_FALSE(checks[0].flag);

  // ≈0.07: the door report goes at DR3 with 14 dBm, 25 bytes, 206 ms on air, reply wanted.
  const auto reports = sent(door, type::door_changed);
  REQUIRE(reports.size() == 1);
  const Record& report = reports[0];
  CHECK(report.label.counter == 1024);
  CHECK(report.data_rate == 3);
  CHECK(report.frequency_hz == 868300000u);
  CHECK(report.rssi_dbm == 14);
  CHECK(report.length == 25);
  // 206 ms in the protocol's table, exactly the core's formula.
  CHECK(report.until - report.from == device::time_on_air(3, 25).value());
  const auto decoded = received<protocol::DoorChanged>(bench, "door");
  REQUIRE(decoded.size() == 1);
  CHECK(decoded[0].flags.door_open);
  CHECK(decoded[0].flags.reply_wanted);
  CHECK(decoded[0].event_age_seconds == 0);
  CHECK(decoded[0].settings_version == bench.hub.settings_version("door") - 1);

  // ≈0.28: tx_done; it listens on 869.525 MHz at DR5 at once, for the event listen time.
  const auto windows = during(RecordKind::rx_window);
  REQUIRE(windows.size() >= 2);
  CHECK(windows[0].at == report.until);
  CHECK(windows[0].frequency_hz == 869525000u);
  CHECK(windows[0].value == 1u << 5);
  // The 1.9 s event listen time at DR3, and the confirmation symbols at DR5.
  CHECK(windows[0].until == report.until + heard_until(milliseconds(1900), 5));

  // ≈0.9: the reply, bound to 1024: armed, countdown started. Settings unchanged: no write.
  const auto replies = hub_sent(bench, type::reply);
  REQUIRE_FALSE(replies.empty());
  const Record& reply = replies.back();
  CHECK(reply.data_rate == 5);
  const auto countdown = bench.hub.decisions(HubAction::countdown_started, "door");
  REQUIRE(countdown.size() == 1);
  CHECK(countdown[0].value >= 29);
  // The buzzer plays the countdown, and the radio listens continuously (D24, LR7).
  const auto buzz = during(RecordKind::buzzer);
  REQUIRE(buzz.size() == 2);
  CHECK(buzz[0].at == reply.until);
  CHECK(buzz[0].value == static_cast<std::uint32_t>(Sound::countdown));
  CHECK(windows[1].at == reply.until);
  CHECK(windows[1].until.is_never());
  CHECK(windows[1].value == 1u << 5);

  // ≈12.3: the first disarmed notice, bound to 1024, stops the buzzer and the radio.
  const auto notices = hub_sent(bench, type::disarmed_notice);
  REQUIRE(notices.size() == 2);
  CHECK(bench.hub.decisions(HubAction::disarmed_notice, "door")[0].value == 1024);
  CHECK(buzz[1].at == notices[0].until);
  CHECK(buzz[1].value == static_cast<std::uint32_t>(Sound::off));
  // The second notice at ≈14.3 is not heard: the radio is asleep, and the chip in deep sleep.
  CHECK(door.records().kind(RecordKind::reception).type(type::disarmed_notice).count() == 1);
  const auto deep = during(RecordKind::deep_sleep);
  REQUIRE(deep.size() == 1);
  CHECK(deep[0].at == notices[0].until);
  CHECK(deep[0].at < notices[1].from);
  // Deep, woken by the door, cover, button and USB, until the next heartbeat.
  CHECK(deep[0].value == device::WakeMask::of(Input::door)
                             .with(Input::cover)
                             .with(Input::button)
                             .with(Input::external_power)
                             .bits());
  CHECK(deep[0].until ==
        retained_state(door).timers.at(roles::sensor::SensorTimer::next_heartbeat));
  // Light sleep while it listened and buzzed: one wait record, light, after the boot.
  const auto waits = during(RecordKind::wait);
  REQUIRE(waits.size() == 1);
  CHECK(waits[0].value == static_cast<std::uint32_t>(device::SleepDepth::light));
  check_sleep_discipline(door);
}

TEST_CASE(
    "worked example, last paragraph: no reply, the radio sleeps, the retry, the local alarm") {
  Bench bench(example_site());
  host::SimDevice& door = bench.add("door", example_settings());
  bench.hub.arm();
  bench.run_to(5);
  REQUIRE(door.state() == host::PowerState::deep_sleep);
  // Replies no longer reach the sensor.
  bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(),
                                           std::numeric_limits<double>::infinity());
  const Instant t0 = at_s(10);
  door.set_input(Input::door, true, t0);
  bench.sim.run_until(t0 + seconds(30 + 200));
  INFO(door.records().between(t0, t0 + seconds(60)).dump());
  const auto reports = sent(door, type::door_changed);
  REQUIRE(reports.size() >= 2);
  const auto windows =
      door.records().kind(RecordKind::rx_window).between(t0, t0 + seconds(5)).records();
  REQUIRE_FALSE(windows.empty());
  // Had no reply arrived by the window's end, the radio sleeps: the window times out...
  CHECK(door.records().kind(RecordKind::rx_timeout).between(t0, t0 + seconds(3)).count() == 1);
  // ...and the retry runs about 2 s after the event, plus up to 1 s, never before it ended.
  const Instant opened = t0 + milliseconds(50);
  CHECK(reports[1].from >= windows[0].until);
  CHECK(reports[1].from >= opened + seconds(2));
  CHECK(reports[1].from <= opened + seconds(3) + milliseconds(100));
  // The sensor believes it is armed and the first try went unanswered: it buzzes from the
  // opening for its stored 30 s, then sounds its own alarm (DS6, D88), in light sleep.
  const auto countdown_at = sound_times(door, Sound::countdown);
  const auto alarm_at = sound_times(door, Sound::alarm);
  REQUIRE(countdown_at.size() == 1);
  REQUIRE(alarm_at.size() == 1);
  CHECK(countdown_at[0] == windows[0].until);
  CHECK(alarm_at[0] == opened + seconds(30));
  CHECK(door.records().kind(RecordKind::deep_sleep).between(t0, alarm_at[0]).count() == 0);
}

}  // namespace
}  // namespace hsn::test::sensor
