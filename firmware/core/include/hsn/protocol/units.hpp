#pragma once

#include <cstdint>
#include <optional>

namespace hsn::protocol {

/**
 * Encodes a battery or cell voltage as its byte: (millivolts − 2,500) ÷ 10, an exact half rounded
 * up, then limited to 0–255 (section 3, "Battery byte").
 */
std::uint8_t battery_code_from_millivolts(std::uint32_t millivolts);

/**
 * Decodes a battery byte: 2,500 + 10 × code millivolts.
 */
std::uint16_t millivolts_from_battery_code(std::uint8_t code);

/**
 * Decodes a count of 15-second units (heartbeat interval, LoRa check interval) into seconds.
 */
std::uint16_t seconds_from_fifteen_second_units(std::uint8_t units);

/**
 * Encodes seconds as 15-second units; empty unless a whole number of units from 0 to 255.
 */
std::optional<std::uint8_t> fifteen_second_units_from_seconds(std::uint32_t seconds);

/**
 * Decodes tenths of a second (next heartbeat) into milliseconds.
 */
std::uint32_t milliseconds_from_tenths(std::uint16_t tenths);

/**
 * Encodes milliseconds as tenths of a second, an exact half rounded up; empty above 65,535.
 */
std::optional<std::uint16_t> tenths_from_milliseconds(std::uint32_t milliseconds);

/**
 * Converts a signal-to-noise ratio in quarter decibels to hundredths of a decibel, which is exact
 * and keeps the core free of floating point.
 */
std::int16_t snr_hundredths_db_from_quarters(std::int8_t quarter_db);

}  // namespace hsn::protocol
