#include "hsn/protocol/checksum.hpp"

#include <cstddef>

namespace hsn::protocol {

std::uint32_t crc32(ByteView bytes, std::uint32_t crc) {
  // Bit by bit: small, and bounded by the input's length.
  crc = ~crc;
  for (std::size_t i = 0; i < bytes.size(); ++i) {
    crc ^= bytes[i];
    for (int bit = 0; bit < 8; ++bit) {
      const std::uint32_t mask = 0u - (crc & 1u);
      crc = (crc >> 1) ^ (0xEDB88320u & mask);
    }
  }
  return ~crc;
}

}  // namespace hsn::protocol
