#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/error.hpp"

namespace hsn::protocol {

/** Size of a device key: AES-128 (section 3). */
constexpr std::size_t kKeySize = 16;

/** Size of the CCM nonce: address, direction, counter, four zero bytes (section 3). */
constexpr std::size_t kNonceSize = 13;

/** Size of the CCM authentication tag (section 3). */
constexpr std::size_t kTagSize = 8;

/** A device's 16-byte key. */
using DeviceKey = std::array<std::uint8_t, kKeySize>;

/** A packet nonce. */
using Nonce = std::array<std::uint8_t, kNonceSize>;

/**
 * AES-128-CCM with an 8-byte tag under one device key, kept behind an interface so the core
 * never depends on a crypto library. The destructor is protected and non-virtual: ciphers are
 * owned by value by the platform, never deleted through this interface.
 */
class PacketCipher {
public:
  /**
   * Encrypts `plaintext` and writes the ciphertext followed by the tag into `sealed`, which must
   * be exactly plaintext.size() + kTagSize bytes.
   */
  [[nodiscard]] virtual Error seal(const Nonce& nonce, ByteView associated_data, ByteView plaintext,
                                   MutableByteView sealed) const = 0;

  /**
   * Verifies the tag at the end of `sealed` and decrypts into `plaintext`, which must be exactly
   * sealed.size() - kTagSize bytes. Returns Error::bad_tag when the tag does not verify; on any
   * failure `plaintext` is zeroed, so no unauthenticated byte is ever exposed.
   */
  [[nodiscard]] virtual Error open(const Nonce& nonce, ByteView associated_data, ByteView sealed,
                                   MutableByteView plaintext) const = 0;

protected:
  PacketCipher() = default;
  PacketCipher(const PacketCipher&) = default;
  PacketCipher& operator=(const PacketCipher&) = default;
  ~PacketCipher() = default;
};

}  // namespace hsn::protocol
