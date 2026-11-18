#pragma once

#include <psa/crypto.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <vector>

#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/image.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/setup.hpp"

namespace hsn::host {

using Bytes = std::vector<std::uint8_t>;

// Firmware images for the bench (m3-updates-design.md sections 3 and 8). A test image is laid out
// as ESP-IDF's application image (esp_image_header_t, one segment whose data starts with the
// esp_app_desc_t, the checksum byte at a 16-byte boundary, then the SHA-256 of all before it):
// the layout is stated from memory (‡ in the design) and checked again when a real image exists
// (step 3a). The fake bootloader and FakeFirmwareSlots::select() check images by it; the image's
// version is the app description's version string, "MAJOR.MINOR.PATCH".

/** The ESP image header's magic byte. */
constexpr std::uint8_t kEspImageMagic = 0xE9;

/** The chip id an ESP32-S3 image carries at offset 12. */
constexpr std::uint16_t kEspChipIdEsp32s3 = 9;

/** The app description's magic word. */
constexpr std::uint32_t kEspAppDescMagic = 0xABCD5432;

/** Offset of the app description's version string in the image (24 + 8 + 16). */
constexpr std::size_t kEspAppVersionOffset = 48;

/** What a test image is made of. */
struct TestImageSpec {
  protocol::FirmwareVersion version;
  /** Total bytes, at least; the image is this long or up to 18 bytes longer (alignment). */
  std::size_t size = 4096;
  /** Seeds the filler bytes, so two images of one version can differ. */
  std::uint32_t seed = 1;
  /** kEspChipIdEsp32s3 for a good image; another value for an image of the wrong chip. */
  std::uint16_t chip_id = kEspChipIdEsp32s3;
};

/** Makes a test image. */
Bytes make_test_image(const TestImageSpec& spec);

/** Makes a test image of `version`, `size` bytes or a little more. */
Bytes make_test_image(const protocol::FirmwareVersion& version, std::size_t size = 4096,
                      std::uint32_t seed = 1);

/** What the image check found. */
struct ImageCheck {
  bool ok = false;
  protocol::FirmwareVersion version;
  /** The image's whole length, its appended hash included. */
  std::size_t bytes = 0;
};

/**
 * The bootloader's check of the image at the start of `slot` (esp_image_verify, as the design has
 * it): the magic byte, the ESP32-S3 chip id, one to sixteen segments inside the slot, the checksum
 * byte, the appended SHA-256, and an app description with a version string. Reads nothing past
 * `slot`.
 */
ImageCheck check_test_image(protocol::ByteView slot);

/**
 * The version an image's app description names, read without checking the rest (so a broken
 * image's version can still be reported): nothing when there is no app description.
 */
std::optional<protocol::FirmwareVersion> version_in_image(protocol::ByteView image);

/** SHA-256 of `bytes`, through PSA. Throws SimulationError if PSA fails. */
protocol::Sha256Digest sha256_of(protocol::ByteView bytes);

/** A P-256 private scalar, 32 bytes big-endian. */
using SigningScalar = std::array<std::uint8_t, 32>;

/**
 * The private key of RFC 6979's P-256 example (A.2.5), which the vectors carry as
 * `signingPrivateKey`: a published test key.
 */
extern const SigningScalar kRfc6979TestKey;

/**
 * A hub's P-256 signing key (D35) for the bench: it signs image headers deterministically (RFC
 * 6979, as the hub's `@noble/curves` does), through PSA. Its public half is what pairing gives a
 * device; its identity is the first 8 bytes of that half's SHA-256 (protocol section 9).
 */
class HubSigningKey {
public:
  /** Imports `scalar`; throws SimulationError if PSA refuses it. */
  explicit HubSigningKey(const SigningScalar& scalar = kRfc6979TestKey);
  ~HubSigningKey();
  HubSigningKey(const HubSigningKey&) = delete;
  HubSigningKey& operator=(const HubSigningKey&) = delete;

  /** The public key, X then Y, as pairing carries it. */
  const protocol::SigningKey& public_key() const {
    return public_;
  }

  /** The hub identity: SHA-256 of the public key, first 8 bytes. */
  const protocol::HubIdentity& identity() const {
    return identity_;
  }

  /** Signs a SHA-256 digest: r then s, big-endian. */
  protocol::ImageSignature sign_digest(const protocol::Sha256Digest& digest) const;

  /** The SHA-256 the header's signature is over: the label, then the header's bytes 0 to 63. */
  static protocol::Sha256Digest signed_digest(const protocol::ImageHeader& header);

  /**
   * Makes and signs the header for `image`: the version its app description gives (zeros if it has
   * none), every role, the ESP32-S3 target, its length and SHA-256, this hub's identity.
   */
  protocol::ImageHeader header_for(protocol::ByteView image, bool own_build = false) const;

  /** Signs `header` as it stands (its signature replaced). */
  void sign(protocol::ImageHeader& header) const;

private:
  psa_key_id_t key_ = PSA_KEY_ID_NULL;
  protocol::SigningKey public_{};
  protocol::HubIdentity identity_{};
};

/** The 128 bytes of a header. */
Bytes header_bytes(const protocol::ImageHeader& header);

/** The file a device pulls: the header's 128 bytes, then the image. */
Bytes image_file(const protocol::ImageHeader& header, protocol::ByteView image);

}  // namespace hsn::host
