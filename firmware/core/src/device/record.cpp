#include "hsn/device/services/record.hpp"

#include <array>
#include <cstring>

namespace hsn::device {

// Out of line, so the one buffer as large as any record is on this function's stack only, and
// never added to that of a caller loading several records.
HalError read_record(Storage& storage, StoreKey key, std::uint8_t version,
                     protocol::MutableByteView out) {
  std::array<std::uint8_t, kMaxRecordSize> stored{};
  const auto read = storage.read(key, protocol::MutableByteView(stored));
  if (!read.ok()) {
    return read.error();
  }
  const std::size_t size = read.value() < stored.size() ? read.value() : stored.size();
  if (size == 0 || stored[0] != version) {
    return HalError::invalid;
  }
  const std::size_t fields = size - 1;
  const std::size_t known = fields < out.size() ? fields : out.size();
  if (known > 0) {
    std::memcpy(out.data(), stored.data() + 1, known);
  }
  return HalError::none;
}

}  // namespace hsn::device
