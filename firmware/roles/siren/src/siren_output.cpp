// The sounder output (D42): on for an alarm or a test, for the command's seconds capped by the
// settings' longest time, and off by itself when they run out (SR5).

#include "hsn/roles/siren/siren_constants.hpp"
#include "hsn/roles/siren/siren_role.hpp"

namespace hsn::roles::siren {

void SirenRole::drive_output(bool on) {
  const bool was_on = state_.output_state != protocol::SirenState::off;
  if (was_on != on) {
    io_.output(on);
  }
}

void SirenRole::start_sounding(std::uint8_t output_state, std::uint16_t seconds,
                               device::Instant now) {
  const std::uint16_t cap = state_.settings.max_sound_seconds;
  const std::uint16_t capped = seconds < cap ? seconds : cap;
  if (capped == 0) {
    stop_sounding();
    return;
  }
  drive_output(true);
  state_.output_state = output_state;
  state_.stop_at = now + device::seconds(capped);
  state_.timers.arm(SirenTimer::auto_stop, state_.stop_at);
}

void SirenRole::stop_sounding() {
  drive_output(false);
  state_.output_state = protocol::SirenState::off;
  state_.stop_at = device::Instant::never();
  state_.timers.cancel(SirenTimer::auto_stop);
}

std::uint16_t SirenRole::seconds_left(device::Instant now) const {
  if (state_.output_state == protocol::SirenState::off || state_.stop_at <= now) {
    return 0;
  }
  const device::Duration left = state_.stop_at - now;
  const std::int64_t whole = (left.us + kMicrosecondsPerSecond - 1) / kMicrosecondsPerSecond;
  return static_cast<std::uint16_t>(whole > kMaxReportSeconds ? kMaxReportSeconds : whole);
}

}  // namespace hsn::roles::siren
