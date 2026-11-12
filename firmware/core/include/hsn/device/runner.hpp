#pragma once

#include <cstdint>

#include "hsn/device/device.hpp"
#include "hsn/device/events.hpp"
#include "hsn/device/hal/waiter.hpp"
#include "hsn/device/hal/watchdog.hpp"
#include "hsn/device/time.hpp"

namespace hsn::device {

/** The hardware watchdog's timeout (design section 6). */
constexpr std::uint32_t kWatchdogTimeoutMs = 5000;

/** The longest wait between feeds, deep sleep apart. */
constexpr Duration kFeedSlice = seconds(2);

/** Immediate wake-ups in a row that count as a busy loop. */
constexpr std::uint8_t kBusyLoopLimit = 64;

/**
 * Turns the device's Wake into waits for the platform, and is the only place the watchdog is
 * fed (FW4, design section 6). Non-blocking: the platform's loop is
 *
 *   runner.start(boot_event);
 *   for (;;) {
 *     const WaitResult result = waiter.wait(runner.plan(clock.now()));
 *     if (result.has_event) { runner.deliver(result.event); } else { runner.timed_out(clock.now());
 * }
 *   }
 */
class Runner {
public:
  Runner(Device& device, Watchdog& watchdog) : device_(device), watchdog_(watchdog) {}

  /**
   * Starts the watchdog and delivers the boot event.
   */
  void start(const Event& boot);

  /**
   * Delivers one event, then feeds the watchdog: a feed proves a handle() returned.
   */
  void deliver(const Event& event);

  /**
   * Plans the next wait: the device's Wake, cut to kFeedSlice unless it is a deep sleep. A busy
   * loop raises a fatal error and turns into a restart.
   */
  WaitRequest plan(Instant now);

  /**
   * A wait reached its `until` with nothing happening: feeds the watchdog, and delivers a timer
   * event when the device's wake time has come (otherwise it was only a slice).
   */
  void timed_out(Instant now);

private:
  Device& device_;
  Watchdog& watchdog_;
  std::uint8_t immediate_ = 0;
};

}  // namespace hsn::device
