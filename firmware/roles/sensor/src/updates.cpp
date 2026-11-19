// Firmware updates and the key change, the sensor's part (m3-updates-design.md sections 2, 5, 6
// and 7; protocol sections 6 and 7). The core's UpdateService does the update itself; the sensor
// opens the hub's offers under its own receiving rule and passes them on, sends the queries and
// statuses the service asks for, and refuses an offer itself while it is armed or its battery is
// low. Over LoRa an update packet is one more report of the exchange (report_bit::update): the hub
// always answers a sensor's, with an offer or a reply bound to it, so it is retried like a report
// and goes after any door, cover or button report. While the service holds the network link up for
// an update, its packets go there instead, and the hub answers on it. A Key change answers any of
// the sensor's packets; the key changes, and what the sensor was saying goes again under it.

#include "hsn/protocol/units.hpp"
#include "hsn/roles/sensor/sensor_role.hpp"

namespace hsn::roles::sensor {
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

/** Overwrites a key held on the stack, in a way the compiler keeps. */
void wipe(protocol::DeviceKey& key) {
  volatile std::uint8_t* bytes = key.data();
  for (std::size_t i = 0; i < key.size(); ++i) {
    bytes[i] = 0;
  }
}

}  // namespace

SensorRole::UpdateOut SensorRole::lora_update(device::Instant now) const {
  UpdateOut out;
  if (state_.refusal_pending) {
    out.refusal = true;
    out.packet.kind = device::UpdatePacketKind::status;
    return out;
  }
  const device::UpdatePacket packet = services_.update.next_packet(now);
  if (packet.kind == device::UpdatePacketKind::status && !packet.links_only) {
    // Progress never goes over LoRa (§6, update status).
    out.packet = packet;
  } else if (packet.kind == device::UpdatePacketKind::query && state_.update_query_due) {
    out.packet = packet;
  }
  return out;
}

void SensorRole::fill(UpdateOut& out, device::Instant now) {
  static_cast<void>(now);
  if (out.refusal) {
    out.packet.status = protocol::UpdateStatus{};
    out.packet.status.image_id = state_.refusal_image;
    out.packet.status.stage = protocol::UpdateStage::refused;
    out.packet.status.reason = state_.refusal_reason;
    return;
  }
  if (out.packet.kind == device::UpdatePacketKind::query) {
    // The role's part of a query: its battery, read while the radio does not send (D109).
    out.packet.query.battery_code =
        protocol::battery_code_from_millivolts(io_.battery_millivolts());
  }
}

void SensorRole::queue_update(device::Instant now) {
  const device::Link* network = services_.hal.network;
  if (network != nullptr && network->up()) {
    // The service joined it for an update (§10): update packets go there, and the report waiting
    // for LoRa, if any, is said there instead.
    state_.waiting = static_cast<std::uint8_t>(state_.waiting & ~report_bit::update);
    state_.unsent = static_cast<std::uint8_t>(state_.unsent & ~report_bit::update);
    send_update_on_link(now);
    return;
  }
  if (services_.update.next_packet(now).kind == device::UpdatePacketKind::none) {
    state_.update_query_due = false;
  }
  // Only into an empty exchange, so a waiting report keeps its retry run (§7), and never across a
  // heartbeat's reply moment or a listening window.
  if (state_.waiting != 0 || state_.reset != ResetPhase::none || port_busy() || window_open() ||
      state_.timers.armed(SensorTimer::reply_moment)) {
    return;
  }
  if (lora_update(now).packet.kind == device::UpdatePacketKind::none) {
    return;
  }
  queue_report(report_bit::update, now);
}

void SensorRole::send_update_on_link(device::Instant now) {
  device::Link* network = services_.hal.network;
  // A status, then the query the service may still want: two at most.
  for (std::size_t sent = 0; sent < 2; ++sent) {
    UpdateOut out;
    if (state_.refusal_pending) {
      out.refusal = true;
      out.packet.kind = device::UpdatePacketKind::status;
    } else {
      out.packet = services_.update.next_packet(now);
    }
    if (out.packet.kind == device::UpdatePacketKind::none) {
      return;
    }
    if (out.packet.kind == device::UpdatePacketKind::query &&
        services_.radio_port.state() == device::PortState::sending) {
      // The battery is not read while the radio sends (D109): after its tx_done.
      return;
    }
    fill(out, now);
    const auto sealed = out.packet.kind == device::UpdatePacketKind::query
                            ? services_.channel.seal(out.packet.query, protocol::Binding::none(),
                                                     protocol::PacketLimit::link,
                                                     protocol::MutableByteView(packet_))
                            : services_.channel.seal(out.packet.status, protocol::Binding::none(),
                                                     protocol::PacketLimit::link,
                                                     protocol::MutableByteView(packet_));
    if (!sealed.ok()) {
      // Tried again at the next event; a key import pending is the usual cause.
      services_.log.add(now, device::LogLevel::warning, sensor_log::seal_failed, "seal failed",
                        static_cast<std::int32_t>(sealed.status()));
      return;
    }
    // The hub answers on the link, bound to this packet: only the latest is kept.
    state_.tries.remove(TryKind::update_link);
    state_.tries.add(sealed.value().counter, TryKind::update_link);
    const device::HalError error =
        network->send(protocol::ByteView(packet_).first(sealed.value().size));
    if (error != device::HalError::none) {
      services_.log.add(now, device::LogLevel::warning, sensor_log::radio_failed,
                        "link send refused", static_cast<std::int32_t>(error));
      return;
    }
    if (out.refusal) {
      state_.refusal_pending = false;
    } else {
      if (out.packet.kind == device::UpdatePacketKind::query) {
        state_.update_query_due = false;
      }
      services_.update.packet_sent(now);
    }
  }
}

