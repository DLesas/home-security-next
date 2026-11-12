#pragma once

#include <cstdint>

#include "hsn/device/hal/indicators.hpp"

namespace hsn::device {

/**
 * The door sensor's inputs and outputs; USB power is the shared Power interface. Reads are short
 * (battery: at most 2 ms, the divider switched on and off by the platform). Input changes also
 * arrive as debounced InputEvents.
 */
class SensorIo {
public:
  virtual bool door_open() = 0;
  virtual bool cover_open() = 0;
  virtual bool button_pressed() = 0;
  virtual bool charging() = 0;
  virtual std::uint16_t battery_millivolts() = 0;
  virtual std::int8_t chip_temperature_c() = 0;
  virtual void buzzer(Sound sound) = 0;
  virtual void led(Blink blink) = 0;

protected:
  SensorIo() = default;
  SensorIo(const SensorIo&) = default;
  SensorIo& operator=(const SensorIo&) = default;
  ~SensorIo() = default;
};

}  // namespace hsn::device
