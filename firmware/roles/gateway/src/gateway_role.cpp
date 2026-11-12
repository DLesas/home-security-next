#include "hsn/roles/gateway/gateway_role.hpp"

#include "hsn/protocol/messages.hpp"

namespace hsn::roles::gateway {

GatewayRole::GatewayRole(device::Services& services, device::GatewayIo& io)
    : services_(services), io_(io) {}

std::uint8_t GatewayRole::role_id() const {
  return protocol::Role::gateway;
}

void GatewayRole::handle(const device::Event& event) {
  static_cast<void>(event);
  static_cast<void>(services_);
  static_cast<void>(io_);
}

device::Wake GatewayRole::next_wake() const {
  return device::Wake{};
}

protocol::MutableByteView GatewayRole::state_bytes() {
  return protocol::MutableByteView(reinterpret_cast<std::uint8_t*>(&state_), sizeof(state_));
}

std::uint8_t GatewayRole::state_layout() const {
  return kGatewayStateLayout;
}

std::uint8_t GatewayRole::state_id() const {
  return state_.top_state;
}

device::Duration GatewayRole::longest_awake() const {
  return device::Duration{};  // always powered: no bound
}

}  // namespace hsn::roles::gateway
