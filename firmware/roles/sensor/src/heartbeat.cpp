// Heartbeats (protocol sections 6 and 7; DS4, LR3, LR11, D72, D108) and the log entries that
// follow them over LoRa (section 6, D110). A heartbeat is routine traffic: it is skipped when
// the airtime budget runs low. Every Nth asks for a reply. After it the sensor sleeps until the
// reply moment and listens briefly; then, if the log holds a warning or worse, one log entries
// packet goes, and the entry leaves the buffer only when the hub's reply to it arrives.

#include "hsn/device/services/retry.hpp"
#include "hsn/protocol/units.hpp"
#include "hsn/roles/sensor/data_rates.hpp"
#include "hsn/roles/sensor/sensor_role.hpp"

namespace hsn::roles::sensor {

device::Duration SensorRole::corrected(device::Duration nominal) const {
  return device::corrected(
      nominal, protocol::ppm_from_clock_correction(state_.settings.clock_correction_ten_ppm));
}

device::Duration SensorRole::interval() const {
  return corrected(heartbeat_interval(state_.settings.heartbeat_interval_units, state_.send_rate));
}

void SensorRole::plan_unslotted(device::Instant base) {
  // No slot, or several replies lost: the interval ±10% at random (§7, heartbeat slots).
  const device::Instant next =
      base + device::jittered(interval(), kHeartbeatJitterPercent, services_.random);
  state_.heartbeat_planned = next;
  state_.timers.arm(SensorTimer::next_heartbeat, next);
}

void SensorRole::take_slot(device::Instant answered_end, std::uint16_t tenths) {
  // Counted from the end of the packet the reply answers, so no clocks need to agree (§7).
  const device::Instant next = answered_end + corrected(device::Duration{kTenth.us * tenths});
  state_.heartbeat_planned = next;
  state_.timers.arm(SensorTimer::next_heartbeat, next);
  state_.slotted = true;
}

void SensorRole::run_heartbeat_timers(device::Instant now) {
  if (state_.timers.take_if_due(SensorTimer::reply_moment, now)) {
    // The reply window opens 20 ms before the reply moment (§8).
    state_.heartbeat_window_end = now + reply_window(listen_rate());
  }
  if (!state_.timers.take_if_due(SensorTimer::next_heartbeat, now)) {
    return;
  }
  // The next one keeps the slot's rhythm, or the interval ±10% without one.
  const device::Instant planned = state_.heartbeat_planned;
  if (state_.slotted) {
    const device::Instant next = planned + interval();
    state_.heartbeat_planned = next > now ? next : now + interval();
    state_.timers.arm(SensorTimer::next_heartbeat, state_.heartbeat_planned);
  } else {
    plan_unslotted(planned + interval() > now ? planned : now);
  }
  // A report in flight already tells the hub everything a heartbeat would.
  if (state_.waiting != 0 || state_.reset != ResetPhase::none || port_busy() || window_open() ||
      state_.timers.armed(SensorTimer::reply_moment)) {
    return;
  }
  send_heartbeat(now);
}

void SensorRole::send_heartbeat(device::Instant now) {
  const std::uint8_t every = state_.settings.link_check_every == 0
                                 ? kDefaultLinkCheckEvery
                                 : state_.settings.link_check_every;
  state_.heartbeats_since_check = saturating_increment(state_.heartbeats_since_check);
  // Every Nth asks for a reply; every one does while the latest reply-wanted packet went
  // unanswered, so a sensor that lost touch is back within a heartbeat or two (§7).
  // So does every one while it holds the next settings of a move (§7, D115).
  const bool link_check =
      state_.heartbeats_since_check >= every || state_.misses > 0 || holds_next();
  protocol::Heartbeat heartbeat;
  static_cast<protocol::SensorStatus&>(heartbeat) = status(link_check, now, false, now);
  const device::Status sent =
      send_message(heartbeat, device::TxClass::routine, TryKind::heartbeat, now);
  if (sent == device::Status::deferred) {
    // Under a fifth of the hour's budget left: routine traffic is skipped (§2).
    services_.log.add(now, device::LogLevel::warning, sensor_log::routine_skipped,
                      "heartbeat skipped");
    return;
  }
  if (sent != device::Status::ok) {
    return;
  }
  if (link_check) {
    state_.heartbeats_since_check = 0;
  }
  state_.heartbeat_wants_reply = link_check;
  state_.log_due = false;
}

void SensorRole::heartbeat_window_closed(device::Instant now) {
  state_.heartbeat_window_end = device::Instant::never();
  if (state_.heartbeat_wants_reply) {
    note_miss(now);
  }
  state_.log_due = true;
}

void SensorRole::run_log(device::Instant now) {
  if (!state_.log_due) {
    return;
  }
  if (state_.waiting != 0 || state_.reset != ResetPhase::none || port_busy() || window_open() ||
      state_.timers.armed(SensorTimer::reply_moment)) {
    return;
  }
  state_.log_due = false;
  if (state_.misses > 0) {
    // The latest reply-wanted packet went unanswered: the entry waits for a reply, so the
    // airtime goes to the heartbeats that find the hub again (§6).
    return;
  }
  // One entry at warning or above, the oldest; lower ones stay (§6, D110).
  protocol::LogEntries entries;
  if (services_.log.prepare(now, entries, device::LogLevel::warning, 1) == 0) {
    return;
  }
  // Over the budget it is simply not sent: the entry stays and goes after a later heartbeat,
  // and a warning about it would only compete for the same airtime.
  static_cast<void>(send_message(entries, device::TxClass::routine, TryKind::log, now));
}

}  // namespace hsn::roles::sensor
