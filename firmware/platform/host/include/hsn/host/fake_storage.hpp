#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <vector>

#include "hsn/device/hal/clock.hpp"
#include "hsn/device/hal/storage.hpp"
#include "hsn/device/time.hpp"
#include "hsn/host/call_meter.hpp"

namespace hsn::host {

using Bytes = std::vector<std::uint8_t>;

/** Flash: a map of records that survives every reset, with every write recorded. */
class FakeStorage final : public device::Storage, public Metered {
public:
  /** One write or erase, as the device made it. */
  struct Operation {
    enum class Kind { write, erase, erase_all_but_role };
    device::Instant at;
    Kind kind = Kind::write;
    device::StoreKey key = device::StoreKey::role;
    Bytes value;
    bool failed = false;
  };

  explicit FakeStorage(const device::Clock& clock) : clock_(clock) {}

  device::HalResult<std::size_t> read(device::StoreKey key, protocol::MutableByteView out) override;
  device::HalError write(device::StoreKey key, protocol::ByteView value) override;
  device::HalError erase(device::StoreKey key) override;
  device::HalError erase_all_but_role() override;

  bool has(device::StoreKey key) const {
    return records.count(key) != 0;
  }

  /** Writes (not erases) to `key` that succeeded. */
  std::size_t write_count(device::StoreKey key) const;

  /** Every successful write and erase. */
  std::size_t change_count() const;

  std::map<device::StoreKey, Bytes> records;
  std::vector<Operation> operations;

  /** Fault switches: every write fails; or the next N writes fail; every read fails. */
  bool fail_writes = false;
  int fail_next_writes = 0;
  bool fail_reads = false;

private:
  bool write_fails();

  const device::Clock& clock_;
};

}  // namespace hsn::host
