#pragma once

#include <cstdint>

#include "hsn/device/time.hpp"

namespace hsn::host {

/**
 * One board's RTC against the simulation's true time: it starts at a local reading at some true
 * instant and then runs `ppm` parts per million fast (positive) or slow (negative), so a +100 ppm
 * board sees 86,400.0086 s in a true day. Integer arithmetic only and exact both ways: local()
 * rounds down, true_time() returns the first true instant whose local reading has reached the
 * argument, so a wake planned for a local instant always finds its timer due.
 */
class DriftClock {
public:
  /** The largest drift accepted either way: half the rate. */
  static constexpr std::int32_t kMaxPpm = 500000;

  /** A clock with `ppm` drift; throws SimulationError beyond kMaxPpm. */
  explicit DriftClock(std::int32_t ppm = 0);

  /** Restarts the RTC: at true instant `true_now` it reads `local_now` (zero after power loss). */
  void start(device::Instant true_now, device::Instant local_now);

  /** Returns the RTC reading at a true instant (the start reading before the start). */
  device::Instant local(device::Instant true_time) const;

  /** Returns the earliest true instant at which the RTC reads `local_time` or more. */
  device::Instant true_time(device::Instant local_time) const;

  /** The drift: positive runs fast. */
  std::int32_t ppm() const {
    return ppm_;
  }

private:
  std::int32_t ppm_;
  /** Local microseconds per million true microseconds: 1,000,000 + ppm. */
  std::uint64_t rate_;
  device::Instant true_origin_;
  device::Instant local_origin_;
};

}  // namespace hsn::host
