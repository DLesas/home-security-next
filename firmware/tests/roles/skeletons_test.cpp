// The three role skeletons build against the frozen constructors, report their role, and fit
// the retained block. Each role's own scenario tests go in tests/roles/<role>/.

#include <optional>

#include "device/device_support.hpp"
#include "hsn/host/host_board.hpp"
#include "hsn/roles/gateway/gateway_role.hpp"
#include "hsn/roles/sensor/sensor_role.hpp"
#include "hsn/roles/siren/siren_role.hpp"

namespace hsn::test {
namespace {

template <typename R, typename Io>
void check_skeleton(std::uint8_t role, Io& (*io_of)(host::HostBoard&)) {
  host::HostBoard board;
  pair_board(board, role);
  std::optional<host::HostInstance<R>> instance;
  instance.emplace(board, io_of(board));
  CHECK(instance->role.role_id() == role);
  CHECK(instance->role.state_bytes().size() <= device::kMaxRoleStateSize);
  instance->runner.start(board.boot_event(device::BootKind::power_on));
  CHECK_FALSE(instance->device.setup_only());
  CHECK(instance->device.retained_status() == device::RetainedStatus::none);
  // The skeleton's state goes through the retained block like any role's.
  instance.reset();
  instance.emplace(board, io_of(board));
  instance->runner.start(board.boot_event(device::BootKind::deep_sleep_wake));
  CHECK(instance->device.retained_status() == device::RetainedStatus::intact);
}

TEST_CASE("the sensor skeleton") {
  check_skeleton<roles::sensor::SensorRole, host::FakeSensorIo>(
      protocol::Role::sensor,
      [](host::HostBoard& b) -> host::FakeSensorIo& { return b.sensor_io; });
}

TEST_CASE("the siren skeleton") {
  check_skeleton<roles::siren::SirenRole, host::FakeSirenIo>(
      protocol::Role::siren, [](host::HostBoard& b) -> host::FakeSirenIo& { return b.siren_io; });
}

TEST_CASE("the gateway skeleton") {
  check_skeleton<roles::gateway::GatewayRole, host::FakeGatewayIo>(
      protocol::Role::gateway,
      [](host::HostBoard& b) -> host::FakeGatewayIo& { return b.gateway_io; });
}

}  // namespace
}  // namespace hsn::test
