#include "hsn/esp/role_io.hpp"

#include "driver/gpio.h"
#include "driver/temperature_sensor.h"
#include "driver/usb_serial_jtag.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_log.h"
#include "hsn/esp/board.hpp"

namespace hsn::esp {
namespace {

constexpr const char* kTag = "hsn.io";
constexpr int kSamples = 4;

}  // namespace

bool Analog::begin() {
  if (kBoard.battery_sense != kNoPin) {
    adc_unit_t unit = ADC_UNIT_1;
    adc_channel_t channel = ADC_CHANNEL_0;
    adc_oneshot_unit_handle_t adc = nullptr;
    adc_oneshot_unit_init_cfg_t unit_config{};
    adc_oneshot_chan_cfg_t channel_config{};
    channel_config.atten = ADC_ATTEN_DB_12;
    channel_config.bitwidth = ADC_BITWIDTH_DEFAULT;
    adc_cali_handle_t calibration = nullptr;
    adc_cali_curve_fitting_config_t calibration_config{};
    if (adc_oneshot_io_to_channel(kBoard.battery_sense, &unit, &channel) == ESP_OK) {
      unit_config.unit_id = unit;
      calibration_config.unit_id = unit;
      calibration_config.chan = channel;
      calibration_config.atten = ADC_ATTEN_DB_12;
      calibration_config.bitwidth = ADC_BITWIDTH_DEFAULT;
      if (adc_oneshot_new_unit(&unit_config, &adc) == ESP_OK &&
          adc_oneshot_config_channel(adc, channel, &channel_config) == ESP_OK &&
          adc_cali_create_scheme_curve_fitting(&calibration_config, &calibration) == ESP_OK) {
        adc_ = adc;
        calibration_ = calibration;
        channel_ = static_cast<int>(channel);
      }
    }
    if (adc_ == nullptr) {
      ESP_LOGE(kTag, "battery reading not configured");
    }
  }
  temperature_sensor_config_t config = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 80);
  temperature_sensor_handle_t sensor = nullptr;
  if (temperature_sensor_install(&config, &sensor) == ESP_OK &&
      temperature_sensor_enable(sensor) == ESP_OK) {
    temperature_ = sensor;
  } else {
    ESP_LOGE(kTag, "temperature sensor not configured");
  }
  return true;
}

std::uint16_t Analog::battery_millivolts() {
  if (adc_ == nullptr) {
    return 0;
  }
  int total = 0;
  for (int i = 0; i < kSamples; ++i) {
    int raw = 0;
    int millivolts = 0;
    if (adc_oneshot_read(static_cast<adc_oneshot_unit_handle_t>(adc_),
                         static_cast<adc_channel_t>(channel_), &raw) != ESP_OK ||
        adc_cali_raw_to_voltage(static_cast<adc_cali_handle_t>(calibration_), raw, &millivolts) !=
            ESP_OK) {
      return 0;
    }
    total += millivolts;
  }
  const std::uint32_t at_pin = static_cast<std::uint32_t>(total / kSamples);
  const std::uint32_t at_battery =
      (at_pin * kBoard.battery_scale_numerator + kBoard.battery_scale_denominator / 2) /
      kBoard.battery_scale_denominator;
  return static_cast<std::uint16_t>(at_battery > 0xFFFF ? 0xFFFF : at_battery);
}

std::int8_t Analog::chip_temperature_c() {
  float celsius = 0.0f;
  if (temperature_ == nullptr ||
      temperature_sensor_get_celsius(static_cast<temperature_sensor_handle_t>(temperature_),
                                     &celsius) != ESP_OK) {
    return 0;
  }
  // The platform may use floating point; the core never sees it (an int8 crosses the interface).
  const float rounded = celsius >= 0.0f ? celsius + 0.5f : celsius - 0.5f;
  if (rounded >= 127.0f) {
    return 127;
  }
  if (rounded <= -128.0f) {
    return -128;
  }
  return static_cast<std::int8_t>(rounded);
}

bool EspSensorIo::door_open() {
  return inputs_.active(device::Input::door);
}

bool EspSensorIo::cover_open() {
  return inputs_.active(device::Input::cover);
}

bool EspSensorIo::button_pressed() {
  return inputs_.active(device::Input::button);
}

bool EspSensorIo::charging() {
  return false;
}

std::uint16_t EspSensorIo::battery_millivolts() {
  return analog_.battery_millivolts();
}

std::int8_t EspSensorIo::chip_temperature_c() {
  return analog_.chip_temperature_c();
}

void EspSensorIo::buzzer(device::Sound sound) {
  indicators_.sound(sound, clock_.now());
}

void EspSensorIo::led(device::Blink blink) {
  indicators_.blink(blink, clock_.now());
}

bool EspSirenIo::begin() {
  if (kBoard.siren_output == kNoPin) {
    return true;
  }
  const gpio_num_t pin = static_cast<gpio_num_t>(kBoard.siren_output);
  // Low first, then an output: the pin goes from held low (the pull-down) to driven low.
  static_cast<void>(gpio_set_level(pin, 0));
  gpio_config_t config{};
  config.pin_bit_mask = 1ull << kBoard.siren_output;
  config.mode = GPIO_MODE_OUTPUT;
  config.pull_down_en = GPIO_PULLDOWN_ENABLE;
  on_ = false;
  return gpio_config(&config) == ESP_OK && gpio_set_level(pin, 0) == ESP_OK;
}

void EspSirenIo::output(bool on) {
  if (kBoard.siren_output != kNoPin) {
    static_cast<void>(gpio_set_level(static_cast<gpio_num_t>(kBoard.siren_output), on ? 1 : 0));
  }
  on_ = on;
}

bool EspSirenIo::output_on() const {
  return on_;
}

bool EspSirenIo::cover_open() {
  return inputs_.active(device::Input::cover);
}

bool EspSirenIo::cell_fitted() {
  return analog_.battery_millivolts() >= kBoard.cell_present_millivolts;
}

bool EspSirenIo::charging() {
  return false;
}

std::uint16_t EspSirenIo::cell_millivolts() {
  return analog_.battery_millivolts();
}

std::int8_t EspSirenIo::chip_temperature_c() {
  return analog_.chip_temperature_c();
}

void EspSirenIo::led(device::Blink blink) {
  indicators_.blink(blink, clock_.now());
}

bool EspGatewayIo::cell_fitted() {
  return analog_.battery_millivolts() >= kBoard.cell_present_millivolts;
}

bool EspGatewayIo::usb_host() {
  return usb_serial_jtag_is_connected();
}

std::int8_t EspGatewayIo::chip_temperature_c() {
  return analog_.chip_temperature_c();
}

void EspGatewayIo::led(device::Blink blink) {
  indicators_.blink(blink, clock_.now());
}

}  // namespace hsn::esp
