#pragma once

#include <cstddef>
#include <cstdint>

#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/error.hpp"
#include "hsn/protocol/packet.hpp"

namespace hsn::protocol {

/** Largest frame content: one link packet (section 10). */
constexpr std::size_t kMaxFrameDataSize = kMaxLinkPacketSize;

/**
 * Upper bound of the COBS encoding of `size` bytes: one code byte per started 254-byte block.
 */
constexpr std::size_t cobs_max_encoded_size(std::size_t size) {
  return size + size / 254 + 1;
}

/** Longest encoded frame a decoder accepts: what 1,024 bytes encode to, 1,029 (section 10). */
constexpr std::size_t kMaxEncodedFrameSize = cobs_max_encoded_size(kMaxFrameDataSize);

/**
 * COBS-encodes `data` into `out` (no delimiter) and returns the encoded size. No empty block is
 * added after a final run of exactly 254 non-zero bytes (section 10).
 */
Result<std::size_t> cobs_encode(ByteView data, MutableByteView out);

/**
 * Encodes one USB frame: COBS, then a zero byte. Fails with Error::too_long above 1,024 bytes.
 */
Result<std::size_t> encode_frame(ByteView data, MutableByteView out);

/**
 * Decodes one COBS frame given without its delimiter into `out`. Fails with Error::bad_frame for
 * invalid COBS (including an empty input or a zero byte), Error::too_long past the frame limits,
 * and Error::buffer_too_small when `out` is the limit.
 */
Result<std::size_t> cobs_decode(ByteView encoded, MutableByteView out);

/** What pushing one byte into a FrameDecoder produced. */
enum class FrameStatus : std::uint8_t {
  /** Nothing yet: mid-frame, or an empty frame skipped. */
  pending,
  /** A frame completed; `FrameEvent::data` holds it. */
  frame,
  /** A frame completed but was dropped; `FrameEvent::error` says why. */
  dropped,
};

/** The result of FrameDecoder::push. */
struct FrameEvent {
  FrameStatus status = FrameStatus::pending;
  Error error = Error::none;
  /** The decoded frame, a view into the decoder's storage valid until the next push. */
  ByteView data;
};

/**
 * Decodes a serial byte stream of zero-delimited COBS frames, in any chunking, into caller-owned
 * storage, decoding as bytes arrive so no encoded copy is kept. Empty frames are skipped; a frame
 * that is corrupt (Error::bad_frame), encodes longer than 1,029 bytes or decodes longer than 1,024
 * (Error::too_long), or does not fit the storage (Error::buffer_too_small) is dropped alone, and
 * decoding resumes at the next zero byte.
 */
class FrameDecoder {
public:
  /**
   * Decodes into `storage`; 1,024 bytes hold any frame.
   */
  explicit FrameDecoder(MutableByteView storage) : storage_(storage) {}

  /**
   * Feeds one byte of the stream.
   */
  FrameEvent push(std::uint8_t byte);

  /**
   * Forgets any partial frame.
   */
  void reset();

private:
  void append(std::uint8_t byte);

  MutableByteView storage_;
  std::size_t size_ = 0;
  std::size_t encoded_size_ = 0;
  /** Data bytes left in the current block; 0 means the next byte is a code byte. */
  std::size_t block_remaining_ = 0;
  /** True when the current block ends in an implied zero (its code was below 0xFF). */
  bool zero_after_block_ = false;
  Error error_ = Error::none;
};

}  // namespace hsn::protocol
