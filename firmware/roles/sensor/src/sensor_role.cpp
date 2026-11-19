#include "hsn/roles/sensor/sensor_role.hpp"

#include "hsn/protocol/radio.hpp"

namespace hsn::roles::sensor {
namespace {

/** The settings record before the hub has sent any (design §5): the protocol's defaults. */
constexpr StoredSettings kDefaultSettings{0,
                                          kDefaultCountdownSeconds,
                                          kDefaultHeartbeatUnits,
                                          kDefaultLinkCheckEvery,
                                          protocol::DataRate::dr5,
                                          protocol::DataRate::dr5,
                                          0,
                                          0,
                                          protocol::kStaysAsItIs,
                                          protocol::kStaysAsItIs,
                                          0};

}  // namespace

SensorRole::SensorRole(device::Services& services, device::SensorIo& io)
    : services_(services),
      io_(io),
      settings_record_(services.hal.storage, kSettingsKey, kSettingsRecordVersion,
                       kDefaultSettings) {
  state_.settings = kDefaultSettings;
}

std::uint8_t SensorRole::role_id() const {
  return protocol::Role::sensor;
}

void SensorRole::handle(const device::Event& event) {
  const device::Instant now = event.now;
  now_ = now;
  key_change_in_event_ = false;
  switch (event.kind) {
    case device::EventKind::boot:
      on_boot(event.boot, now);
      break;
    case device::EventKind::input:
      on_input(event.input, now);
      break;
    case device::EventKind::radio:
      on_radio(event.radio, now);
      break;
    case device::EventKind::link:
      // The network link is the update service's, up only for an update (§10): its up and down
      // are the service's (Device tells it), and the hub's packets on it are answers to ours.
      if (event.link.link == device::LinkKind::network &&
          event.link.kind == device::LinkEventKind::packet) {
        on_packet(event.link.packet, device::UpdatePath::network, now);
      }
      break;
    case device::EventKind::timer:
      // A timer only means "something is due".
      break;
  }
  advance(now);
  finish(now);
}

void SensorRole::advance(device::Instant now) {
  if (restart_) {
    return;
  }
  if (services_.radio_port.next_deadline() <= now) {
    on_port_report(services_.radio_port.on_timer(now), nullptr, now);
  }
  close_windows(now);
  run_alert_timers(now);
  run_button_timers(now);
  run_heartbeat_timers(now);
  if (restart_) {
    return;
  }
  if (!key_change_in_event_) {
    run_heartbeat_again(now);
    queue_update(now);
    run_tries(now);
    if (restart_) {
      return;
    }
    run_log(now);
  }
  keep_listening(now);
}

void SensorRole::finish(device::Instant now) {
  const device::Sound sound = desired_sound();
  if (state_.sound != static_cast<std::uint8_t>(sound)) {
    io_.buzzer(sound);
    state_.sound = static_cast<std::uint8_t>(sound);
  }
  if (state_.external_power) {
    state_.awake_bound_from = now;
  }
  if (can_sleep_deep()) {
    state_.awake_since = now;
  }
  if (state_.reset != ResetPhase::none) {
    state_.top_state = TopState::resetting;
  } else if (state_.alert != Alert::none) {
    state_.top_state = TopState::alerting;
  } else if (state_.waiting != 0) {
    state_.top_state = TopState::reporting;
  } else if (state_.timers.armed(SensorTimer::reply_moment) ||
             !state_.heartbeat_window_end.is_never()) {
    state_.top_state = TopState::heartbeat_listen;
  } else {
    state_.top_state = TopState::idle;
  }
}

protocol::MutableByteView SensorRole::state_bytes() {
  return protocol::MutableByteView(reinterpret_cast<std::uint8_t*>(&state_), sizeof(state_));
}

std::uint8_t SensorRole::state_layout() const {
  return kSensorStateLayout;
}

std::uint8_t SensorRole::state_id() const {
  return static_cast<std::uint8_t>(state_.top_state);
}

device::Duration SensorRole::longest_awake() const {
  // Time on external power, and time since the latest input, do not count (design §6): on USB
  // the sensor never sleeps deep (§10), and each new event may start a new retry run and alarm.
  const device::Duration exempt = state_.awake_bound_from > state_.awake_since
                                      ? state_.awake_bound_from - state_.awake_since
                                      : device::Duration{};
  return kSensorLongestAwake + exempt;
}

}  // namespace hsn::roles::sensor
