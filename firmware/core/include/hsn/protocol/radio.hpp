#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>

#include "hsn/protocol/error.hpp"

namespace hsn::protocol {

/** Data rate indexes (section 2, "Data rates"). */
struct DataRate {
  static constexpr std::uint8_t dr0 = 0;
  static constexpr std::uint8_t dr1 = 1;
  static constexpr std::uint8_t dr2 = 2;
  static constexpr std::uint8_t dr3 = 3;
  static constexpr std::uint8_t dr4 = 4;
  static constexpr std::uint8_t dr5 = 5;
  static constexpr std::array<std::uint8_t, 6> known{dr0, dr1, dr2, dr3, dr4, dr5};
};

/** LoRa settings shared by every packet (section 2, "LoRa settings"). */
struct LoraSettings {
  static constexpr std::uint32_t bandwidth_hz = 125000;
  /** Coding rate 4/5, as the denominator minus 4. */
  static constexpr std::uint32_t coding_rate = 1;
  static constexpr std::uint32_t preamble_symbols = 8;
  static constexpr bool explicit_header = true;
  static constexpr bool crc_on = true;
};

/**
 * Returns the spreading factor of a data rate (DR0 is SF12 … DR5 is SF7), or nothing for an
 * unlisted index.
 */
std::optional<std::uint8_t> spreading_factor(std::uint8_t data_rate);

/**
 * Returns the LoRa time on air of a `length`-byte packet at `data_rate`, exactly, in
 * microseconds, using the formula of Semtech's SX126x driver (hardware notes, section 3).
 * Fails with Error::bad_value for an unlisted data rate and Error::too_long above 255 bytes.
 */
Result<std::uint32_t> time_on_air_microseconds(std::uint8_t data_rate, std::size_t length);

/**
 * Returns the event listen time for a packet sent at `data_rate`, in milliseconds: how long a
 * sensor listens for the hub's answer after a door, cover, button, started or log packet, and how
 * late the hub may start that answer (section 8 †). Fails with Error::bad_value for an unlisted
 * data rate.
 */
Result<std::uint16_t> event_listen_milliseconds(std::uint8_t data_rate);

}  // namespace hsn::protocol
