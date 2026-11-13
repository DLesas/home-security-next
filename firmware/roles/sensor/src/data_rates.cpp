#include "hsn/roles/sensor/data_rates.hpp"

#include "hsn/protocol/radio.hpp"
#include "hsn/roles/sensor/sensor_constants.hpp"

namespace hsn::roles::sensor {
namespace {

/** The LoRa bandwidth, for the symbol time (§2, "LoRa settings"). */
constexpr std::int64_t kBandwidthHz = protocol::LoraSettings::bandwidth_hz;

/** Microseconds in a second. */
constexpr std::int64_t kMicrosPerSecond = 1000000;

/** The fastest data rate the protocol lists (§2): the default set's fast rate. */
constexpr std::uint8_t kFastestRate = protocol::DataRate::dr5;

/** DR5's spreading factor, SF7 (§2, "Data rates"), for a rate the protocol does not list. */
constexpr std::uint8_t kFastestSpreadingFactor = 7;

}  // namespace

bool is_known_rate(std::uint8_t data_rate) {
  return data_rate < kDataRateCount;
}

bool is_allowed_rate(std::uint8_t data_rate, std::uint8_t allowed_mask) {
  return is_known_rate(data_rate) && (allowed_mask & (1u << data_rate)) != 0;
}

std::uint8_t fastest_allowed_rate(std::uint8_t allowed_mask) {
  for (std::uint8_t step = 0; step < kDataRateCount; ++step) {
    const auto rate = static_cast<std::uint8_t>(kFastestRate - step);
    if (is_allowed_rate(rate, allowed_mask)) {
      return rate;
    }
  }
  return kFastestRate;
}

std::optional<std::uint8_t> slower_allowed_rate(std::uint8_t data_rate, std::uint8_t allowed_mask) {
  if (!is_known_rate(data_rate)) {
    return std::nullopt;
  }
  for (std::uint8_t rate = data_rate; rate > 0; --rate) {
    const auto slower = static_cast<std::uint8_t>(rate - 1);
    if (is_allowed_rate(slower, allowed_mask)) {
      return slower;
    }
  }
  return std::nullopt;
}

device::Duration heartbeat_interval(std::uint8_t interval_units, std::uint8_t send_rate) {
  const std::uint8_t units = interval_units == 0 ? kDefaultHeartbeatUnits : interval_units;
  const device::Duration hub = device::Duration{kHeartbeatUnit.us * units};
  device::Duration floor{};
  if (send_rate == protocol::DataRate::dr0) {
    floor = kMinHeartbeatAtSf12;
  } else if (send_rate == protocol::DataRate::dr1) {
    floor = kMinHeartbeatAtSf11;
  }
  return hub < floor ? floor : hub;
}

device::Duration event_listen_time(std::uint8_t send_rate) {
  const std::uint8_t rate = is_known_rate(send_rate) ? send_rate : kFastestRate;
  return device::milliseconds(kEventListenMs[rate]);
}

device::Duration symbol_time(std::uint8_t data_rate) {
  const auto factor = protocol::spreading_factor(data_rate);
  const std::uint8_t sf = factor.value_or(kFastestSpreadingFactor);
  return device::Duration{(std::int64_t{1} << sf) * kMicrosPerSecond / kBandwidthHz};
}

device::Duration reply_window(std::uint8_t reply_rate) {
  return kReplyEarly + kReplyLate +
         device::Duration{symbol_time(reply_rate).us * kReplyLateSymbols};
}

}  // namespace hsn::roles::sensor
