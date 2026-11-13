// USB setup messages and their rules (protocol section 10), and health reporting (FW5, FW8).

#include "device_support.hpp"
#include "hsn/device/services/health.hpp"
#include "hsn/device/services/setup.hpp"
#include "hsn/host/fake_clock.hpp"
#include "hsn/host/fake_storage.hpp"
#include "hsn/protocol/setup.hpp"

namespace hsn::test {
namespace {

using device::SetupAction;
using device::SetupService;
using device::StoreKey;
using protocol::ProvisionOutcome;
using protocol::Role;

struct Fixture {
  explicit Fixture(bool development) {
    build.development = development;
    build.version = protocol::FirmwareVersion{1, 2, 3};
    build.chip_id = {1, 2, 3, 4, 5, 6};
  }

  template <typename Message>
  device::SetupResult send(SetupService& setup, const Message& message) {
    Bytes bytes(300);
    const auto size =
        protocol::encode_setup(message, protocol::MutableByteView(bytes.data(), bytes.size()));
    REQUIRE(size.ok());
    bytes.resize(size.value());
    return send_bytes(setup, bytes);
  }

  device::SetupResult send_bytes(SetupService& setup, const Bytes& bytes) {
    reply.assign(64, 0);
    return setup.handle(view_of(bytes), protocol::MutableByteView(reply.data(), reply.size()), log,
                        at_seconds(1));
  }

  std::uint8_t provision_outcome(const device::SetupResult& result) const {
    std::uint8_t outcome = 0xFF;
    REQUIRE(protocol::decode_setup(protocol::ByteView(reply.data(), result.reply_size),
                                   [&](const auto& message) {
                                     using M = std::decay_t<decltype(message)>;
                                     if constexpr (std::is_same_v<M, protocol::ProvisionResult>) {
                                       outcome = message.result;
                                     }
                                   }) == protocol::Error::none);
    return outcome;
  }

  protocol::Identity identity(const device::SetupResult& result) const {
    protocol::Identity identity;
    REQUIRE(protocol::decode_setup(protocol::ByteView(reply.data(), result.reply_size),
                                   [&](const auto& message) {
                                     using M = std::decay_t<decltype(message)>;
                                     if constexpr (std::is_same_v<M, protocol::Identity>) {
                                       identity = message;
                                     }
                                   }) == protocol::Error::none);
    return identity;
  }

