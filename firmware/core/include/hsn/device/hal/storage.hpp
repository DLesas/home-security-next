#pragma once

#include <cstddef>
#include <cstdint>

#include "hsn/device/status.hpp"
#include "hsn/protocol/bytes.hpp"

namespace hsn::device {

/** Largest stored record. */
constexpr std::size_t kMaxRecordSize = 256;

/**
 * Keys of stored records. Each role owns a range, so roles add keys without touching the core:
 * core 0x00–0x0F, sensor 0x10–0x1F, siren 0x20–0x2F, gateway 0x30–0x3F. The platform maps a key
 * to its own name (an NVS key on the ESP32).
 */
enum class StoreKey : std::uint8_t {
  /** The board's role (D103); kept by erase_all_but_role. */
  role = 0x00,
  /** Pairing data (protocol section 9). */
  pairing = 0x01,
  /** The send counter's resume point (protocol section 4). */
  counter_resume = 0x02,
  /** The siren's last accepted command counter (protocol section 4). */
  command_counter = 0x03,
  /** The last fatal error code (FW5). */
  fatal_error = 0x04,
  sensor_first = 0x10,
  sensor_last = 0x1F,
  siren_first = 0x20,
  siren_last = 0x2F,
  gateway_first = 0x30,
  gateway_last = 0x3F,
};

/**
 * Persistent storage: NVS on the ESP32. Blocking, but bounded: a write takes at most 500 ms,
 * erase included. Every write is whole or nothing, and durable when it returns.
 */
class Storage {
public:
  /**
   * Copies the record into `out` and returns its size. HalError::not_found when it does not
   * exist, HalError::invalid when `out` is smaller than the record, HalError::io on a fault.
   */
  virtual HalResult<std::size_t> read(StoreKey key, protocol::MutableByteView out) = 0;

  /**
   * Replaces the record. HalError::invalid above kMaxRecordSize, HalError::io on a fault, in
   * which case the old value is kept.
   */
  virtual HalError write(StoreKey key, protocol::ByteView value) = 0;

  /**
   * Removes one record; removing one that does not exist succeeds.
   */
  virtual HalError erase(StoreKey key) = 0;

  /**
   * Removes every record except the role: factory reset (PR4), Erase, and a new pairing.
   */
  virtual HalError erase_all_but_role() = 0;

protected:
  Storage() = default;
  Storage(const Storage&) = default;
  Storage& operator=(const Storage&) = default;
  ~Storage() = default;
};

}  // namespace hsn::device
