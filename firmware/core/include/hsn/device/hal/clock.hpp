#pragma once

#include "hsn/device/time.hpp"

namespace hsn::device {

/**
 * The monotonic clock. Only the platform's loop reads it, to stamp events; roles and services are
 * given the time. On a sensor it must keep counting through deep sleep (the RTC timer).
 */
class Clock {
public:
  /**
   * Returns the current instant. Never goes backwards while the chip runs; may restart from zero
   * after a power loss, which the core detects (design section 5).
   */
  virtual Instant now() const = 0;

protected:
  Clock() = default;
  Clock(const Clock&) = default;
  Clock& operator=(const Clock&) = default;
  ~Clock() = default;
};

}  // namespace hsn::device
