#pragma once

#include <cstdint>

namespace hsn::device {

/**
 * The hardware watchdog (FW4). On the ESP32-S3 it is the task watchdog, subscribed by the main
 * task only. Only the core's Runner calls feed() (design section 6).
 */
class Watchdog {
public:
  /**
   * Arms the watchdog; the chip resets when `timeout_ms` passes without a feed.
   */
  virtual void start(std::uint32_t timeout_ms) = 0;

  /**
   * Restarts the timeout.
   */
  virtual void feed() = 0;

protected:
  Watchdog() = default;
  Watchdog(const Watchdog&) = default;
  Watchdog& operator=(const Watchdog&) = default;
  ~Watchdog() = default;
};

}  // namespace hsn::device
