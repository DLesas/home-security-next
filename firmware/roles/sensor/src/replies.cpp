// What the hub sends a sensor (protocol sections 4, 6, 7): replies and the disarmed notice, each
// accepted only when bound to one of the sensor's own recent counters, newest first, up to 16.
// A reply always carries the full settings; they are stored only when a stored field changes,
// and the armed state and settings version are kept in retained memory only.

#include "hsn/roles/sensor/data_rates.hpp"
#include "hsn/roles/sensor/sensor_role.hpp"

namespace hsn::roles::sensor {

void SensorRole::on_packet(protocol::ByteView packet, device::Instant now) {
  const std::size_t count = state_.tries.newest_first(candidates_);
  const auto opened = services_.channel.open_bound(
      packet, protocol::Span<const std::uint32_t>(candidates_.data(), count));
  if (!opened.ok()) {
    // Another device's packet is simply not for us; one for us that fails is recorded.
    if (opened.status() == device::Status::protocol_error) {
      services_.log.add(now, device::LogLevel::warning, sensor_log::hub_packet_rejected,
                        "hub packet rejected", static_cast<std::int32_t>(opened.detail()));
    }
    return;
  }
  const std::uint32_t answered = opened.value().answered;
  const TryKind kind = state_.tries.kind_of(answered);
  const std::uint8_t type = opened.value().packet.type;
  if (type == protocol::message_type::reply) {
    protocol::Reply reply;
    if (protocol::decode_body(opened.value().packet.body, reply) != protocol::Error::none) {
      services_.log.add(now, device::LogLevel::warning, sensor_log::hub_message_ignored,
                        "reply not decoded");
      return;
    }
    on_reply(reply, answered, kind, now);
  } else if (type == protocol::message_type::disarmed_notice) {
    on_disarmed(kind, now);
  } else {
    // A type the sensor does not act on is dropped and logged (§5).
    services_.log.add(now, device::LogLevel::warning, sensor_log::hub_message_ignored,
                      "hub type ignored", type);
  }
}

void SensorRole::on_reply(const protocol::Reply& reply, std::uint32_t answered, TryKind kind,
                          device::Instant now) {
  apply_settings(reply, now);
  if (reply.next_heartbeat_tenths != 0) {
    // Counted from the end of the packet this reply answers (§6): the latest heartbeat's or the
    // latest packet's, whose ends are kept; a reply to an older packet gives no slot.
    if (kind == TryKind::heartbeat) {
      take_slot(state_.heartbeat_tx_end, reply.next_heartbeat_tenths);
    } else if (answered == state_.last_counter) {
      take_slot(state_.last_tx_end, reply.next_heartbeat_tenths);
    }
  }
  if (state_.alarm_flag_counter != 0 && answered >= state_.alarm_flag_counter) {
    // The hub has seen flag bit 5 (§6).
    state_.local_alarm_sounded = false;
    state_.alarm_flag_counter = 0;
  }
  if (reply.flags.armed && reply.flags.countdown_started) {
    // The buzzer starts on the hub's word, whatever the sensor believed (DS12, D71). Before the
    // exchange ends, so the opening's tries stay candidates for the disarmed notice.
    start_hub_countdown(reply.countdown_remaining_seconds, now);
  }
  switch (kind) {
    case TryKind::heartbeat:
      state_.heartbeat_window_end = device::Instant::never();
      state_.timers.cancel(SensorTimer::reply_moment);
      state_.log_due = true;
      break;
    case TryKind::log:
      // Only now does the entry leave the buffer (D110).
      services_.log.release();
      state_.log_window_end = device::Instant::never();
      state_.tries.remove(TryKind::log);
      break;
    case TryKind::going_ahead:
    case TryKind::door:
    case TryKind::cover:
    case TryKind::started:
    case TryKind::button:
      report_answered(kind, now);
      break;
    case TryKind::countdown:
    case TryKind::settled:
    case TryKind::none:
      break;
  }
  if (restart_) {
    return;
  }
  if (reply.flags.armed) {
    // Anything that answers while a reset hold waits on an armed sensor refuses it (D89).
    if (state_.reset == ResetPhase::armed_wait) {
      services_.log.add(now, device::LogLevel::warning, sensor_log::factory_reset_refused,
                        "factory reset refused");
      state_.reset = ResetPhase::none;
    }
    return;
  }
  // "Not armed" ends the countdown and the local alarm (DS6, D88), and lets a reset that was
  // waiting on an armed sensor go ahead (D89).
  if (state_.alert != Alert::none) {
    stop_alerts();
  }
  if (state_.reset == ResetPhase::armed_wait) {
    begin_going_ahead(now);
  }
}

void SensorRole::ensure_settings_loaded(device::Instant now) {
  if (settings_loaded_) {
    return;
  }
  settings_loaded_ = true;
  const device::HalError loaded = settings_record_.load();
  if (loaded != device::HalError::none && loaded != device::HalError::not_found) {
    services_.log.add(now, device::LogLevel::error, sensor_log::settings_not_stored,
                      "settings unreadable", static_cast<std::int32_t>(loaded));
  }
}

void SensorRole::apply_settings(const protocol::Reply& reply, device::Instant now) {
  // A refused setting is recorded once per settings version, not on every reply carrying it.
  const bool new_version = reply.settings_version != state_.settings_version;
  state_.settings_version = reply.settings_version;
  state_.armed = reply.flags.armed;
  StoredSettings next = state_.settings;
  next.countdown_seconds = reply.countdown_seconds;
  next.heartbeat_interval_units = reply.heartbeat_interval_units;
  next.link_check_every = reply.link_check_every;
  next.clock_correction_ten_ppm = reply.clock_correction_ten_ppm;
  const std::uint8_t mask = services_.setup.pairing().allowed_data_rate_mask;
  // A rate the device does not know, or the pairing does not allow, keeps the current one (§3).
  if (is_allowed_rate(reply.send_data_rate, mask)) {
    next.send_data_rate = reply.send_data_rate;
    state_.send_rate = reply.send_data_rate;
  } else if (new_version) {
    services_.log.add(now, device::LogLevel::warning, sensor_log::setting_ignored,
                      "send rate ignored", reply.send_data_rate);
  }
  if (is_known_rate(reply.reply_data_rate)) {
    next.reply_data_rate = reply.reply_data_rate;
  } else if (new_version) {
    services_.log.add(now, device::LogLevel::warning, sensor_log::setting_ignored,
                      "reply rate ignored", reply.reply_data_rate);
  }
  state_.settings = next;
  ensure_settings_loaded(now);
  if (settings_record_.update(next) != device::HalError::none) {
    services_.log.add(now, device::LogLevel::error, sensor_log::settings_not_stored,
                      "settings not stored");
  }
  // A reply gives the reply rate again (§7, data rate).
  state_.misses = 0;
  state_.misses_at_rate = 0;
  state_.listen_at_send_rate = false;
}

void SensorRole::note_miss(device::Instant now) {
  state_.misses = saturating_increment(state_.misses);
  if (state_.misses >= kMissesBeforeOwnRate) {
    // Perhaps the faster reply was what failed: listen at the sending rate (§7).
    state_.listen_at_send_rate = true;
  }
  if (state_.misses >= kMissesBeforeUnslotted) {
    state_.slotted = false;
  }
  if (state_.misses <= kMissesBeforeOwnRate) {
    return;
  }
  // Every two further misses, one allowed rate slower; from the slowest allowed, back to the
  // fastest, so the sensor is never left on a rate nobody listens at (§7). Counted apart from
  // `misses`, which stops at 255, so the round goes on however long the outage lasts.
  state_.misses_at_rate = saturating_increment(state_.misses_at_rate);
  if (state_.misses_at_rate < kMissesPerSlowerStep) {
    return;
  }
  state_.misses_at_rate = 0;
  const std::uint8_t mask = services_.setup.pairing().allowed_data_rate_mask;
  const std::uint8_t next =
      slower_allowed_rate(state_.send_rate, mask).value_or(fastest_allowed_rate(mask));
  if (next != state_.send_rate) {
    state_.send_rate = next;
    services_.log.add(now, device::LogLevel::warning, sensor_log::rate_stepped, "rate stepped",
                      next);
  }
}

void SensorRole::on_disarmed(TryKind kind, device::Instant now) {
  static_cast<void>(now);
  if (kind == TryKind::settled) {
    // The hub's second copy: already acted on (§6).
    return;
  }
  // No longer armed until a reply says otherwise; the settings version stays, and the next
  // reply corrects both (§6). The buzzer stops, and so does the listening (D24, DS13). The
  // opening's counters stay, settled, so the second copy is recognised.
  state_.armed = false;
  state_.tries.retag(TryKind::countdown, TryKind::settled);
  if (state_.alert != Alert::none) {
    stop_alerts();
  }
}

}  // namespace hsn::roles::sensor
