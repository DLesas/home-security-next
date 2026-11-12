#pragma once

#include "hsn/device/hal/clock.hpp"
#include "hsn/device/time.hpp"

namespace hsn::host {

/**
 * A virtual clock. Nothing in the fakes reads time on its own: whoever drives the device (a test,
 * or step B's Simulation from its true time and this board's drift) pushes time in with set() or
 * advance(). Every fake stamps its records with this clock.
 */
class FakeClock final : public device::Clock {
public:
  device::Instant now() const override {
    return now_;
  }

  /** Sets the time; going backwards is allowed, to model a power loss that restarts the RTC. */
  void set(device::Instant at) {
    now_ = at;
  }

  void advance(device::Duration by) {
    now_ = now_ + by;
  }

private:
  device::Instant now_;
};

}  // namespace hsn::host
