#pragma once

#include <cstdint>

#include "hsn/device/time.hpp"

namespace hsn::host {

/**
 * Thermal noise in a 125 kHz channel with a 6 dB receiver noise figure: −174 + 51 + 6 dBm. With
 * the SNR limits below it gives the SX126x's sensitivities (−124.5 dBm at SF7, −137 at SF12).
 */
constexpr double kThermalNoiseDbm = -117.0;

/** The capture margin of the protocol's design: one packet survives another 6 dB weaker. */
constexpr double kDefaultCaptureMarginDb = 6.0;

/**
 * Returns the lowest signal-to-noise ratio a data rate demodulates at, in dB (Semtech's table:
 * −7.5 dB at SF7 down to −20 dB at SF12). Throws SimulationError for an unlisted data rate.
 */
double demodulation_snr_db(std::uint8_t data_rate);

/** Returns one LoRa symbol at 125 kHz: 2^SF ÷ 125 kHz. Throws for an unlisted data rate. */
device::Duration symbol_time(std::uint8_t data_rate);

/**
 * Returns how long after a packet's start a receiver confirms its preamble: the receive's symbol
 * timeout in symbols (at least one, at most the 8-symbol preamble).
 */
device::Duration preamble_detect_time(std::uint8_t data_rate, std::uint8_t symbol_timeout);

/**
 * Returns how long after a packet's start its explicit header has been received: the 8-symbol
 * preamble, 4.25 sync symbols and the 8-symbol header block.
 */
device::Duration header_time(std::uint8_t data_rate);

}  // namespace hsn::host
