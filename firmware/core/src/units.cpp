#include "hsn/protocol/units.hpp"

namespace hsn::protocol {
namespace {

constexpr std::uint32_t kBatteryBaseMillivolts = 2500;
constexpr std::uint32_t kBatteryStepMillivolts = 10;
constexpr std::uint32_t kSecondsPerUnit = 15;
constexpr std::uint32_t kMillisecondsPerTenth = 100;

}  // namespace

std::uint8_t battery_code_from_millivolts(std::uint32_t millivolts) {
  // At or below the base every value rounds to zero or less, so it clamps to 0.
  if (millivolts <= kBatteryBaseMillivolts) {
    return 0;
  }
  // 64-bit, so adding the half step cannot overflow for any input.
  const std::uint64_t above = static_cast<std::uint64_t>(millivolts - kBatteryBaseMillivolts);
  const std::uint64_t code = (above + kBatteryStepMillivolts / 2) / kBatteryStepMillivolts;
  return static_cast<std::uint8_t>(code > 255 ? 255 : code);
}

std::uint16_t millivolts_from_battery_code(std::uint8_t code) {
  return static_cast<std::uint16_t>(kBatteryBaseMillivolts + kBatteryStepMillivolts * code);
}

std::uint16_t seconds_from_fifteen_second_units(std::uint8_t units) {
  return static_cast<std::uint16_t>(kSecondsPerUnit * units);
}

std::optional<std::uint8_t> fifteen_second_units_from_seconds(std::uint32_t seconds) {
  if (seconds % kSecondsPerUnit != 0 || seconds / kSecondsPerUnit > 255) {
    return std::nullopt;
  }
  return static_cast<std::uint8_t>(seconds / kSecondsPerUnit);
}

std::uint32_t milliseconds_from_tenths(std::uint16_t tenths) {
  return kMillisecondsPerTenth * tenths;
}

std::optional<std::uint16_t> tenths_from_milliseconds(std::uint32_t milliseconds) {
  const std::uint64_t tenths =
      (static_cast<std::uint64_t>(milliseconds) + kMillisecondsPerTenth / 2) /
      kMillisecondsPerTenth;
  if (tenths > 0xFFFF) {
    return std::nullopt;
  }
  return static_cast<std::uint16_t>(tenths);
}

std::int16_t snr_hundredths_db_from_quarters(std::int8_t quarter_db) {
  return static_cast<std::int16_t>(quarter_db * 25);
}

}  // namespace hsn::protocol
