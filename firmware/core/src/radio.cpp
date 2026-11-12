#include "hsn/protocol/radio.hpp"

#include "hsn/protocol/layout.hpp"
#include "hsn/protocol/packet.hpp"

namespace hsn::protocol {
namespace {

constexpr std::uint32_t kMicrosecondsPerSecond = 1000000;
constexpr std::uint8_t kSlowestSpreadingFactor = 12;
// Low data rate optimisation is on at SF11 and SF12 (section 2).
constexpr std::uint8_t kLowDataRateFrom = 11;

}  // namespace

std::optional<std::uint8_t> spreading_factor(std::uint8_t data_rate) {
  if (!is_known<DataRate>(data_rate)) {
    return std::nullopt;
  }
  return static_cast<std::uint8_t>(kSlowestSpreadingFactor - data_rate);
}

Result<std::uint32_t> time_on_air_microseconds(std::uint8_t data_rate, std::size_t length) {
  const std::optional<std::uint8_t> found = spreading_factor(data_rate);
  if (!found) {
    return Error::bad_value;
  }
  if (length > kMaxRadioPacketSize) {
    return Error::too_long;
  }
  const std::int32_t sf = *found;
  const std::int32_t low_data_rate = sf >= kLowDataRateFrom ? 1 : 0;
  // sx126x_get_lora_time_on_air_numerator, for SF7 to SF12:
  //   payload symbols = ceil(max(8·PL + 16·CRC − 4·SF + 8 + 20·H, 0) / (4·(SF − 2·DE))) · (CR + 4)
  //   total symbols   = payload symbols + preamble + 12.25
  //   time            = total symbols · 2^SF / BW
  // With everything bounded (PL ≤ 255), int32 holds every intermediate value.
  std::int32_t numerator = 8 * static_cast<std::int32_t>(length) + (LoraSettings::crc_on ? 16 : 0) -
                           4 * sf + 8 + (LoraSettings::explicit_header ? 20 : 0);
  if (numerator < 0) {
    numerator = 0;
  }
  const std::int32_t denominator = 4 * (sf - 2 * low_data_rate);
  const std::int32_t payload_symbols = (numerator + denominator - 1) / denominator *
                                       static_cast<std::int32_t>(LoraSettings::coding_rate + 4);
  const std::int32_t whole_symbols =
      payload_symbols + static_cast<std::int32_t>(LoraSettings::preamble_symbols) + 12;
  // Quarter symbols, so the extra 0.25 stays an integer: (4·symbols + 1) · 2^(SF−2) / BW seconds.
  const std::uint64_t quarter_symbols = static_cast<std::uint64_t>(4 * whole_symbols + 1);
  const std::uint64_t scaled =
      quarter_symbols * (std::uint64_t{1} << (sf - 2)) * kMicrosecondsPerSecond;
  // At 125 kHz every result divides exactly; the largest (SF12, 255 bytes) is about 9 seconds.
  return static_cast<std::uint32_t>(scaled / LoraSettings::bandwidth_hz);
}

}  // namespace hsn::protocol
