#pragma once

#include <stdexcept>
#include <string>

namespace hsn::host {

/**
 * A rule of the bench was broken: a handle() made more hardware calls than the budget, time stood
 * still, a radio was asked for an unlisted data rate. Thrown out of Simulation::run_until, so a
 * doctest case fails with the message wherever it happens. The simulation is not usable after.
 */
class SimulationError : public std::runtime_error {
public:
  /** An error saying which rule broke, where and when. */
  explicit SimulationError(const std::string& what) : std::runtime_error(what) {}
};

}  // namespace hsn::host
