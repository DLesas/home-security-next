#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>

#include "hsn/device/status.hpp"
#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/image.hpp"
#include "hsn/protocol/messages.hpp"

namespace hsn::device {

/** One flash sector: the unit of FirmwareSlots::erase, and the most one write or read moves. */
constexpr std::size_t kSlotSectorSize = 4096;

/** What this boot is running (m3-updates-design.md section 2). */
struct BootImage {
  protocol::FirmwareVersion version;
  /** The image is on trial (ESP-IDF's PENDING_VERIFY): any reset before confirm() rolls it back. */
  bool on_trial = false;
  /** The other slot was ABORTED or INVALID since the last confirm: a rollback happened. */
  bool rolled_back = false;
  /** That slot's version, when rolled_back; zeros otherwise. */
  protocol::FirmwareVersion failed;
  /** The payload IDs of the running and failed images, if known to the platform. */
  std::optional<protocol::ImageId> id;
  std::optional<protocol::ImageId> failed_id;
};

/**
 * The two application slots and the bootloader's trial and rollback (m3-updates-design.md section
 * 2). Writing always goes to the slot not running, whose offsets count from its first byte; the
 * running slot is never written. On the ESP32-S3: esp_partition on the slot
 * esp_ota_get_next_update_partition names, and esp_ota_ops for the boot state. Calls are bounded as
 * design section 3 says, an erase by one sector (at most 400 ms).
 */
class FirmwareSlots {
public:
  /**
   * Returns what this boot is running and any rollback, with IDs when known.
   */
  virtual BootImage running() = 0;

  /**
   * Returns the size of the other slot in bytes: the largest image it can hold.
   */
  virtual std::uint32_t capacity() = 0;

  /**
   * Erases the sector of the other slot at `offset`, a multiple of kSlotSectorSize.
   * HalError::invalid off a sector boundary or past the slot, HalError::io on a fault.
   */
  virtual HalError erase(std::uint32_t offset) = 0;

  /**
   * Writes at most kSlotSectorSize bytes at `offset` of the other slot, into erased space.
   */
  virtual HalError write(std::uint32_t offset, protocol::ByteView bytes) = 0;

  /**
   * Reads at most kSlotSectorSize bytes at `offset` of the other slot into `out`, filling it.
   */
  virtual HalError read(std::uint32_t offset, protocol::MutableByteView out) = 0;

  /**
   * Makes the other slot boot next: checks the image's format (esp_ota_set_boot_partition) and
   * marks it NEW. HalError::invalid when the image check fails. The caller then restarts.
   */
  virtual HalError select() = 0;

  /**
   * Confirms the running image (mark valid, cancel rollback). Only the image itself, after its
   * health condition, calls it.
   */
  virtual HalError confirm() = 0;

  /**
   * Refuses the running image (mark invalid); the caller then restarts into the other slot.
   */
  virtual HalError reject() = 0;

protected:
  FirmwareSlots() = default;
  FirmwareSlots(const FirmwareSlots&) = default;
  FirmwareSlots& operator=(const FirmwareSlots&) = default;
  ~FirmwareSlots() = default;
};

}  // namespace hsn::device
