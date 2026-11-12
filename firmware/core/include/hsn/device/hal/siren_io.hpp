#pragma once

#include <cstdint>

#include "hsn/device/hal/indicators.hpp"

namespace hsn::device {

/**
 * The siren controller's inputs and outputs; mains is the shared Power interface. The sounder
 * output is low during reset.
 */
class SirenIo {
public:
  virtual void output(bool on) = 0;
  virtual bool output_on() const = 0;
  virtual bool cover_open() = 0;
  virtual bool cell_fitted() = 0;
  virtual bool charging() = 0;
  virtual std::uint16_t cell_millivolts() = 0;
  virtual std::int8_t chip_temperature_c() = 0;
  virtual void led(Blink blink) = 0;

protected:
  SirenIo() = default;
  SirenIo(const SirenIo&) = default;
  SirenIo& operator=(const SirenIo&) = default;
  ~SirenIo() = default;
};

}  // namespace hsn::device
