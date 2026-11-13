#pragma once

#include <cstddef>
#include <cstdint>

#include "hsn/device/hal/storage.hpp"
#include "hsn/device/services/retry.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/packet.hpp"
#include "hsn/protocol/radio.hpp"

namespace hsn::roles::siren {

/** Wi-Fi report interval until settings give one: 30 s (protocol sections 6 and 8, D73). */
constexpr std::uint8_t kDefaultWifiReportSeconds = 30;

/** LoRa check interval until settings give one: 20 units of 15 s, 5 minutes (protocol §6). */
constexpr std::uint8_t kDefaultLoraCheckUnits = 20;

/**
 * The longest a command may make it sound until settings give a valid one: the product default
 * of 300 s (D40, AL6). A longest time of 0 is not valid (protocol §6) and never replaces it.
 */
constexpr std::uint16_t kDefaultMaxSoundSeconds = 300;

/** Data rate used when the pairing allows none this version knows: DR5, the provisional fast. */
constexpr std::uint8_t kFallbackDataRate = protocol::DataRate::dr5;

/** Transmit power on the site channel: 14 dBm, 25 mW radiated (protocol section 2). */
constexpr std::int8_t kSendPowerDbm = 14;

/**
 * How long after a start-up Started waits for Wi-Fi before it goes on LoRa (protocol §6, task
 * item 9): one default Wi-Fi report interval, so the hub hears from the siren within its usual
 * report time either way.
 */
constexpr device::Duration kStartedLoraAfter = device::seconds(kDefaultWifiReportSeconds);

/**
 * The share of the site channel's hourly airtime that regular reports and LoRa checks are paced
 * to: half the 36 s (§2, §7), so they go no closer together than 200 times one report's airtime,
 * and the other half is always free for answers, reports of a change and log entries.
 * Numerator and denominator.
 */
constexpr std::int64_t kRoutineReportShareNumerator = 1;
constexpr std::int64_t kRoutineReportShareDenominator = 2;

/** The rolling hour every airtime budget is kept over (protocol section 2). */
constexpr device::Duration kAirtimeHour = device::seconds(3600);

/** Wait before using the radio again after it refused an operation or was recovered. */
constexpr device::Duration kRadioRetry = device::seconds(1);

/** Reconnect back-off: 1, 2, 4, 8, 15, then every 30 s (protocol §7, HN(a)46). */
constexpr device::RetryTable kReconnectTable = device::kReconnect;

/** The back-off's steady gap, should the table ever give none (protocol §7). */
constexpr device::Duration kReconnectSteadyGap = device::seconds(30);

/** The settings record: a siren store key (design section 5) and its version byte. */
constexpr device::StoreKey kSettingsKey = device::StoreKey::siren_first;
constexpr std::uint8_t kSettingsRecordVersion = 2;  // 2: the site channel in place of a spare byte

/** Body sizes of the packets the siren sends (protocol section 6). */
constexpr std::size_t kSirenReportBodySize = 10;
constexpr std::size_t kStartedBodySize = 8;
/** One log entry's fixed part: age 4, level 1, code 2, text length 1 (protocol section 6). */
constexpr std::size_t kLogEntryFixedSize = 8;

/** Whole radio packets: clear part, type byte, body, tag (protocol section 3). */
constexpr std::size_t kReportPacketSize = protocol::kPacketOverhead + 1 + kSirenReportBodySize;
constexpr std::size_t kStartedPacketSize = protocol::kPacketOverhead + 1 + kStartedBodySize;
/** The longest log entries packet with one entry, which bounds a LoRa log's airtime check. */
constexpr std::size_t kLoraLogPacketBound =
    protocol::kPacketOverhead + 1 + kLogEntryFixedSize + protocol::kMaxLogTextSize;

/** Most seconds a report or a resume can carry: the 16-bit field of protocol section 6. */
constexpr std::uint16_t kMaxReportSeconds = 0xFFFF;

/** The low 16 bits of a command counter, as a report carries them (protocol section 6). */
constexpr std::uint32_t kCounterLowMask = 0xFFFFu;

/** Microseconds in a second, for whole-second arithmetic on durations. */
constexpr std::int64_t kMicrosecondsPerSecond = 1000000;

}  // namespace hsn::roles::siren
