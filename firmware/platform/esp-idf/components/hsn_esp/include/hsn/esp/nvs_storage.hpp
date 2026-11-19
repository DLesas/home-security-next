#pragma once

#include <cstddef>
#include <cstdint>

#include "hsn/device/hal/storage.hpp"

namespace hsn::esp {

/**
 * Stored records on NVS (design section 5): the `nvs` partition, namespace "hsn", one blob per
 * StoreKey, named "k" and the key's two hex digits. The core gives each record its own version
 * byte; NVS adds a CRC per entry. A write is one nvs_set_blob followed by nvs_commit: NVS keeps the
 * old value until the new one is whole (the NVS guide: "only the pair being written may be lost"),
 * so a write is whole or nothing, and durable when commit returns.
 *
 * Wear, against the design's budget (section 5, 24 KB, about 630 usable entries per cycle): a blob
 * takes one blob-index entry, one data-chunk entry and one 32-byte entry per 32 bytes of data (the
 * NVS guide, "Entry structure"), so the 5-byte resume point costs 3 entries where the design
 * counted 1. The gateway's 7,500 resume-point writes a year are then about 22,500 entries, about 36
 * erases of each page a year instead of 12: still far inside any NOR rating. Writes of an unchanged
 * value never reach here (Record<T>::update compares first).
 */
class NvsStorage final : public device::Storage {
public:
  /**
   * Initialises the NVS partition (erasing and starting it again only when NVS says its pages are
   * full or of a newer format) and opens the namespace.
   */
  device::HalError begin();

  device::HalResult<std::size_t> read(device::StoreKey key, protocol::MutableByteView out) override;
  device::HalError write(device::StoreKey key, protocol::ByteView value) override;
  device::HalError erase(device::StoreKey key) override;
  device::HalError erase_all_but_role() override;

private:
  std::uint32_t handle_ = 0;
  bool open_ = false;
};

}  // namespace hsn::esp
