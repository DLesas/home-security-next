#include "device_support.hpp"
#include "hsn/device/services/setup.hpp"
#include "hsn/host/fake_clock.hpp"
#include "hsn/host/fake_storage.hpp"
#include "hsn/protocol/setup.hpp"

namespace hsn::test {
namespace {

struct Fixture {
  explicit Fixture(bool development) {
    build.development = development;
    storage.records[device::StoreKey::role] = {device::kRoleRecordVersion, protocol::Role::sensor};
  }

  /** Encodes a request and passes it through the public setup entry for the given link. */
  template <typename Message>
  device::SetupResult receive(device::SetupService& setup, const Message& message,
                              device::LinkKind link = device::LinkKind::bluetooth) {
    std::array<std::uint8_t, 256> input{};
    const auto encoded = protocol::encode_setup(message, protocol::MutableByteView(input));
    REQUIRE(encoded.ok());
    return setup.handle(link, protocol::ByteView(input).first(encoded.value()),
                        protocol::MutableByteView(output), log, {});
  }

  host::FakeClock clock;
  host::FakeStorage storage{clock};
  device::BuildInfo build;
  device::LogState logs{};
  device::LogBuffer log{logs};
  std::array<std::uint8_t, 32> output{};
};

TEST_CASE("F1: encrypted setup dispatch allows Identify and unpaired Provision") {
  for (const bool development : {false, true}) {
    Fixture f(development);
    device::SetupService setup(f.storage, f.build);
    REQUIRE(setup.load() == device::HalError::none);
    CHECK(f.receive(setup, protocol::Identify{}).reply_size == 22);
    CHECK(f.output[1] == protocol::setup_type::identity);
    CHECK(f.output[2] == protocol::Role::sensor);

    protocol::Provision provision;
    provision.pairing.address = kAddress;
    provision.pairing.key = kKey;
    provision.pairing.site_channel = 2;
    provision.pairing.allowed_data_rate_mask = 0x24;
    const auto network = f.receive(setup, provision, device::LinkKind::network);
    CHECK(network.reply_size == 0);
    CHECK(network.action == device::SetupAction::none);
    CHECK_FALSE(setup.paired());

    const auto first = f.receive(setup, provision);
    REQUIRE(first.reply_size == 3);
    CHECK(f.output[2] == protocol::ProvisionOutcome::accepted);
    CHECK(first.action == device::SetupAction::restart);
    CHECK(setup.pairing().address == kAddress);

    provision.pairing.address = kAddress + 1;
    const auto second = f.receive(setup, provision);
    REQUIRE(second.reply_size == 3);
    CHECK(f.output[2] == protocol::ProvisionOutcome::refused);
    CHECK(second.action == device::SetupAction::none);
    CHECK(setup.pairing().address == kAddress);
  }
}

TEST_CASE("F1: Bluetooth Provision requires a role in every build") {
  protocol::Provision provision;
  provision.pairing.address = kAddress;
  provision.pairing.key = kKey;
  provision.pairing.site_channel = 2;
  provision.pairing.allowed_data_rate_mask = 0x24;

  for (const bool development : {false, true}) {
    CAPTURE(development);
    Fixture unassigned(development);
    unassigned.storage.records.erase(device::StoreKey::role);
    device::SetupService without_role(unassigned.storage, unassigned.build);
    REQUIRE(without_role.load() == device::HalError::none);
    REQUIRE(without_role.role() == 0);
    REQUIRE_FALSE(without_role.paired());
    const auto refused = unassigned.receive(without_role, provision);
    REQUIRE(refused.reply_size == 3);
    CHECK(unassigned.output[1] == protocol::setup_type::provision_result);
    CHECK(unassigned.output[2] == protocol::ProvisionOutcome::refused);
    CHECK(refused.action == device::SetupAction::none);
    CHECK(unassigned.storage.operations.empty());
    CHECK(unassigned.storage.records.empty());
    CHECK_FALSE(without_role.paired());

    Fixture assigned(development);
    device::SetupService with_role(assigned.storage, assigned.build);
    REQUIRE(with_role.load() == device::HalError::none);
    REQUIRE(with_role.role() == protocol::Role::sensor);
    REQUIRE_FALSE(with_role.paired());
    const auto accepted = assigned.receive(with_role, provision);
    REQUIRE(accepted.reply_size == 3);
    CHECK(assigned.output[1] == protocol::setup_type::provision_result);
    CHECK(assigned.output[2] == protocol::ProvisionOutcome::accepted);
    CHECK(accepted.action == device::SetupAction::restart);
    CHECK(assigned.storage.has(device::StoreKey::pairing));
    CHECK(with_role.paired());
    CHECK(with_role.pairing().address == kAddress);
  }
}

TEST_CASE("F1: Bluetooth refuses Erase and Set role even in development") {
  Fixture f(true);
  device::SetupService setup(f.storage, f.build);
  REQUIRE(setup.load() == device::HalError::none);
  f.storage.records[device::StoreKey::counter_resume] = {1, 0, 0, 0};
  const auto erase = f.receive(setup, protocol::Erase{});
  CHECK(erase.reply_size == 0);
  CHECK(erase.action == device::SetupAction::none);
  CHECK(f.storage.has(device::StoreKey::counter_resume));
  const auto role = f.receive(setup, protocol::SetRole{protocol::Role::gateway});
  CHECK(role.reply_size == 0);
  CHECK(role.action == device::SetupAction::none);
  CHECK(setup.role() == protocol::Role::sensor);
}

}  // namespace
}  // namespace hsn::test
