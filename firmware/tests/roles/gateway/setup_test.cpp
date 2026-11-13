// Added by plugging it into the hub computer (§10 setup messages; PR7, D100): a release gateway
// with its role stored and no pairing accepts Provision on USB, restarts, and then connects over
// that same cable with the key it was given; a gateway already paired to a hub refuses.

#include "hsn/device/services/setup.hpp"
#include "gateway_bench.hpp"
#include "hsn/device/services/record.hpp"
#include "hsn/protocol/setup.hpp"

namespace hsn::test {
namespace {

using roles::gateway::ConnectionPhase;

/** A Provision message carrying `pairing`. */
Bytes provision_message(const host::Provisioning& pairing) {
  protocol::Provision message;
  message.pairing.address = pairing.address;
  message.pairing.key = pairing.key;
  message.pairing.hub_identity = pairing.hub_identity;
  message.pairing.site_channel = pairing.site_channel;
  message.pairing.allowed_data_rate_mask = pairing.allowed_data_rate_mask;
  message.pairing.wifi_name.bytes = protocol::ByteView(
      reinterpret_cast<const std::uint8_t*>(pairing.wifi_name.data()), pairing.wifi_name.size());
  message.pairing.wifi_password.bytes =
      protocol::ByteView(reinterpret_cast<const std::uint8_t*>(pairing.wifi_password.data()),
                         pairing.wifi_password.size());
  Bytes out(256);
  const auto size =
      protocol::encode_setup(message, protocol::MutableByteView(out.data(), out.size()));
  REQUIRE(size.ok());
  out.resize(size.value());
  return out;
}

/** A gateway board with only its role stored, as it leaves the factory. */
host::SimDevice& factory_gateway(host::Simulation& sim) {
  host::DeviceSpec spec;
  spec.name = "gateway";
  spec.role = gateway_role();
  host::SimDevice& device = sim.add_device(spec);
  device.board().power.external = true;
  // A release build: the rules of §10 for one (the bench's boards are development builds).
  device.board().hal().build.development = false;
  device::Record<device::RoleRecord> role(device.board().storage, device::StoreKey::role,
                                          device::kRoleRecordVersion, {});
  REQUIRE(role.update(device::RoleRecord{protocol::Role::gateway}) == device::HalError::none);
  return device;
}

/** The provision results the gateway sent on USB, read from the port itself. */
std::vector<std::uint8_t> provision_results(host::SimDevice& gateway) {
  std::vector<std::uint8_t> results;
  for (const host::FakeLink::Sent& sent : gateway.board().usb.sent) {
    if (sent.packet.size() >= 3 && sent.packet[0] == protocol::kSetupMarker &&
        sent.packet[1] == protocol::setup_type::provision_result) {
      results.push_back(sent.packet[2]);
    }
  }
  return results;
}

TEST_CASE("PR7 D100 a new gateway on the hub computer's USB is paired and connects there") {
  host::Simulation sim;
  host::SimDevice& gateway = factory_gateway(sim);
  const host::Provisioning pairing = gateway_pairing(0x6A7E0042);
  LinkHub hub(sim, gateway, pairing);
  hub.attach(device::LinkKind::usb);
  sim.run_until(at(seconds(1)));
  // Unpaired, the role does not run: nothing but setup on the cable.
  CHECK(hub.hellos == 0);
  sim.schedule(at(seconds(1)), [&]() { hub.send_raw(provision_message(pairing)); });
  sim.run_until(at(seconds(4)));
  INFO(sim.timeline().select().dump());
  CHECK(provision_results(gateway) ==
        std::vector<std::uint8_t>{protocol::ProvisionOutcome::accepted});
  // The restart that follows lets the result finish reaching the hub (design, Waiter): first time.
  CHECK(hub.provision_results == std::vector<std::uint8_t>{protocol::ProvisionOutcome::accepted});
  CHECK(gateway.boots() == 2);
  // Paired and restarted, it says hello on the same cable with its new key, and is welcomed.
  CHECK(hub.hellos == 1);
  CHECK(gateway_of(gateway).state().connection.link == device::LinkKind::usb);
  CHECK(gateway_of(gateway).state().connection.phase == ConnectionPhase::connected);
  CHECK(hub.got(type::started).size() == 1);
  CHECK(gateway.board().network.connects == 0);
}

TEST_CASE("D100 a gateway paired to a hub is left alone when plugged into another") {
  host::Simulation sim;
  host::DeviceSpec spec;
  spec.name = "gateway";
  spec.role = gateway_role();
  host::SimDevice& gateway = sim.add_device(spec);
  gateway.board().power.external = true;
  gateway.board().hal().build.development = false;
  host::provision(gateway.board(), gateway_pairing());
  LinkHub hub(sim, gateway, gateway_pairing());
  hub.auto_welcome = false;
  hub.attach(device::LinkKind::usb);
  host::Provisioning other = gateway_pairing(0x0BADCAFE);
  other.key[0] ^= 0xFF;
  sim.schedule(at(seconds(1)), [&]() { hub.send_raw(provision_message(other)); });
  sim.run_until(at(seconds(3)));
  CHECK(provision_results(gateway) ==
        std::vector<std::uint8_t>{protocol::ProvisionOutcome::refused});
  CHECK(hub.provision_results == std::vector<std::uint8_t>{protocol::ProvisionOutcome::refused});
  CHECK(gateway.boots() == 1);
  device::Record<device::PairingRecord> stored(gateway.board().storage, device::StoreKey::pairing,
                                               device::kPairingRecordVersion, {});
  REQUIRE(stored.load() == device::HalError::none);
  CHECK(stored.get().address == gateway_pairing().address);
}

}  // namespace
}  // namespace hsn::test
