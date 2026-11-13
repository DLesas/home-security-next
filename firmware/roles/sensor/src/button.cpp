// The button (DS7, DS8, D88, D89, PR4). A hold is judged when it ends: under 5 s it is a short
// press, from 5 s a pairing hold, from 15 s a factory-reset hold. The LED blinks once as each
// mark passes, so the person holding it knows when to let go.

#include "hsn/roles/sensor/sensor_role.hpp"

namespace hsn::roles::sensor {

void SensorRole::button_pressed(device::Instant at, device::Instant now) {
  static_cast<void>(now);
  state_.button_down = true;
  state_.button_pressed_at = at;
  // A press stops the local countdown and alarm at once (D88).
  if (state_.alert == Alert::local_countdown || state_.alert == Alert::local_alarm) {
    state_.alert = Alert::none;
    state_.timers.cancel(SensorTimer::local_alarm);
  }
  state_.timers.arm(SensorTimer::button_hold, at + kPairingHold);
}

void SensorRole::button_released(device::Instant at, device::Instant now) {
  state_.button_down = false;
  state_.timers.cancel(SensorTimer::button_hold);
  state_.button_event_at = at;
  const device::Duration held = at - state_.button_pressed_at;
  if (held >= kResetHold) {
    reset_hold(now);
  } else if (held >= kPairingHold) {
    if (state_.armed) {
      // While armed a pairing hold does nothing, and is reported (DS8).
      report_button(protocol::ButtonAction::pairing_hold_ignored, now);
    } else {
      // The pairing window; the indicator only until Bluetooth comes in M3 (DS7, PR3).
      state_.pairing = true;
      io_.led(device::Blink::pairing);
      state_.timers.arm(SensorTimer::pairing_end, now + kPairingWindow);
    }
  } else {
    report_button(protocol::ButtonAction::short_press, now);
  }
}

void SensorRole::report_button(std::uint8_t action, device::Instant now) {
  if (state_.reset != ResetPhase::none) {
    // The factory reset's report stays the button report until it is settled.
    return;
  }
  state_.button_action = action;
  queue_report(report_bit::button, now);
}

void SensorRole::reset_hold(device::Instant now) {
  if (state_.reset != ResetPhase::none) {
    return;
  }
  if (state_.armed) {
    // D89: reported, the reset warning sounds through the whole retry run; a reply that says
    // armed refuses the reset, one that says not armed, or none at all, lets it go ahead.
    state_.button_action = protocol::ButtonAction::factory_reset_hold_while_armed;
    state_.reset = ResetPhase::armed_wait;
    queue_report(report_bit::button, now);
  } else {
    begin_going_ahead(now);
  }
}

void SensorRole::begin_going_ahead(device::Instant now) {
  // Action 4 goes before any other report (report_bit's order), once, with a reply wanted; its
  // listen window is the last thing before the erase (PR4: the hub is told just before).
  state_.reset = ResetPhase::going_ahead;
  queue_report(report_bit::going_ahead, now);
}

void SensorRole::erase_and_restart(device::Instant now) {
  if (services_.setup.factory_reset() != device::HalError::none) {
    services_.log.add(now, device::LogLevel::critical, sensor_log::factory_reset_failed,
                      "factory reset failed");
    state_.reset = ResetPhase::none;
    state_.waiting = 0;
    state_.unsent = 0;
    state_.timers.cancel(SensorTimer::retry);
    return;
  }
  // Keys and settings are gone (PR4); the restart comes up unpaired, in setup-only mode.
  state_ = kFreshState;
  // The buzzer is already off (going ahead plays nothing): no call needed before the restart.
  state_.sound = static_cast<std::uint8_t>(device::Sound::off);
  restart_ = true;
}

void SensorRole::run_button_timers(device::Instant now) {
  if (state_.timers.take_if_due(SensorTimer::button_hold, now) && state_.button_down) {
    io_.led(device::Blink::short_once);
    if (now - state_.button_pressed_at < kResetHold) {
      state_.timers.arm(SensorTimer::button_hold, state_.button_pressed_at + kResetHold);
    }
  }
  if (state_.timers.take_if_due(SensorTimer::pairing_end, now)) {
    state_.pairing = false;
    io_.led(device::Blink::off);
  }
}

}  // namespace hsn::roles::sensor
