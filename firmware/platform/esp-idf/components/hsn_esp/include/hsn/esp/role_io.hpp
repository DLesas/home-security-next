#pragma once

#include <cstdint>

#include "hsn/device/hal/gateway_io.hpp"
#include "hsn/device/hal/sensor_io.hpp"
#include "hsn/device/hal/siren_io.hpp"
#include "hsn/esp/clock.hpp"
#include "hsn/esp/indicators.hpp"
#include "hsn/esp/inputs.hpp"

namespace hsn::esp {

/**
 * The battery and the chip's temperature. The battery is read through the board's divider on
 * ADC1 with ESP-IDF's curve-fitting calibration, four samples averaged (under 2 ms, sensor_io.hpp)
 * ‡; the Olimex divider is always on, so there is nothing to switch. The temperature is the chip's
 * own sensor (driver/temperature_sensor.h), rounded to whole degrees.
 */
class Analog {
public:
  bool begin();
  /** Millivolts at the battery; 0 when the reading failed. */
  std::uint16_t battery_millivolts();
  /** Degrees Celsius, clamped to an int8; 0 when the reading failed. */
  std::int8_t chip_temperature_c();

private:
  void* adc_ = nullptr;
  void* calibration_ = nullptr;
  int channel_ = -1;
  void* temperature_ = nullptr;
};

class EspSensorIo final : public device::SensorIo {
public:
  EspSensorIo(const EspClock& clock, Inputs& inputs, Analog& analog, Indicators& indicators)
      : clock_(clock), inputs_(inputs), analog_(analog), indicators_(indicators) {}

  bool door_open() override;
  bool cover_open() override;
  bool button_pressed() override;
  /** The Olimex board has no charger status pin (board.hpp): false. */
  bool charging() override;
  std::uint16_t battery_millivolts() override;
  std::int8_t chip_temperature_c() override;
  void buzzer(device::Sound sound) override;
  void led(device::Blink blink) override;

private:
  const EspClock& clock_;
  Inputs& inputs_;
  Analog& analog_;
  Indicators& indicators_;
};

/**
 * The siren controller. The sounder output drives the MOSFET module's control pin, which a 10 kΩ
 * resistor holds low through every reset, while the pin is an input (dev-board-choice.md); the
 * output is set low before the pin becomes an output, so starting never glitches it high.
 */
class EspSirenIo final : public device::SirenIo {
public:
  EspSirenIo(const EspClock& clock, Inputs& inputs, Analog& analog, Indicators& indicators)
      : clock_(clock), inputs_(inputs), analog_(analog), indicators_(indicators) {}

  bool begin();
  void output(bool on) override;
  bool output_on() const override;
  bool cover_open() override;
  bool cell_fitted() override;
  bool charging() override;
  std::uint16_t cell_millivolts() override;
  std::int8_t chip_temperature_c() override;
  void led(device::Blink blink) override;

private:
  const EspClock& clock_;
  Inputs& inputs_;
  Analog& analog_;
  Indicators& indicators_;
  bool on_ = false;
};

class EspGatewayIo final : public device::GatewayIo {
public:
  EspGatewayIo(const EspClock& clock, Analog& analog, Indicators& indicators)
      : clock_(clock), analog_(analog), indicators_(indicators) {}

  bool cell_fitted() override;
  /** A computer is attached: the chip's USB serial port receives start-of-frame packets. */
  bool usb_host() override;
  std::int8_t chip_temperature_c() override;
  void led(device::Blink blink) override;

private:
  const EspClock& clock_;
  Analog& analog_;
  Indicators& indicators_;
};

}  // namespace hsn::esp
