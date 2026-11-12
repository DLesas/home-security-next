#pragma once

#include <cstdint>

#include "hsn/device/events.hpp"
#include "hsn/device/hal/gateway_io.hpp"
#include "hsn/device/role.hpp"
#include "hsn/device/services.hpp"
#include "hsn/device/time.hpp"
#include "hsn/device/timers.hpp"
#include "hsn/protocol/bytes.hpp"

namespace hsn::roles::gateway {

/** The gateway's timers (design section 7). */
enum class GatewayTimer : std::uint8_t {
  status,
  noise_sample,
  interference_hold,
  reconnect,
  welcome_timeout,
  usb_probe,
  scheduled_transmit,
  radio_guard,
  count,
};

/**
 * The gateway's state. Kept in the retained block like every role's, though nothing in it needs
 * to survive a reset. The transmit queue lives in the role object, not here. Provisional: the
 * gateway's owner may reshape it.
 */
struct GatewayState {
  std::uint8_t top_state = 0;
  std::uint8_t connection = 0;
  std::uint8_t reconnect_attempt = 0;
  bool on_usb = false;
  device::SessionState session;
  device::TimerSet<GatewayTimer, static_cast<std::size_t>(GatewayTimer::count)> timers;
};

/** Bumped whenever GatewayState changes. */
constexpr std::uint8_t kGatewayStateLayout = 1;

/** The gateway (design section 7). Skeleton: the behaviour is still to be written. */
class GatewayRole final : public device::Role {
public:
  GatewayRole(device::Services& services, device::GatewayIo& io);

  std::uint8_t role_id() const override;
  void handle(const device::Event& event) override;
  device::Wake next_wake() const override;
  protocol::MutableByteView state_bytes() override;
  std::uint8_t state_layout() const override;
  std::uint8_t state_id() const override;
  device::Duration longest_awake() const override;

private:
  device::Services& services_;
  device::GatewayIo& io_;
  GatewayState state_;
};

static_assert(device::is_complete_role<GatewayRole>, "a role must override every Role method");
static_assert(sizeof(GatewayState) <= device::kMaxRoleStateSize, "fits the retained block");

}  // namespace hsn::roles::gateway
