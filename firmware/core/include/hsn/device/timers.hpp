#pragma once

#include <array>
#include <cstddef>
#include <type_traits>

#include "hsn/device/time.hpp"

namespace hsn::device {

/**
 * A fixed set of deadlines indexed by an enum whose values run from 0 to N − 1. Trivially
 * copyable, so it can live in a role's retained state.
 */
template <typename Id, std::size_t N>
class TimerSet {
  static_assert(std::is_enum_v<Id>, "TimerSet is indexed by an enum");

public:
  /**
   * Arms (or re-arms) one timer.
   */
  constexpr void arm(Id id, Instant at) {
    if (index(id) < N) {
      at_[index(id)] = at;
    }
  }

  /**
   * Disarms one timer.
   */
  constexpr void cancel(Id id) {
    arm(id, Instant::never());
  }

  /**
   * Disarms every timer.
   */
  constexpr void cancel_all() {
    for (std::size_t i = 0; i < N; ++i) {
      at_[i] = Instant::never();
    }
  }

  constexpr bool armed(Id id) const {
    return index(id) < N && !at_[index(id)].is_never();
  }

  /**
   * Returns when the timer is due, or never.
   */
  constexpr Instant at(Id id) const {
    return index(id) < N ? at_[index(id)] : Instant::never();
  }

  constexpr bool due(Id id, Instant now) const {
    return armed(id) && at_[index(id)] <= now;
  }

  /**
   * Returns true and disarms the timer when it is due.
   */
  constexpr bool take_if_due(Id id, Instant now) {
    if (!due(id, now)) {
      return false;
    }
    cancel(id);
    return true;
  }

  /**
   * Returns the earliest armed deadline, or never.
   */
  constexpr Instant earliest() const {
    Instant first = Instant::never();
    for (std::size_t i = 0; i < N; ++i) {
      first = device::earliest(first, at_[i]);
    }
    return first;
  }

private:
  static constexpr std::size_t index(Id id) {
    return static_cast<std::size_t>(id);
  }

  std::array<Instant, N> at_ = make_never();

  static constexpr std::array<Instant, N> make_never() {
    std::array<Instant, N> all{};
    for (std::size_t i = 0; i < N; ++i) {
      all[i] = Instant::never();
    }
    return all;
  }
};

}  // namespace hsn::device
