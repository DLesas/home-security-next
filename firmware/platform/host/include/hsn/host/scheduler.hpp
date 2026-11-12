#pragma once

#include <cstdint>
#include <functional>
#include <vector>

#include "hsn/device/time.hpp"

namespace hsn::host {

/**
 * The discrete-event queue over the simulation's one true time. Actions run in order of time, and
 * actions due at the same instant in the order they were scheduled, so a run is a pure function
 * of what was scheduled. Nothing here reads a wall clock. Cancelling is the caller's business: an
 * action captures a generation number and does nothing when it is stale.
 */
class Scheduler {
public:
  using Action = std::function<void()>;

  /** Actions at one instant before the queue decides time stands still (a zero-time loop). */
  static constexpr std::uint64_t kMaxActionsPerInstant = 1000000;

  /** Returns the true time: the instant of the action running, or the last run_until limit. */
  device::Instant now() const {
    return now_;
  }

  /** Runs `action` at `when`; an instant in the past means now, after what is already due. */
  void schedule(device::Instant when, Action action);

  /**
   * Runs every action due at or before `limit`, including those they schedule, then sets the
   * time to `limit`. Throws SimulationError when time stands still.
   */
  void run_until(device::Instant limit);

  /** Returns how many actions are waiting. */
  std::size_t pending() const {
    return heap_.size();
  }

  /** Returns how many actions have run, for performance figures. */
  std::uint64_t executed() const {
    return executed_;
  }

private:
  struct Entry {
    device::Instant at;
    std::uint64_t sequence = 0;
    Action action;
  };

  /** Heap order: the earliest instant, then the earliest scheduled, comes first. */
  static bool later(const Entry& a, const Entry& b);

  std::vector<Entry> heap_;
  device::Instant now_;
  std::uint64_t sequence_ = 0;
  std::uint64_t executed_ = 0;
  std::uint64_t same_instant_ = 0;
};

}  // namespace hsn::host
