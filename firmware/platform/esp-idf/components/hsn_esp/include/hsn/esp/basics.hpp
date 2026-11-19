#pragma once

#include <cstdint>

#include "hsn/device/events.hpp"
#include "hsn/device/hal/build_info.hpp"
#include "hsn/device/hal/power.hpp"
#include "hsn/device/hal/random.hpp"
#include "hsn/protocol/messages.hpp"

namespace hsn::esp {

/**
 * esp_fill_random: true randomness only while Wi-Fi or Bluetooth runs (or bootloader_random is
 * on), which holds for the gateway's hello; retry jitter needs no more (design section 3).
 */
class EspRandom final : public device::Random {
public:
  void fill(protocol::MutableByteView out) override;
};

/** External power: the board's USB 5 V sense pin (board.hpp). */
class EspPower final : public device::Power {
public:
  bool external_power() override;
};

/**
 * The build: this image's version (its app description, read by parse_version in
 * update/firmware_slots.hpp), the development flag (Kconfig), the chip's base MAC.
 */
device::BuildInfo build_info();

/**
 * What this start is: esp_reset_reason() as the raw value Started carries (protocol section 6),
 * the watchdog and panic reasons read as a watchdog reset, and for a deep-sleep wake what woke the
 * chip, from the GPIO wake status and the timer cause, mapped back to inputs through board.hpp.
 */
device::BootInfo boot_info();

}  // namespace hsn::esp
