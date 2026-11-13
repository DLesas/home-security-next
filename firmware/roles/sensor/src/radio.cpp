// Sending through the core's RadioPort and listening for the hub (protocol sections 2, 7, 8;
// LR7, LR10). A sensor sends on the site channel and listens on 869.525 MHz. Three listening
// windows can be open: after a report try, around the heartbeat reply moment, and after a log
// entries packet; while the hub's countdown runs the radio listens continuously (D24). Otherwise
// the radio sleeps.

#include "hsn/device/services/radio_plan.hpp"
#include "hsn/roles/sensor/data_rates.hpp"
#include "hsn/roles/sensor/sensor_role.hpp"

namespace hsn::roles::sensor {

bool SensorRole::port_busy() const {
  const device::PortState port = services_.radio_port.state();
  return port == device::PortState::checking || port == device::PortState::backing_off ||
         port == device::PortState::sending;
}

bool SensorRole::timed_receive() const {
  return services_.radio_port.state() == device::PortState::receiving && !rx_continuous_;
}

bool SensorRole::radio_held() const {
  // A timed receive ends only by the port's word (received, rx_error, rx_timeout, recovered):
  // with stop on preamble a packet that started in the window is received past its end. A packet
  // whose header has come is received whole, a continuous receive's too.
  return timed_receive() || rx_arriving_;
}

bool SensorRole::window_open() const {
  return !state_.report_window_end.is_never() || !state_.heartbeat_window_end.is_never() ||
         !state_.log_window_end.is_never();
}

bool SensorRole::holds_next() const {
  return state_.settings.next_site_channel != protocol::kStaysAsItIs ||
         state_.settings.next_send_data_rate != protocol::kStaysAsItIs;
}

std::uint8_t SensorRole::send_rate_in_use() const {
  return state_.use_next && state_.settings.next_send_data_rate != protocol::kStaysAsItIs
             ? state_.settings.next_send_data_rate
             : state_.send_rate;
}

bool SensorRole::at_send_rate() const {
  // With no settings version held there is no reply rate either (§2); a packet on the next
  // settings of a move is answered at the rate it went at (§7).
  return state_.settings_version == 0 || state_.listen_at_send_rate || state_.use_next;
}

std::uint8_t SensorRole::listen_rate() const {
  return at_send_rate() ? send_rate_in_use() : state_.settings.reply_data_rate;
}

std::optional<device::RadioChannel> SensorRole::site_channel() const {
  const std::uint8_t channel =
      state_.use_next && state_.settings.next_site_channel != protocol::kStaysAsItIs
          ? state_.settings.next_site_channel
          : state_.settings.site_channel;
  const auto frequency = device::site_channel_frequency(channel);
  if (!frequency.has_value()) {
    return std::nullopt;
  }
  return device::RadioChannel{*frequency, send_rate_in_use()};
}

device::Status SensorRole::start_send(const device::Sealed& sealed,
                                      const device::Transmission& transmission, TryKind kind,
                                      device::Instant now) {
  const device::Status sent =
      services_.radio_port.send(protocol::ByteView(packet_).first(sealed.size), transmission, now);
  if (sent != device::Status::ok) {
    services_.log.add(now, device::LogLevel::warning, sensor_log::radio_failed, "send refused",
                      static_cast<std::int32_t>(sent));
    return sent;
  }
  radio_asleep_ = false;
  state_.tx_kind = kind;
  state_.last_counter = sealed.counter;
  if (kind == TryKind::heartbeat || kind == TryKind::log) {
    // Only the latest heartbeat and log packet can still be answered.
    state_.tries.remove(kind);
  }
  state_.tries.add(sealed.counter, kind, state_.use_next);
  const bool carries_flags = kind != TryKind::started && kind != TryKind::log;
  if (carries_flags && state_.local_alarm_sounded && state_.alarm_flag_counter == 0) {
    // Flag bit 5 is cleared by a reply to this packet or a later one (§6).
    state_.alarm_flag_counter = sealed.counter;
  }
  return device::Status::ok;
}

void SensorRole::on_radio(const device::RadioEvent& radio, device::Instant now) {
  const device::PortReport report = services_.radio_port.on_radio(radio, now);
  if (radio.kind == device::RadioEventKind::header_seen) {
    const device::PortState port = services_.radio_port.state();
    rx_arriving_ = port == device::PortState::receiving || port == device::PortState::backing_off;
  }
  on_port_report(report, &radio, now);
}

void SensorRole::on_port_report(const device::PortReport& report, const device::RadioEvent* radio,
                                device::Instant now) {
  if (report.result == device::PortResult::received ||
      report.result == device::PortResult::rx_error ||
      report.result == device::PortResult::rx_timeout ||
      report.result == device::PortResult::recovered) {
    // The port says the receive, or the packet in it, is over.
    rx_arriving_ = false;
  }
  switch (report.result) {
    case device::PortResult::sent:
      on_sent(report.at, now);
      break;
    case device::PortResult::received:
      if (radio != nullptr) {
        on_packet(radio->packet, now);
      }
      break;
    case device::PortResult::not_sent:
      on_send_failed(now);
      break;
    case device::PortResult::recovered:
      // The port reset the radio and logged it. A send in progress is lost; a receive is
      // started again by keep_listening while its window lasts (the port is idle now).
      if (state_.tx_kind != TryKind::none) {
        on_send_failed(now);
      }
      break;
    case device::PortResult::rx_timeout:
    case device::PortResult::rx_error:
    case device::PortResult::none:
      break;
  }
}

void SensorRole::on_sent(device::Instant at, device::Instant now) {
  static_cast<void>(now);
  const TryKind kind = state_.tx_kind;
  state_.tx_kind = TryKind::none;
  state_.last_tx_end = at;
  switch (kind) {
    case TryKind::heartbeat:
      // Sleep until the reply moment, then listen briefly (§7, sensor heartbeat).
      state_.heartbeat_tx_end = at;
      state_.timers.arm(SensorTimer::reply_moment, at + corrected(kReplyMoment - kReplyEarly));
      break;
    case TryKind::log:
      state_.log_window_end = at + event_listen_time(send_rate_in_use());
      break;
    case TryKind::none:
    case TryKind::countdown:
    case TryKind::settled:
      break;
    default:
      // A report: listen at once, for the event listen time (§7, §8).
      state_.report_window_end = at + event_listen_time(send_rate_in_use());
      break;
  }
}

void SensorRole::on_send_failed(device::Instant now) {
  const TryKind kind = state_.tx_kind;
  state_.tx_kind = TryKind::none;
  services_.log.add(now, device::LogLevel::warning, sensor_log::radio_failed, "not sent");
  if (kind == TryKind::door || kind == TryKind::cover || kind == TryKind::started ||
      kind == TryKind::button || kind == TryKind::going_ahead) {
    state_.report_kind = kind;
    next_retry(now, now);
  }
}

void SensorRole::close_windows(device::Instant now) {
  if (timed_receive()) {
    // A window ends when the receive does: its end, or the port's guard, closes them.
    return;
  }
  if (!state_.report_window_end.is_never() && state_.report_window_end <= now) {
    report_window_closed(now);
  }
  if (restart_) {
    return;
  }
  if (!state_.heartbeat_window_end.is_never() && state_.heartbeat_window_end <= now) {
    heartbeat_window_closed(now);
  }
  if (!state_.log_window_end.is_never() && state_.log_window_end <= now) {
    // Unanswered: the entry stays and goes again after a later heartbeat (D110). The hub always
    // answers a log entries packet, so this is a miss like any reply-wanted packet's (§6, §7).
    state_.log_window_end = device::Instant::never();
    note_miss(now);
  }
}

void SensorRole::listen(device::Duration timeout, device::Instant now) {
  device::RxParams params;
  params.channel.frequency_hz = device::kReplyFrequencyHz;
  params.channel.data_rate = listen_rate();
  // A packet that starts by the window's end needs the confirmation symbols to be detected
  // (hardware notes section 3): the receive runs that much longer.
  params.timeout = timeout.us == 0
                       ? timeout
                       : timeout + device::Duration{symbol_time(params.channel.data_rate).us *
                                                    kPreambleConfirmSymbols};
  params.stop = device::RxStop::preamble;
  params.symbol_timeout = kPreambleConfirmSymbols;
  const device::Status listening = services_.radio_port.listen(params, now);
  if (listening != device::Status::ok) {
    services_.log.add(now, device::LogLevel::warning, sensor_log::radio_failed, "listen refused",
                      static_cast<std::int32_t>(listening));
    return;
  }
  radio_asleep_ = false;
  rx_continuous_ = timeout.us == 0;
}

void SensorRole::keep_listening(device::Instant now) {
  if (port_busy() || restart_ || radio_held()) {
    // Never cut a receive short: when it ends, this runs again and listens on if a window needs it.
    return;
  }
  const bool receiving = services_.radio_port.state() == device::PortState::receiving;
  if (state_.alert == Alert::hub_countdown) {
    // Buzzing for the hub's countdown: listen continuously for the disarmed notice (D24, LR7).
    if (!(receiving && rx_continuous_)) {
      listen(device::Duration{}, now);
    }
    return;
  }
  device::Instant until = now;
  const std::array<device::Instant, 3> ends{state_.report_window_end, state_.heartbeat_window_end,
                                            state_.log_window_end};
  for (const device::Instant end : ends) {
    if (!end.is_never() && end > until) {
      until = end;
    }
  }
  if (until > now) {
    // Not receiving on a timed receive here (that would be held): start one to the latest end.
    listen(until - now, now);
    return;
  }
  // Nothing to listen for: the radio sleeps whenever the sensor may (LR7).
  if (receiving || !radio_asleep_) {
    services_.radio_port.sleep(now);
    radio_asleep_ = true;
  }
}

}  // namespace hsn::roles::sensor
