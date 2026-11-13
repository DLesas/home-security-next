#pragma once

#include <cstdint>

#include "hsn/device/services/log_buffer.hpp"

namespace hsn::roles::siren {

/** The siren's log codes, in its range 0x2xxx (design section 4, FW6, D110). */
namespace siren_log {
using device::log_code::siren_first;

/** A new command's counter could not be written to flash; it was acted on anyway (§7). */
constexpr std::uint16_t counter_not_saved = siren_first + 0x01;
/** Settings could not be written to flash; they are held in RAM. */
constexpr std::uint16_t settings_not_saved = siren_first + 0x02;
/** The stored settings could not be read; the defaults are used. */
constexpr std::uint16_t settings_not_loaded = siren_first + 0x03;
/** A packet for this siren failed its checks (tag, length, version). Value: the codec error. */
constexpr std::uint16_t packet_dropped = siren_first + 0x04;
/** A command or settings body the channel passed did not decode: a codec fault. Value: type. */
constexpr std::uint16_t body_dropped = siren_first + 0x05;
/** A packet for this siren of a type it does not take. Value: the type. */
constexpr std::uint16_t unexpected_type = siren_first + 0x06;
/** A command action this version does not list; answered, nothing else (§3). Value: it. */
constexpr std::uint16_t unknown_action = siren_first + 0x07;
/** The Wi-Fi link went down. */
constexpr std::uint16_t wifi_down = siren_first + 0x08;
/** A connect attempt failed. Value: the HAL error, or 0 when the link came back down. */
constexpr std::uint16_t wifi_connect_failed = siren_first + 0x09;
/** A report or answer could not go on Wi-Fi and goes on LoRa (§7). Value: the HAL error. */
constexpr std::uint16_t wifi_report_failed = siren_first + 0x0A;
/** A LoRa packet waits for airtime (§2). Value: what waits (LoraItem). */
constexpr std::uint16_t lora_deferred = siren_first + 0x0B;
/** A LoRa packet could not go: the radio refused it or was recovered. Value: LoraItem. */
constexpr std::uint16_t lora_not_sent = siren_first + 0x0C;
/** Continuous receive could not be started. */
constexpr std::uint16_t listen_failed = siren_first + 0x0D;
/** A packet could not be sealed (resume point not saved, channel not ready). Value: Status. */
constexpr std::uint16_t seal_failed = siren_first + 0x0E;
/** The pairing's site channel is not one this version knows: no LoRa sending. Value: it. */
constexpr std::uint16_t no_site_channel = siren_first + 0x0F;
/** The cover was opened. */
constexpr std::uint16_t cover_opened = siren_first + 0x10;
/** Mains power was lost. */
constexpr std::uint16_t mains_lost = siren_first + 0x11;
/** A packet with a bad radio CRC was heard. */
constexpr std::uint16_t crc_error = siren_first + 0x12;
/** A packet on USB that is not a setup message: sirens take commands on Wi-Fi and LoRa only. */
constexpr std::uint16_t usb_packet_ignored = siren_first + 0x13;
/** Sounding resumed after a reset (D80). Value: seconds left. */
constexpr std::uint16_t resumed = siren_first + 0x14;
/** A reset that was not a power-on found no retained state: the output stays off. */
constexpr std::uint16_t retained_lost = siren_first + 0x15;
/** Clearing the reported fatal error failed. */
constexpr std::uint16_t fatal_not_cleared = siren_first + 0x16;
/** The board has no network link: reports go on LoRa only. */
constexpr std::uint16_t no_network_link = siren_first + 0x17;
/** A setting that is not valid (a longest time of 0) was ignored; the value held is kept. */
constexpr std::uint16_t invalid_setting = siren_first + 0x18;
/** A LoRa item that can never fit the airtime budget was dropped. Value: LoraItem. */
constexpr std::uint16_t lora_dropped = siren_first + 0x19;
}  // namespace siren_log

}  // namespace hsn::roles::siren
