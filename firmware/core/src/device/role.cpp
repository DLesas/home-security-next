#include "hsn/device/role.hpp"

namespace hsn::device {

// The defaults of "no role" (see role.hpp). role_id() is the key function: the vtable is emitted
// here, once, in hsn_core.

std::uint8_t Role::role_id() const {
  return 0;
}

void Role::handle(const Event& event) {
  static_cast<void>(event);
}

Wake Role::next_wake() const {
  return Wake{};
}

protocol::MutableByteView Role::state_bytes() {
  return protocol::MutableByteView();
}

std::uint8_t Role::state_layout() const {
  return 0;
}

std::uint8_t Role::state_id() const {
  return 0;
}

Duration Role::longest_awake() const {
  return Duration{};
}

void Role::report_again(Instant now) {
  static_cast<void>(now);
}

}  // namespace hsn::device
