#pragma once

#include "hsn/device/events.hpp"
#include "hsn/device/role.hpp"
#include "hsn/device/time.hpp"

namespace hsn::device {

/** What the platform waits for: planned by the core's Runner (design section 2). */
struct WaitRequest {
  /** Return at this instant at the latest, if nothing happens first. */
  Instant until = Instant::never();
  SleepDepth depth = SleepDepth::awake;
  /** Deep sleep only. */
  WakeMask deep_wake_inputs;
  /** Restart the chip; never returns. */
  bool restart = false;
};

/** What ended a wait. */
struct WaitResult {
  /** False when `until` came with nothing happening. */
  bool has_event = false;
  Event event;
};

/**
 * The platform's wait: the only blocking call in the firmware, and the core never calls it; the
 * platform's loop does. Light sleep wakes on the radio's interrupt, inputs, link activity or
 * `until`. Before deep sleep the platform stops Wi-Fi and Bluetooth, puts the radio to sleep
 * before releasing its pins, turns the LED and battery divider off, arms the wake levels from the
 * pins' current levels, reads the inputs again, and returns an input event instead of sleeping
 * when one changed (hardware notes (a) 27 and 34). Deep sleep and restart never return.
 */
class Waiter {
public:
  virtual WaitResult wait(const WaitRequest& request) = 0;

protected:
  Waiter() = default;
  Waiter(const Waiter&) = default;
  Waiter& operator=(const Waiter&) = default;
  ~Waiter() = default;
};

}  // namespace hsn::device