  host::FakeClock clock;
  host::FakeStorage storage{clock};
  device::BuildInfo build;
  device::LogState log_state;
  device::LogBuffer log{log_state};
  Bytes reply;
};

protocol::Provision provision_message(std::uint32_t address = kAddress) {
  protocol::Provision message;
  message.pairing.address = address;
  message.pairing.key = kKey;
  message.pairing.hub_identity = {1, 1, 2, 2, 3, 3, 4, 4};
  message.pairing.site_channel = 2;
  message.pairing.allowed_data_rate_mask = 0x24;
  static const std::uint8_t name[] = {'h', 'o', 'm', 'e'};
  message.pairing.wifi_name.bytes = protocol::ByteView(name);
  return message;
}

void store_role(Fixture& f, std::uint8_t role) {
  f.storage.records[StoreKey::role] = Bytes{device::kRoleRecordVersion, role};
}

TEST_CASE("identify is answered with the identity") {
  Fixture f(false);
  store_role(f, Role::gateway);
  SetupService setup(f.storage, f.build);
  REQUIRE(setup.load() == device::HalError::none);
  const auto result = f.send(setup, protocol::Identify{});
  REQUIRE(result.reply_size > 0);
  CHECK(result.action == SetupAction::none);
  const auto identity = f.identity(result);
  CHECK(identity.role == Role::gateway);
  CHECK(identity.chip_id == f.build.chip_id);
  CHECK(identity.firmware_version.minor == 2);
  CHECK_FALSE(identity.paired);
  CHECK(identity.hub_identity == protocol::HubIdentity{});
  CHECK_FALSE(identity.development_build);
}

TEST_CASE("a release gateway accepts provision only while unpaired") {
  Fixture f(false);
  store_role(f, Role::gateway);
  SetupService setup(f.storage, f.build);
  REQUIRE(setup.load() == device::HalError::none);
  const auto first = f.send(setup, provision_message());
  CHECK(f.provision_outcome(first) == ProvisionOutcome::accepted);
  CHECK(first.action == SetupAction::restart);
  CHECK(setup.paired());
  CHECK(setup.pairing().address == kAddress);
  CHECK(setup.pairing().wifi_name_size == 4);
  // A fresh resume point of one step for a gateway (protocol section 4).
  CHECK(f.storage.records[StoreKey::counter_resume] == Bytes{0x00, 0x04, 0x00, 0x00});
  CHECK(f.identity(f.send(setup, protocol::Identify{})).paired);
  const auto second = f.send(setup, provision_message(kAddress + 1));
  CHECK(f.provision_outcome(second) == ProvisionOutcome::refused);
  CHECK(second.action == SetupAction::none);
  CHECK(setup.pairing().address == kAddress);
}

TEST_CASE("release sensors and sirens refuse provision; development builds accept it any time") {
  for (const std::uint8_t role : {Role::sensor, Role::siren}) {
    Fixture f(false);
    store_role(f, role);
    SetupService setup(f.storage, f.build);
    REQUIRE(setup.load() == device::HalError::none);
    CHECK(f.provision_outcome(f.send(setup, provision_message())) == ProvisionOutcome::refused);
    CHECK_FALSE(setup.paired());
  }
  Fixture f(true);
  store_role(f, Role::sensor);
  SetupService setup(f.storage, f.build);
  REQUIRE(setup.load() == device::HalError::none);
  CHECK(f.provision_outcome(f.send(setup, provision_message())) == ProvisionOutcome::accepted);
  f.storage.records[StoreKey::command_counter] = Bytes{1, 0, 0, 0};
  CHECK(f.provision_outcome(f.send(setup, provision_message(kAddress + 7))) ==
        ProvisionOutcome::accepted);
  CHECK(setup.pairing().address == kAddress + 7);
  CHECK_FALSE(f.storage.has(StoreKey::command_counter));
  CHECK(f.storage.records[StoreKey::counter_resume] == Bytes{0x40, 0x00, 0x00, 0x00});
  CHECK(f.storage.has(StoreKey::role));
}

TEST_CASE("pairing data that does not decode is answered not valid") {
  Fixture f(true);
  store_role(f, Role::sensor);
  SetupService setup(f.storage, f.build);
  REQUIRE(setup.load() == device::HalError::none);
  Bytes bytes(300);
  const auto size = protocol::encode_setup(provision_message(),
                                           protocol::MutableByteView(bytes.data(), bytes.size()));
  REQUIRE(size.ok());
  bytes.resize(size.value());
  bytes[2] = 2;  // pairing format version 2
  const auto result = f.send_bytes(setup, bytes);
  CHECK(f.provision_outcome(result) == ProvisionOutcome::not_valid);
  CHECK_FALSE(setup.paired());
}

TEST_CASE("erase works in development builds only and keeps the role") {
  Fixture release(false);
  store_role(release, Role::sensor);
  SetupService release_setup(release.storage, release.build);
  REQUIRE(release_setup.load() == device::HalError::none);
  CHECK(release.send(release_setup, protocol::Erase{}).action == SetupAction::none);
  CHECK(release.log.size() == 1);

  Fixture dev(true);
  store_role(dev, Role::siren);
  SetupService setup(dev.storage, dev.build);
  REQUIRE(setup.load() == device::HalError::none);
  REQUIRE(dev.provision_outcome(dev.send(setup, provision_message())) ==
          ProvisionOutcome::accepted);
  const auto erased = dev.send(setup, protocol::Erase{});
  CHECK(erased.action == SetupAction::restart);
  CHECK(erased.reply_size == 0);
  CHECK_FALSE(setup.paired());
  CHECK_FALSE(dev.storage.has(StoreKey::pairing));
  CHECK(setup.role() == Role::siren);
}

TEST_CASE("set role: release only while none is stored; development any time; unlisted refused") {
  Fixture release(false);
  SetupService setup(release.storage, release.build);
  REQUIRE(setup.load() == device::HalError::none);
  protocol::SetRole message;
  message.role = 9;
  const auto unlisted = release.send(setup, message);
  CHECK(unlisted.action == SetupAction::none);
  CHECK(release.identity(unlisted).role == 0);
  message.role = Role::gateway;
  const auto set = release.send(setup, message);
  CHECK(set.action == SetupAction::restart);
  CHECK(release.identity(set).role == Role::gateway);
  CHECK(device::stored_role(release.storage) == Role::gateway);
  message.role = Role::siren;
  const auto refused = release.send(setup, message);
  CHECK(refused.action == SetupAction::none);
  CHECK(release.identity(refused).role == Role::gateway);

  Fixture dev(true);
  store_role(dev, Role::sensor);
  SetupService dev_setup(dev.storage, dev.build);
  REQUIRE(dev_setup.load() == device::HalError::none);
  REQUIRE(dev.provision_outcome(dev.send(dev_setup, provision_message())) ==
          ProvisionOutcome::accepted);
  message.role = Role::sensor;
  CHECK(dev.send(dev_setup, message).action == SetupAction::none);
  CHECK(dev_setup.paired());
  message.role = Role::siren;
  const auto changed = dev.send(dev_setup, message);
  CHECK(changed.action == SetupAction::restart);
  CHECK(dev.identity(changed).role == Role::siren);
  CHECK_FALSE(dev.identity(changed).paired);
  CHECK_FALSE(dev.storage.has(StoreKey::pairing));
}

TEST_CASE("messages that travel to the hub, unknown types and junk are dropped without a reply") {
  Fixture f(true);
  SetupService setup(f.storage, f.build);
  REQUIRE(setup.load() == device::HalError::none);
  CHECK(f.send(setup, protocol::ProvisionResult{}).reply_size == 0);
  CHECK(f.send_bytes(setup, Bytes{0xF1, 0x7E}).reply_size == 0);
  CHECK(f.send_bytes(setup, Bytes{0xF1}).reply_size == 0);
  CHECK(f.send_bytes(setup, Bytes{0xF1, 0x06}).reply_size == 0);
}

TEST_CASE("health: Started carries version, reset cause and the last fatal error") {
  host::FakeClock clock;
  host::FakeStorage storage(clock);
  device::BuildInfo build;
  build.version = protocol::FirmwareVersion{2, 0, 1};
  device::LogState log_state;
  device::LogBuffer log(log_state);
  device::BootInfo boot;
  boot.reset_cause = 7;
  boot.watchdog_reset = true;
  {
    device::Health health(storage, build);
    health.boot(boot, device::breadcrumb_of(device::EventKind::radio, 0x21));
    const auto started = health.started(Role::siren, 5);
    CHECK(started.role == Role::siren);
    CHECK(started.firmware_version.major == 2);
    CHECK(started.reset_cause == 7);
    CHECK(started.settings_version == 5);
    CHECK(started.last_fatal_error == 0x8221);
    // Nothing stored: reporting writes nothing.
    const std::size_t before = storage.operations.size();
    CHECK(health.reported() == device::HalError::none);
    CHECK(storage.operations.size() == before);
    CHECK(health.started(Role::siren, 5).last_fatal_error == 0);
    health.raise_fatal(device::fatal_code::stuck_awake, at_seconds(3), log);
    CHECK(health.restart_requested());
    CHECK(storage.has(device::StoreKey::fatal_error));
  }
  device::Health after(storage, build);
  boot.watchdog_reset = true;
  after.boot(boot, 0x0100);
  // A stored code wins over the breadcrumb.
  CHECK(after.last_fatal() == device::fatal_code::stuck_awake);
  CHECK(after.reported() == device::HalError::none);
  CHECK_FALSE(storage.has(device::StoreKey::fatal_error));
  CHECK(after.last_fatal() == 0);
}

}  // namespace
}  // namespace hsn::test
