// What the gateway tells the hub about itself (protocol sections 6 and 7; GW6, GW11, FW5, FW6,
// FW8, D82, D110): the settings it holds, Started once per start-up, a status at the settings'
// interval, interference as it starts and ends, and its log entries as they arise.

#include "hsn/device/services/airtime.hpp"
#include "hsn/device/services/radio_plan.hpp"
#include "hsn/roles/gateway/gateway_role.hpp"

namespace hsn::roles::gateway {

void GatewayRole::apply_settings(const protocol::GatewaySettings& message, device::Instant now) {
  HeldSettings next = HeldSettings::from(message);
  RadioState& radio = state_.radio;
  bool listen_now = false;
  // A channel or data rate this version does not list leaves the current one (protocol
  // section 3, enumerated values).
  if (device::site_channel_frequency(next.site_channel).has_value()) {
    if (next.site_channel != radio.site_channel) {
      radio.site_channel = next.site_channel;
      NoiseMonitor(state_.noise).reset();
      listen_now = true;
    }
  } else {
    services_.log.add(now, device::LogLevel::warning, gateway_log::unknown_channel,
                      "unknown channel", next.site_channel);
    next.site_channel = state_.settings.site_channel;
  }
  const auto rate = listen_data_rate(next.listen_data_rate_mask);
  if (rate.has_value()) {
    if (names_several_data_rates(next.listen_data_rate_mask)) {
      // One radio hears one data rate (O14, spike S7): the slowest named is heard, the rest not.
      services_.log.add(now, device::LogLevel::warning, gateway_log::several_data_rates,
                        "several data rates", next.listen_data_rate_mask);
    }
    if (*rate != radio.data_rate) {
      radio.data_rate = *rate;
      listen_now = true;
    }
  } else {
    services_.log.add(now, device::LogLevel::warning, gateway_log::unknown_data_rate,
                      "unknown data rate", next.listen_data_rate_mask);
    next.listen_data_rate_mask = state_.settings.listen_data_rate_mask;
  }
  // A zero interval, level or duration is not valid: the value held stays (protocol section 6).
  // One warning names them all, a bit each, since the log merges repeats of one code.
  constexpr std::int32_t kZeroInterval = 1;
  constexpr std::int32_t kZeroThreshold = 2;
  constexpr std::int32_t kZeroDuration = 4;
  std::int32_t zeros = 0;
  if (next.status_interval_seconds == 0) {
    zeros |= kZeroInterval;
    next.status_interval_seconds = state_.settings.status_interval_seconds;
  }
  if (next.interference_threshold_db == 0) {
    zeros |= kZeroThreshold;
    next.interference_threshold_db = state_.settings.interference_threshold_db;
  }
  if (next.interference_seconds == 0) {
    zeros |= kZeroDuration;
    next.interference_seconds = state_.settings.interference_seconds;
  }
  if (zeros != 0) {
    services_.log.add(now, device::LogLevel::warning, gateway_log::zero_setting, "zero setting",
                      zeros);
  }
  const device::Duration old_interval = status_interval(state_.settings);
  state_.settings = next;
  if (status_interval(next) != old_interval && session_open()) {
    state_.timers.arm(GatewayTimer::status, now + status_interval(next));
  }
  // Stored only when they change (design section 5).
  const device::HalError stored = stored_settings_.update(next);
  if (stored != device::HalError::none) {
    services_.log.add(now, device::LogLevel::error, gateway_log::settings_store_failed,
                      "settings not stored", static_cast<std::int32_t>(stored));
  }
  if (listen_now) {
    if (radio.mode == RadioMode::listening || radio.mode == RadioMode::off) {
      listen(now);
    } else if (radio.mode == RadioMode::receiving) {
      // Never cut a reception off (protocol section 7); a transmission's end listens anew anyway.
      radio.listen_again = true;
    }
  }
  ConnectionState& connection = state_.connection;
  if (!connection.settings_received) {
    // Hello, welcome, settings, then Started (design section 7).
    connection.settings_received = true;
    if (!connection.started_sent) {
      send_started(now);
    }
  }
}

void GatewayRole::send_started(device::Instant now) {
  const protocol::Started started =
      services_.health.started(protocol::Role::gateway, state_.settings.version);
  if (!send_to_hub(started, now)) {
    return;
  }
  state_.connection.started_sent = true;
  // The fatal error it carried has been reported (FW5).
  const device::HalError cleared = services_.health.reported();
  if (cleared != device::HalError::none) {
    services_.log.add(now, device::LogLevel::warning, gateway_log::health_clear_failed,
                      "fatal not cleared", static_cast<std::int32_t>(cleared));
  }
}

void GatewayRole::send_status(device::Instant now) {
  if (!session_open()) {
    return;
  }
  state_.timers.arm(GatewayTimer::status, now + status_interval(state_.settings));
  NoiseMonitor noise(state_.noise);
  protocol::GatewayStatus status;
  status.settings_version = state_.settings.version;
  status.uptime_seconds = services_.uptime_seconds(now);
  status.airtime_hundredths_percent =
      services_.airtime.used_hundredths_of_percent(device::Band::g3, now);
  status.noise_median_dbm = noise.median();
  status.noise_highest_dbm = noise.highest();
  status.normal_noise_dbm = noise.normal();
  status.packets_received = state_.packets.received;
  status.packets_crc_failed = state_.packets.crc_failed;
  // The network link's signal on Wi-Fi; 0 on USB (protocol section 6).
  device::Link* network = link(device::LinkKind::network);
  status.wifi_rssi_dbm = state_.connection.link == device::LinkKind::network && network != nullptr
                             ? network->signal_dbm()
                             : std::int8_t{0};
  status.flags.usb_connected = state_.connection.link == device::LinkKind::usb;
  status.flags.cell_fitted = io_.cell_fitted();
  status.flags.on_mains = services_.hal.power.external_power();
  if (send_to_hub(status, now)) {
    // "Since the last status": the counts start again only once one has gone.
    state_.packets = PacketCounts{};
    noise.start_period();
  }
}

void GatewayRole::send_interference(const InterferenceReport& report, device::Instant now) {
  const bool started = report.change == InterferenceChange::started;
  // Logged as well, so an episode is recorded even while the hub cannot be reached (D110).
  services_.log.add(now, started ? device::LogLevel::warning : device::LogLevel::info,
                    gateway_log::interference, started ? "interference" : "interference ended",
                    report.noise_dbm);
  if (!session_open()) {
    return;
  }
  protocol::Interference message;
  message.event =
      started ? protocol::InterferenceEvent::started : protocol::InterferenceEvent::ended;
  message.noise_dbm = report.noise_dbm;
  message.duration_seconds = report.duration_seconds;
  static_cast<void>(send_to_hub(message, now));
}

void GatewayRole::flush_log(device::Instant now) {
  // Over USB and Wi-Fi entries go as they arise and leave once the link takes them (protocol
  // section 6, D110). A failure here is not logged: the entries stay, and that is the record.
  if (!session_open() || services_.log.size() == 0) {
    return;
  }
  protocol::LogEntries entries;
  if (services_.log.prepare(now, entries) == 0) {
    return;
  }
  if (seal_and_send(entries, state_.connection.session.binding(), state_.connection.link).outcome ==
      SendOutcome::sent) {
    services_.log.release();
  }
}

}  // namespace hsn::roles::gateway
