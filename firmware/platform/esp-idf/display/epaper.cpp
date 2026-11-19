#include "hsn/esp/epaper.hpp"

#include "driver/gpio.h"
#include "esp_log.h"

namespace hsn::esp {
namespace {

/** Converts the board table's pin number to ESP-IDF's GPIO type. */
gpio_num_t gpio(int pin) {
  return static_cast<gpio_num_t>(pin);
}

constexpr const char* kTag = "hsn.epaper";
}  // namespace

bool Epaper::begin(int cs, int dc, int reset, int busy) {
  dc_ = dc;
  reset_ = reset;
  busy_ = busy;
  gpio_config_t pins{};
  pins.pin_bit_mask = (1ull << dc) | (1ull << reset);
  pins.mode = GPIO_MODE_OUTPUT;
  if (gpio_config(&pins) != ESP_OK || gpio_set_level(gpio(reset), 1) != ESP_OK) {
    return false;
  }
  pins.pin_bit_mask = 1ull << busy;
  pins.mode = GPIO_MODE_INPUT;
  if (gpio_config(&pins) != ESP_OK) {
    return false;
  }
  spi_device_interface_config_t config{};
  config.spics_io_num = cs;
  config.clock_speed_hz = 4000000;  // ‡ SSD1681 module and bench wiring.
  config.queue_size = 1;
  return spi_bus_add_device(SPI2_HOST, &config, &device_) == ESP_OK;
}

void Epaper::after(Stage stage, device::Instant now, device::Duration delay) {
  stage_ = stage;
  due_ = now + delay;
  timeout_ = now + device::seconds(12);  // ‡ Conservative BUSY timeout; bench across temperature.
}

void Epaper::draw(const PairCode& code, const ChipId& chip, std::uint8_t role,
                  device::Instant now) {
  if (device_ == nullptr) {
    return;
  }
  pairing_bitmap(code, chip, role, bitmap_);
  static_cast<void>(gpio_set_level(gpio(reset_), 1));
  after(Stage::reset_high, now, device::milliseconds(20));  // ‡ Module reset/power timing.
}

bool Epaper::transfer(bool data, const std::uint8_t* bytes, std::size_t size) {
  spi_transaction_t tx{};
  tx.length = size * 8;
  if (size <= sizeof(tx.tx_data)) {
    tx.flags = SPI_TRANS_USE_TXDATA;
    for (std::size_t i = 0; i < size; ++i) {
      tx.tx_data[i] = bytes[i];
    }
  } else {
    tx.tx_buffer = bytes;
  }
  return gpio_set_level(gpio(dc_), data ? 1 : 0) == ESP_OK &&
         spi_device_polling_transmit(device_, &tx) == ESP_OK;
}

bool Epaper::command(std::uint8_t opcode, const std::uint8_t* data, std::size_t size) {
  return transfer(false, &opcode, 1) && (size == 0 || transfer(true, data, size));
}

bool Epaper::refresh() {
  // ‡ SSD1681/Waveshare 1.54-inch V2 full-refresh initialization and OTP waveform.
  constexpr std::uint8_t gate[]{199, 0, 0};
  constexpr std::uint8_t rightward = 3;
  constexpr std::uint8_t x_window[]{0, 24};
  constexpr std::uint8_t y_window[]{0, 0, 199, 0};
  constexpr std::uint8_t border = 5;
  constexpr std::uint8_t internal_temperature = 0x80;
  constexpr std::uint8_t zero[]{0, 0};
  constexpr std::uint8_t full_update = 0xf7;
  return command(0x01, gate, sizeof(gate)) && command(0x11, &rightward, 1) &&
         command(0x44, x_window, sizeof(x_window)) && command(0x45, y_window, sizeof(y_window)) &&
         command(0x3c, &border, 1) && command(0x18, &internal_temperature, 1) &&
         command(0x4e, zero, 1) && command(0x4f, zero, 2) &&
         command(0x24, bitmap_.data(), bitmap_.size()) && command(0x22, &full_update, 1) &&
         command(0x20);
}

void Epaper::fail() {
  ESP_LOGW(kTag, "panel refresh failed");
  due_ = device::Instant::never();
  stage_ = Stage::idle;
  bitmap_.fill(0xff);
}

void Epaper::step(device::Instant now) {
  if (due_.is_never() || now < due_) {
    return;
  }
  if (stage_ == Stage::reset_high || stage_ == Stage::reset_low) {
    const bool release = stage_ == Stage::reset_low;
    static_cast<void>(gpio_set_level(gpio(reset_), release ? 1 : 0));
    // ‡ The V2 module uses a short active-low reset pulse, then waits for BUSY.
    after(release ? Stage::wait_hardware : Stage::reset_low, now,
          device::milliseconds(release ? 20 : 2));
    return;
  }
  if (gpio_get_level(gpio(busy_)) != 0) {  // ‡ SSD1681 BUSY is active-high.
    if (now >= timeout_) {
      fail();
    } else {
      due_ = now + device::milliseconds(20);
    }
    return;
  }
  if (stage_ == Stage::wait_hardware && command(0x12)) {  // ‡ Software reset.
    after(Stage::wait_software, now, device::milliseconds(20));
  } else if (stage_ == Stage::wait_software && refresh()) {
    after(Stage::refreshing, now, device::milliseconds(20));
  } else if (stage_ == Stage::refreshing) {
    // ‡ SSD1681 deep sleep mode 1, exit by hardware reset, image stays without power.
    constexpr std::uint8_t sleep = 1;
    if (!command(0x10, &sleep, 1)) {
      fail();
      return;
    }
    done_ = true;
    stage_ = Stage::idle;
    due_ = device::Instant::never();
    bitmap_.fill(0xff);
  } else {
    fail();
  }
}

bool Epaper::take_done() {
  const bool done = done_;
  done_ = false;
  return done;
}

}  // namespace hsn::esp
