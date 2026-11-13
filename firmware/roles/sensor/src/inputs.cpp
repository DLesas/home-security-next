// The door, the cover and external power (DS1, DS3, DS9, DS12). Every change is reported at
// once with the newest state; the platform debounces and reports levels (design section 3).

#include "hsn/roles/sensor/sensor_role.hpp"

namespace hsn::roles::sensor {

void SensorRole::on_input(const device::InputEvent& input, device::Instant now) {
  // Each input may start a new retry run and alarm: the stuck-awake bound counts from here.
  state_.awake_bound_from = now;
  switch (input.input) {
    case device::Input::door:
      if (input.active != state_.door_open) {
        door_changed(input.at, now);
      }
      break;
    case device::Input::cover:
      if (input.active != state_.cover_open) {
        cover_changed(input.at, now);
      }
      break;
    case device::Input::button:
      if (input.active && !state_.button_down) {
        button_pressed(input.at, now);
      } else if (!input.active && state_.button_down) {
        button_released(input.at, now);
      }
      break;
    case device::Input::external_power:
      state_.external_power = input.active;
      break;
  }
}

void SensorRole::door_changed(device::Instant at, device::Instant now) {
  state_.door_open = !state_.door_open;
  // One per open and one per close, wrapping at 256 (§6).
  state_.change_count = static_cast<std::uint8_t>(state_.change_count + 1);
  state_.door_changed_at = at;
  if (state_.door_open) {
    state_.door_opened_at = at;
    state_.opening = Opening::unanswered;
    // A new opening: the last countdown's second notice can no longer come.
    state_.tries.remove(TryKind::settled);
  }
  queue_report(report_bit::door, now);
}

void SensorRole::cover_changed(device::Instant at, device::Instant now) {
  state_.cover_open = !state_.cover_open;
  state_.cover_changed_at = at;
  queue_report(report_bit::cover, now);
}

}  // namespace hsn::roles::sensor
