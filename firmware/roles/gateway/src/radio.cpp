// The gateway's radio (protocol sections 2, 6 and 7; GW1, GW3, GW11): continuous receive on the
// site channel at one data rate, every good packet of at least 18 bytes forwarded to the hub with
// how it was heard, a guard on every reception and transmission, and the noise sampled while
// listening.

#include <limits>

#include "hsn/device/services/radio_plan.hpp"
#include "hsn/device/services/radio_port.hpp"
#include "hsn/protocol/layout.hpp"
#include "hsn/roles/gateway/gateway_clock.hpp"
#include "hsn/roles/gateway/gateway_role.hpp"

namespace hsn::roles::gateway {
namespace {

/** Adds one to a status count, which stops at its largest value. */
void count(std::uint16_t& counter) {
  if (counter < std::numeric_limits<std::uint16_t>::max()) {
    counter += 1;
  }
}

}  // namespace

void GatewayRole::listen(device::Instant now) {
  RadioState& radio = state_.radio;
  radio.listen_again = false;
  const auto frequency = device::site_channel_frequency(radio.site_channel);
  if (!frequency.has_value()) {
    services_.log.add(now, device::LogLevel::error, gateway_log::unknown_channel, "no channel",
                      radio.site_channel);
    radio.mode = RadioMode::off;
    return;
  }
  device::RxParams params;
  params.channel.frequency_hz = *frequency;
  params.channel.data_rate = radio.data_rate;
  params.timeout = device::Duration{};  // continuous (GW1)
  params.stop = device::RxStop::header;
  device::HalError error = services_.hal.radio.receive(params);
  if (error != device::HalError::none) {
    services_.log.add(now, device::LogLevel::error, gateway_log::radio_call_failed,
                      "receive failed", static_cast<std::int32_t>(error));
    if (services_.hal.radio.recover() == device::HalError::none) {
      error = services_.hal.radio.receive(params);
    }
  }
  if (error != device::HalError::none) {
    // Try again shortly; the radio_guard timer does it.
    radio.mode = RadioMode::off;
    state_.timers.arm(GatewayTimer::radio_guard, now + kRadioRetryInterval);
    return;
  }
  radio.mode = RadioMode::listening;
  state_.timers.cancel(GatewayTimer::radio_guard);
}

void GatewayRole::recover_radio(device::Instant now, std::uint16_t code, std::int32_t value) {
  services_.log.add(now, device::LogLevel::error, code, "radio reset", value);
  if (state_.radio.mode == RadioMode::transmitting) {
    transmission_done(now, protocol::TransmitOutcome::radio_busy);
  }
  const device::HalError error = services_.hal.radio.recover();
  if (error != device::HalError::none) {
    services_.log.add(now, device::LogLevel::error, gateway_log::radio_call_failed,
                      "recover failed", static_cast<std::int32_t>(error));
  }
  listen(now);
}

void GatewayRole::radio_guard_passed(device::Instant now) {
  switch (state_.radio.mode) {
    case RadioMode::off:
      listen(now);
      break;
    case RadioMode::receiving:
    case RadioMode::transmitting:
      // The event that ends it never came (design section 4, radio guard).
      recover_radio(now, gateway_log::radio_guard, static_cast<std::int32_t>(state_.radio.mode));
      break;
    case RadioMode::listening:
      break;
  }
}

void GatewayRole::on_radio(const device::RadioEvent& event, device::Instant now) {
  RadioState& radio = state_.radio;
  switch (event.kind) {
    case device::RadioEventKind::header_seen:
      if (radio.mode == RadioMode::listening) {
        // Receiving comes first: nothing is sent until this reception ends (protocol section 7).
        radio.mode = RadioMode::receiving;
        const auto longest = device::time_on_air(radio.data_rate, kLongestRadioPacket);
        state_.timers.arm(GatewayTimer::radio_guard,
                          now + longest.value_or(device::Duration{}) + device::kRadioGuardMargin);
      }
      break;
    case device::RadioEventKind::rx_done:
      if (radio.mode == RadioMode::listening || radio.mode == RadioMode::receiving) {
        count(state_.packets.received);
        if (event.packet.size() >= protocol::kMinCarriedPacketSize) {
          forward(event, now);
        }
        reception_ended(now);
      }
      break;
    case device::RadioEventKind::rx_crc_error:
      if (radio.mode == RadioMode::listening || radio.mode == RadioMode::receiving) {
        count(state_.packets.crc_failed);
        reception_ended(now);
      }
      break;
    case device::RadioEventKind::rx_timeout:
      // A continuous receive does not time out; if the radio says so, listen again.
      if (radio.mode != RadioMode::transmitting) {
        listen(now);
      }
      break;
    case device::RadioEventKind::tx_done:
      if (radio.mode == RadioMode::transmitting) {
        transmission_done(now, protocol::TransmitOutcome::sent);
        // Straight back to listening after every transmission (protocol section 7).
        listen(now);
      }
      break;
    case device::RadioEventKind::fault:
      recover_radio(now, gateway_log::radio_fault, static_cast<std::int32_t>(radio.mode));
      break;
    case device::RadioEventKind::cad_done:
      // The gateway does no channel activity detection (protocol section 2).
      break;
  }
}

void GatewayRole::reception_ended(device::Instant now) {
  RadioState& radio = state_.radio;
  if (radio.mode == RadioMode::receiving) {
    radio.mode = RadioMode::listening;
    state_.timers.cancel(GatewayTimer::radio_guard);
  }
  if (radio.listen_again) {
    listen(now);
  }
}

void GatewayRole::forward(const device::RadioEvent& event, device::Instant now) {
  counts_.heard += 1;
  if (!session_open()) {
    forward_lost(now, ForwardLoss::not_connected, 0);
    return;
  }
  // The gateway cannot read the packet (D71); it adds how and when it heard it (protocol
  // section 6, forwarded packet).
  protocol::ForwardedPacket forwarded;
  forwarded.received_at_micros = clock_value(event.at);
  forwarded.rssi_dbm = event.rssi_dbm;
  forwarded.snr_quarter_db = event.snr_quarter_db;
  forwarded.data_rate = state_.radio.data_rate;
  forwarded.site_channel = state_.radio.site_channel;
  forwarded.packet.bytes = event.packet;
  const SendResult result =
      seal_and_send(forwarded, state_.connection.session.binding(), state_.connection.link);
  switch (result.outcome) {
    case SendOutcome::sent:
      break;
    case SendOutcome::not_connected:
      forward_lost(now, ForwardLoss::not_connected, result.detail);
      return;
    case SendOutcome::seal_failed:
      forward_lost(now, ForwardLoss::seal_failed, result.detail);
      return;
    case SendOutcome::link_busy:
      forward_lost(now, ForwardLoss::link_busy, result.detail);
      return;
    case SendOutcome::link_down:
      forward_lost(now, ForwardLoss::link_down, result.detail);
      return;
  }
  counts_.forwarded += 1;
}

void GatewayRole::forward_lost(device::Instant now, ForwardLoss cause, std::int32_t detail) {
  counts_.forwards_lost += 1;
  switch (cause) {
    case ForwardLoss::not_connected:
      services_.log.add(now, device::LogLevel::warning, gateway_log::forward_lost, "not connected",
                        detail);
      return;
    case ForwardLoss::seal_failed:
      services_.log.add(now, device::LogLevel::warning, gateway_log::forward_seal_failed,
                        "forward seal failed", detail);
      return;
    case ForwardLoss::link_busy:
      services_.log.add(now, device::LogLevel::warning, gateway_log::forward_link_busy,
                        "forward link busy", detail);
      return;
    case ForwardLoss::link_down:
      services_.log.add(now, device::LogLevel::warning, gateway_log::forward_link_down,
                        "forward link down", detail);
      return;
  }
}

void GatewayRole::sample_noise(device::Instant now) {
  if (state_.radio.mode != RadioMode::listening) {
    return;
  }
  const auto level = services_.hal.radio.noise_dbm();
  if (!level.ok()) {
    services_.log.add(now, device::LogLevel::warning, gateway_log::radio_call_failed,
                      "noise failed", static_cast<std::int32_t>(level.error()));
    return;
  }
  const InterferenceReport report =
      NoiseMonitor(state_.noise).sample(now, level.value(), interference_limits(state_.settings));
  if (report.change != InterferenceChange::none) {
    send_interference(report, now);
  }
}

}  // namespace hsn::roles::gateway
