#pragma once

#include <cstdint>
#include <limits>

namespace hsn::device {

/**
 * A signed span of time in microseconds. Roles and services compute with these; nothing in the
 * core reads a clock (design section 2).
 */
struct Duration {
  std::int64_t us = 0;

  friend constexpr bool operator==(Duration a, Duration b) {
    return a.us == b.us;
  }
  friend constexpr bool operator!=(Duration a, Duration b) {
    return a.us != b.us;
  }
  friend constexpr bool operator<(Duration a, Duration b) {
    return a.us < b.us;
  }
  friend constexpr bool operator<=(Duration a, Duration b) {
    return a.us <= b.us;
  }
  friend constexpr bool operator>(Duration a, Duration b) {
    return a.us > b.us;
  }
  friend constexpr bool operator>=(Duration a, Duration b) {
    return a.us >= b.us;
  }
  friend constexpr Duration operator+(Duration a, Duration b) {
    return Duration{a.us + b.us};
  }
  friend constexpr Duration operator-(Duration a, Duration b) {
    return Duration{a.us - b.us};
  }
};

/** Returns a duration of `value` microseconds. */
constexpr Duration microseconds(std::int64_t value) {
  return Duration{value};
}

/** Returns a duration of `value` milliseconds. */
constexpr Duration milliseconds(std::int64_t value) {
  return Duration{value * 1000};
}

/** Returns a duration of `value` seconds. */
constexpr Duration seconds(std::int64_t value) {
  return Duration{value * 1000000};
}

/**
 * A moment on the device's monotonic clock, in microseconds. On the ESP32-S3 it is the RTC timer,
 * which keeps counting through deep sleep. Its low 32 bits are the gateway's microsecond clock of
 * protocol section 6.
 */
struct Instant {
  std::uint64_t us = 0;

  /** The instant that never comes: "no timer". */
  static constexpr Instant never() {
    return Instant{std::numeric_limits<std::uint64_t>::max()};
  }

  constexpr bool is_never() const {
    return us == std::numeric_limits<std::uint64_t>::max();
  }

  friend constexpr bool operator==(Instant a, Instant b) {
    return a.us == b.us;
  }
  friend constexpr bool operator!=(Instant a, Instant b) {
    return a.us != b.us;
  }
  friend constexpr bool operator<(Instant a, Instant b) {
    return a.us < b.us;
  }
  friend constexpr bool operator<=(Instant a, Instant b) {
    return a.us <= b.us;
  }
  friend constexpr bool operator>(Instant a, Instant b) {
    return a.us > b.us;
  }
  friend constexpr bool operator>=(Instant a, Instant b) {
    return a.us >= b.us;
  }
};

/**
 * Moves an instant by a duration, saturating: never stays never, nothing passes never, and
 * nothing goes below zero.
 */
constexpr Instant operator+(Instant at, Duration by) {
  if (at.is_never()) {
    return at;
  }
  if (by.us >= 0) {
    const auto step = static_cast<std::uint64_t>(by.us);
    const std::uint64_t room = Instant::never().us - 1 - at.us;
    return Instant{step > room ? Instant::never().us - 1 : at.us + step};
  }
  const std::uint64_t back = static_cast<std::uint64_t>(-(by.us + 1)) + 1;
  return Instant{back > at.us ? 0 : at.us - back};
}

/** Returns `later − earlier`, saturated to the range of a duration. */
constexpr Duration operator-(Instant later, Instant earlier) {
  constexpr auto max = static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max());
  if (later.us >= earlier.us) {
    const std::uint64_t span = later.us - earlier.us;
    return Duration{span > max ? std::numeric_limits<std::int64_t>::max()
                               : static_cast<std::int64_t>(span)};
  }
  const std::uint64_t span = earlier.us - later.us;
  return Duration{span > max ? std::numeric_limits<std::int64_t>::min()
                             : -static_cast<std::int64_t>(span)};
}

/** Returns the earlier of two instants. */
constexpr Instant earliest(Instant a, Instant b) {
  return a < b ? a : b;
}

/** Returns the later of two instants. */
constexpr Instant latest(Instant a, Instant b) {
  return a < b ? b : a;
}

/**
 * Applies the hub's clock correction (protocol section 6, reply): stretches a nominal duration by
 * `ppm` parts per million, rounding to the nearest microsecond. Integer arithmetic only; exact for
 * any duration under about 300 days at the reply field's ±327,680 ppm.
 */
constexpr Duration corrected(Duration nominal, std::int32_t ppm) {
  const std::int64_t product = nominal.us * static_cast<std::int64_t>(ppm);
  const std::int64_t half = product >= 0 ? 500000 : -500000;
  return Duration{nominal.us + (product + half) / 1000000};
}

}  // namespace hsn::device
