// Wi-Fi (§7, §10): one WebSocket to the paired hub, which the platform pings and reports `down`
// on by itself when the hub stops answering. The role connects with the pairing's link target and
// reconnects on the back-off of §7; Started goes once per start-up when the link first comes up,
// and log entries go to the hub as they arise while it is up (D110).

#include <limits>

#include "hsn/device/services/retry.hpp"
#include "hsn/roles/siren/siren_constants.hpp"
#include "hsn/roles/siren/siren_log_codes.hpp"
#include "hsn/roles/siren/siren_role.hpp"

namespace hsn::roles::siren {

void SirenRole::on_link(const device::LinkEvent& link, device::Instant now) {
  if (link.link != device::LinkKind::network) {
    if (link.kind == device::LinkEventKind::packet) {
      // Device answers setup messages itself; anything else on USB is not for a siren.
      services_.log.add(now, device::LogLevel::debug, siren_log::usb_packet_ignored,
                        "usb packet ignored");
    }
    return;
  }
  switch (link.kind) {
    case device::LinkEventKind::up:
      on_wifi_up(now);
      break;
    case device::LinkEventKind::down:
      if (state_.wifi_path == WifiPath::up) {
        services_.log.add(now, device::LogLevel::warning, siren_log::wifi_down, "wifi down");
        // The reports since the hub last answered a ping went nowhere: report on LoRa at once.
        state_.lora.change = true;
      } else {
        services_.log.add(now, connect_failure_level(), siren_log::wifi_connect_failed,
                          "wifi connect failed", 0);
      }
      on_wifi_failed(now);
      break;
    case device::LinkEventKind::packet:
      // A packet that passes its tag is acted on whatever the path's state; its answer falls
      // back to LoRa when the link will not take it.
      on_hub_packet(link.packet, Path::wifi, now);
      break;
  }
}

device::LogLevel SirenRole::connect_failure_level() const {
  // The first failure of a run is news; the rest of the back-off only repeats it.
  return state_.reconnect_attempt == 0 ? device::LogLevel::warning : device::LogLevel::info;
}

void SirenRole::connect(device::Instant now) {
  device::Link* network = services_.hal.network;
  if (network == nullptr) {
    services_.log.add(now, device::LogLevel::error, siren_log::no_network_link, "no network link");
    return;
  }
  const device::HalError started = network->connect(services_.setup.pairing().link_target());
  if (started != device::HalError::none) {
    services_.log.add(now, connect_failure_level(), siren_log::wifi_connect_failed,
                      "wifi connect failed", static_cast<std::int32_t>(started));
    on_wifi_failed(now);
    return;
  }
  state_.wifi_path = WifiPath::connecting;
}

void SirenRole::on_wifi_failed(device::Instant now) {
  state_.wifi_path = WifiPath::down;
  if (state_.reconnect_attempt < std::numeric_limits<std::uint8_t>::max()) {
    state_.reconnect_attempt = static_cast<std::uint8_t>(state_.reconnect_attempt + 1);
  }
  const device::RetrySchedule schedule(kReconnectTable);
  const std::optional<device::Instant> next =
      schedule.after_failure(now, state_.reconnect_attempt, services_.random);
  state_.timers.arm(SirenTimer::reconnect, next.value_or(now + kReconnectSteadyGap));
}

void SirenRole::on_wifi_up(device::Instant now) {
  state_.wifi_path = WifiPath::up;
  state_.reconnect_attempt = 0;
  state_.timers.cancel(SirenTimer::reconnect);
  if (state_.started_pending && state_.lora.in_flight != LoraItem::started) {
    if (!send_started_wifi(now)) {
      state_.lora.started = true;
    }
  }
  // The hub learns at once that the path is back. The regular reports keep their own random
  // phase (§7): re-arming them here would line up sirens whose links came up together.
  report(now, true);
}

bool SirenRole::send_started_wifi(device::Instant now) {
  if (services_.hal.network == nullptr || state_.wifi_path != WifiPath::up) {
    return false;
  }
  const device::HalError sent = send_sealed_wifi(
      services_.channel.seal(
          services_.health.started(protocol::Role::siren, state_.settings.settings_version),
          protocol::Binding::none(), protocol::PacketLimit::link,
          protocol::MutableByteView(link_packet_)),
      now);
  if (sent != device::HalError::none) {
    services_.log.add(now, device::LogLevel::warning, siren_log::wifi_report_failed,
                      "wifi started failed", static_cast<std::int32_t>(sent));
    return false;
  }
  started_sent(now);
  return true;
}

void SirenRole::started_sent(device::Instant now) {
  state_.started_pending = false;
  state_.lora.started = false;
  state_.timers.cancel(SirenTimer::started_lora);
  if (services_.health.reported() != device::HalError::none) {
    services_.log.add(now, device::LogLevel::error, siren_log::fatal_not_cleared,
                      "fatal not cleared");
  }
}

void SirenRole::flush_logs_wifi(device::Instant now) {
  device::Link* network = services_.hal.network;
  // A LoRa log entry in flight owns the buffer's only packet until it is sent.
  if (network == nullptr || state_.wifi_path != WifiPath::up || services_.log.size() == 0 ||
      state_.lora.in_flight == LoraItem::log) {
    return;
  }
  protocol::LogEntries entries;
  if (services_.log.prepare(now, entries) == 0) {
    return;
  }
  const device::Outcome<device::Sealed> sealed =
      services_.channel.seal(entries, protocol::Binding::none(), protocol::PacketLimit::link,
                             protocol::MutableByteView(link_packet_));
  // On a failure the entries stay and go with the next flush; logging it here would only add to
  // what cannot be sent.
  if (sealed.ok() && network->send(protocol::ByteView(link_packet_).first(sealed.value().size)) ==
                         device::HalError::none) {
    services_.log.release();
  }
}

}  // namespace hsn::roles::siren
