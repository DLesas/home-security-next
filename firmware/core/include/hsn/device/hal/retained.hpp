#pragma once

#include <cstddef>

#include "hsn/protocol/bytes.hpp"

namespace hsn::device {

/** Size of the retained block every platform provides (design section 5). */
constexpr std::size_t kRetainedBlockSize = 1024;

/** Size of the no-init breadcrumb word (design section 6). */
constexpr std::size_t kBreadcrumbSize = 4;

/**
 * Memory that survives deep sleep: RTC slow memory on the ESP32-S3. Whether it survives a
 * watchdog reset or a brown-out is unverified (hardware notes, part b), so the core checks its
 * integrity on every start and never assumes either way.
 */
class RetainedMemory {
public:
  /**
   * Returns the retained block, exactly kRetainedBlockSize bytes. Its contents are whatever the
   * core last wrote, or anything at all after a power loss.
   */
  virtual protocol::MutableByteView block() = 0;

  /**
   * Returns the breadcrumb, kBreadcrumbSize bytes of no-init memory outside the block, written
   * before every event so that a watchdog reset can say what was running.
   */
  virtual protocol::MutableByteView breadcrumb() = 0;

protected:
  RetainedMemory() = default;
  RetainedMemory(const RetainedMemory&) = default;
  RetainedMemory& operator=(const RetainedMemory&) = default;
  ~RetainedMemory() = default;
};

}  // namespace hsn::device
