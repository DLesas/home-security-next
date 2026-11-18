#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <tuple>

#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/error.hpp"
#include "hsn/protocol/layout.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/setup.hpp"

namespace hsn::protocol {

/** Size of the device image header (m3-updates-design.md section 3). */
constexpr std::size_t kImageHeaderSize = 128;

/** Bytes of the header the hub's signature covers: offsets 0 to 63. */
constexpr std::size_t kImageHeaderSignedSize = 64;

/** Image header format version. */
constexpr std::uint8_t kImageHeaderFormat = 1;

/** The only target so far: an ESP32-S3 board of ours. */
constexpr std::uint8_t kImageTargetEsp32s3 = 1;

/**
 * The bytes the hub's P-256 signature is made over come after this label: "hsn-image/1" and a zero
 * byte, then the header's bytes 0 to 63. The signature is over their SHA-256.
 */
constexpr std::array<std::uint8_t, 12> kImageSignatureLabel{'h', 's', 'n', '-', 'i', 'm',
                                                            'a', 'g', 'e', '/', '1', 0};

/** An ECDSA P-256 signature: r then s, 32 bytes each, big-endian. */
using ImageSignature = std::array<std::uint8_t, 64>;

/** A SHA-256 digest. */
using Sha256Digest = std::array<std::uint8_t, 32>;

/** Flags of an image header. */
struct ImageHeaderFlags {
  /** An owner's own build, not from the publisher (D35, D84). */
  bool own_build = false;

  /**
   * Bit 0; the others are zero.
   */
  static constexpr auto flag_bits() {
    return std::make_tuple(field("ownBuild", &ImageHeaderFlags::own_build));
  }
};

/**
 * Returns the bit of `role` (Role) in an image header's roles: bit 1 sensor, bit 2 siren, bit 3
 * gateway; 0 for a role outside 1 to 7.
 */
constexpr std::uint8_t image_role_bit(std::uint8_t role) {
  return role >= 1 && role <= 7 ? static_cast<std::uint8_t>(1u << role) : std::uint8_t{0};
}

/**
 * The 128-byte header the hub makes and signs for every image it stores (m3-updates-design.md
 * section 3). The file a device pulls is this header followed by the image. Decoding checks the
 * structure only: the magic "HSNI" and the zero bytes (Error::bad_value) and the format
 * (Error::bad_version). The target, the hub identity, the role and the signature are the device's
 * checks, in the order section 3 lists them.
 */
struct ImageHeader {
  ImageHeaderFlags flags;
  /** One bit per role, as image_role_bit gives it. */
  std::uint8_t roles = 0;
  /** kImageTargetEsp32s3 for every image so far; an unlisted value decodes. */
  std::uint8_t target = 0;
  FirmwareVersion version;
  std::uint32_t image_bytes = 0;
  /** SHA-256 of the image bytes; its first 8 bytes are the image id. */
  Sha256Digest image_sha256{};
  /** The identity of the hub that signed it (protocol section 9). */
  HubIdentity hub_identity{};
  ImageSignature signature{};

  /**
   * Wire layout, 128 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(
        fixed_byte('H', Error::bad_value), fixed_byte('S', Error::bad_value),
        fixed_byte('N', Error::bad_value), fixed_byte('I', Error::bad_value),
        fixed_byte(kImageHeaderFormat, Error::bad_version), field("flags", &ImageHeader::flags),
        field("roles", &ImageHeader::roles), field("target", &ImageHeader::target),
        field("version", &ImageHeader::version), fixed_byte(0, Error::bad_value),
        field("imageBytes", &ImageHeader::image_bytes),
        field("imageSha256", &ImageHeader::image_sha256),
        field("hubIdentity", &ImageHeader::hub_identity), fixed_byte(0, Error::bad_value),
        fixed_byte(0, Error::bad_value), fixed_byte(0, Error::bad_value),
        fixed_byte(0, Error::bad_value), fixed_byte(0, Error::bad_value),
        fixed_byte(0, Error::bad_value), fixed_byte(0, Error::bad_value),
        fixed_byte(0, Error::bad_value), field("signature", &ImageHeader::signature));
  }
};

/**
 * Returns the header's image id: the first 8 bytes of the image's SHA-256.
 */
constexpr ImageId image_id_of(const ImageHeader& header) {
  ImageId id{};
  for (std::size_t i = 0; i < id.size(); ++i) {
    id[i] = header.image_sha256[i];
  }
  return id;
}

/**
 * Decodes an image header from its 128 bytes; extra bytes are ignored and `out` is left unchanged
 * on error.
 */
Error decode_image_header(ByteView bytes, ImageHeader& out);

/**
 * Encodes an image header and returns its size, 128.
 */
Result<std::size_t> encode_image_header(const ImageHeader& header, MutableByteView out);

}  // namespace hsn::protocol
