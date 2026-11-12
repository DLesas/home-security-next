#include "hsn/host/scheduler.hpp"

#include <algorithm>
#include <utility>

#include "hsn/host/sim_time.hpp"
#include "hsn/host/simulation_error.hpp"

namespace hsn::host {

bool Scheduler::later(const Entry& a, const Entry& b) {
  if (a.at != b.at) {
    return a.at > b.at;
  }
  return a.sequence > b.sequence;
}

void Scheduler::schedule(device::Instant when, Action action) {
  Entry entry;
  entry.at = when < now_ ? now_ : when;
  entry.sequence = sequence_++;
  entry.action = std::move(action);
  heap_.push_back(std::move(entry));
  std::push_heap(heap_.begin(), heap_.end(), later);
}

void Scheduler::run_until(device::Instant limit) {
  while (!heap_.empty() && heap_.front().at <= limit) {
    std::pop_heap(heap_.begin(), heap_.end(), later);
    Entry entry = std::move(heap_.back());
    heap_.pop_back();
    if (entry.at == now_) {
      same_instant_ += 1;
      if (same_instant_ > kMaxActionsPerInstant) {
        throw SimulationError("time stands still at " + format_instant(now_) +
                              ": a zero-time loop between devices or the hub");
      }
    } else {
      same_instant_ = 0;
      now_ = entry.at;
    }
    executed_ += 1;
    entry.action();
  }
  if (limit > now_ && !limit.is_never()) {
    now_ = limit;
    same_instant_ = 0;
  }
}

}  // namespace hsn::host
