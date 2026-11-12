#include "hsn/protocol/framing.hpp"

namespace hsn::protocol {
namespace {

// A block holds at most 254 data bytes; its code byte is the count plus one.
constexpr std::size_t kMaxBlockData = 254;

}  // namespace

Result<std::size_t> cobs_encode(ByteView data, MutableByteView out) {
  if (out.empty()) {
    return Error::buffer_too_small;
  }
  std::size_t code_index = 0;
  std::size_t size = 1;
  std::size_t block_length = 0;
  // Writes the current block's code byte and reserves room for the next block's.
  const auto next_block = [&]() {
    out[code_index] = static_cast<std::uint8_t>(block_length + 1);
    if (size == out.size()) {
      return false;
    }
    code_index = size;
    size += 1;
    block_length = 0;
    return true;
  };
  for (std::size_t i = 0; i < data.size(); ++i) {
    if (data[i] == 0) {
      if (!next_block()) {
        return Error::buffer_too_small;
      }
      continue;
    }
    if (size == out.size()) {
      return Error::buffer_too_small;
    }
    out[size] = data[i];
    size += 1;
    block_length += 1;
    // A full block has no implied zero. Open the next one only if data follows, so a final run
    // of exactly 254 bytes gets no empty block after it.
    if (block_length == kMaxBlockData && i + 1 < data.size() && !next_block()) {
      return Error::buffer_too_small;
    }
  }
  out[code_index] = static_cast<std::uint8_t>(block_length + 1);
  return size;
}

Result<std::size_t> encode_frame(ByteView data, MutableByteView out) {
  if (data.size() > kMaxFrameDataSize) {
    return Error::too_long;
  }
  const Result<std::size_t> encoded = cobs_encode(data, out);
  if (!encoded.ok()) {
    return encoded;
  }
  if (encoded.value() == out.size()) {
    return Error::buffer_too_small;
  }
  out[encoded.value()] = 0;
  return encoded.value() + 1;
}

Result<std::size_t> cobs_decode(ByteView encoded, MutableByteView out) {
  if (encoded.empty()) {
    return Error::bad_frame;
  }
  FrameDecoder decoder(out);
  for (const std::uint8_t byte : encoded) {
    if (byte == 0) {
      return Error::bad_frame;
    }
    decoder.push(byte);
  }
  const FrameEvent event = decoder.push(0);
  if (event.status == FrameStatus::frame) {
    return event.data.size();
  }
  return event.error;
}

FrameEvent FrameDecoder::push(std::uint8_t byte) {
  if (byte == 0) {
    FrameEvent event;
    if (error_ != Error::none) {
      event.status = FrameStatus::dropped;
      event.error = error_;
    } else if (block_remaining_ != 0) {
      // The frame ended inside a block.
      event.status = FrameStatus::dropped;
      event.error = Error::bad_frame;
    } else if (encoded_size_ != 0) {
      // A frame that decodes to no bytes is passed on and fails later as too short (section 10).
      event.status = FrameStatus::frame;
      event.data = ByteView(storage_).first(size_);
    }
    reset();
    return event;
  }
  if (error_ != Error::none) {
    return FrameEvent{};
  }
  encoded_size_ += 1;
  if (encoded_size_ > kMaxEncodedFrameSize) {
    error_ = Error::too_long;
    return FrameEvent{};
  }
  if (block_remaining_ == 0) {
    // A code byte. The previous block's implied zero is only real when another block follows.
    if (zero_after_block_) {
      append(0);
    }
    block_remaining_ = static_cast<std::size_t>(byte) - 1;
    zero_after_block_ = byte != 0xFF;
  } else {
    append(byte);
    block_remaining_ -= 1;
  }
  return FrameEvent{};
}

void FrameDecoder::reset() {
  size_ = 0;
  encoded_size_ = 0;
  block_remaining_ = 0;
  zero_after_block_ = false;
  error_ = Error::none;
}

void FrameDecoder::append(std::uint8_t byte) {
  if (size_ == kMaxFrameDataSize) {
    error_ = Error::too_long;
    return;
  }
  if (size_ == storage_.size()) {
    error_ = Error::buffer_too_small;
    return;
  }
  storage_[size_] = byte;
  size_ += 1;
}

}  // namespace hsn::protocol
