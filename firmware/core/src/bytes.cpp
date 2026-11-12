#include "hsn/protocol/bytes.hpp"

namespace hsn::protocol {

bool ByteReader::read_u8(std::uint8_t& out) {
  if (remaining() < 1) {
    return false;
  }
  out = bytes_[position_];
  position_ += 1;
  return true;
}

bool ByteReader::read_u16(std::uint16_t& out) {
  if (remaining() < 2) {
    return false;
  }
  const auto low = static_cast<unsigned>(bytes_[position_]);
  const auto high = static_cast<unsigned>(bytes_[position_ + 1]);
  out = static_cast<std::uint16_t>(low | (high << 8));
  position_ += 2;
  return true;
}

bool ByteReader::read_u32(std::uint32_t& out) {
  if (remaining() < 4) {
    return false;
  }
  std::uint32_t value = 0;
  for (std::size_t i = 0; i < 4; ++i) {
    value |= static_cast<std::uint32_t>(bytes_[position_ + i]) << (8 * i);
  }
  out = value;
  position_ += 4;
  return true;
}

bool ByteReader::read_i8(std::int8_t& out) {
  std::uint8_t raw = 0;
  if (!read_u8(raw)) {
    return false;
  }
  out = to_signed(raw);
  return true;
}

bool ByteReader::read_i16(std::int16_t& out) {
  std::uint16_t raw = 0;
  if (!read_u16(raw)) {
    return false;
  }
  out = to_signed(raw);
  return true;
}

bool ByteReader::read_bytes(MutableByteView out) {
  ByteView source;
  if (!read_view(out.size(), source)) {
    return false;
  }
  for (std::size_t i = 0; i < source.size(); ++i) {
    out[i] = source[i];
  }
  return true;
}

bool ByteReader::read_view(std::size_t count, ByteView& out) {
  if (remaining() < count) {
    return false;
  }
  out = bytes_.subspan(position_, count);
  position_ += count;
  return true;
}

ByteView ByteReader::read_rest() {
  const ByteView rest = bytes_.subspan(position_);
  position_ = bytes_.size();
  return rest;
}

bool ByteWriter::write_u8(std::uint8_t value) {
  if (remaining() < 1) {
    return false;
  }
  out_[position_] = value;
  position_ += 1;
  return true;
}

bool ByteWriter::write_u16(std::uint16_t value) {
  if (remaining() < 2) {
    return false;
  }
  out_[position_] = static_cast<std::uint8_t>(value & 0xFFu);
  out_[position_ + 1] = static_cast<std::uint8_t>(value >> 8);
  position_ += 2;
  return true;
}

bool ByteWriter::write_u32(std::uint32_t value) {
  if (remaining() < 4) {
    return false;
  }
  for (std::size_t i = 0; i < 4; ++i) {
    out_[position_ + i] = static_cast<std::uint8_t>((value >> (8 * i)) & 0xFFu);
  }
  position_ += 4;
  return true;
}

bool ByteWriter::write_i8(std::int8_t value) {
  // Signed to unsigned conversion is defined as modulo 2^8: two's complement on every host.
  return write_u8(static_cast<std::uint8_t>(value));
}

bool ByteWriter::write_i16(std::int16_t value) {
  return write_u16(static_cast<std::uint16_t>(value));
}

bool ByteWriter::write_bytes(ByteView bytes) {
  if (remaining() < bytes.size()) {
    return false;
  }
  for (std::size_t i = 0; i < bytes.size(); ++i) {
    out_[position_ + i] = bytes[i];
  }
  position_ += bytes.size();
  return true;
}

}  // namespace hsn::protocol
