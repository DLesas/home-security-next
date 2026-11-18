#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <tuple>

#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/error.hpp"
#include "hsn/protocol/layout.hpp"
#include "hsn/protocol/messages.hpp"

namespace hsn::protocol {

/**
 * First byte of every transfer frame (m3-updates-design.md section 5, "Transfer frames"). No packet
 * starts with it (packets start 0x10 or 0x18, setup messages 0xF1). Frames are not packets: they
 * are in the clear, and the image's signature checks what they carry. One frame per WebSocket
 * message, per COBS frame on USB, per Bluetooth write or notification. Little-endian.
 */
constexpr std::uint8_t kTransferMarker = 0xF2;

/** Most data bytes a Data frame carries: on Wi-Fi and USB a frame then fits a 1,024-byte buffer. */
constexpr std::size_t kMaxTransferData = 1000;

/** Bytes of a Data frame before its data: marker, kind, image id, offset, CRC-32. */
constexpr std::size_t kTransferDataHeaderSize = 18;

/** True for a length one Get may ask for: 1 to kMaxTransferData bytes. */
constexpr bool is_valid_transfer_length(std::uint16_t length) {
  return length >= 1 && length <= kMaxTransferData;
}

/** Transfer frame kinds, the byte after the marker. */
namespace transfer_kind {
constexpr std::uint8_t get = 0x01;
constexpr std::uint8_t data = 0x02;
constexpr std::uint8_t gone = 0x03;
constexpr std::uint8_t hello = 0x10;
constexpr std::uint8_t open = 0x11;
constexpr std::uint8_t done = 0x12;
}  // namespace transfer_kind

/** Why a source answers a Get with Gone. */
struct GoneReason {
  static constexpr std::uint8_t not_available = 0;
  static constexpr std::uint8_t not_granted = 1;
  static constexpr std::uint8_t paused = 2;
  static constexpr std::uint8_t out_of_range = 3;
  static constexpr std::array<std::uint8_t, 4> known{not_available, not_granted, paused,
                                                     out_of_range};
};

/** The result in a Done frame. */
struct DoneResult {
  static constexpr std::uint8_t verified = 0;
  static constexpr std::uint8_t refused = 1;
  static constexpr std::array<std::uint8_t, 2> known{verified, refused};
};

/** A session tag in an Open frame: the first 16 bytes of an HMAC-SHA256 (section 5). */
using SessionTag = std::array<std::uint8_t, 16>;

/** A device's random value in a Hello frame. */
using DeviceRandom = std::array<std::uint8_t, 8>;

/**
 * The info of the Bluetooth session key's HKDF-SHA256, before the device address (u32 LE):
 * "hsn-ble-update/1" and a zero byte. The key is the device key, the salt the session nonce.
 */
constexpr std::array<std::uint8_t, 17> kSessionKeyLabel{'h', 's', 'n', '-', 'b', 'l', 'e', '-', 'u',
                                                        'p', 'd', 'a', 't', 'e', '/', '1', 0};

/**
 * The start of the message an Open frame's tag is the HMAC-SHA256 of, under the session key:
 * "hsn-ble-open/1" and a zero byte, then the address (u32 LE), the device random and the image id.
 */
constexpr std::array<std::uint8_t, 15> kSessionOpenLabel{'h', 's', 'n', '-', 'b', 'l', 'e', '-',
                                                         'o', 'p', 'e', 'n', '/', '1', 0};

/** The frames (m3-updates-design.md section 5); each struct is the body after marker and kind. */
namespace transfer {

/** Get (0x01), device to source: asks for `length` bytes of the file at `offset`. */
struct Get {
  static constexpr std::uint8_t kind = transfer_kind::get;
  ImageId image_id{};
  /** Counted from the image header's first byte. */
  std::uint32_t offset = 0;
  /** 1 to kMaxTransferData; anything else is Error::bad_value. */
  std::uint16_t length = 0;

