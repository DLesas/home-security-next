// How deeply the sensor sleeps (DS1, DS2, LR7, protocol section 10, design section 6). Deep
// sleep whenever it is idle, woken by the door, cover, button, external power or its timer;
// light sleep while it sends, waits for the reply moment, listens, sounds, times a button hold
// up to its 15 s mark, or shows the pairing window; never deeper than light sleep on external
// power, so USB setup messages get through.

#include "hsn/roles/sensor/sensor_role.hpp"

namespace hsn::roles::sensor {

bool SensorRole::can_sleep_deep() const {
  return !restart_ && !state_.external_power && !port_busy() &&
         services_.radio_port.state() != device::PortState::receiving &&
         !state_.timers.armed(SensorTimer::reply_moment) && state_.alert == Alert::none &&
         state_.reset == ResetPhase::none && !state_.pairing &&
         !state_.timers.armed(SensorTimer::button_hold) &&
         !(state_.gap_wait && state_.timers.armed(SensorTimer::retry));
}

device::Wake SensorRole::next_wake() const {
  device::Wake wake;
  if (restart_) {
    wake.restart = true;
    return wake;
  }
  device::Instant at = services_.radio_port.next_deadline();
  const bool blocked = try_blocked();
  const bool reporting = state_.waiting != 0 || state_.reset != ResetPhase::none;
  for (std::size_t i = 0; i < static_cast<std::size_t>(SensorTimer::count); ++i) {
    const auto id = static_cast<SensorTimer>(i);
    if (id == SensorTimer::retry && blocked) {
      // A try that must wait is run by the radio event or window end that ends the wait.
      continue;
    }
    if (id == SensorTimer::next_heartbeat && reporting) {
      // A heartbeat would be skipped during an exchange: no wake for it (DS2).
      continue;
    }
    at = device::earliest(at, state_.timers.at(id));
  }
  if (!timed_receive()) {
    at = device::earliest(at, state_.report_window_end);
    at = device::earliest(at, state_.heartbeat_window_end);
    at = device::earliest(at, state_.log_window_end);
  }
  wake.at = at;
  wake.deepest = can_sleep_deep() ? device::SleepDepth::deep : device::SleepDepth::light;
  wake.deep_wake_inputs = device::WakeMask::of(device::Input::door)
                              .with(device::Input::cover)
                              .with(device::Input::button)
                              .with(device::Input::external_power);
  return wake;
}

}  // namespace hsn::roles::sensor
