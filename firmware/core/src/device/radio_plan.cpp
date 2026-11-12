#include "hsn/device/services/radio_plan.hpp"

#include "hsn/protocol/radio.hpp"

namespace hsn::device {
namespace {

/** One spreading factor's CAD settings and measured duration (hardware notes section 3). */
struct CadRow {
  std::uint8_t spreading_factor;
  std::uint8_t symbols;
  std::uint8_t detect_peak;
  std::uint32_t duration_us;
};

constexpr CadRow kCadRows[] = {
    {7, 2, 22, 2660},   {8, 2, 22, 5390},   {9, 4, 23, 19150},
    {10, 4, 24, 38730}, {11, 4, 25, 78410}, {12, 4, 28, 158790},
};

constexpr std::uint8_t kCadDetectMin = 10;

const CadRow* cad_row(std::uint8_t data_rate) {
  const auto spreading_factor = protocol::spreading_factor(data_rate);
  if (!spreading_factor.has_value()) {
    return nullptr;
  }
  for (const CadRow& row : kCadRows) {
    if (row.spreading_factor == *spreading_factor) {
      return &row;
    }
  }
  return nullptr;
}

}  // namespace

std::optional<std::uint32_t> site_channel_frequency(std::uint8_t site_channel) {
  switch (site_channel) {
    case 0:
      return 868100000u;
    case 1:
      return 868300000u;
    case 2:
      return 868500000u;
    default:
      return std::nullopt;
  }
}

std::optional<Band> band_of(std::uint32_t frequency_hz) {
  if (frequency_hz >= 868000000u && frequency_hz <= 868600000u) {
    return Band::g1;
  }
  if (frequency_hz >= 869400000u && frequency_hz <= 869650000u) {
    return Band::g3;
  }
  return std::nullopt;
}

Duration hourly_limit(Band band) {
  return band == Band::g1 ? seconds(36) : seconds(360);
}

std::optional<CadParams> cad_params(const RadioChannel& channel) {
  const CadRow* row = cad_row(channel.data_rate);
  if (row == nullptr) {
    return std::nullopt;
  }
  CadParams params;
  params.channel = channel;
  params.symbols = row->symbols;
  params.detect_peak = row->detect_peak;
  params.detect_min = kCadDetectMin;
  return params;
}

std::optional<Duration> cad_duration(std::uint8_t data_rate) {
  const CadRow* row = cad_row(data_rate);
  if (row == nullptr) {
    return std::nullopt;
  }
  return microseconds((row->duration_us + 999) / 1000 * 1000);
}

std::optional<Duration> time_on_air(std::uint8_t data_rate, std::size_t length) {
  const auto time = protocol::time_on_air_microseconds(data_rate, length);
  if (!time.ok()) {
    return std::nullopt;
  }
  return microseconds(time.value());
}

}  // namespace hsn::device
