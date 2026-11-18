// The gateway role's entry points: start-up, the dispatch of events, the timers and the wake.

#include "hsn/roles/gateway/gateway_role.hpp"

#include "hsn/protocol/radio.hpp"

namespace hsn::roles::gateway {
namespace {

/** Bits of the breadcrumb's state byte that hold the radio mode; the phase sits above them. */
constexpr unsigned kPhaseShift = 4;

}  // namespace

GatewayRole::GatewayRole(device::Services& services, device::GatewayIo& io)
    : services_(services),
      io_(io),
      stored_settings_(services.hal.storage, kSettingsKey, kSettingsRecordVersion, HeldSettings{}) {
}

std::uint8_t GatewayRole::role_id() const {
  return protocol::Role::gateway;
}

void GatewayRole::boot(device::Instant now) {
  // Nothing retained is of value: every boot starts afresh with a new connection (design
  // section 7), whatever the retained block held.
  state_ = GatewayState{};
  static_cast<void>(queue_.clear());
  const device::HalError loaded = stored_settings_.load();
  if (loaded == device::HalError::none) {
    state_.settings = stored_settings_.get();
  } else {
    if (loaded != device::HalError::not_found) {
      services_.log.add(now, device::LogLevel::warning, gateway_log::settings_store_failed,
                        "settings unreadable", static_cast<std::int32_t>(loaded));
    }
    // Until the hub sends settings, listen as the pairing says (protocol section 9).
    const device::PairingRecord& pairing = services_.setup.pairing();
    state_.settings.site_channel = pairing.site_channel;
    state_.settings.listen_data_rate_mask = pairing.allowed_data_rate_mask;
  }
  state_.radio.site_channel = state_.settings.site_channel;
  state_.radio.data_rate =
      listen_data_rate(state_.settings.listen_data_rate_mask).value_or(protocol::DataRate::dr0);
  listen(now);
  state_.timers.arm(GatewayTimer::noise_sample, now + kNoiseSampleInterval);
  start_connection(now);
}

void GatewayRole::handle(const device::Event& event) {
  const device::Instant now = event.now;
  switch (event.kind) {
    case device::EventKind::boot:
      boot(now);
      break;
    case device::EventKind::link:
      on_link(event.link, now);
      break;
    case device::EventKind::radio:
      on_radio(event.radio, now);
      break;
    case device::EventKind::timer:
    case device::EventKind::input:
      break;
  }
  run_timers(now);
  serve_queue(now);
  flush_log(now);
}

void GatewayRole::run_timers(device::Instant now) {
  device::TimerSet<GatewayTimer, kGatewayTimerCount>& timers = state_.timers;
  if (timers.take_if_due(GatewayTimer::radio_guard, now)) {
    radio_guard_passed(now);
  }
  if (timers.take_if_due(GatewayTimer::noise_sample, now)) {
    sample_noise(now);
    timers.arm(GatewayTimer::noise_sample, now + kNoiseSampleInterval);
  }
  if (timers.take_if_due(GatewayTimer::welcome_timeout, now)) {
    if (link(device::LinkKind::network) != nullptr) {
      link(device::LinkKind::network)->disconnect();
    }
    connection_failed(now, gateway_log::welcome_timeout, 0);
  }
  if (timers.take_if_due(GatewayTimer::usb_hello, now)) {
    ConnectionState& connection = state_.connection;
    send_usb_hello(connection.probing ? connection.probe : connection.session, now);
  }
  if (timers.take_if_due(GatewayTimer::usb_window, now)) {
    usb_window_closed(now);
  }
  if (timers.take_if_due(GatewayTimer::usb_retry, now)) {
    start_usb_probe(now);
  }
  if (timers.take_if_due(GatewayTimer::reconnect, now)) {
    start_connection(now);
  }
  if (timers.take_if_due(GatewayTimer::status, now)) {
    send_status(now);
  }
}

device::Wake GatewayRole::next_wake() const {
  device::Wake wake;
  wake.at = device::earliest(state_.timers.earliest(), queue_.next_deadline());
  // Mains powered and always listening: never deeper than awake (design section 7).
  wake.deepest = device::SleepDepth::awake;
  return wake;
}

protocol::MutableByteView GatewayRole::state_bytes() {
  return protocol::MutableByteView(reinterpret_cast<std::uint8_t*>(&state_), sizeof(state_));
}

std::uint8_t GatewayRole::state_layout() const {
  return kGatewayStateLayout;
}

std::uint8_t GatewayRole::state_id() const {
  return static_cast<std::uint8_t>((static_cast<unsigned>(state_.connection.phase) << kPhaseShift) |
                                   static_cast<unsigned>(state_.radio.mode));
}

device::Duration GatewayRole::longest_awake() const {
  return device::Duration{};  // always powered: no bound
}

void GatewayRole::report_again(device::Instant now) {
  // Step 4 of the key change after a hub restore (m3-updates-design.md section 7), the role
  // owner's to build. Device calls it only after SecureChannel::change_key succeeds, which it
  // does not yet.
  static_cast<void>(now);
}

}  // namespace hsn::roles::gateway
