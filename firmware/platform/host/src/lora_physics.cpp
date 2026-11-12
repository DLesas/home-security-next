#include "hsn/host/lora_physics.hpp"

#include <string>

#include "hsn/host/simulation_error.hpp"
#include "hsn/protocol/radio.hpp"

namespace hsn::host {
namespace {

std::uint8_t spreading_factor_of(std::uint8_t data_rate) {
  const auto factor = protocol::spreading_factor(data_rate);
  if (!factor.has_value()) {
    throw SimulationError("unlisted data rate " + std::to_string(data_rate));
  }
  return *factor;
}

}  // namespace

double demodulation_snr_db(std::uint8_t data_rate) {
  // −7.5 dB at SF7, 2.5 dB lower per step.
  return -7.5 - 2.5 * (spreading_factor_of(data_rate) - 7);
}

device::Duration symbol_time(std::uint8_t data_rate) {
  // 2^SF chips at 125,000 chips per second: 8 µs per chip.
  return device::microseconds(std::int64_t{8} << spreading_factor_of(data_rate));
}

device::Duration preamble_detect_time(std::uint8_t data_rate, std::uint8_t symbol_timeout) {
  const std::int64_t symbols = symbol_timeout == 0 ? 1 : (symbol_timeout > 8 ? 8 : symbol_timeout);
  return device::microseconds(symbols * symbol_time(data_rate).us);
}

device::Duration header_time(std::uint8_t data_rate) {
  // 20.25 symbols, as quarters.
  return device::microseconds(81 * symbol_time(data_rate).us / 4);
}

}  // namespace hsn::host
