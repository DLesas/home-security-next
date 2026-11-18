#pragma once

#include <array>
#include <cstdint>
#include <cstring>
#include <type_traits>

#include "hsn/device/hal/storage.hpp"
#include "hsn/device/status.hpp"
#include "hsn/protocol/bytes.hpp"

namespace hsn::device {

/**
 * Reads the record stored under `key`: a version byte, then its fields. When the version byte is
 * `version`, copies the stored fields into `out` and returns HalError::none: all of `out` from a
 * record at least as long, only the start of `out` from a shorter one, leaving the rest of `out`
 * as it was. HalError::invalid for another version or an empty record, and the read's own error
 * (HalError::not_found when absent) otherwise; `out` is then untouched.
 */
HalError read_record(Storage& storage, StoreKey key, std::uint8_t version,
                     protocol::MutableByteView out);

/**
 * A typed record in flash: a version byte, then the bytes of a plain struct. It loads with a
 * fallback and writes only when the value really changes, which is what keeps flash writes to
 * the counts of design section 5. The struct must have no padding, so equal values have equal
 * bytes.
 *
 * A record changes format only by adding fields at its end, keeping its version byte, and every
 * image reads the fields it knows (m3-updates-design.md section 2, D134): a longer stored record
 * (written by a newer image, read after a rollback) gives the fields this struct has, and a
 * shorter one (written by an older image) gives the fields it holds, the rest at the fallback's
 * values. A different version byte means a format this image cannot read.
 */
template <typename T>
class Record {
  static_assert(std::is_trivially_copyable_v<T>, "a record is a plain struct");
  static_assert(std::has_unique_object_representations_v<T>, "a record has no padding");
  static_assert(sizeof(T) + 1 <= kMaxRecordSize, "a record fits a storage entry");

public:
  Record(Storage& storage, StoreKey key, std::uint8_t version, const T& fallback)
      : storage_(storage), key_(key), version_(version), fallback_(fallback), value_(fallback) {}

  /**
   * Reads the record, of any length, as read_record() says: the fields stored, and the
   * fallback's for any the stored record is too short to hold. When it is missing, empty or of
   * another version, the value is the fallback and the result says why: HalError::not_found or
   * HalError::invalid. A later update() writes the whole struct, at this image's length.
   */
  HalError load() {
    value_ = fallback_;
    stored_ = false;
    std::array<std::uint8_t, sizeof(T)> bytes{};
    std::memcpy(bytes.data(), &fallback_, sizeof(T));
    const HalError error = read_record(storage_, key_, version_, protocol::MutableByteView(bytes));
    if (error != HalError::none) {
      return error;
    }
    std::memcpy(&value_, bytes.data(), sizeof(T));
    stored_ = true;
    return HalError::none;
  }

  /**
   * Returns the value held.
   */
  const T& get() const {
    return value_;
  }

  /**
   * Returns true when the value came from flash or was written there.
   */
  bool stored() const {
    return stored_;
  }

  /**
   * Stores `value` when it differs from what is stored; no write when it is the same. On a write
   * failure the value is still held in RAM, and the error is returned.
   */
  HalError update(const T& value) {
    if (stored_ && std::memcmp(&value_, &value, sizeof(T)) == 0) {
      return HalError::none;
    }
    value_ = value;
    std::array<std::uint8_t, sizeof(T) + 1> bytes{};
    bytes[0] = version_;
    std::memcpy(bytes.data() + 1, &value, sizeof(T));
    const HalError error = storage_.write(key_, protocol::ByteView(bytes));
    stored_ = error == HalError::none;
    return error;
  }

  /**
   * Removes the record and goes back to the fallback.
   */
  HalError erase() {
    value_ = fallback_;
    stored_ = false;
    return storage_.erase(key_);
  }

private:
  Storage& storage_;
  StoreKey key_;
  std::uint8_t version_;
  T fallback_;
  T value_;
  bool stored_ = false;
};

}  // namespace hsn::device
