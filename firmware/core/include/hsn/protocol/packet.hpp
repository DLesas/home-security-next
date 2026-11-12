#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "hsn/protocol/binding.hpp"
#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/cipher.hpp"
#include "hsn/protocol/error.hpp"

namespace hsn::protocol {

/** Protocol version carried in the header's high nibble (section 3). */
constexpr std::uint8_t kProtocolVersion = 1;

/** The clear part of a packet: header, address, counter (section 3). */
constexpr std::size_t kClearSize = 9;

/** Bytes a packet adds around its plaintext: clear part and tag. */
constexpr std::size_t kPacketOverhead = kClearSize + kTagSize;

/** Smallest packet: clear part, type byte and tag (section 3). */
constexpr std::size_t kMinPacketSize = kPacketOverhead + 1;

/** Largest packet on the radio (section 3). */
constexpr std::size_t kMaxRadioPacketSize = 255;

/** Largest packet over WebSocket and USB (section 3). */
constexpr std::size_t kMaxLinkPacketSize = 1024;

/** Associated data: the clear part followed by the longest binding. */
constexpr std::size_t kMaxAssociatedDataSize = kClearSize + kMaxBindingSize;

/** Direction of a packet: header bit 3 and the nonce's direction byte (section 3). */
enum class Direction : std::uint8_t {
  to_hub = 0,
  from_hub = 1,
};

/** Size limit a packet is opened or sealed with (section 3). */
enum class PacketLimit : std::uint16_t {
  radio = kMaxRadioPacketSize,
  link = kMaxLinkPacketSize,
};

/** The fields of a packet's clear part. */
struct PacketHeader {
  Direction direction = Direction::to_hub;
  std::uint32_t address = 0;
  std::uint32_t counter = 0;
};

/** A packet whose tag verified and whose type matches its direction. */
struct OpenedPacket {
  PacketHeader header;
  std::uint8_t type = 0;
  /** The body, a view into the caller's plaintext buffer. */
  ByteView body;
};

/** Associated data built on the stack: at most 25 bytes. */
struct AssociatedData {
  std::array<std::uint8_t, kMaxAssociatedDataSize> bytes{};
  std::size_t size = 0;

  /**
   * Returns the bytes in use.
   */
  constexpr ByteView view() const {
    return ByteView(bytes.data(), size);
  }
};

/**
 * Returns false for the addresses no device can have: 0 and 0xFFFFFFFF (section 3).
 */
constexpr bool is_valid_address(std::uint32_t address) {
  return address != 0 && address != 0xFFFFFFFFu;
}

/**
 * Returns the direction a message type travels in: 0x80 and above come from the hub (section 5).
 */
constexpr Direction direction_of_type(std::uint8_t type) {
  return type >= 0x80 ? Direction::from_hub : Direction::to_hub;
}

/**
 * Checks and reads the clear part alone, as a receiver must before looking up a key (section 3,
 * "Order of checks"). Checks length, version, direction, address and counter.
 */
Result<PacketHeader> read_header(ByteView packet, Direction expected, PacketLimit limit);

/**
 * Builds the 13-byte nonce: address, direction byte, counter, four zero bytes.
 */
Nonce make_nonce(const PacketHeader& header);

/**
 * Builds the associated data: the clear part exactly as sent, then the binding.
 */
AssociatedData make_associated_data(ByteView clear_part, const Binding& binding);

/**
 * Opens a packet into the caller's `plaintext` buffer (at least packet size − 17 bytes). Nothing
 * from the encrypted part is used before the tag verifies; on any failure once decryption has
 * started, the bytes decrypted into are zeroed. The type-versus-direction rule is applied after
 * the tag; the body is decoded separately (decode_message), which refuses unknown types.
 * `packet` and `plaintext` must not overlap: Error::overlapping_buffers.
 */
Result<OpenedPacket> open_packet(const PacketCipher& cipher, ByteView packet, Direction expected,
                                 const Binding& binding, PacketLimit limit,
                                 MutableByteView plaintext);

/**
 * Seals `plaintext` (type byte then body) into `out` and returns the packet size. Refuses an
 * invalid address or counter, an empty plaintext, a type that does not match the direction, and
 * a packet over `limit`. `plaintext` and `out` must not overlap: Error::overlapping_buffers.
 */
Result<std::size_t> seal_packet(const PacketCipher& cipher, const PacketHeader& header,
                                const Binding& binding, ByteView plaintext, PacketLimit limit,
                                MutableByteView out);

}  // namespace hsn::protocol
