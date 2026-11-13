#pragma once

#include <cstdint>

#include "hsn/device/services/log_buffer.hpp"

namespace hsn::roles::sensor {

/**
 * The door sensor's log codes, in the sensor's range 0x1xxx (design §4, LogBuffer). Every
 * failure path of the role records one of these (FW6, D110).
 */
namespace sensor_log {
/** A report's retry run of 10 minutes ended unanswered (§7); value: the report kinds. */
constexpr std::uint16_t report_given_up = device::log_code::sensor_first + 0x01;
/** A packet could not be sealed: the resume point's flash write failed, or the codec refused. */
constexpr std::uint16_t seal_failed = device::log_code::sensor_first + 0x02;
/** The radio port refused a send or a receive; value: the service status. */
constexpr std::uint16_t radio_failed = device::log_code::sensor_first + 0x03;
/** The settings record could not be written to flash; the settings are kept in RAM. */
constexpr std::uint16_t settings_not_stored = device::log_code::sensor_first + 0x04;
/** A packet for this sensor failed its tag under every candidate binding (§4). */
constexpr std::uint16_t hub_packet_rejected = device::log_code::sensor_first + 0x05;
/** A hub packet of a type the sensor does not act on, or a body that does not decode (§5). */
constexpr std::uint16_t hub_message_ignored = device::log_code::sensor_first + 0x06;
/** A heartbeat or log packet was skipped: routine traffic over the budget (§2). */
constexpr std::uint16_t routine_skipped = device::log_code::sensor_first + 0x07;
/** The factory reset's erase failed; the sensor stays paired (PR4). */
constexpr std::uint16_t factory_reset_failed = device::log_code::sensor_first + 0x09;
/** The sensor sounded its own alarm: the hub did not answer an armed opening (DS6, D88). */
constexpr std::uint16_t local_alarm = device::log_code::sensor_first + 0x0A;
/** The battery is at or below the low-battery threshold (DS11); value: millivolts. */
constexpr std::uint16_t low_battery = device::log_code::sensor_first + 0x0B;
/** A reply carried a data rate the pairing does not allow or the protocol does not list (§3). */
constexpr std::uint16_t setting_ignored = device::log_code::sensor_first + 0x0C;
/** The pairing's site channel is not one the protocol lists: nothing can be sent (§3). */
constexpr std::uint16_t no_site_channel = device::log_code::sensor_first + 0x0D;
/**
 * The sending rate stepped after unanswered packets: one allowed rate slower, or from the slowest
 * back to the fastest (§7); value: the new rate.
 */
constexpr std::uint16_t rate_stepped = device::log_code::sensor_first + 0x0E;
/** A factory-reset hold on an armed sensor was refused: the hub answered armed (D89). */
constexpr std::uint16_t factory_reset_refused = device::log_code::sensor_first + 0x0F;
/** Started was answered, but the stored fatal error code could not be cleared (FW5). */
constexpr std::uint16_t fatal_not_cleared = device::log_code::sensor_first + 0x10;
}  // namespace sensor_log

}  // namespace hsn::roles::sensor
