#pragma once

#include <iosfwd>
#include <string>

#include "hsn/device/time.hpp"

namespace hsn::host {

/**
 * Returns the true-time instant `since_start` after the simulation's start, so scenarios read as
 * `sim.run_until(at(seconds(30)))`.
 */
constexpr device::Instant at(device::Duration since_start) {
  return device::Instant{} + since_start;
}

/** Formats an instant as seconds with six decimals ("12.345678"), or "never". */
std::string format_instant(device::Instant instant);

/** Formats a duration as seconds with six decimals ("0.206000 s"). */
std::string format_duration(device::Duration duration);

}  // namespace hsn::host

namespace hsn::device {

/** Prints an instant as host::format_instant does, so doctest shows times in failed checks. */
std::ostream& operator<<(std::ostream& out, Instant instant);

/** Prints a duration as host::format_duration does. */
std::ostream& operator<<(std::ostream& out, Duration duration);

}  // namespace hsn::device
