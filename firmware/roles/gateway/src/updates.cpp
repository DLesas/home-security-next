// Firmware updates and the key change, the gateway's part (m3-updates-design.md sections 2, 5, 6
// and 7). The core's UpdateService pulls the image on the gateway's connection; the gateway passes
// it the hub's offers, sends its queries and statuses bound to the session, refuses an offer while
// it is off mains, and keeps the radio's timing: while a transmit request waits in the queue for
// its moment or the radio, or the radio is receiving or sending, no flash is written (the service
// bounds that at 10 minutes and answers radioBusy; an offer with action 6 writes anyway), and an
// "install now" waits for the same quiet, so the restart cuts off no request in the queue. A new
// image is healthy once welcomed on its link, its settings opened and its continuous receive
// running without a fault. A Key change comes in place of the welcome; the key changes, and the
// gateway says hello again under the new key.

#include "hsn/roles/gateway/gateway_role.hpp"

namespace hsn::roles::gateway {
namespace {

/** True for an offer that would download or install: the ones a gateway off mains refuses. */
bool needs_mains(std::uint8_t action) {
  return action == protocol::UpdateAction::fetch ||
         action == protocol::UpdateAction::join_wifi_and_fetch ||
         action == protocol::UpdateAction::install_now ||
         action == protocol::UpdateAction::forced_fetch;
}

/** The update path of the connection's link. */
device::UpdatePath path_of(device::LinkKind link) {
  return link == device::LinkKind::usb ? device::UpdatePath::usb : device::UpdatePath::network;
}

/** Overwrites a key held on the stack, in a way the compiler keeps. */
void wipe(protocol::DeviceKey& key) {
  volatile std::uint8_t* bytes = key.data();
  for (std::size_t i = 0; i < key.size(); ++i) {
    bytes[i] = 0;
  }
}

}  // namespace

bool GatewayRole::radio_needs_quiet() const {
  // A sector erase can hold the processor for up to 400 ms ‡: a request waiting for its moment
  // would go late, a reception would end unseen, a transmission's end would be heard late.
  return !queue_.empty() || state_.radio.mode == RadioMode::receiving ||
         state_.radio.mode == RadioMode::transmitting;
}

void GatewayRole::on_offer(const protocol::UpdateOffer& offer, device::Instant now) {
  // A newer offer replaces an "install now" that was waiting.
  install_waiting_ = false;
  if (needs_mains(offer.action) && !services_.hal.power.external_power()) {
    // Gateways update on mains only (m3-updates-design.md section 4): the gateway says so itself.
    services_.log.add(now, device::LogLevel::warning, device::log_code::update_refused,
                      "update refused", protocol::UpdateReason::battery);
    refusal_pending_ = true;
    refusal_image_ = offer.image_id;
    return;
  }
  if (offer.action == protocol::UpdateAction::install_now && radio_needs_quiet()) {
    install_waiting_ = true;
    install_offer_ = offer;
    services_.log.add(now, device::LogLevel::info, gateway_log::install_waits, "install waits");
    return;
  }
  services_.update.offer(offer, path_of(state_.connection.link), now);
}

void GatewayRole::pump_update(device::Instant now) {
  if (!session_open()) {
    return;
  }
  // The refusal or a status, then the query the service may still want: two at most per event.
  for (std::size_t sent = 0; sent < 2; ++sent) {
    if (refusal_pending_) {
      protocol::UpdateStatus refused;
      refused.image_id = refusal_image_;
      refused.stage = protocol::UpdateStage::refused;
      refused.reason = protocol::UpdateReason::battery;
      if (!send_to_hub(refused, now)) {
        return;
      }
      refusal_pending_ = false;
      continue;
    }
    const device::UpdatePacket packet = services_.update.next_packet(now);
    bool went = false;
    if (packet.kind == device::UpdatePacketKind::query) {
      // A gateway reads no cell voltage: its battery byte is 0; mains is in the flags.
      went = send_to_hub(packet.query, now);
    } else if (packet.kind == device::UpdatePacketKind::status) {
      went = send_to_hub(packet.status, now);
    } else {
      return;
    }
    if (!went) {
      // send_to_hub logged why; the next event tries again.
      return;
    }
    services_.update.packet_sent(now);
  }
}

void GatewayRole::finish_update(device::Instant now) {
  const bool quiet = radio_needs_quiet();
  services_.update.hold_writes(quiet, now);
  if (install_waiting_ && !quiet) {
    install_waiting_ = false;
    services_.update.offer(install_offer_, path_of(state_.connection.link), now);
  }
  if (session_open() && state_.connection.settings_received && receive_healthy_ &&
      services_.update.on_trial()) {
    services_.update.healthy(now);
  }
}

void GatewayRole::on_key_change(protocol::ByteView body, bool probe, device::Instant now) {
  protocol::KeyChange change;
  const protocol::Error error = protocol::decode_body(body, change);
  if (error != protocol::Error::none) {
    services_.log.add(now, device::LogLevel::warning, gateway_log::unexpected_type,
                      "key change malformed", static_cast<std::int32_t>(error));
    return;
  }
  key_change_on_probe_ = probe;
  // The channel logs the outcome. When it fails before the key is in flash nothing changed: the
  // next hello under the old key draws the Key change again (§7).
  static_cast<void>(services_.channel.change_key(change.new_key, now));
  wipe(change.new_key);
}

void GatewayRole::report_again(device::Instant now) {
  // Step 4 of the key change (m3-updates-design.md section 7): a new hello, with a new random,
  // under the new key, on the link the Key change came by. A seal refused while the key's import
  // is pending is covered as any lost hello is: by the next USB hello, or the welcome's timeout
  // and the reconnect on Wi-Fi.
  ConnectionState& connection = state_.connection;
  if (key_change_on_probe_) {
    if (connection.probing) {
      send_usb_hello(connection.probe, now);
    }
    return;
  }
  if (connection.phase != ConnectionPhase::awaiting_welcome) {
    return;
  }
  if (connection.link == device::LinkKind::usb) {
    send_usb_hello(connection.session, now);
    return;
  }
  state_.timers.arm(GatewayTimer::welcome_timeout, now + kWelcomeTimeout);
  send_hello(device::LinkKind::network, connection.session, now);
}

}  // namespace hsn::roles::gateway
