#include "hsn/roles/gateway/gateway_settings.hpp"

#include <cstddef>

#include "hsn/protocol/radio.hpp"

namespace hsn::roles::gateway {

HeldSettings HeldSettings::from(const protocol::GatewaySettings& message) {
  HeldSettings held;
  held.version = message.settings_version;
  held.site_channel = message.site_channel;
  held.listen_data_rate_mask = message.listen_data_rate_mask;
  held.status_interval_seconds = message.status_interval_seconds;
  held.interference_threshold_db = message.interference_threshold_db;
  held.interference_seconds = message.interference_seconds;
  held.default_tx_power_dbm = message.default_tx_power_dbm;
  held.siren_tx_power_dbm = message.siren_tx_power_dbm;
  return held;
}

std::optional<std::uint8_t> listen_data_rate(std::uint8_t mask) {
  // DR0 is the slowest (SF12): the lowest listed index named wins.
  for (const std::uint8_t rate : protocol::DataRate::known) {
    if ((mask & (1u << rate)) != 0) {
      return rate;
    }
  }
  return std::nullopt;
}

bool names_several_data_rates(std::uint8_t mask) {
  std::size_t named = 0;
  for (const std::uint8_t rate : protocol::DataRate::known) {
    if ((mask & (1u << rate)) != 0) {
      ++named;
    }
  }
  return named > 1;
}

device::Duration status_interval(const HeldSettings& settings) {
  return device::seconds(settings.status_interval_seconds == 0 ? kDefaultStatusSeconds
                                                               : settings.status_interval_seconds);
}

InterferenceLimits interference_limits(const HeldSettings& settings) {
  InterferenceLimits limits;
  limits.threshold_db = settings.interference_threshold_db == 0
                            ? kDefaultInterferenceDb
                            : settings.interference_threshold_db;
  limits.seconds = settings.interference_seconds == 0 ? kDefaultInterferenceSeconds
                                                      : settings.interference_seconds;
  return limits;
}

}  // namespace hsn::roles::gateway
