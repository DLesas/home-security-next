#pragma once

#include <cstdint>

#include "hsn/device/events.hpp"
#include "hsn/device/hal/build_info.hpp"
#include "hsn/device/hal/storage.hpp"
#include "hsn/device/services/log_buffer.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/messages.hpp"

namespace hsn::device {

/** Fatal error codes (FW5). The high bit marks a watchdog reset, with the breadcrumb below it. */
namespace fatal_code {
constexpr std::uint16_t none = 0x0000;
/** The role asked to run at once too many times in a row (design section 6). */
constexpr std::uint16_t busy_loop = 0x0001;
/** The role stayed awake longer than it said it ever would. */
constexpr std::uint16_t stuck_awake = 0x0002;
/** No sending counter left: the device must be paired again (protocol section 4). */
constexpr std::uint16_t counter_exhausted = 0x0003;
/** Flash failed where the device cannot go on. */
constexpr std::uint16_t storage = 0x0004;
/** Set on a watchdog reset; bits 14–8 hold the event kind and bits 7–0 the role's state. */
constexpr std::uint16_t watchdog = 0x8000;
}  // namespace fatal_code

/**
 * Builds the breadcrumb Device writes before each event: the event kind and the role's state.
 */
constexpr std::uint32_t breadcrumb_of(EventKind kind, std::uint8_t state_id) {
  return (static_cast<std::uint32_t>(kind) << 8) | state_id;
}

/**
 * Reset cause, last fatal error and firmware version (FW5, FW8), reported in Started. A fatal
 * error raised on purpose is stored in flash and a restart requested; after a watchdog reset the
 * breadcrumb names what hung. The stored code is cleared once a Started carrying it has gone.
 */
class Health {
public:
  Health(Storage& storage, const BuildInfo& build) : storage_(storage), build_(build) {}

  /**
   * Records this start: the platform's boot facts and the breadcrumb left by the previous run.
   */
  void boot(const BootInfo& boot, std::uint32_t previous_breadcrumb);

  /**
   * Returns the last fatal error to report, or 0.
   */
  std::uint16_t last_fatal() const {
    return last_fatal_;
  }

  /**
   * Builds the Started message (protocol section 6).
   */
  protocol::Started started(std::uint8_t role, std::uint8_t settings_version) const;

  /**
   * Stores `code` and asks for a restart.
   */
  void raise_fatal(std::uint16_t code, Instant now, LogBuffer& log);

  bool restart_requested() const {
    return restart_requested_;
  }

  /**
   * Call once a Started has gone out: clears a stored code (one write, only when one is stored).
   */
  HalError reported();

private:
  Storage& storage_;
  BuildInfo build_;
  std::uint8_t reset_cause_ = 0;
  std::uint16_t last_fatal_ = 0;
  bool stored_ = false;
  bool restart_requested_ = false;
};

}  // namespace hsn::device