device::Status SensorRole::send_update_try(device::Instant now) {
  UpdateOut out = lora_update(now);
  fill(out, now);
  // Routine traffic (§2): it waits for the budget, a door report never waits for it.
  const device::Status sent =
      out.packet.kind == device::UpdatePacketKind::query
          ? send_message(out.packet.query, device::TxClass::routine, TryKind::update, now)
          : send_message(out.packet.status, device::TxClass::routine, TryKind::update, now);
  if (sent == device::Status::ok) {
    sent_update_ = out;
  }
  return sent;
}

void SensorRole::update_answered(device::Instant now) {
  const UpdateOut sent = sent_update_;
  sent_update_ = UpdateOut{};
  if (sent.refusal) {
    state_.refusal_pending = false;
    return;
  }
  if (sent.packet.kind == device::UpdatePacketKind::none) {
    return;
  }
  if (sent.packet.kind == device::UpdatePacketKind::query) {
    state_.update_query_due = false;
  }
  // Only what was sent is out: a newer status the service set meanwhile still goes.
  if (same_packet(services_.update.next_packet(now), sent.packet)) {
    services_.update.packet_sent(now);
  }
}

std::uint8_t SensorRole::own_refusal(const protocol::UpdateOffer& offer) {
  const std::uint8_t action = offer.action;
  if (action != protocol::UpdateAction::join_wifi_and_fetch &&
      action != protocol::UpdateAction::open_bluetooth &&
      action != protocol::UpdateAction::install_now) {
    // Discard, wait and a grant on the link the sensor joined go to the service: a download
    // under way goes on when the sensor is armed meanwhile (m3-updates-design.md section 4).
    return protocol::UpdateReason::none;
  }
  if (state_.armed) {
    // A sensor updates only while disarmed (D91, D135).
    return protocol::UpdateReason::armed;
  }
  if (!state_.external_power && io_.battery_millivolts() < kUpdateBatteryFloorMillivolts) {
    return protocol::UpdateReason::battery;
  }
  return protocol::UpdateReason::none;
}

void SensorRole::on_offer(const protocol::UpdateOffer& offer, TryKind kind, device::UpdatePath path,
                          device::Instant now) {
  if (kind == TryKind::update) {
    update_answered(now);
    report_answered(kind, now);
  }
  const std::uint8_t refusal = own_refusal(offer);
  if (refusal != protocol::UpdateReason::none) {
    services_.log.add(now, device::LogLevel::warning, device::log_code::update_refused,
                      "update refused", refusal);
    state_.refusal_pending = true;
    state_.refusal_reason = refusal;
    state_.refusal_image = offer.image_id;
  } else {
    services_.update.offer(offer, path, now);
  }
  // The service may want to tell the hub what it holds now.
  state_.update_query_due = true;
}

void SensorRole::on_key_change(protocol::ByteView body, device::Instant now) {
  protocol::KeyChange change;
  if (protocol::decode_body(body, change) != protocol::Error::none) {
    services_.log.add(now, device::LogLevel::warning, sensor_log::hub_message_ignored,
                      "key change not decoded");
    return;
  }
  // The channel logs the outcome. When it fails before the key is in flash nothing changed: the
  // window stays open, and the next packet under the old key draws the Key change again (§7).
  key_change_in_event_ = true;
  static_cast<void>(services_.channel.change_key(change.new_key, now));
  wipe(change.new_key);
}

void SensorRole::report_again(device::Instant now) {
  // Step 4 of the key change (m3-updates-design.md section 7). The hub answers nothing sealed
  // under the old key, and the counters start again at one step under the new one: every counter
  // a hub packet could still answer, and every window waiting for one, is gone.
  state_.tries = TryRing{};
  state_.alarm_flag_counter = 0;
  state_.report_window_end = device::Instant::never();
  state_.heartbeat_window_end = device::Instant::never();
  state_.log_window_end = device::Instant::never();
  state_.timers.cancel(SensorTimer::reply_moment);
  sent_update_ = UpdateOut{};
  if (timed_receive() && !rx_arriving_) {
    // The receive kept for those windows can only bring old-key answers, which the new key
    // cannot open: it ends now, so the report goes at once instead of after it.
    services_.radio_port.sleep(now);
    radio_asleep_ = true;
  }
  if (state_.waiting != 0) {
    // Its current report goes again at once, with the newest state; a door report's age still
    // counts from the opening (DS3, D106).
    state_.unsent = state_.waiting;
    state_.origin = now;
    state_.attempt = 0;
    state_.timers.arm(SensorTimer::retry, now);
    return;
  }
  // After a heartbeat (or the log entry after one): a heartbeat asking for a reply.
  state_.heartbeat_again_at = now;
}

void SensorRole::run_heartbeat_again(device::Instant now) {
  if (state_.heartbeat_again_at.is_never() || state_.heartbeat_again_at > now ||
      state_.waiting != 0 || state_.reset != ResetPhase::none || port_busy() || window_open() ||
      radio_held() || state_.timers.armed(SensorTimer::reply_moment)) {
    return;
  }
  const device::Status sent = send_heartbeat(now);
  if (sent == device::Status::ok) {
    state_.heartbeat_again_at = device::Instant::never();
  } else if (sent == device::Status::deferred && !deferred_until_.is_never()) {
    state_.heartbeat_again_at = deferred_until_;
  } else {
    // A seal refused while the new key's import is pending, or the radio refusing: soon again.
    state_.heartbeat_again_at = now + kHeartbeatAgainRetry;
  }
}

}  // namespace hsn::roles::sensor
