#pragma once

#include <cstddef>
#include <cstdint>

#include "hsn/device/status.hpp"
#include "hsn/protocol/bytes.hpp"

namespace hsn::device {

/** Size of a SHA-256 digest and of an HMAC-SHA256. */
constexpr std::size_t kSha256Size = 32;

/** Size of a Bluetooth session key (m3-updates-design.md section 5). */
constexpr std::size_t kSessionKeySize = 32;

/**
 * The crypto an update needs beyond the packet cipher (m3-updates-design.md sections 2, 3 and 5):
 * PSA Crypto in hsn_psa, on the host and the target. One SHA-256 runs at a time.
 */
class UpdateCrypto {
public:
  /**
   * Starts a SHA-256, discarding any one under way.
   */
  virtual HalError sha256_start() = 0;

  /**
   * Adds bytes to the SHA-256 under way. HalError::invalid when none was started.
   */
  virtual HalError sha256_add(protocol::ByteView bytes) = 0;

  /**
   * Finishes the SHA-256 under way into `digest`, kSha256Size bytes.
   */
  virtual HalError sha256_finish(protocol::MutableByteView digest) = 0;

  /**
   * Returns true when `signature_rs` (r then s, 32 bytes each, big-endian) is a valid ECDSA P-256
   * signature of the SHA-256 `digest` under `public_xy` (X then Y, 32 bytes each, without the 0x04
   * prefix, as protocol section 9 carries it). False for any failure.
   */
  virtual bool verify_p256(protocol::ByteView public_xy, protocol::ByteView digest,
                           protocol::ByteView signature_rs) = 0;

  /**
   * Derives a Bluetooth session key into `out` (kSessionKeySize bytes): HKDF-SHA256 with the
   * device key as the key, `nonce` (8 bytes) as the salt, and kSessionKeyLabel then `address`
   * (u32 LE) as the info. The device key is the one the platform holds for the packet cipher, so
   * the raw key never reaches the core.
   */
  virtual HalError session_key(protocol::ByteView nonce, std::uint32_t address,
                               protocol::MutableByteView out) = 0;

  /**
   * Writes HMAC-SHA256 of `message` under `key` into `out`, kSha256Size bytes.
   */
  virtual HalError hmac_sha256(protocol::ByteView key, protocol::ByteView message,
                               protocol::MutableByteView out) = 0;

protected:
  UpdateCrypto() = default;
  UpdateCrypto(const UpdateCrypto&) = default;
  UpdateCrypto& operator=(const UpdateCrypto&) = default;
  ~UpdateCrypto() = default;
};

}  // namespace hsn::device
