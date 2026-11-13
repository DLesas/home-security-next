#pragma once

#include <cstdint>
#include <optional>

#include "hsn/device/time.hpp"

// The sensor's data-rate arithmetic (protocol sections 2, 7 and 8): which rates a pairing allows,
// the next slower one, and the times that depend on the rate. Pure functions, no state.

namespace hsn::roles::sensor {

/** True for a data rate the protocol lists, DR0 to DR5 (§2). */
bool is_known_rate(std::uint8_t data_rate);

/** True for a listed data rate whose bit is set in the pairing's allowed set (§9). */
bool is_allowed_rate(std::uint8_t data_rate, std::uint8_t allowed_mask);

/**
 * Returns the fastest rate the pairing allows, where a sensor starts (§7, LR4); DR5 when the
 * mask allows none the protocol lists.
 */
std::uint8_t fastest_allowed_rate(std::uint8_t allowed_mask);

/**
 * Returns the next slower rate the pairing allows (a lower index), or nothing at the slowest:
 * the fall-back never leaves the allowed set (§7, data rate).
 */
std::optional<std::uint8_t> slower_allowed_rate(std::uint8_t data_rate, std::uint8_t allowed_mask);

/**
 * Returns the heartbeat interval at a sending rate: the hub's interval, lengthened to at least
 * 3 minutes at SF11 and 5 minutes at SF12 to stay inside the airtime (§7, data rate).
 */
device::Duration heartbeat_interval(std::uint8_t interval_units, std::uint8_t send_rate);

/** Returns the event listen time after a packet sent at `send_rate` (§8) †. */
device::Duration event_listen_time(std::uint8_t send_rate);

/** Returns one LoRa symbol at a data rate: 2^SF ÷ 125 kHz (§2); SF7's for an unlisted rate. */
device::Duration symbol_time(std::uint8_t data_rate);

/**
 * Returns the heartbeat reply window: 20 ms early to 50 ms plus 8 symbols late around the reply
 * moment, at the rate the reply comes at (§8) †.
 */
device::Duration reply_window(std::uint8_t reply_rate);

}  // namespace hsn::roles::sensor
