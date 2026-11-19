// Start-up and wake (protocol section 6, Started; design section 5). A deep-sleep wake with the
// retained block intact carries on where the sensor left off; every other start is a start-up,
// which sends Started.

#include "hsn/roles/sensor/data_rates.hpp"
#include "hsn/roles/sensor/sensor_role.hpp"

namespace hsn::roles::sensor {

void SensorRole::on_boot(const device::BootInfo& boot, device::Instant now) {
  // A sensor keeps warnings and above (design section 4, LogBuffer).
  services_.log.set_min_level(device::LogLevel::warning);
  const bool start_up = device::is_start_up(boot);
  // Before a deep sleep the platform puts the radio to sleep; after any other start its state
  // is not known, so the first quiet moment puts it to sleep.
  radio_asleep_ = !start_up;
  if (boot.retained == device::RetainedStatus::none) {
    cold_start(now);
  } else {
    if (boot.retained == device::RetainedStatus::clock_reset) {
      rebase_clock(now);
    }
    state_.external_power = services_.hal.power.external_power();
    read_inputs_after_wake(boot.woke_by, now);
  }
  state_.awake_since = now;
  state_.awake_bound_from = now;
  if (start_up) {
    // Whatever was playing or sending stopped with the reset.
    state_.sound = kSoundUnknown;
    queue_report(report_bit::started, now);
    // A start-up while the update service holds part of an image is a (re)connection: its query
    // goes over LoRa, after Started (protocol section 6, update query). A deep-sleep wake is not.
    state_.update_query_due =
        services_.update.next_packet(now).kind == device::UpdatePacketKind::query;
  }
}

void SensorRole::cold_start(device::Instant now) {
  // No retained memory: no armed state and no settings version, so the sensor counts as
  // disarmed until a reply arrives (§6). The stored settings are the hub's last ones.
  state_ = kFreshState;
  ensure_settings_loaded(now);
  state_.settings = settings_record_.get();
  if (!settings_record_.stored()) {
    // The pairing gives the site's channel and rates only until settings are stored (§7, §9).
    state_.settings.site_channel = services_.setup.pairing().site_channel;
    state_.settings.allowed_rate_mask = services_.setup.pairing().allowed_data_rate_mask;
  }
  const std::uint8_t mask = state_.settings.allowed_rate_mask;
  state_.send_rate = is_allowed_rate(state_.settings.send_data_rate, mask)
                         ? state_.settings.send_data_rate
                         : fastest_allowed_rate(mask);
  state_.external_power = services_.hal.power.external_power();
  // The levels as found: not changes, since nothing says what they were before.
  state_.door_open = io_.door_open();
  state_.cover_open = io_.cover_open();
  state_.button_down = io_.button_pressed();
  state_.button_pressed_at = now;
  state_.door_changed_at = now;
  state_.cover_changed_at = now;
  state_.origin = now;
  plan_unslotted(now);
}

void SensorRole::rebase_clock(device::Instant now) {
  // Deadlines and event times from the old clock mean nothing (design section 5): every timer
  // starts again from now, waiting reports go again at once, and alerts that cannot be timed
  // any more stop. Armed state, settings, counters and the reports themselves are kept.
  state_.timers.cancel_all();
  state_.door_changed_at = now;
  state_.door_opened_at = now;
  state_.cover_changed_at = now;
  state_.button_event_at = now;
  state_.button_pressed_at = now;
  state_.origin = now;
  state_.last_tx_end = now;
  state_.chirped_at = device::Instant::never();
  state_.report_window_end = device::Instant::never();
  state_.heartbeat_window_end = device::Instant::never();
  state_.log_window_end = device::Instant::never();
  state_.alert = Alert::none;
  state_.tries.remove(TryKind::countdown);
  state_.pairing = false;
  state_.slotted = false;
  state_.attempt = 0;
  if (state_.waiting != 0) {
    state_.unsent = static_cast<std::uint8_t>(state_.unsent | state_.waiting);
    state_.timers.arm(SensorTimer::retry, now);
  }
  plan_unslotted(now);
}

void SensorRole::read_inputs_after_wake(device::WakeMask woke_by, device::Instant now) {
  // A wake input whose level is back where it was changed twice while the chip booted: both
  // changes count, and the newest state goes (hardware notes, checklist item 27).
  const bool door = io_.door_open();
  if (door != state_.door_open) {
    door_changed(now, now);
  } else if (woke_by.has(device::Input::door)) {
    door_changed(now, now);
    door_changed(now, now);
  }
  const bool cover = io_.cover_open();
  if (cover != state_.cover_open) {
    cover_changed(now, now);
  } else if (woke_by.has(device::Input::cover)) {
    cover_changed(now, now);
    cover_changed(now, now);
  }
  const bool button = io_.button_pressed();
  if (button && !state_.button_down) {
    button_pressed(now, now);
  } else if (!button && state_.button_down) {
    button_released(now, now);
  } else if (!button && woke_by.has(device::Input::button)) {
    // Pressed and released while the chip booted: a short press.
    button_pressed(now, now);
    button_released(now, now);
  }
}

}  // namespace hsn::roles::sensor
