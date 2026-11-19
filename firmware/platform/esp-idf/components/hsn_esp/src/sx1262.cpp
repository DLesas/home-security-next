#include "hsn/esp/sx1262.hpp"

#include <algorithm>
#include <array>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "hsn/esp/board.hpp"
#include "hsn/esp/pairing_bitmap.hpp"

namespace hsn::esp {
namespace {

constexpr const char* kTag = "hsn.sx1262";
constexpr spi_host_device_t kHost = SPI2_HOST;
/** SX1262 command chunks, unchanged with DMA enabled for the panel. */
constexpr std::size_t kChunk = 64;
/** BUSY after an ordinary command: well under a millisecond ‡; 10 ms marks a fault. */
constexpr std::int64_t kBusyUs = 10000;
/** BUSY after a reset or a cold wake: 3.5 ms (P, Table 8-2), with room. */
constexpr std::int64_t kStartUs = 20000;

gpio_num_t gpio(Pin pin) {
  return static_cast<gpio_num_t>(pin);
}

}  // namespace

void Sx1262Bus::release_hold() {
  gpio_hold_dis(gpio(kBoard.radio_nss));
  if (kBoard.radio_rf_switch != kNoPin) {
    gpio_hold_dis(gpio(kBoard.radio_rf_switch));
  }
  gpio_deep_sleep_hold_dis();
}

bool Sx1262Bus::begin() {
  // Pins held through deep sleep by hold_for_deep_sleep are released first.
  release_hold();

  gpio_config_t outputs{};
  outputs.pin_bit_mask = (1ull << kBoard.radio_nss) | (1ull << kBoard.radio_reset);
  if (kBoard.radio_rf_switch != kNoPin) {
    outputs.pin_bit_mask |= 1ull << kBoard.radio_rf_switch;
  }
  outputs.mode = GPIO_MODE_OUTPUT;
  if (gpio_config(&outputs) != ESP_OK) {
    return false;
  }
  gpio_set_level(gpio(kBoard.radio_nss), 1);
  gpio_set_level(gpio(kBoard.radio_reset), 1);
  rf_switch(false);

  gpio_config_t busy{};
  busy.pin_bit_mask = 1ull << kBoard.radio_busy;
  busy.mode = GPIO_MODE_INPUT;
  if (gpio_config(&busy) != ESP_OK) {
    return false;
  }

  spi_bus_config_t bus{};
  bus.mosi_io_num = kBoard.radio_mosi;
  bus.miso_io_num = kBoard.radio_miso;
  bus.sclk_io_num = kBoard.radio_sck;
  bus.quadwp_io_num = -1;
  bus.quadhd_io_num = -1;
  bus.max_transfer_sz = static_cast<int>(Bitmap{}.size());
  if (spi_bus_initialize(kHost, &bus, SPI_DMA_CH_AUTO) != ESP_OK) {
    ESP_LOGE(kTag, "spi bus not started");
    return false;
  }
  spi_device_interface_config_t config{};
  config.mode = 0;
  config.clock_speed_hz = static_cast<int>(kBoard.radio_spi_hz);
  config.spics_io_num = -1;  // NSS is driven by hand
  config.queue_size = 1;
  spi_device_handle_t handle = nullptr;
  if (spi_bus_add_device(kHost, &config, &handle) != ESP_OK) {
    ESP_LOGE(kTag, "spi device not added");
    return false;
  }
  device_ = handle;
  return true;
}

device::HalError Sx1262Bus::wait_busy(std::int64_t timeout_us) {
  const std::int64_t deadline = esp_timer_get_time() + timeout_us;
  while (gpio_get_level(gpio(kBoard.radio_busy)) != 0) {
    if (esp_timer_get_time() > deadline) {
      return device::HalError::io;
    }
    esp_rom_delay_us(5);
  }
  return device::HalError::none;
}

device::HalError Sx1262Bus::reset() {
  gpio_set_level(gpio(kBoard.radio_nss), 1);
  gpio_set_level(gpio(kBoard.radio_reset), 0);
  esp_rom_delay_us(200);  // at least 100 µs ‡
  gpio_set_level(gpio(kBoard.radio_reset), 1);
  esp_rom_delay_us(500);
  slept_at_us_ = -1;
  return wait_busy(kStartUs);
}

void Sx1262Bus::slept() {
  slept_at_us_ = esp_timer_get_time();
}

device::HalError Sx1262Bus::wake() {
  if (slept_at_us_ >= 0) {
    const std::int64_t ready = slept_at_us_ + sx1262::kAfterSleepUs;
    const std::int64_t now = esp_timer_get_time();
    if (now < ready) {
      esp_rom_delay_us(static_cast<std::uint32_t>(ready - now));
    }
  }
  // A falling edge on NSS wakes the chip (P, 13.1.1); BUSY falls once it is in STDBY_RC.
  gpio_set_level(gpio(kBoard.radio_nss), 0);
  esp_rom_delay_us(100);
  gpio_set_level(gpio(kBoard.radio_nss), 1);
  slept_at_us_ = -1;
  return wait_busy(kStartUs);
}

void Sx1262Bus::rf_switch(bool on) {
  if (kBoard.radio_rf_switch != kNoPin) {
    gpio_set_level(gpio(kBoard.radio_rf_switch), on ? 1 : 0);
  }
}

void Sx1262Bus::hold_for_deep_sleep() {
  gpio_set_level(gpio(kBoard.radio_nss), 1);
  gpio_hold_en(gpio(kBoard.radio_nss));
  rf_switch(false);
  if (kBoard.radio_rf_switch != kNoPin) {
    gpio_hold_en(gpio(kBoard.radio_rf_switch));
  }
  // GPIO42 is a digital pad: its hold lasts through deep sleep only with this (gpio.h) ‡.
  gpio_deep_sleep_hold_en();
}

device::HalError Sx1262Bus::chunk(const std::uint8_t* tx, std::uint8_t* rx, std::size_t size) {
  spi_transaction_t transaction{};
  transaction.length = size * 8;
  transaction.tx_buffer = tx;
  transaction.rx_buffer = rx;
  const esp_err_t result =
      spi_device_polling_transmit(static_cast<spi_device_handle_t>(device_), &transaction);
  return result == ESP_OK ? device::HalError::none : device::HalError::io;
}

device::HalError Sx1262Bus::transfer(protocol::ByteView head, protocol::ByteView out_bytes,
                                     protocol::MutableByteView in_bytes, std::size_t skip) {
  if (device_ == nullptr || wait_busy(kBusyUs) != device::HalError::none) {
    return device::HalError::io;
  }
  spi_device_handle_t handle = static_cast<spi_device_handle_t>(device_);
  if (spi_device_acquire_bus(handle, portMAX_DELAY) != ESP_OK) {
    return device::HalError::io;
  }
  const std::size_t writes = head.size() + out_bytes.size();
  const std::size_t reads_from = writes + skip;
  const std::size_t total = reads_from + in_bytes.size();
  std::array<std::uint8_t, kChunk> tx{};
  std::array<std::uint8_t, kChunk> rx{};
  device::HalError error = device::HalError::none;
  gpio_set_level(gpio(kBoard.radio_nss), 0);
  for (std::size_t at = 0; at < total && error == device::HalError::none; at += kChunk) {
    const std::size_t size = std::min(kChunk, total - at);
    for (std::size_t i = 0; i < size; ++i) {
      const std::size_t index = at + i;
      tx[i] = index < head.size() ? head[index]
              : index < writes    ? out_bytes[index - head.size()]
                                  : std::uint8_t{0};
    }
    error = chunk(tx.data(), rx.data(), size);
    for (std::size_t i = 0; i < size; ++i) {
      const std::size_t index = at + i;
      if (index >= reads_from) {
        in_bytes[index - reads_from] = rx[i];
      }
    }
  }
  gpio_set_level(gpio(kBoard.radio_nss), 1);
  spi_device_release_bus(handle);
  return error;
}

device::HalError Sx1262Bus::command(std::uint8_t opcode, protocol::ByteView params) {
  const std::array<std::uint8_t, 1> head{opcode};
  return transfer(protocol::ByteView(head), params, protocol::MutableByteView(), 0);
}

device::HalError Sx1262Bus::read(std::uint8_t opcode, protocol::MutableByteView out) {
  const std::array<std::uint8_t, 1> head{opcode};
  return transfer(protocol::ByteView(head), protocol::ByteView(), out, 1);
}

device::HalError Sx1262Bus::write_register(std::uint16_t address, protocol::ByteView bytes) {
  const std::array<std::uint8_t, 3> head{sx1262::op::write_register,
                                         static_cast<std::uint8_t>(address >> 8),
                                         static_cast<std::uint8_t>(address & 0xFF)};
  return transfer(protocol::ByteView(head), bytes, protocol::MutableByteView(), 0);
}

device::HalError Sx1262Bus::read_register(std::uint16_t address, protocol::MutableByteView out) {
  const std::array<std::uint8_t, 3> head{sx1262::op::read_register,
                                         static_cast<std::uint8_t>(address >> 8),
                                         static_cast<std::uint8_t>(address & 0xFF)};
  return transfer(protocol::ByteView(head), protocol::ByteView(), out, 1);
}

device::HalError Sx1262Bus::write_buffer(std::uint8_t offset, protocol::ByteView bytes) {
  const std::array<std::uint8_t, 2> head{sx1262::op::write_buffer, offset};
  return transfer(protocol::ByteView(head), bytes, protocol::MutableByteView(), 0);
}

device::HalError Sx1262Bus::read_buffer(std::uint8_t offset, protocol::MutableByteView out) {
  const std::array<std::uint8_t, 2> head{sx1262::op::read_buffer, offset};
  return transfer(protocol::ByteView(head), protocol::ByteView(), out, 1);
}

}  // namespace hsn::esp
