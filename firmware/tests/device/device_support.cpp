#include "device/device_support.hpp"

#include "hsn/device/services/record.hpp"
#include "hsn/device/services/setup.hpp"

namespace hsn::test {

void pair_board(host::HostBoard& board, std::uint8_t role, std::uint32_t address) {
  device::Record<device::RoleRecord> role_record(board.storage, device::StoreKey::role,
                                                 device::kRoleRecordVersion, {});
  REQUIRE(role_record.update(device::RoleRecord{role}) == device::HalError::none);
  device::PairingRecord pairing;
  pairing.address = address;
  pairing.key = kKey;
  pairing.hub_identity = {9, 8, 7, 6, 5, 4, 3, 2};
  pairing.site_channel = 1;
  pairing.allowed_data_rate_mask = 0x24;
  device::Record<device::PairingRecord> pairing_record(board.storage, device::StoreKey::pairing,
                                                       device::kPairingRecordVersion, {});
  REQUIRE(pairing_record.update(pairing) == device::HalError::none);
  const auto step = static_cast<std::uint32_t>(device::counter_step(role));
  const std::uint8_t resume[4] = {static_cast<std::uint8_t>(step & 0xFF),
                                  static_cast<std::uint8_t>(step >> 8), 0, 0};
  REQUIRE(board.storage.write(device::StoreKey::counter_resume, protocol::ByteView(resume)) ==
          device::HalError::none);
  board.set_key(kKey);
}

HubOpened hub_open(protocol::ByteView packet, const protocol::Binding& binding,
                   protocol::PacketLimit limit) {
  psa::PsaPacketCipher cipher;
  REQUIRE(cipher.set_key(kKey) == protocol::Error::none);
  Bytes plaintext(protocol::kMaxLinkPacketSize);
  const auto opened =
      protocol::open_packet(cipher, packet, protocol::Direction::to_hub, binding, limit,
                            protocol::MutableByteView(plaintext.data(), plaintext.size()));
  HubOpened result;
  if (!opened.ok()) {
    result.error = opened.error();
    return result;
  }
  result.header = opened.value().header;
  result.type = opened.value().type;
  result.body.assign(opened.value().body.begin(), opened.value().body.end());
  return result;
}

}  // namespace hsn::test
