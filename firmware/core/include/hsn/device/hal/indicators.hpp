#pragma once

#include <cstdint>

namespace hsn::device {

/** Sounds a sensor's buzzer plays by itself, without waking the core (design section 3). */
enum class Sound : std::uint8_t {
  off,
  countdown,
  alarm,
  chirp,
  low_battery,
  reset_warning,
};

/** Status LED patterns, played by the platform. */
enum class Blink : std::uint8_t {
  off,
  short_once,
  pairing,
  fault,
};

}  // namespace hsn::device
