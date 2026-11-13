// The report exchange (protocol section 7, "No reply from the hub"; DS3, DS9, DS12, LR3). One
// exchange carries every report not yet answered: door, cover, button, Started, and the factory
// reset's last word. A change goes at once; unanswered tries are retried about 2, 5 and 10 s
// after the newest change, then every 60 s, each with a random extra wait, never before the last
// try's listening ended, for up to 10 minutes. Every try carries the newest state and its age.

#include <limits>

#include "hsn/device/services/retry.hpp"
#include "hsn/protocol/units.hpp"
#include "hsn/roles/sensor/sensor_role.hpp"

namespace hsn::roles::sensor {
namespace {

/** The retry table of protocol section 7, from the core (design section 4, RetrySchedule). */
constexpr device::RetrySchedule kRetries{device::kSensorReportRetries};

/** Seconds that fit the event age field, two bytes (§6). */
constexpr std::int64_t kMaxAgeSeconds = std::numeric_limits<std::uint16_t>::max();

/** Microseconds in a second. */
constexpr std::int64_t kMicrosPerSecond = 1000000;

/** Returns the most important report among `bits`: the lowest bit (report_bit's order). */
std::uint8_t first_bit(std::uint8_t bits) {
  const auto all = static_cast<unsigned>(bits);
  return static_cast<std::uint8_t>(all & (~all + 1u));
}

/** The ring's kind for a report bit. */
TryKind kind_of_bit(std::uint8_t bit) {
  switch (bit) {
    case report_bit::going_ahead:
      return TryKind::going_ahead;
    case report_bit::door:
      return TryKind::door;
    case report_bit::cover:
      return TryKind::cover;
    case report_bit::started:
      return TryKind::started;
    default:
      return TryKind::button;
  }
}

/** The report bit of a ring kind, or 0 for a kind that is not a report. */
std::uint8_t bit_of_kind(TryKind kind) {
  switch (kind) {
    case TryKind::going_ahead:
      return report_bit::going_ahead;
    case TryKind::door:
      return report_bit::door;
    case TryKind::cover:
      return report_bit::cover;
    case TryKind::started:
      return report_bit::started;
    case TryKind::button:
      return report_bit::button;
    default:
      return 0;
  }
}

/** Whole seconds from `since` to `now`, limited to the age field. */
std::uint16_t age_seconds(device::Instant since, device::Instant now) {
  const device::Duration age = now - since;
  const std::int64_t whole = age.us <= 0 ? 0 : age.us / kMicrosPerSecond;
  return static_cast<std::uint16_t>(whole > kMaxAgeSeconds ? kMaxAgeSeconds : whole);
}

}  // namespace

void SensorRole::queue_report(std::uint8_t bits, device::Instant now) {
  state_.waiting = static_cast<std::uint8_t>(state_.waiting | bits);
  state_.unsent = static_cast<std::uint8_t>(state_.unsent | bits);
  // A new change: the retry run counts again from it (§7), and it goes as soon as the last
  // try's listening has ended.
  state_.origin = now;
  state_.attempt = 0;
  state_.timers.arm(SensorTimer::retry, now);
}

bool SensorRole::try_blocked() const {
  return port_busy() || !state_.report_window_end.is_never() || radio_held();
}

void SensorRole::run_tries(device::Instant now) {
  if (!state_.timers.due(SensorTimer::retry, now)) {
    return;
  }
  if (state_.waiting == 0) {
    state_.timers.cancel(SensorTimer::retry);
    return;
  }
  if (try_blocked()) {
    // Stays due; the radio event or the window's end that unblocks it runs it.
    return;
  }
  state_.timers.cancel(SensorTimer::retry);
  send_try(now);
}

protocol::SensorStatus SensorRole::status(bool reply_wanted, device::Instant event_at, bool has_age,
                                          device::Instant now) {
  // Read now, while the radio is not sending: a try never starts while it is (D109).
  const std::uint16_t millivolts = io_.battery_millivolts();
  check_battery(millivolts, now);
  protocol::SensorStatus status;
  status.settings_version = state_.settings_version;
  status.flags.door_open = state_.door_open;
  status.flags.cover_open = state_.cover_open;
  status.flags.usb_power = state_.external_power;
  status.flags.charging = io_.charging();
  status.flags.reply_wanted = reply_wanted;
  status.flags.local_alarm_sounded = state_.local_alarm_sounded;
  status.flags.buzzing = desired_sound() != device::Sound::off;
  status.flags.listening_at_send_rate = at_send_rate();
  status.battery_code = protocol::battery_code_from_millivolts(millivolts);
  status.temperature_celsius = io_.chip_temperature_c();
  status.door_change_count = state_.change_count;
  status.event_age_seconds = has_age ? age_seconds(event_at, now) : 0;
  return status;
}

void SensorRole::send_try(device::Instant now) {
  state_.gap_wait = false;
  const std::uint8_t pool = state_.unsent != 0 ? state_.unsent : state_.waiting;
  const std::uint8_t bit = first_bit(pool);
  const TryKind kind = kind_of_bit(bit);
  device::Status sent = device::Status::ok;
  if (bit == report_bit::started) {
    sent = send_message(services_.health.started(protocol::Role::sensor, state_.settings_version),
                        device::TxClass::essential, kind, now);
  } else if (bit == report_bit::door) {
    protocol::DoorChanged report;
    static_cast<protocol::SensorStatus&>(report) = status(true, state_.door_changed_at, true, now);
    sent = send_message(report, device::TxClass::essential, kind, now);
  } else if (bit == report_bit::cover) {
    protocol::CoverChanged report;
    static_cast<protocol::SensorStatus&>(report) = status(true, state_.cover_changed_at, true, now);
    sent = send_message(report, device::TxClass::essential, kind, now);
  } else {
    protocol::Button report;
    static_cast<protocol::SensorStatus&>(report) = status(true, state_.button_event_at, true, now);
    report.button_action = bit == report_bit::going_ahead
                               ? protocol::ButtonAction::factory_reset_going_ahead
                               : state_.button_action;
    sent = send_message(report, device::TxClass::essential, kind, now);
  }
  if (sent == device::Status::ok) {
    state_.unsent = static_cast<std::uint8_t>(state_.unsent & ~bit);
    state_.report_kind = kind;
    return;
  }
  if (sent == device::Status::deferred && !deferred_until_.is_never()) {
    // Past the legal hour an urgent report waits only for the D111 gap, at most about 13 s at
    // SF12, and goes with the newest state and age; the port logs it as past the limit (§2).
    // It waits in light sleep, so it goes the moment the gap ends.
    state_.gap_wait = deferred_past_limit_;
    state_.timers.arm(SensorTimer::retry, deferred_until_);
    return;
  }
  // The try failed before it went: it counts, and the next one follows the schedule.
  next_retry(now, now);
}

void SensorRole::next_retry(device::Instant not_before, device::Instant now) {
  state_.attempt = saturating_increment(state_.attempt);
  const auto at = kRetries.retry_time(state_.origin, state_.attempt, not_before, services_.random);
  if (at.has_value()) {
    state_.timers.arm(SensorTimer::retry, *at);
  } else {
    give_up(now);
  }
}

void SensorRole::give_up(device::Instant now) {
  services_.log.add(now, device::LogLevel::warning, sensor_log::report_given_up, "report given up",
                    state_.waiting);
  const bool going_ahead = (state_.waiting & report_bit::going_ahead) != 0;
  const bool reset_waits =
      state_.reset == ResetPhase::armed_wait && (state_.waiting & report_bit::button) != 0;
  state_.waiting = 0;
  state_.unsent = 0;
  state_.attempt = 0;
  state_.timers.cancel(SensorTimer::retry);
  state_.tries.remove_reports();
  if (going_ahead) {
    // Action 4 could not be sent through a whole run: the reset still goes ahead (PR4).
    erase_and_restart(now);
  } else if (reset_waits) {
    // Nothing answered the reset hold through the whole retry run (D89).
    begin_going_ahead(now);
  }
}

void SensorRole::report_window_closed(device::Instant now) {
  state_.report_window_end = device::Instant::never();
  if (state_.report_kind == TryKind::going_ahead) {
    // Its one listen window is over, answered or not (D89).
    erase_and_restart(now);
    return;
  }
  // Every report wants a reply, and the hub always answers Started (§6).
  note_miss(now);
  if (state_.report_kind == TryKind::door && state_.opening == Opening::unanswered &&
      state_.armed && state_.alert == Alert::none) {
    // The first unanswered try of an armed opening (§7, DS6).
    state_.opening = Opening::alarmed;
    start_local_alarm(now);
  }
  if (state_.waiting == 0) {
    return;
  }
  if (state_.unsent != 0) {
    state_.timers.arm(SensorTimer::retry, now);
  } else {
    next_retry(now, now);
  }
}

void SensorRole::report_answered(TryKind kind, device::Instant now) {
  state_.report_window_end = device::Instant::never();
  if (kind == TryKind::going_ahead) {
    erase_and_restart(now);
    return;
  }
  if (kind == TryKind::door && state_.opening == Opening::unanswered) {
    state_.opening = Opening::none;
  }
  if (kind == TryKind::started && services_.health.reported() != device::HalError::none) {
    services_.log.add(now, device::LogLevel::error, sensor_log::fatal_not_cleared,
                      "fatal code not cleared");
  }
  const std::uint8_t bit = bit_of_kind(kind);
  if ((state_.unsent & bit) == 0) {
    state_.waiting = static_cast<std::uint8_t>(state_.waiting & ~bit);
  }
  if (state_.waiting == 0) {
    // No retry is armed while a try is listened for, so none needs cancelling.
    state_.attempt = 0;
    state_.tries.remove_reports();
    return;
  }
  // The hub is reachable: what still waits goes at once, with a fresh run.
  state_.unsent = state_.waiting;
  state_.origin = now;
  state_.attempt = 0;
  state_.timers.arm(SensorTimer::retry, now);
}

}  // namespace hsn::roles::sensor
