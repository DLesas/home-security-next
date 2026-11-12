#include "hsn/roles/siren/siren_role.hpp"

#include "hsn/protocol/messages.hpp"

namespace hsn::roles::siren {

SirenRole::SirenRole(device::Services& services, device::SirenIo& io)
    : services_(services), io_(io) {}

std::uint8_t SirenRole::role_id() const {
  return protocol::Role::siren;
}

void SirenRole::handle(const device::Event& event) {
  static_cast<void>(event);
  static_cast<void>(services_);
  static_cast<void>(io_);
}

device::Wake SirenRole::next_wake() const {
  return device::Wake{};
}

protocol::MutableByteView SirenRole::state_bytes() {
  return protocol::MutableByteView(reinterpret_cast<std::uint8_t*>(&state_), sizeof(state_));
}

std::uint8_t SirenRole::state_layout() const {
  return kSirenStateLayout;
}

std::uint8_t SirenRole::state_id() const {
  return state_.top_state;
}

device::Duration SirenRole::longest_awake() const {
  return device::Duration{};  // always powered: no bound
}

}  // namespace hsn::roles::siren
