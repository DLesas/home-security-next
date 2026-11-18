#include "hsn/host/provisioning.hpp"

#include <algorithm>

#include "hsn/device/services/record.hpp"
#include "hsn/device/services/setup.hpp"
#include "hsn/host/simulation_error.hpp"

namespace hsn::host {

void provision(HostBoard& board, const Provisioning& provisioning) {
  device::Record<device::RoleRecord> role(board.storage, device::StoreKey::role,
                                          device::kRoleRecordVersion, {});
  device::PairingRecord pairing;
  pairing.address = provisioning.address;
  pairing.key = provisioning.key;
  pairing.hub_identity = provisioning.hub_identity;
  pairing.firmware_signing_key = provisioning.signing_key;
  pairing.site_channel = provisioning.site_channel;
  pairing.allowed_data_rate_mask = provisioning.allowed_data_rate_mask;
  pairing.wifi_name_size =
      static_cast<std::uint8_t>(std::min(provisioning.wifi_name.size(), pairing.wifi_name.size()));
  std::copy_n(provisioning.wifi_name.begin(), pairing.wifi_name_size, pairing.wifi_name.begin());
  pairing.wifi_password_size = static_cast<std::uint8_t>(
      std::min(provisioning.wifi_password.size(), pairing.wifi_password.size()));
  std::copy_n(provisioning.wifi_password.begin(), pairing.wifi_password_size,
              pairing.wifi_password.begin());
  device::Record<device::PairingRecord> stored(board.storage, device::StoreKey::pairing,
                                               device::kPairingRecordVersion, {});
  const auto step = static_cast<std::uint32_t>(device::counter_step(provisioning.role));
  const std::uint8_t resume[4] = {static_cast<std::uint8_t>(step & 0xFFu),
                                  static_cast<std::uint8_t>((step >> 8) & 0xFFu), 0, 0};
  if (role.update(device::RoleRecord{provisioning.role}) != device::HalError::none ||
      stored.update(pairing) != device::HalError::none ||
      board.storage.write(device::StoreKey::counter_resume, protocol::ByteView(resume)) !=
          device::HalError::none) {
    throw SimulationError("flash refused the provisioning records");
  }
  board.set_key(provisioning.key);
}

void make_board(HostBoard& board, std::uint8_t role) {
  device::Record<device::RoleRecord> stored(board.storage, device::StoreKey::role,
                                            device::kRoleRecordVersion, {});
  if (stored.update(device::RoleRecord{role}) != device::HalError::none) {
    throw SimulationError("flash refused the role");
  }
}

bool import_stored_key(HostBoard& board) {
  device::Record<device::PairingRecord> stored(board.storage, device::StoreKey::pairing,
                                               device::kPairingRecordVersion, {});
  if (stored.load() != device::HalError::none) {
    return false;
  }
  board.set_key(stored.get().key);
  return true;
}

}  // namespace hsn::host
