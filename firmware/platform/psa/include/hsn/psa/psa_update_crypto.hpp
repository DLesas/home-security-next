#pragma once

#include <psa/crypto.h>

#include <cstddef>
#include <cstdint>

#include "hsn/device/hal/key_import.hpp"
#include "hsn/device/hal/update_crypto.hpp"
#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/cipher.hpp"
#include "hsn/psa/psa_packet_cipher.hpp"

namespace hsn::psa {

/** The Bluetooth session nonce's size: the update offer's (protocol section 6). */
constexpr std::size_t kSessionNonceSize = 8;

/**
 * The update crypto on the PSA Crypto API (public headers only, as ESP-IDF v6.1's Mbed TLS 4.1
 * requires; m3-updates-design.md sections 2, 3 and 5): SHA-256 in three steps, ECDSA P-256
 * verification over a SHA-256 digest, the Bluetooth session key by HKDF-SHA256 from the device
 * key, and HMAC-SHA256. No heap of its own, no exceptions; every failure is a HalError (false for
 * verify_p256), and an output it could not fill is zeroed. The operations PSA keeps state in are
 * members, not locals, so no stack frame holds them; PSA wipes them when they end.
 *
 * The device key is imported into PSA as an HKDF secret (set_device_key, or PsaKeyImport for the
 * packet cipher and this together), so the raw key stays in PSA's key store and is never held here.
 */
class PsaUpdateCrypto final : public device::UpdateCrypto {
public:
  PsaUpdateCrypto() = default;
  /** Aborts a hash under way and destroys the device key. */
  ~PsaUpdateCrypto();
  PsaUpdateCrypto(const PsaUpdateCrypto&) = delete;
  PsaUpdateCrypto& operator=(const PsaUpdateCrypto&) = delete;

  /**
   * Imports the device key session_key() derives from, replacing the earlier one only once it is
   * in: HalError::io when PSA refuses it, and the earlier key stays.
   */
  device::HalError set_device_key(const protocol::DeviceKey& key);

  /** True once a device key is held. */
  bool has_device_key() const {
    return device_key_ != PSA_KEY_ID_NULL;
  }

  /** Discards a hash under way; HalError::io when PSA cannot start one. */
  device::HalError sha256_start() override;

  /**
   * HalError::invalid with no hash under way; HalError::io when PSA fails, which ends the hash.
   */
  device::HalError sha256_add(protocol::ByteView bytes) override;

  /**
   * Ends the hash. HalError::invalid with none under way, or for a digest not kSha256Size bytes
   * (the hash then goes on); HalError::io when PSA fails. `digest` is zeroed on any failure.
   */
  device::HalError sha256_finish(protocol::MutableByteView digest) override;

  /**
   * See UpdateCrypto::verify_p256. Both a low and a high `s` verify (the hub's signatures are not
   * normalised, image-header.json "signing"). False for wrong sizes, a key that is no point on the
   * curve, and any PSA failure.
   */
  bool verify_p256(protocol::ByteView public_xy, protocol::ByteView digest,
                   protocol::ByteView signature_rs) override;

  /**
   * See UpdateCrypto::session_key. HalError::invalid without a device key, for a nonce not
   * kSessionNonceSize bytes or an `out` not kSessionKeySize bytes; HalError::io when PSA fails.
   * `out` is zeroed on any failure.
   */
  device::HalError session_key(protocol::ByteView nonce, std::uint32_t address,
                               protocol::MutableByteView out) override;

  /**
   * See UpdateCrypto::hmac_sha256. HalError::invalid for an empty key or an `out` not kSha256Size
   * bytes; HalError::io when PSA fails. `out` is zeroed on any failure.
   */
  device::HalError hmac_sha256(protocol::ByteView key, protocol::ByteView message,
                               protocol::MutableByteView out) override;

private:
  friend class PsaKeyImport;

  /** Takes `key`, already imported as the session secret, and destroys the earlier one. */
  void adopt_device_key(psa_key_id_t key);
  void end_hash();

  psa_hash_operation_t hash_ = PSA_HASH_OPERATION_INIT;
  bool hashing_ = false;
  psa_key_id_t device_key_ = PSA_KEY_ID_NULL;
  psa_key_derivation_operation_t derivation_ = PSA_KEY_DERIVATION_OPERATION_INIT;
};

/**
 * The device key the platform holds, on PSA: one import of the key into both the packet cipher
 * and the update crypto's session secret, both or neither. The platform calls it with the paired
 * key at start-up; the core calls it after a key change (m3-updates-design.md section 7).
 */
class PsaKeyImport final : public device::KeyImport {
public:
  PsaKeyImport(PsaPacketCipher& cipher, PsaUpdateCrypto& crypto)
      : cipher_(cipher), crypto_(crypto) {}
  PsaKeyImport(const PsaKeyImport&) = delete;
  PsaKeyImport& operator=(const PsaKeyImport&) = delete;
  ~PsaKeyImport() = default;

  /**
   * Imports `key` for both; HalError::io when PSA refuses either, and then both keep the key they
   * had.
   */
  device::HalError import_key(const protocol::DeviceKey& key) override;

private:
  PsaPacketCipher& cipher_;
  PsaUpdateCrypto& crypto_;
};

}  // namespace hsn::psa
