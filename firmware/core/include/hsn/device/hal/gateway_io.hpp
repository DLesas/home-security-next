#pragma once

#include <cstdint>

#include "hsn/device/hal/indicators.hpp"

namespace hsn::device {

/** The gateway's inputs and outputs; mains is the shared Power interface. */
class GatewayIo {
public:
  virtual bool cell_fitted() = 0;
  /** True while a computer is attached to the USB port, where the board can sense it. */
  virtual bool usb_host() = 0;
  virtual std::int8_t chip_temperature_c() = 0;
  virtual void led(Blink blink) = 0;

protected:
  GatewayIo() = default;
  GatewayIo(const GatewayIo&) = default;
  GatewayIo& operator=(const GatewayIo&) = default;
  ~GatewayIo() = default;
};

}  // namespace hsn::device
