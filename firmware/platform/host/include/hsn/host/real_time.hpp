#pragma once

#include <chrono>
#include <cstdint>
#include <functional>

#include "hsn/device/time.hpp"
#include "hsn/host/simulation.hpp"

namespace hsn::host {

/** The host's monotonic clock, as the real-time driver reads it. */
class HostClock {
public:
  /** Time since an arbitrary fixed origin; never goes back. */
  virtual device::Duration elapsed() const = 0;

protected:
  ~HostClock() = default;
};

/** The real host clock: std::chrono::steady_clock. */
class SteadyHostClock final : public HostClock {
public:
  SteadyHostClock() : origin_(std::chrono::steady_clock::now()) {}

  device::Duration elapsed() const override {
    return device::microseconds(std::chrono::duration_cast<std::chrono::microseconds>(
                                    std::chrono::steady_clock::now() - origin_)
                                    .count());
  }

private:
  std::chrono::steady_clock::time_point origin_;
};

/** A host clock a test moves by hand. */
class ManualHostClock final : public HostClock {
public:
  device::Duration elapsed() const override {
    return elapsed_;
  }

  void advance(device::Duration by) {
    elapsed_ = elapsed_ + by;
  }

private:
  device::Duration elapsed_;
};

/** An action that ran later than due by more than the limit. */
struct Lag {
  /** The true instant it was due. */
  device::Instant due;
  /** How late it ran. */
  device::Duration by;
};

/**
 * Runs a Simulation in real time (hub-design.md section 11, "What the bench must provide", item
 * 1): true time follows the host's monotonic clock from the moment the driver is made, the
 * simulation never runs ahead of it, external input is delivered at the host instant it is read,
 * and any action that runs more than `report_over` late is reported. The caller owns the loop and
 * the waiting: catch_up(), deliver() what arrived, then wait for time_to_next() or input.
 */
class RealTimeDriver {
public:
  /** Lags over this are reported (section 11: 5 ms). */
  static constexpr device::Duration kReportLagOver = device::milliseconds(5);

  RealTimeDriver(Simulation& sim, const HostClock& clock,
                 device::Duration report_over = kReportLagOver);

  /** The true instant the host clock says it is now. */
  device::Instant host_now() const;

  /** Runs everything due up to the host clock; reports a lag over the limit. */
  void catch_up();

  /**
   * Delivers an external input at its arrival instant: catches up to the host clock, runs
   * `input` there, then everything it made due by then.
   */
  void deliver(const std::function<void()>& input);

  /** How long until the next action is due by the host clock: zero when overdue, `cap` at most. */
  device::Duration time_to_next(device::Duration cap) const;

  /** Told of each lag over the limit. */
  void set_lag_listener(std::function<void(const Lag&)> listener) {
    on_lag_ = std::move(listener);
  }

  /** Lags reported so far, and the worst. */
  std::uint64_t lags() const {
    return lags_;
  }
  device::Duration worst_lag() const {
    return worst_;
  }

private:
  Simulation& sim_;
  const HostClock& clock_;
  device::Duration report_over_;
  device::Instant true_origin_;
  device::Duration host_origin_;
  std::function<void(const Lag&)> on_lag_;
  std::uint64_t lags_ = 0;
  device::Duration worst_;
};

}  // namespace hsn::host
