// A role that forgets one override (longest_awake). It must not compile: the build of this probe
// is expected to fail with the static_assert's message.

#include "hsn/device/role.hpp"

namespace hsn::probe {

class IncompleteRole final : public device::Role {
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
  void report_again(device::Instant) override {}
};

static_assert(device::is_complete_role<IncompleteRole>, "a role must override every Role method");

}  // namespace hsn::probe
