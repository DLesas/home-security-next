#pragma once

#include <psa/crypto.h>

#include "hsn/protocol/cipher.hpp"

namespace hsn::psa {

class PsaKeyImport;

/**
 * The packet cipher on the PSA Crypto API (public headers only, as ESP-IDF v6.1's Mbed TLS 4.1
 * requires): AES-128-CCM with an 8-byte tag. The key is imported once by set_key() and reused
 * for every packet, then destroyed with the object.
 */
class PsaPacketCipher final : public protocol::PacketCipher {
public:
  PsaPacketCipher() = default;
  ~PsaPacketCipher();
  PsaPacketCipher(const PsaPacketCipher&) = delete;
  PsaPacketCipher& operator=(const PsaPacketCipher&) = delete;

  /**
   * Imports `key` as a volatile key usable only for this algorithm, replacing the earlier key only
   * once it is in: when PSA refuses it, the earlier key stays in use. Initialises PSA Crypto
   * first, which is harmless when already done.
   */
  [[nodiscard]] protocol::Error set_key(const protocol::DeviceKey& key);

  /**
   * See PacketCipher::seal. Fails with Error::cipher_failure when no key is set.
   */
  [[nodiscard]] protocol::Error seal(const protocol::Nonce& nonce,
                                     protocol::ByteView associated_data,
                                     protocol::ByteView plaintext,
                                     protocol::MutableByteView sealed) const override;

  /**
   * See PacketCipher::open.
   */
  [[nodiscard]] protocol::Error open(const protocol::Nonce& nonce,
                                     protocol::ByteView associated_data, protocol::ByteView sealed,
                                     protocol::MutableByteView plaintext) const override;

private:
  friend class PsaKeyImport;

  /** Takes `key`, already imported for this algorithm, and destroys the earlier one. */
  void adopt(psa_key_id_t key);

  psa_key_id_t key_ = PSA_KEY_ID_NULL;
};

}  // namespace hsn::psa
