#pragma once

#include <cstdint>
#include <optional>

#include "hsn/device/hal/storage.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/roles/gateway/constants.hpp"
#include "hsn/roles/gateway/noise_monitor.hpp"

namespace hsn::roles::gateway {

/** Where the gateway keeps the settings it holds (its key range, design section 3). */
constexpr device::StoreKey kSettingsKey = device::StoreKey::gateway_first;

/**
 * The gateway settings held (protocol section 6, gateway settings), as stored: eight bytes, no
 * padding. Version 0 means none have arrived yet; the site channel and data rates then come from
 * the pairing data.
 */
struct HeldSettings {
  std::uint8_t version = 0;
  std::uint8_t site_channel = 0;
  std::uint8_t listen_data_rate_mask = 0;
  std::uint8_t status_interval_seconds = kDefaultStatusSeconds;
  std::uint8_t interference_threshold_db = kDefaultInterferenceDb;
  std::uint8_t interference_seconds = kDefaultInterferenceSeconds;
  std::int8_t default_tx_power_dbm = 0;
  std::int8_t siren_tx_power_dbm = 0;

  /** Copies a settings message. */
  static HeldSettings from(const protocol::GatewaySettings& message);
};

/**
 * Returns the one data rate to listen at for a mask (O14: one radio hears one data rate): the
 * slowest the mask names, or nothing when it names no rate this version lists.
 */
std::optional<std::uint8_t> listen_data_rate(std::uint8_t mask);

/**
 * Returns true when the mask names more than one listed data rate, which this gateway cannot
 * hear at once (O14, spike S7).
 */
bool names_several_data_rates(std::uint8_t mask);

/**
 * Returns the status interval in force: the settings', or the default for a 0, which the gateway
 * never holds but a record from older firmware might.
 */
device::Duration status_interval(const HeldSettings& settings);

/** Returns the interference limits in force: the settings', or the defaults for a 0 (as above). */
InterferenceLimits interference_limits(const HeldSettings& settings);

}  // namespace hsn::roles::gateway
