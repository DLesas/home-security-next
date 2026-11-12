#include "hsn/roles/sensor/sensor_role.hpp"

#include "hsn/protocol/messages.hpp"

namespace hsn::roles::sensor {

SensorRole::SensorRole(device::Services& services, device::SensorIo& io)
    : services_(services), io_(io) {}

std::uint8_t SensorRole::role_id() const {
  return protocol::Role::sensor;
}

void SensorRole::handle(const device::Event& event) {
  static_cast<void>(event);
  static_cast<void>(services_);
  static_cast<void>(io_);
}

device::Wake SensorRole::next_wake() const {
  return device::Wake{};
}

protocol::MutableByteView SensorRole::state_bytes() {
  return protocol::MutableByteView(reinterpret_cast<std::uint8_t*>(&state_), sizeof(state_));
}

std::uint8_t SensorRole::state_layout() const {
  return kSensorStateLayout;
}

std::uint8_t SensorRole::state_id() const {
  return state_.top_state;
}

device::Duration SensorRole::longest_awake() const {
  return kSensorLongestAwake;
}

}  // namespace hsn::roles::sensor
