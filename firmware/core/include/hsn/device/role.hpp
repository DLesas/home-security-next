#pragma once

#include <cstdint>
#include <type_traits>

#include "hsn/device/events.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/bytes.hpp"

namespace hsn::device {

/** How deeply the chip may sleep while it waits. */
enum class SleepDepth : std::uint8_t {
  /** Stay awake; the platform blocks on its event queue. */
  awake,
  /** Light sleep: RAM kept, woken by the radio, inputs, links or the timer. */
  light,
  /** Deep sleep: a reset on wake; only the retained block and flash survive. */
  deep,
};

/** When the core must run next, and how deeply the chip may sleep until then. */
struct Wake {
  /** Deliver a timer event at or after this instant. */
  Instant at = Instant::never();
  SleepDepth deepest = SleepDepth::awake;
  /** Deep sleep only: which inputs end it. The platform picks each pin's level from the pin. */
  WakeMask deep_wake_inputs;
  /** Restart the chip instead of waiting. */
  bool restart = false;
};

/**
 * A device role: sensor, siren or gateway (design section 7). A role never blocks, never sleeps
 * and never reads a clock: it reacts to events by calling hardware interfaces and services.
 * Its whole state is one trivially copyable struct, which Device keeps in retained memory.
 *
 * Every role overrides every method, which is_complete_role below checks at compile time. They
 * are not pure virtual only because a pure virtual
 * function makes each library that builds a role reference __cxa_pure_virtual, which the
 * core_symbols rule forbids; the defaults, defined once in the core, describe "no role", which
 * Device treats as setup-only mode. The destructor is protected and non-virtual: roles are static
 * objects, never deleted through this interface, and a virtual destructor would reference
 * operator delete.
 */
class Role {
public:
  /**
   * Returns the protocol's role number: 1 sensor, 2 siren, 3 gateway; 0 for no role.
   */
  virtual std::uint8_t role_id() const;

  /**
   * Reacts to one event. Works through every due timer, not only on timer events.
   */
  virtual void handle(const Event& event);

  /**
   * Returns when the role must run next and how deeply the chip may sleep until then.
   */
  virtual Wake next_wake() const;

  /**
   * Returns the role's state struct as bytes, copied to and from the retained block.
   */
  virtual protocol::MutableByteView state_bytes();

  /**
   * Returns the layout number of the state struct; a change discards an old retained copy.
   */
  virtual std::uint8_t state_layout() const;

  /**
   * Returns the current top-level state, for the watchdog breadcrumb (design section 6).
   */
  virtual std::uint8_t state_id() const;

  /**
   * Returns the longest the role may stay awake without allowing deep sleep, or zero for no
   * bound. Device raises a fatal error past it (design section 6).
   */
  virtual Duration longest_awake() const;

protected:
  Role() = default;
  Role(const Role&) = default;
  Role& operator=(const Role&) = default;
  ~Role() = default;
};

/**
 * True when R declares every Role method itself. `&R::method` is a pointer to a member of R when R
 * overrides the method and to a member of Role when it does not, so a forgotten override, which
 * would compile and silently behave as "no role", is caught at compile time. Every role header
 * asserts it with the message "a role must override every Role method".
 */
template <typename R>
constexpr bool is_complete_role =
    std::is_base_of_v<Role, R> && !std::is_same_v<R, Role> &&
    std::is_same_v<decltype(&R::role_id), std::uint8_t (R::*)() const> &&
    std::is_same_v<decltype(&R::handle), void (R::*)(const Event&)> &&
    std::is_same_v<decltype(&R::next_wake), Wake (R::*)() const> &&
    std::is_same_v<decltype(&R::state_bytes), protocol::MutableByteView (R::*)()> &&
    std::is_same_v<decltype(&R::state_layout), std::uint8_t (R::*)() const> &&
    std::is_same_v<decltype(&R::state_id), std::uint8_t (R::*)() const> &&
    std::is_same_v<decltype(&R::longest_awake), Duration (R::*)() const>;

}  // namespace hsn::device
