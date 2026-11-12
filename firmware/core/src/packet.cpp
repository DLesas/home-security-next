#include "hsn/protocol/packet.hpp"

#include <cstring>

namespace hsn::protocol {
namespace {

constexpr std::uint8_t kDirectionBit = 0x08;

constexpr std::uint8_t header_byte(Direction direction) {
  return static_cast<std::uint8_t>((kProtocolVersion << 4) |
                                   (direction == Direction::from_hub ? kDirectionBit : 0));
}

void wipe(MutableByteView bytes) {
  if (!bytes.empty()) {
    std::memset(bytes.data(), 0, bytes.size());
  }
}

}  // namespace

Result<PacketHeader> read_header(ByteView packet, Direction expected, PacketLimit limit) {
  if (packet.size() < kMinPacketSize) {
    return Error::truncated;
  }
  if (packet.size() > static_cast<std::size_t>(limit)) {
    return Error::too_long;
  }
  ByteReader reader(packet);
  std::uint8_t header = 0;
  PacketHeader result;
  // The size check above guarantees all nine clear bytes are there.
  if (!reader.read_u8(header) || !reader.read_u32(result.address) ||
      !reader.read_u32(result.counter)) {
    return Error::truncated;
  }
  if ((header >> 4) != kProtocolVersion) {
    return Error::bad_version;
  }
  // The three low bits are ignored on receipt (section 3, "Header").
  result.direction = (header & kDirectionBit) != 0 ? Direction::from_hub : Direction::to_hub;
  if (result.direction != expected) {
    return Error::wrong_direction;
  }
  if (!is_valid_address(result.address)) {
    return Error::bad_address;
  }
  if (result.counter == 0) {
    return Error::bad_counter;
  }
  return result;
}

Nonce make_nonce(const PacketHeader& header) {
  Nonce nonce{};
  ByteWriter writer(nonce);
  // 13 bytes always fit: 4 + 1 + 4, and the last four stay zero.
  const bool written = writer.write_u32(header.address) &&
                       writer.write_u8(static_cast<std::uint8_t>(header.direction)) &&
                       writer.write_u32(header.counter);
  static_cast<void>(written);
  return nonce;
}

AssociatedData make_associated_data(ByteView clear_part, const Binding& binding) {
  AssociatedData data;
  ByteWriter writer(data.bytes);
  // At most 9 + 16 bytes, which is the buffer's size.
  const bool written =
      writer.write_bytes(clear_part.first(kClearSize)) && writer.write_bytes(binding.view());
  static_cast<void>(written);
  data.size = writer.size();
  return data;
}

Result<OpenedPacket> open_packet(const PacketCipher& cipher, ByteView packet, Direction expected,
                                 const Binding& binding, PacketLimit limit,
                                 MutableByteView plaintext) {
  const Result<PacketHeader> header = read_header(packet, expected, limit);
  if (!header.ok()) {
    return header.error();
  }
  const std::size_t plaintext_size = packet.size() - kPacketOverhead;
  if (overlap(packet, plaintext)) {
    return Error::overlapping_buffers;
  }
  if (plaintext.size() < plaintext_size) {
    return Error::buffer_too_small;
  }
  const MutableByteView decrypted = plaintext.first(plaintext_size);
  const AssociatedData associated_data = make_associated_data(packet, binding);
  const Error opened = cipher.open(make_nonce(header.value()), associated_data.view(),
                                   packet.subspan(kClearSize), decrypted);
  if (opened != Error::none) {
    // The interface promises a zeroed buffer; wiping here as well keeps the core's guarantee
    // independent of any one cipher implementation.
    wipe(decrypted);
    return opened;
  }
  const std::uint8_t type = decrypted[0];
  // Checked before the known-type rule; the order does not matter (section 3, "Any failed check").
  if (direction_of_type(type) != expected) {
    wipe(decrypted);
    return Error::wrong_direction;
  }
  return OpenedPacket{header.value(), type, ByteView(decrypted).subspan(1)};
}

Result<std::size_t> seal_packet(const PacketCipher& cipher, const PacketHeader& header,
                                const Binding& binding, ByteView plaintext, PacketLimit limit,
                                MutableByteView out) {
  if (!is_valid_address(header.address)) {
    return Error::bad_address;
  }
  if (header.counter == 0) {
    return Error::bad_counter;
  }
  if (plaintext.empty()) {
    return Error::truncated;
  }
  if (direction_of_type(plaintext[0]) != header.direction) {
    return Error::wrong_direction;
  }
  const std::size_t packet_size = plaintext.size() + kPacketOverhead;
  if (packet_size > static_cast<std::size_t>(limit)) {
    return Error::too_long;
  }
  if (overlap(plaintext, out)) {
    return Error::overlapping_buffers;
  }
  if (out.size() < packet_size) {
    return Error::buffer_too_small;
  }
  ByteWriter writer(out);
  // The size check above guarantees the clear part fits.
  const bool written = writer.write_u8(header_byte(header.direction)) &&
                       writer.write_u32(header.address) && writer.write_u32(header.counter);
  static_cast<void>(written);
  const AssociatedData associated_data = make_associated_data(out, binding);
  const Error sealed = cipher.seal(make_nonce(header), associated_data.view(), plaintext,
                                   out.subspan(kClearSize, plaintext.size() + kTagSize));
  if (sealed != Error::none) {
    wipe(out.first(packet_size));
    return sealed;
  }
  return packet_size;
}

}  // namespace hsn::protocol