  /**
   * Wire layout, 14 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(
        field("imageId", &Get::image_id), field("offset", &Get::offset),
        checked_field("length", &Get::length, &is_valid_transfer_length, Error::bad_value));
  }
};

/** Data (0x02), source to device: the bytes one Get asked for, with their CRC-32. */
struct Data {
  static constexpr std::uint8_t kind = transfer_kind::data;
  ImageId image_id{};
  std::uint32_t offset = 0;
  /** CRC-32 of `data` (crc32 in checksum.hpp). */
  std::uint32_t crc32 = 0;
  /** A view into the input, to the end of the frame. */
  TrailingBytes<kMaxTransferData> data;

  /**
   * Wire layout: 16 bytes, then the data to the end of the frame.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("imageId", &Data::image_id), field("offset", &Data::offset),
                           field("crc32", &Data::crc32), field("data", &Data::data));
  }
};

/** Gone (0x03), source to device: why a Get gets no Data. */
struct Gone {
  static constexpr std::uint8_t kind = transfer_kind::gone;
  ImageId image_id{};
  /** See GoneReason. */
  std::uint8_t reason = 0;

  /**
   * Wire layout, 9 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("imageId", &Gone::image_id), field("reason", &Gone::reason));
  }
};

/** Hello (0x10), device to phone, Bluetooth only: the first frame of a session. */
struct Hello {
  static constexpr std::uint8_t kind = transfer_kind::hello;
  std::uint32_t address = 0;
  DeviceRandom device_random{};
  ImageId image_id{};
  std::uint32_t bytes_held = 0;
  /** The most data bytes one Data frame may carry on this connection. */
  std::uint16_t largest_data = 0;

  /**
   * Wire layout, 26 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(
        field("address", &Hello::address), field("deviceRandom", &Hello::device_random),
        field("imageId", &Hello::image_id), field("bytesHeld", &Hello::bytes_held),
        field("largestData", &Hello::largest_data));
  }
};

/** Open (0x11), phone to device: the session tag. */
struct Open {
  static constexpr std::uint8_t kind = transfer_kind::open;
  SessionTag tag{};

  /**
   * Wire layout, 16 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("tag", &Open::tag));
  }
};

/** Done (0x12), device to phone, Bluetooth only: the session's end. */
struct Done {
  static constexpr std::uint8_t kind = transfer_kind::done;
  ImageId image_id{};
  /** See DoneResult. */
  std::uint8_t result = 0;
  /** As an update status's reason (UpdateReason). */
  std::uint8_t reason = 0;

  /**
   * Wire layout, 10 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("imageId", &Done::image_id), field("result", &Done::result),
                           field("reason", &Done::reason));
  }
};

}  // namespace transfer

/** Every transfer frame, for dispatch on the kind byte. */
using TransferFrames = std::tuple<transfer::Get, transfer::Data, transfer::Gone, transfer::Hello,
                                  transfer::Open, transfer::Done>;

/**
 * Decodes the body of a transfer frame (the bytes after marker and kind) into `out`. Extra bytes
 * after a frame's fields are ignored, as for message bodies; `out` is left unchanged on error.
 * Instantiated for every type in TransferFrames.
 */
template <typename Frame>
Error decode_transfer_body(ByteView body, Frame& out);

/**
 * Writes a transfer frame, marker, kind and body, and returns its size. Instantiated for every
 * type in TransferFrames.
 */
template <typename Frame>
Result<std::size_t> encode_transfer(const Frame& frame, MutableByteView out);

/**
 * Decodes a transfer frame and passes the decoded struct to `visitor`, which must accept every
 * type in TransferFrames. Fails with Error::truncated, Error::bad_value (no marker),
 * Error::unknown_type, or the body's error.
 */
template <typename Visitor>
Error decode_transfer(ByteView bytes, Visitor&& visitor) {
  if (bytes.empty()) {
    return Error::truncated;
  }
  if (bytes[0] != kTransferMarker) {
    return Error::bad_value;
  }
  if (bytes.size() < 2) {
    return Error::truncated;
  }
  const std::uint8_t kind = bytes[1];
  const ByteView body = bytes.subspan(2);
  Error error = Error::unknown_type;
  for_each_type<TransferFrames>([&](auto tag) {
    using Frame = typename decltype(tag)::type;
    if (Frame::kind != kind) {
      return;
    }
    Frame frame;
    error = decode_transfer_body(body, frame);
    if (error == Error::none) {
      visitor(static_cast<const Frame&>(frame));
    }
  });
  return error;
}

}  // namespace hsn::protocol
