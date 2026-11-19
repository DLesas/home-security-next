#pragma once

#include <cstdint>

#include "driver/spi_master.h"
#include "hsn/device/time.hpp"
#include "hsn/esp/pairing_bitmap.hpp"

namespace hsn::esp {

/** Polls the panel as part of the waiter's loop; no SPI ownership spans a BUSY wait. */
class Epaper {
public:
  /** Adds the panel device to the radio's already-initialized SPI2 bus. */
  bool begin(int cs, int dc, int reset, int busy);
  /** Starts one full refresh of a pairing label. */
  void draw(const PairCode& code, const ChipId& chip, std::uint8_t role, device::Instant now);
  /** Advances a due reset/BUSY stage, with bounded progress even if the panel is absent. */
  void step(device::Instant now);
  /** Next instant to service the panel; never when it is idle. */
  device::Instant due() const {
    return due_;
  }
  /** Consumes a completed refresh so its label can be marked durable. */
  bool take_done();

private:
  enum class Stage { idle, reset_high, reset_low, wait_hardware, wait_software, refreshing };
  /** Sends one command and its optional data without keeping SPI during panel work. */
  bool command(std::uint8_t opcode, const std::uint8_t* data = nullptr, std::size_t size = 0);
  /** Sets D/C and submits a bounded SPI transaction. */
  bool transfer(bool data, const std::uint8_t* bytes, std::size_t size);
  /** Sets the full address window, writes the frame and starts its refresh. */
  bool refresh();
  /** Records a new state and its polling deadline. */
  void after(Stage stage, device::Instant now, device::Duration delay);
  /** Stops a failed refresh so the waiter can sleep and a later boot can retry. */
  void fail();

  spi_device_handle_t device_ = nullptr;
  int dc_ = -1;
  int reset_ = -1;
  int busy_ = -1;
  alignas(4) Bitmap bitmap_{};
  Stage stage_ = Stage::idle;
  device::Instant due_ = device::Instant::never();
  device::Instant timeout_ = device::Instant::never();
  bool done_ = false;
};

}  // namespace hsn::esp
