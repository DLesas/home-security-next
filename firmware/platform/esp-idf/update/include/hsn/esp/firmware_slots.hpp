#pragma once

#include <cstdint>

#include "hsn/device/hal/firmware_slots.hpp"
#include "hsn/protocol/messages.hpp"

namespace hsn::esp {

/**
 * Parses an app description's version string, "MAJOR.MINOR.PATCH" with each part 0 to 255 (the
 * form the hub reads, m3-updates-design.md section 3), NUL-terminated inside its `room` bytes;
 * false otherwise, `out` untouched. The running image's BuildInfo and both slots' versions come
 * from it.
 */
constexpr bool parse_version(const char* text, std::uint32_t room, protocol::FirmwareVersion& out) {
  std::uint32_t parts[3] = {0, 0, 0};
  bool seen[3] = {false, false, false};
  std::uint32_t part = 0;
  std::uint32_t i = 0;
  for (; i < room && text[i] != '\0'; ++i) {
    const char c = text[i];
    if (c == '.') {
      if (!seen[part] || part == 2) {
        return false;
      }
      part += 1;
      continue;
    }
    if (c < '0' || c > '9') {
      return false;
    }
    parts[part] = parts[part] * 10 + static_cast<std::uint32_t>(c - '0');
    seen[part] = true;
    if (parts[part] > 255) {
      return false;
    }
  }
  // Ended inside the field, with a digit in the third part (which only a third part can have).
  if (i == room || !seen[2]) {
    return false;
  }
  out.major = static_cast<std::uint8_t>(parts[0]);
  out.minor = static_cast<std::uint8_t>(parts[1]);
  out.patch = static_cast<std::uint8_t>(parts[2]);
  return true;
}

namespace detail {
/** parse_version on a string literal, for the checks below: the version as one number, or −1. */
template <std::uint32_t N>
constexpr long parsed(const char (&text)[N], std::uint32_t room = N) {
  protocol::FirmwareVersion version{};
  return parse_version(text, room, version)
             ? static_cast<long>(version.major) * 65536 + version.minor * 256 + version.patch
             : -1;
}
}  // namespace detail

// The parser at its edges: what the hub accepts as a version (m3-updates-design.md section 3).
static_assert(detail::parsed("0.1.0") == 256, "the first version");
static_assert(detail::parsed("255.255.255") == 16777215, "the largest");
static_assert(detail::parsed("256.0.0") == -1 && detail::parsed("1.256.0") == -1, "over 255");
static_assert(detail::parsed("1.2") == -1 && detail::parsed("1.2.3.4") == -1, "three parts");
static_assert(detail::parsed("1..2") == -1 && detail::parsed(".1.2") == -1, "empty part");
static_assert(detail::parsed("1.2.") == -1 && detail::parsed("") == -1, "empty last part");
static_assert(detail::parsed("1.2.3-dirty") == -1 && detail::parsed("v1.2.3") == -1, "digits only");
static_assert(detail::parsed("1.2.3", 5) == -1, "no NUL inside the field");

/**
 * The two application slots (m3-updates-design.md section 2, "Behind the platform interface"), on
 * ESP-IDF's bootloader with rollback on (CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE). The slot written
 * is always the one esp_ota_get_next_update_partition names, never the running one, with
 * esp_partition_erase_range, esp_partition_write and esp_partition_read, so a download resumes
 * after a reset with nothing to reopen (not esp_ota_begin and esp_ota_write). select() is
 * esp_ota_set_boot_partition, which runs esp_image_verify on the slot and marks it NEW
 * (esp_ota_ops.h: "Equivalent to esp_image_verify() followed by
 * esp_ota_set_boot_partition_skip_validate()"); confirm() is
 * esp_ota_mark_app_valid_cancel_rollback; reject() is esp_ota_mark_app_invalid_rollback, which does
 * not restart (the caller does).
 *
 * running() reads this boot's state: on trial while the running slot is PENDING_VERIFY; rolled back
 * when the newest otadata entry names the other slot and is INVALID or ABORTED, as the host's fake
 * bootloader reads it (fake_update.cpp: the newest intact entry names another slot), with that
 * slot's version from its app description. Both otadata copies are read and checked (sequence and
 * CRC) as the bootloader does.
 */
class EspFirmwareSlots final : public device::FirmwareSlots {
public:
  /** Finds the running slot and the other one. */
  bool begin();

  device::BootImage running() override;
  std::uint32_t capacity() override;
  device::HalError erase(std::uint32_t offset) override;
  device::HalError write(std::uint32_t offset, protocol::ByteView bytes) override;
  device::HalError read(std::uint32_t offset, protocol::MutableByteView out) override;
  device::HalError select() override;
  device::HalError confirm() override;
  device::HalError reject() override;

private:
  const void* running_ = nullptr;
  const void* other_ = nullptr;
};

}  // namespace hsn::esp
