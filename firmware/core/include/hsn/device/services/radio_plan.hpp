#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>

#include "hsn/device/hal/radio.hpp"
#include "hsn/device/time.hpp"

namespace hsn::device {

/** The hub's reply and command frequency (protocol section 2). */
constexpr std::uint32_t kReplyFrequencyHz = 869525000;

/**
 * Returns the frequency of a site channel number (0 = 868.1, 1 = 868.3, 2 = 868.5 MHz), or
 * nothing for an unlisted one, which a device ignores (protocol section 3).
 */
std::optional<std::uint32_t> site_channel_frequency(std::uint8_t site_channel);

/** The two sub-bands this protocol uses, each with its own airtime limit (D104). */
enum class Band : std::uint8_t {
  /** 868.0–868.6 MHz, 1% per hour: the site channels. */
  g1 = 0,
  /** 869.4–869.65 MHz, 10% per hour: replies and commands. */
  g3 = 1,
};

/** Number of sub-bands. */
constexpr std::size_t kBandCount = 2;

/** Returns the sub-band of a frequency, or nothing outside both. */
std::optional<Band> band_of(std::uint32_t frequency_hz);

/** Returns a sub-band's airtime over a rolling hour: 36 s for g1, 360 s for g3. */
Duration hourly_limit(Band band);

/**
 * Returns Semtech's recommended channel activity detection settings for a channel's spreading
 * factor (hardware notes section 3, AN1200.48), or nothing for an unlisted data rate.
 */
std::optional<CadParams> cad_params(const RadioChannel& channel);

/**
 * Returns how long a CAD takes at a data rate, from AN1200.48's measurements, rounded up to the
 * millisecond, or nothing for an unlisted data rate.
 */
std::optional<Duration> cad_duration(std::uint8_t data_rate);

/** Returns a packet's time on air, or nothing for an unlisted data rate or over 255 bytes. */
std::optional<Duration> time_on_air(std::uint8_t data_rate, std::size_t length);

}  // namespace hsn::device
