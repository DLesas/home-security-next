#pragma once

#include <cstdint>
#include <string>

#include "hsn/host/host_board.hpp"
#include "hsn/protocol/setup.hpp"

namespace hsn::host {

/** What a board is given when it is made and paired (protocol sections 9 and 10). */
struct Provisioning {
  /** protocol::Role. */
  std::uint8_t role = 0;
  std::uint32_t address = 0;
  protocol::DeviceKey key{};
  protocol::HubIdentity hub_identity{9, 8, 7, 6, 5, 4, 3, 2};
  /** 0 = 868.1, 1 = 868.3, 2 = 868.5 MHz. */
  std::uint8_t site_channel = 1;
  /** One bit per data rate the site allows: DR5 and DR2 by default (protocol section 2). */
  std::uint8_t allowed_data_rate_mask = 0x24;
  std::string wifi_name = "home";
  std::string wifi_password = "secret";
};

/**
 * Stores the role, the pairing record and a resume point of one step in the board's flash, as Set
 * role and Provision do, and imports the key into the board's cipher. Call before the board's
 * first boot; throws SimulationError if flash refuses.
 */
void provision(HostBoard& board, const Provisioning& provisioning);

/**
 * Imports the stored pairing's key into the board's cipher, as the platform does at every start;
 * returns false when the board is not paired.
 */
bool import_stored_key(HostBoard& board);

}  // namespace hsn::host
