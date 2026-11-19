#pragma once

#include <cstdint>

#include "hsn/device/services/log_buffer.hpp"

namespace hsn::roles::gateway {

/** The gateway's log codes, in its range 0x3xxx (design section 4, LogBuffer; D110, FW6). */
namespace gateway_log {
constexpr std::uint16_t first = device::log_code::gateway_first;

/** A packet from the hub failed open_session: bad tag, old counter, wrong session. */
constexpr std::uint16_t hub_packet_refused = first + 0x01;
/** A packet from the hub of a type the gateway does not act on. */
constexpr std::uint16_t unexpected_type = first + 0x02;
/** No welcome came in time on the network link. */
constexpr std::uint16_t welcome_timeout = first + 0x03;
/** The link of the connection went down. */
constexpr std::uint16_t link_down = first + 0x04;
/** A link refused to start connecting. */
constexpr std::uint16_t connect_failed = first + 0x05;
/** A link refused a packet. */
constexpr std::uint16_t link_send_failed = first + 0x06;
/** A packet to the hub could not be sealed (counter, flash). */
constexpr std::uint16_t seal_failed = first + 0x07;
/**
 * A heard packet did not reach the hub, one code per cause so that repeats of one cause never
 * count as another's (the log merges repeats of a code); the value is the HAL's or service's
 * status. Not connected; the seal failed; the link's queue was full; the link was down.
 */
constexpr std::uint16_t forward_lost = first + 0x08;
constexpr std::uint16_t forward_seal_failed = first + 0x1C;
constexpr std::uint16_t forward_link_busy = first + 0x1D;
constexpr std::uint16_t forward_link_down = first + 0x1E;
/** The settings could not be written to flash. */
constexpr std::uint16_t settings_store_failed = first + 0x09;
/** Settings named a site channel this version does not list; the old one is kept. */
constexpr std::uint16_t unknown_channel = first + 0x0A;
/** Settings named no data rate this version lists; the old one is kept. */
constexpr std::uint16_t unknown_data_rate = first + 0x0B;
/** Settings named several data rates; only the slowest is heard (O14). */
constexpr std::uint16_t several_data_rates = first + 0x0C;
/** The radio refused a call. */
constexpr std::uint16_t radio_call_failed = first + 0x0D;
/** The radio reported a fault. */
constexpr std::uint16_t radio_fault = first + 0x0E;
/** A reception or transmission outlasted its guard: the radio was reset. */
constexpr std::uint16_t radio_guard = first + 0x0F;
/** A transmit request was not valid. */
constexpr std::uint16_t request_not_valid = first + 0x10;
/** A transmit request's moment passed. */
constexpr std::uint16_t request_too_late = first + 0x11;
/** A transmit request did not fit the airtime budget. */
constexpr std::uint16_t request_no_airtime = first + 0x12;
/** A transmit request's moment found the radio busy. */
constexpr std::uint16_t request_radio_busy = first + 0x13;
/** A transmit request found the queue full. */
constexpr std::uint16_t queue_full = first + 0x14;
/** Transmit requests were dropped with their connection; the value is how many. */
constexpr std::uint16_t requests_dropped = first + 0x15;
/** A transmit result could not be sent: its connection is gone. */
constexpr std::uint16_t result_lost = first + 0x16;
/** The reported fatal error could not be cleared from flash. */
constexpr std::uint16_t health_clear_failed = first + 0x17;
/** No welcome came on USB in its window: Wi-Fi is used. */
constexpr std::uint16_t usb_no_welcome = first + 0x18;
/** A transmit request's body did not decode. */
constexpr std::uint16_t request_malformed = first + 0x19;
/** A request gave its place in a full queue to a siren command. */
constexpr std::uint16_t request_displaced = first + 0x1B;
/** Settings gave 0 for a status interval, alert level or alert duration, which is not valid;
 * the value held is kept (protocol section 6). The value has bit 0 for the interval, bit 1
 * for the level and bit 2 for the duration. */
constexpr std::uint16_t zero_setting = first + 0x1F;
/** Interference started or ended (GW11, D82); the value is its noise level. */
constexpr std::uint16_t interference = first + 0x1A;
/** An "install now" came while a request waited or the radio was busy: it waits. Info. */
constexpr std::uint16_t install_waits = first + 0x20;
/** An update query or status could not go to the hub; it goes at the next event. */
constexpr std::uint16_t update_send_failed = first + 0x21;
}  // namespace gateway_log

}  // namespace hsn::roles::gateway
