#pragma once

#include <cstdint>

#include "hsn/protocol/bytes.hpp"

namespace hsn::protocol {

/**
 * CRC-32 as IEEE 802.3 and zlib compute it: the reflected polynomial 0xEDB88320, initial value and
 * final XOR 0xFFFFFFFF. It checks a transfer frame's data (m3-updates-design.md section 5) and the
 * retained block. `crc` continues an earlier result, so crc32(b, crc32(a)) is the CRC of a then b;
 * the CRC of "123456789" is 0xCBF43926.
 */
std::uint32_t crc32(ByteView bytes, std::uint32_t crc = 0);

}  // namespace hsn::protocol
