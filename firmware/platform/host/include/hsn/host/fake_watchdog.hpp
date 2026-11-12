#pragma once

#include <cstdint>
#include <vector>

#include "hsn/device/hal/clock.hpp"
#include "hsn/device/hal/watchdog.hpp"
#include "hsn/device/time.hpp"

namespace hsn::host {

/** The watchdog: records starts and feeds, and the longest gap between them. */
class FakeWatchdog final : public device::Watchdog {
public:
  explicit FakeWatchdog(const device::Clock& clock) : clock_(clock) {}

  void start(std::uint32_t timeout_ms) override;
  void feed() override;

  /**
   * Returns the longest time between a start or feed and the next feed, or until `now` when
   * given: what a real watchdog would have to tolerate.
   */
  device::Duration longest_gap(device::Instant now = device::Instant{}) const;

  /** Would a real watchdog with this timeout have fired by `now`? */
  bool would_have_fired(device::Instant now) const;

  /** Forgets the record, as a reset of the chip does. */
  void reset();

  std::uint32_t timeout_ms = 0;
  std::uint32_t starts = 0;
  std::vector<device::Instant> feeds;

private:
  const device::Clock& clock_;
  device::Instant last_;
  device::Duration longest_;
};

}  // namespace hsn::host
