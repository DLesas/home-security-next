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
 * A typed record in flash: a version byte, then the bytes of a plain struct. It loads with a
 * fallback and writes only when the value really changes, which is what keeps flash writes to
 * the counts of design section 5. The struct must have no padding, so equal values have equal
 * bytes.
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
   * Reads the record. When it is missing, of another size or another version, the value is the
   * fallback and the result says why: HalError::not_found or HalError::invalid.
   */
  HalError load() {
    value_ = fallback_;
    stored_ = false;
    std::array<std::uint8_t, sizeof(T) + 1> bytes{};
    const auto read = storage_.read(key_, protocol::MutableByteView(bytes));
    if (!read.ok()) {
      return read.error();
    }
    if (read.value() != bytes.size() || bytes[0] != version_) {
      return HalError::invalid;
    }
    std::memcpy(&value_, bytes.data() + 1, sizeof(T));
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
