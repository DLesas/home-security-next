#pragma once

#include <cstdint>
#include <vector>

#include "hsn/device/hal/clock.hpp"
#include "hsn/device/hal/gateway_io.hpp"
#include "hsn/device/hal/power.hpp"
#include "hsn/device/hal/sensor_io.hpp"
#include "hsn/device/hal/siren_io.hpp"
#include "hsn/device/time.hpp"
#include "hsn/host/call_meter.hpp"

namespace hsn::host {

/** External power, set by the test: off by default, as for a board on its cell. */
class FakePower final : public device::Power, public Metered {
public:
  bool external_power() override {
    tick();
    return external;
  }

  bool external = false;
};

/** One output change, stamped. */
template <typename T>
struct Change {
  device::Instant at;
  T value;
};

/** The sensor's inputs, set by the test, and its outputs, recorded. */
class FakeSensorIo final : public device::SensorIo, public Metered {
public:
  explicit FakeSensorIo(const device::Clock& clock) : clock_(clock) {}

  bool door_open() override {
    tick();
    return door;
  }
  bool cover_open() override {
    tick();
    return cover;
  }
  bool button_pressed() override {
    tick();
    return button;
  }
  bool charging() override {
    tick();
    return charge;
  }
  std::uint16_t battery_millivolts() override {
    tick();
    battery_reads += 1;
    return battery_mv;
  }
  std::int8_t chip_temperature_c() override {
    tick();
    return temperature_c;
  }
  void buzzer(device::Sound sound) override {
    tick();
    sounds.push_back({clock_.now(), sound});
  }
  void led(device::Blink blink) override {
    tick();
    blinks.push_back({clock_.now(), blink});
  }

  bool door = false;
  bool cover = false;
  bool button = false;
  bool charge = false;
  std::uint16_t battery_mv = 3900;
  std::int8_t temperature_c = 21;
  std::uint32_t battery_reads = 0;
  std::vector<Change<device::Sound>> sounds;
  std::vector<Change<device::Blink>> blinks;

private:
  const device::Clock& clock_;
};

/** The siren's inputs and its sounder output, recorded. */
class FakeSirenIo final : public device::SirenIo, public Metered {
public:
  explicit FakeSirenIo(const device::Clock& clock) : clock_(clock) {}

  void output(bool on) override {
    tick();
    output_state = on;
    outputs.push_back({clock_.now(), on});
  }
  bool output_on() const override {
    tick();
    return output_state;
  }
  bool cover_open() override {
    tick();
    return cover;
  }
  bool cell_fitted() override {
    tick();
    return cell;
  }
  bool charging() override {
    tick();
    return charge;
  }
  std::uint16_t cell_millivolts() override {
    tick();
    return cell_mv;
  }
  std::int8_t chip_temperature_c() override {
    tick();
    return temperature_c;
  }
  void led(device::Blink blink) override {
    tick();
    blinks.push_back({clock_.now(), blink});
  }

  /** Low at power-on, as the hardware guarantees. */
  bool output_state = false;
  bool cover = false;
  bool cell = false;
  bool charge = false;
  std::uint16_t cell_mv = 0;
  std::int8_t temperature_c = 25;
  std::vector<Change<bool>> outputs;
  std::vector<Change<device::Blink>> blinks;

private:
  const device::Clock& clock_;
};

/** The gateway's inputs and LED. */
class FakeGatewayIo final : public device::GatewayIo, public Metered {
public:
  explicit FakeGatewayIo(const device::Clock& clock) : clock_(clock) {}

  bool cell_fitted() override {
    tick();
    return cell;
  }
  bool usb_host() override {
    tick();
    return host;
  }
  std::int8_t chip_temperature_c() override {
    tick();
    return temperature_c;
  }
  void led(device::Blink blink) override {
    tick();
    blinks.push_back({clock_.now(), blink});
  }

  bool cell = false;
  bool host = false;
  std::int8_t temperature_c = 30;
  std::vector<Change<device::Blink>> blinks;

private:
  const device::Clock& clock_;
};

}  // namespace hsn::host
