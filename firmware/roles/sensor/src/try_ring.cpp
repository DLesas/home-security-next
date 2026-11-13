#include "hsn/roles/sensor/sensor_state.hpp"

#include <limits>

namespace hsn::roles::sensor {
namespace {

/** True for the kinds that belong to the report exchange. */
bool is_report(TryKind kind) {
  return kind == TryKind::going_ahead || kind == TryKind::door || kind == TryKind::cover ||
         kind == TryKind::started || kind == TryKind::button;
}

}  // namespace

void TryRing::add(std::uint32_t counter, TryKind kind) {
  // An empty slot, or else the oldest: counters only grow (§4).
  std::size_t slot = 0;
  for (std::size_t i = 0; i < counters_.size(); ++i) {
    if (counters_[i] == 0) {
      slot = i;
      break;
    }
    if (counters_[i] < counters_[slot]) {
      slot = i;
    }
  }
  counters_[slot] = counter;
  kinds_[slot] = kind;
}

void TryRing::remove(TryKind kind) {
  for (std::size_t i = 0; i < counters_.size(); ++i) {
    if (kinds_[i] == kind) {
      counters_[i] = 0;
      kinds_[i] = TryKind::none;
    }
  }
}

void TryRing::remove_reports() {
  for (std::size_t i = 0; i < counters_.size(); ++i) {
    if (is_report(kinds_[i])) {
      counters_[i] = 0;
      kinds_[i] = TryKind::none;
    }
  }
}

void TryRing::retag(TryKind from, TryKind to) {
  for (std::size_t i = 0; i < counters_.size(); ++i) {
    if (kinds_[i] == from) {
      kinds_[i] = to;
    }
  }
}

TryKind TryRing::kind_of(std::uint32_t counter) const {
  for (std::size_t i = 0; i < counters_.size(); ++i) {
    if (counter != 0 && counters_[i] == counter) {
      return kinds_[i];
    }
  }
  return TryKind::none;
}

std::size_t TryRing::newest_first(
    std::array<std::uint32_t, device::kMaxBoundCandidates>& out) const {
  // Selection by value, newest (highest) first; 16 × 16 comparisons at most.
  std::size_t count = 0;
  std::uint32_t below = std::numeric_limits<std::uint32_t>::max();
  for (std::size_t round = 0; round < counters_.size(); ++round) {
    std::uint32_t best = 0;
    for (std::size_t i = 0; i < counters_.size(); ++i) {
      if (counters_[i] != 0 && counters_[i] < below && counters_[i] > best) {
        best = counters_[i];
      }
    }
    if (best == 0) {
      break;
    }
    out[count++] = best;
    below = best;
  }
  return count;
}

}  // namespace hsn::roles::sensor
