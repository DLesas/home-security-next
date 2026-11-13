#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "hsn/device/events.hpp"
#include "hsn/device/role.hpp"
#include "hsn/device/services.hpp"
#include "hsn/device/time.hpp"

namespace hsn::device {

/** Identifies a retained block written by this firmware ("HSNR"). */
constexpr std::uint32_t kRetainedMagic = 0x524E5348;

/** Layout of the retained block's header and core part; bumped when either changes. */
constexpr std::uint8_t kRetainedLayout = 3;

/**
 * Receives every event and passes it on (design section 2). It restores and seals the retained
 * block, writes the breadcrumb, answers USB setup messages itself, keeps an unpaired or role-less
 * board in setup-only mode, and catches a role that stays awake too long.
 */
class Device {
public:
  /**
   * `role` is null when no role is stored or the board is not paired; it is also ignored when
   * the stored role differs from it or the board is not paired.
   */
  Device(Services& services, Role* role) : services_(services), role_(role) {}

  /**
   * Handles one event; the first must be the boot event. Never blocks.
   */
  void handle(const Event& event);

  /**
   * Returns when to run next and how deeply the chip may sleep. In setup-only mode: light sleep
   * on external power, otherwise deep sleep woken by external power or the button.
   */
  Wake next_wake() const;

  /**
   * True when the role does not run: no role, another role stored, or not paired.
   */
  bool setup_only() const {
    return !active_;
  }

  /**
   * What the boot found in retained memory.
   */
  RetainedStatus retained_status() const {
    return retained_status_;
  }

  /**
   * Stores a fatal error and asks for a restart (used by Runner for a busy loop).
   */
  void raise_fatal(std::uint16_t code, Instant now);

private:
  void boot(const Event& event);
  bool handle_setup(const Event& event);
  void write_breadcrumb(std::uint32_t value);
  std::uint32_t read_breadcrumb();
  bool restore();
  void seal();
  void invalidate_retained();
  void check_awake(Instant now);
  protocol::MutableByteView role_bytes();
  std::uint8_t role_id() const;
  std::uint8_t role_layout() const;

  Services& services_;
  Role* role_;
  bool booted_ = false;
  bool active_ = false;
  bool restart_ = false;
  bool retain_ = true;
  RetainedStatus retained_status_ = RetainedStatus::none;
  Instant awake_since_;
  std::array<std::uint8_t, 64> setup_reply_{};
};

}  // namespace hsn::device
