// Firmware updates and the key change, the siren's part (m3-updates-design.md sections 2, 5, 6
// and 7). Offers and Key changes arrive under the command rule on either path (§4). An offer goes
// to the core's UpdateService, which pulls the image on the siren's own Wi-Fi link, unless the
// siren is off mains (it refuses, "battery") or sounding: an "install now" waits for the output to
// stop, so the siren never restarts while it sounds. The service's queries and statuses go on
// Wi-Fi; a status that is not progress goes on LoRa when Wi-Fi is down. A new image is healthy
// once a command or settings packet from the hub opened on either path and one LoRa transmission
// completed. A Key change changes the key, and the answer, a report, goes under the new one.

#include "hsn/protocol/units.hpp"
#include "hsn/roles/siren/siren_log_codes.hpp"
#include "hsn/roles/siren/siren_role.hpp"

namespace hsn::roles::siren {
namespace {

/** The same update packet: its kind, and for a status every field (a query is always the same). */
bool same_packet(const device::UpdatePacket& a, const device::UpdatePacket& b) {
  if (a.kind != b.kind) {
    return false;
  }
  if (a.kind != device::UpdatePacketKind::status) {
    return true;
  }
  return a.status.image_id == b.status.image_id && a.status.stage == b.status.stage &&
         a.status.reason == b.status.reason && a.status.bytes_written == b.status.bytes_written;
}

/** True for an offer that would download or install: the ones a siren off mains refuses. */
bool needs_mains(std::uint8_t action) {
  return action == protocol::UpdateAction::fetch ||
         action == protocol::UpdateAction::join_wifi_and_fetch ||
         action == protocol::UpdateAction::install_now ||
         action == protocol::UpdateAction::forced_fetch;
}

/** Overwrites a key held on the stack, in a way the compiler keeps. */
void wipe(protocol::DeviceKey& key) {
  volatile std::uint8_t* bytes = key.data();
  for (std::size_t i = 0; i < key.size(); ++i) {
    bytes[i] = 0;
  }
}

}  // namespace

SirenRole::UpdateOut SirenRole::next_update(device::Instant now) const {
  UpdateOut out;
  if (refusal_pending_) {
    out.refusal = true;
    out.packet.kind = device::UpdatePacketKind::status;
    out.packet.status.image_id = refusal_image_;
    out.packet.status.stage = protocol::UpdateStage::refused;
    out.packet.status.reason = refusal_reason_;
    return out;
  }
  out.packet = services_.update.next_packet(now);
  if (out.packet.kind == device::UpdatePacketKind::query) {
    // The role's part of a query: a siren's cell, encoded as a sensor's battery (0 when none is
    // fitted), and mains (the service sets it from external power).
    out.packet.query.battery_code =
        io_.cell_fitted() ? protocol::battery_code_from_millivolts(io_.cell_millivolts()) : 0;
  }
  return out;
}

void SirenRole::on_offer(const protocol::UpdateOffer& offer, Path path, device::Instant now) {
  // A newer offer replaces an "install now" that was waiting.
  install_waiting_ = false;
  if (needs_mains(offer.action) && !services_.hal.power.external_power()) {
    // Sirens update on mains only (m3-updates-design.md section 4): the siren says so itself.
    services_.log.add(now, device::LogLevel::warning, device::log_code::update_refused,
                      "update refused", protocol::UpdateReason::battery);
    refusal_pending_ = true;
    refusal_reason_ = protocol::UpdateReason::battery;
    refusal_image_ = offer.image_id;
    return;
  }
  if (offer.action == protocol::UpdateAction::install_now &&
      state_.output_state != protocol::SirenState::off) {
    // It installs only when off (section 5): the go-ahead waits for the output to stop.
    install_waiting_ = true;
    install_offer_ = offer;
    install_path_ = path;
    services_.log.add(now, device::LogLevel::info, siren_log::install_waits, "install waits");
    return;
  }
  services_.update.offer(
      offer, path == Path::wifi ? device::UpdatePath::network : device::UpdatePath::radio, now);
}

void SirenRole::release_install(device::Instant now) {
  if (!install_waiting_ || state_.output_state != protocol::SirenState::off) {
    return;
  }
  install_waiting_ = false;
  services_.update.offer(
      install_offer_,
      install_path_ == Path::wifi ? device::UpdatePath::network : device::UpdatePath::radio, now);
}

device::Outcome<device::Sealed> SirenRole::seal_update(const UpdateOut& out,
                                                       protocol::PacketLimit limit,
                                                       protocol::MutableByteView buffer) {
  if (out.packet.kind == device::UpdatePacketKind::query) {
    return services_.channel.seal(out.packet.query, protocol::Binding::none(), limit, buffer);
  }
  return services_.channel.seal(out.packet.status, protocol::Binding::none(), limit, buffer);
}

void SirenRole::update_sent(const UpdateOut& out, device::Instant now) {
  if (out.refusal) {
    refusal_pending_ = false;
    return;
  }
  // Only what went is out: a newer status the service set meanwhile still goes.
  if (out.packet.kind != device::UpdatePacketKind::none &&
      same_packet(services_.update.next_packet(now), out.packet)) {
    services_.update.packet_sent(now);
  }
}

void SirenRole::pump_update(device::Instant now) {
  device::Link* network = services_.hal.network;
  // A status, then the query the service may still want: two at most per event.
  for (std::size_t sent = 0; sent < 2; ++sent) {
    const UpdateOut out = next_update(now);
    if (out.packet.kind == device::UpdatePacketKind::none) {
      return;
    }
    if (network == nullptr || state_.wifi_path != WifiPath::up) {
      // Never progress on LoRa, and no query: the hub offers a siren its updates on Wi-Fi.
      if (out.packet.kind == device::UpdatePacketKind::status &&
          (out.refusal || !out.packet.links_only) && state_.lora.in_flight != LoraItem::update) {
        state_.lora.update = true;
      }
      return;
    }
    const device::HalError error = send_sealed_wifi(
        seal_update(out, protocol::PacketLimit::link, protocol::MutableByteView(link_packet_)),
        now);
    if (error != device::HalError::none) {
      // Tried again at the next event; the link's own `down` sends a status to LoRa.
      services_.log.add(now, device::LogLevel::warning, siren_log::wifi_report_failed,
                        "wifi update failed", static_cast<std::int32_t>(error));
      return;
    }
    // Wi-Fi carried it: a copy waiting for LoRa is not needed.
    state_.lora.update = false;
    update_sent(out, now);
  }
}

void SirenRole::check_health(device::Instant now) {
  if (hub_packet_opened_ && lora_sent_ && services_.update.on_trial()) {
    services_.update.healthy(now);
  }
}

void SirenRole::on_key_change(protocol::ByteView body, Path path, device::Instant now) {
  protocol::KeyChange change;
  if (protocol::decode_body(body, change) != protocol::Error::none) {
    services_.log.add(now, device::LogLevel::error, siren_log::body_dropped, "body dropped",
                      protocol::message_type::key_change);
    return;
  }
  key_change_path_ = path;
  key_change_in_event_ = true;
  // The channel logs the outcome. When it fails before the key is in flash nothing changed, and
  // the siren's next report under the old key draws the Key change again (§7).
  static_cast<void>(services_.channel.change_key(change.new_key, now));
  wipe(change.new_key);
}

void SirenRole::report_again(device::Instant now) {
  // Step 4 of the key change (m3-updates-design.md section 7): a report answering it, under the
  // new key, on the path it came by (reason 1). A seal refused while the key's import is pending
  // falls back to LoRa, which tries again until it seals. Then what the event held back.
  answer(key_change_path_, now);
  pump_update(now);
  pump_lora(now);
  keep_listening(now);
  flush_logs_wifi(now);
}

}  // namespace hsn::roles::siren
