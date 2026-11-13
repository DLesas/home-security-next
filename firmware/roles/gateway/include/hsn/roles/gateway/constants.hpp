#pragma once

#include <cstddef>
#include <cstdint>

#include "hsn/device/time.hpp"

namespace hsn::roles::gateway {

/** While a computer is attached, a hello goes on USB this often (protocol section 10, D81). */
constexpr device::Duration kUsbHelloInterval = device::seconds(2);

/** Without a welcome on USB this long, the gateway uses Wi-Fi (protocol section 10, D81). */
constexpr device::Duration kUsbWelcomeWindow = device::seconds(10);

/** On Wi-Fi, USB is tried again this often while a computer is attached (protocol section 10). */
constexpr device::Duration kUsbRetryInterval = device::seconds(30);

/**
 * How long a hello on Wi-Fi waits for its welcome before the connection counts as failed. The
 * protocol names no time for Wi-Fi; this reads section 10's ten seconds for USB as the time any
 * welcome has to come (protocol section 7, "Gateway connection").
 */
constexpr device::Duration kWelcomeTimeout = device::seconds(10);

/** Status interval held until settings name one (protocol section 8); 0 is not valid (section 6).
 */
constexpr std::uint8_t kDefaultStatusSeconds = 30;

/** Interference alert level and duration held until settings name them (protocol section 8, †). */
constexpr std::uint8_t kDefaultInterferenceDb = 10;
constexpr std::uint8_t kDefaultInterferenceSeconds = 30;

/**
 * Transmit requests held at once (design section 7, gateway): 16, set from the gateway load
 * sweep, where an armed burst with four sirens filled a queue of 8.
 */
constexpr std::size_t kTransmitQueueSize = 16;

/**
 * How late a request "at a given time" may still go out: one reached later than this is answered
 * "too late" and not sent, since the device has stopped listening (protocol section 6, †).
 */
constexpr device::Duration kMomentTolerance = device::milliseconds(20);

/** Noise samples kept between two statuses (design section 7, gateway). */
constexpr std::size_t kNoiseSampleCount = 64;

/** How often the noise level is sampled while listening (design section 7; GW11, D82). */
constexpr device::Duration kNoiseSampleInterval = device::seconds(1);

/**
 * Weight of the learned normal noise level: a new sample moves it by 1/kNormalNoiseWeight, an
 * integer average over about the last minute of quiet samples (D82).
 */
constexpr std::int32_t kNormalNoiseWeight = 64;

/** Fixed-point scale of the learned normal noise level: sixteenths of a dB. */
constexpr std::int32_t kNoiseScale = 16;

/** What a status reports for a noise level when no sample was taken since the last one. */
constexpr std::int8_t kNoNoiseReading = -128;

/** The radio's highest transmit power (protocol section 2: up to +22 dBm). */
constexpr std::int8_t kMaxTxPowerDbm = 22;

/** Bytes of the longest radio packet, the bound for a reception's guard (protocol section 3). */
constexpr std::size_t kLongestRadioPacket = 255;

/** After a radio call fails and recovery fails too, the radio is tried again this much later. */
constexpr device::Duration kRadioRetryInterval = device::seconds(1);

/** Layout version of the stored settings record (design section 5). */
constexpr std::uint8_t kSettingsRecordVersion = 1;

/** Half the span of the 32-bit microsecond clock: the reach of "the nearest instant". */
constexpr std::uint64_t kClockHalfSpan = std::uint64_t{1} << 31;

/** The span of the 32-bit microsecond clock (protocol section 6). */
constexpr std::uint64_t kClockSpan = std::uint64_t{1} << 32;

/** Microseconds per second, for whole-second fields. */
constexpr std::int64_t kMicrosPerSecond = 1000000;

}  // namespace hsn::roles::gateway
