// The same role with every override: it must compile, so the incomplete probe cannot fail for any
// other reason.

#include "hsn/device/role.hpp"

namespace hsn::probe {

class CompleteRole final : public device::Role {
public:
  std::uint8_t role_id() const override {
    return 1;
  }
  void handle(const device::Event& event) override {
    static_cast<void>(event);
  }
  device::Wake next_wake() const override {
    return device::Wake{};
  }
  protocol::MutableByteView state_bytes() override {
    return protocol::MutableByteView();
  }
  std::uint8_t state_layout() const override {
    return 1;
  }
  std::uint8_t state_id() const override {
    return 0;
  }
  device::Duration longest_awake() const override {
    return device::Duration{};
  }
};

static_assert(device::is_complete_role<CompleteRole>, "a role must override every Role method");
static_assert(!device::is_complete_role<device::Role>, "Role itself is no complete role");

}  // namespace hsn::probe
