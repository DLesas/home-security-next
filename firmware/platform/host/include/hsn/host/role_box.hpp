#pragma once

#include <functional>
#include <memory>
#include <utility>

#include "hsn/device/role.hpp"
#include "hsn/device/services.hpp"
#include "hsn/host/host_board.hpp"

namespace hsn::host {

/**
 * Owns one boot's role object, whatever its type. A role's destructor is protected and not
 * virtual (design section 1), so the box, not a pointer to Role, destroys it. The type tag lets a
 * test reach the concrete role without RTTI, which code deriving from Role is built without.
 */
class RoleBox {
public:
  virtual ~RoleBox() = default;

  /** The role, as Device sees it. */
  virtual device::Role& role() = 0;

  /** Identifies the concrete role type (see role_type_tag). */
  virtual const void* type_tag() const = 0;
};

/** A unique address per role type, standing in for a typeid. */
template <typename R>
const void* role_type_tag() {
  static const char tag = 0;
  return &tag;
}

/** A RoleBox holding an R. */
template <typename R>
class RoleBoxOf final : public RoleBox {
public:
  /** Builds the role from `args`. */
  template <typename... Args>
  explicit RoleBoxOf(Args&&... args) : role_(std::forward<Args>(args)...) {}

  device::Role& role() override {
    return role_;
  }
  const void* type_tag() const override {
    return role_type_tag<R>();
  }
  /** The role as its own type. */
  R& get() {
    return role_;
  }

private:
  R role_;
};

/**
 * Builds the role for one boot, on that boot's Services and the board's fakes. Called again on
 * every boot, since a reset destroys the role with the rest of RAM. Returning null builds no role
 * (setup-only mode).
 */
using RoleFactory = std::function<std::unique_ptr<RoleBox>(device::Services&, HostBoard&)>;

/** Boxes an R built from `args`; for factories written as lambdas. */
template <typename R, typename... Args>
std::unique_ptr<RoleBox> box_role(Args&&... args) {
  return std::make_unique<RoleBoxOf<R>>(std::forward<Args>(args)...);
}

/**
 * A factory for a role constructed as R(Services&, io...), taking each I/O fake from the board:
 * make_role<roles::sensor::SensorRole>(&HostBoard::sensor_io).
 */
template <typename R, typename... Io>
RoleFactory make_role(Io HostBoard::*... io) {
  return [io...](device::Services& services, HostBoard& board) -> std::unique_ptr<RoleBox> {
    return box_role<R>(services, (board.*io)...);
  };
}

}  // namespace hsn::host
