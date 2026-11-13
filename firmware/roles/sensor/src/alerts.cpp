// What the buzzer plays (design section 3, Sound): the hub's countdown (D24, DS12, DS13), the
// local countdown and local alarm when the hub does not answer an armed opening (DS6, D88), the
// reset warning (D89), and the low-battery chirp (DS11, D109).

#include "hsn/roles/sensor/sensor_role.hpp"

namespace hsn::roles::sensor {

void SensorRole::start_hub_countdown(std::uint8_t remaining_seconds, device::Instant now) {
  // A countdown of zero ends in this same event, so it never buzzes (D86).
  state_.alert = Alert::hub_countdown;
  state_.timers.cancel(SensorTimer::local_alarm);
  state_.timers.arm(SensorTimer::countdown_end, now + device::seconds(remaining_seconds));
  // The disarmed notice is bound to the opening's newest report (§4): keep its tries.
  state_.tries.retag(TryKind::door, TryKind::countdown);
}

void SensorRole::start_local_alarm(device::Instant now) {
  // The stored countdown counts from the opening, then the alarm sounds (DS6, DS14).
  const device::Instant countdown_end =
      state_.door_opened_at + device::seconds(state_.settings.countdown_seconds);
  if (now < countdown_end) {
    state_.alert = Alert::local_countdown;
    state_.timers.arm(SensorTimer::local_alarm, countdown_end);
  } else {
    begin_alarm(countdown_end, now);
  }
}

void SensorRole::begin_alarm(device::Instant from, device::Instant now) {
  const device::Instant end = from + kLocalAlarmLength;
  if (end <= now) {
    state_.alert = Alert::none;
    return;
  }
  state_.alert = Alert::local_alarm;
  state_.timers.arm(SensorTimer::local_alarm, end);
  // The next packet that gets through says so, with flag bit 5 (§6, §7).
  state_.local_alarm_sounded = true;
  state_.alarm_flag_counter = 0;
  services_.log.add(now, device::LogLevel::warning, sensor_log::local_alarm, "local alarm");
}

void SensorRole::stop_alerts() {
  state_.alert = Alert::none;
  state_.timers.cancel(SensorTimer::countdown_end);
  state_.timers.cancel(SensorTimer::local_alarm);
  state_.tries.remove(TryKind::countdown);
}

void SensorRole::run_alert_timers(device::Instant now) {
  if (state_.timers.take_if_due(SensorTimer::countdown_end, now)) {
    // The hub sounds the sirens now; the sensor stops buzzing at the same moment (§7).
    if (state_.alert == Alert::hub_countdown) {
      stop_alerts();
    }
  }
  const device::Instant phase_end = state_.timers.at(SensorTimer::local_alarm);
  if (state_.timers.take_if_due(SensorTimer::local_alarm, now)) {
    if (state_.alert == Alert::local_countdown) {
      begin_alarm(phase_end, now);
    } else if (state_.alert == Alert::local_alarm) {
      state_.alert = Alert::none;
    }
  }
}

device::Sound SensorRole::desired_sound() const {
  switch (state_.alert) {
    case Alert::local_alarm:
      return device::Sound::alarm;
    case Alert::hub_countdown:
    case Alert::local_countdown:
      return device::Sound::countdown;
    case Alert::none:
      break;
  }
  return state_.reset == ResetPhase::armed_wait ? device::Sound::reset_warning : device::Sound::off;
}

void SensorRole::check_battery(std::uint16_t millivolts, device::Instant now) {
  // On USB the cell is charging; otherwise chirp at the threshold, at most once in a while.
  if (millivolts > kLowBatteryMillivolts || state_.external_power) {
    return;
  }
  if (!state_.chirped_at.is_never() && now - state_.chirped_at < kLowBatteryChirpGap) {
    return;
  }
  if (desired_sound() != device::Sound::off) {
    // A continuous sound is playing; the next reading tries again.
    return;
  }
  state_.chirped_at = now;
  io_.buzzer(device::Sound::low_battery);
  services_.log.add(now, device::LogLevel::warning, sensor_log::low_battery, "low battery",
                    millivolts);
}

}  // namespace hsn::roles::sensor
