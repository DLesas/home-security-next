#include "hsn/psa/psa_update_crypto.hpp"

#include <array>
#include <cstring>

#include "hsn/protocol/transfer.hpp"
#include "psa_call.hpp"
#include "psa_keys.hpp"

namespace hsn::psa {
namespace {

using device::HalError;

/** The image signature's algorithm: ECDSA P-256 over a SHA-256 digest (section 3). */
constexpr psa_algorithm_t kSignatureAlgorithm = PSA_ALG_ECDSA(PSA_ALG_SHA_256);
constexpr psa_algorithm_t kHmacAlgorithm = PSA_ALG_HMAC(PSA_ALG_SHA_256);

/** A P-256 public key as protocol section 9 carries it, X then Y, and as PSA takes it, after 0x04.
 */
constexpr std::size_t kPublicXySize = 64;
constexpr std::size_t kSignatureSize = 64;

void wipe(protocol::MutableByteView bytes) {
  if (!bytes.empty()) {
    std::memset(bytes.data(), 0, bytes.size());
  }
}

/** The session key's info: the label, then the address (u32 little-endian). Nothing secret. */
using SessionInfo = std::array<std::uint8_t, protocol::kSessionKeyLabel.size() + 4>;

SessionInfo session_info(std::uint32_t address) {
  SessionInfo info{};
  std::memcpy(info.data(), protocol::kSessionKeyLabel.data(), protocol::kSessionKeyLabel.size());
  for (std::size_t i = 0; i < 4; ++i) {
    info[protocol::kSessionKeyLabel.size() + i] =
        static_cast<std::uint8_t>((address >> (8 * i)) & 0xFFu);
  }
  return info;
}

}  // namespace

PsaUpdateCrypto::~PsaUpdateCrypto() {
  end_hash();
  detail::destroy(device_key_);
}

void PsaUpdateCrypto::end_hash() {
  if (hashing_) {
    static_cast<void>(psa_hash_abort(&hash_));
    hashing_ = false;
  }
}

void PsaUpdateCrypto::adopt_device_key(psa_key_id_t key) {
  detail::destroy(device_key_);
  device_key_ = key;
}

HalError PsaUpdateCrypto::set_device_key(const protocol::DeviceKey& key) {
  psa_key_id_t imported = PSA_KEY_ID_NULL;
  if (detail::import_session_secret(key, imported) != PSA_SUCCESS) {
    return HalError::io;
  }
  adopt_device_key(imported);
  return HalError::none;
}

HalError PsaUpdateCrypto::sha256_start() {
  end_hash();
  if (HSN_PSA(psa_crypto_init()) != PSA_SUCCESS) {
    return HalError::io;
  }
  // All-bits-zero is a fresh operation (PSA Crypto API 1.x); unlike assigning
  // PSA_HASH_OPERATION_INIT it puts no copy of the operation on the stack.
  std::memset(&hash_, 0, sizeof(hash_));
  if (HSN_PSA(psa_hash_setup(&hash_, PSA_ALG_SHA_256)) != PSA_SUCCESS) {
    // A failed set-up leaves the operation to be aborted (PSA's rule for every failed step).
    static_cast<void>(psa_hash_abort(&hash_));
    return HalError::io;
  }
  hashing_ = true;
  return HalError::none;
}

HalError PsaUpdateCrypto::sha256_add(protocol::ByteView bytes) {
  if (!hashing_) {
    return HalError::invalid;
  }
  if (HSN_PSA(psa_hash_update(&hash_, bytes.data(), bytes.size())) != PSA_SUCCESS) {
    end_hash();
    return HalError::io;
  }
  return HalError::none;
}

HalError PsaUpdateCrypto::sha256_finish(protocol::MutableByteView digest) {
  if (!hashing_ || digest.size() != device::kSha256Size) {
    wipe(digest);
    return HalError::invalid;
  }
  std::size_t length = 0;
  const psa_status_t status =
      HSN_PSA(psa_hash_finish(&hash_, digest.data(), digest.size(), &length));
  // Finished or failed, the hash is over; aborting a finished operation does nothing.
  end_hash();
  if (status != PSA_SUCCESS || length != digest.size()) {
    wipe(digest);
    return HalError::io;
  }
  return HalError::none;
}

bool PsaUpdateCrypto::verify_p256(protocol::ByteView public_xy, protocol::ByteView digest,
                                  protocol::ByteView signature_rs) {
  if (public_xy.size() != kPublicXySize || digest.size() != device::kSha256Size ||
      signature_rs.size() != kSignatureSize) {
    return false;
  }
  if (HSN_PSA(psa_crypto_init()) != PSA_SUCCESS) {
    return false;
  }
  // PSA takes an uncompressed point: 0x04, then X and Y (HN(a)5).
  std::array<std::uint8_t, 1 + kPublicXySize> point{};
  point[0] = 0x04;
  std::memcpy(point.data() + 1, public_xy.data(), public_xy.size());
  psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
  psa_set_key_type(&attributes, PSA_KEY_TYPE_ECC_PUBLIC_KEY(PSA_ECC_FAMILY_SECP_R1));
  psa_set_key_bits(&attributes, 256);
  psa_set_key_algorithm(&attributes, kSignatureAlgorithm);
  psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_VERIFY_HASH);
  psa_key_id_t key = PSA_KEY_ID_NULL;
  const psa_status_t imported =
      HSN_PSA(psa_import_key(&attributes, point.data(), point.size(), &key));
  psa_reset_key_attributes(&attributes);
  if (imported != PSA_SUCCESS) {
    // Not a point on the curve, or PSA failed: nothing verifies.
    return false;
  }
  const psa_status_t status =
      HSN_PSA(psa_verify_hash(key, kSignatureAlgorithm, digest.data(), digest.size(),
                              signature_rs.data(), signature_rs.size()));
  detail::destroy(key);
  return status == PSA_SUCCESS;
}

HalError PsaUpdateCrypto::session_key(protocol::ByteView nonce, std::uint32_t address,
                                      protocol::MutableByteView out) {
  if (device_key_ == PSA_KEY_ID_NULL || nonce.size() != kSessionNonceSize ||
      out.size() != device::kSessionKeySize) {
    wipe(out);
    return HalError::invalid;
  }
  if (HSN_PSA(psa_crypto_init()) != PSA_SUCCESS) {
    wipe(out);
    return HalError::io;
  }
  const SessionInfo info = session_info(address);
  // HKDF's inputs in the order PSA requires: salt, secret, info. The operation starts
  // all-bits-zero, as sha256_start() does its hash.
  std::memset(&derivation_, 0, sizeof(derivation_));
  const bool derived =
      HSN_PSA(psa_key_derivation_setup(&derivation_, detail::kSessionAlgorithm)) == PSA_SUCCESS &&
      HSN_PSA(psa_key_derivation_input_bytes(&derivation_, PSA_KEY_DERIVATION_INPUT_SALT,
                                             nonce.data(), nonce.size())) == PSA_SUCCESS &&
      HSN_PSA(psa_key_derivation_input_key(&derivation_, PSA_KEY_DERIVATION_INPUT_SECRET,
                                           device_key_)) == PSA_SUCCESS &&
      HSN_PSA(psa_key_derivation_input_bytes(&derivation_, PSA_KEY_DERIVATION_INPUT_INFO,
                                             info.data(), info.size())) == PSA_SUCCESS &&
      HSN_PSA(psa_key_derivation_output_bytes(&derivation_, out.data(), out.size())) == PSA_SUCCESS;
  // The operation held the pseudorandom key; aborting wipes it, success or not.
  static_cast<void>(psa_key_derivation_abort(&derivation_));
  if (!derived) {
    wipe(out);
    return HalError::io;
  }
  return HalError::none;
}

HalError PsaUpdateCrypto::hmac_sha256(protocol::ByteView key, protocol::ByteView message,
                                      protocol::MutableByteView out) {
  if (key.empty() || out.size() != device::kSha256Size) {
    wipe(out);
    return HalError::invalid;
  }
  if (HSN_PSA(psa_crypto_init()) != PSA_SUCCESS) {
    wipe(out);
    return HalError::io;
  }
  psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
  psa_set_key_type(&attributes, PSA_KEY_TYPE_HMAC);
  psa_set_key_bits(&attributes, PSA_BYTES_TO_BITS(key.size()));
  psa_set_key_algorithm(&attributes, kHmacAlgorithm);
  psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_SIGN_MESSAGE);
  psa_key_id_t imported = PSA_KEY_ID_NULL;
  const psa_status_t status =
      HSN_PSA(psa_import_key(&attributes, key.data(), key.size(), &imported));
  psa_reset_key_attributes(&attributes);
  if (status != PSA_SUCCESS) {
    wipe(out);
    return HalError::io;
  }
  std::size_t length = 0;
  const psa_status_t computed = HSN_PSA(psa_mac_compute(
      imported, kHmacAlgorithm, message.data(), message.size(), out.data(), out.size(), &length));
  // The key leaves PSA's store wiped.
  detail::destroy(imported);
  if (computed != PSA_SUCCESS || length != out.size()) {
    wipe(out);
    return HalError::io;
  }
  return HalError::none;
}

HalError PsaKeyImport::import_key(const protocol::DeviceKey& key) {
  // Both imports first, then both swaps, so a refusal of either leaves both as they were.
  psa_key_id_t packet = PSA_KEY_ID_NULL;
  if (detail::import_packet_key(key, packet) != PSA_SUCCESS) {
    return HalError::io;
  }
  psa_key_id_t secret = PSA_KEY_ID_NULL;
  if (detail::import_session_secret(key, secret) != PSA_SUCCESS) {
    detail::destroy(packet);
    return HalError::io;
  }
  cipher_.adopt(packet);
  crypto_.adopt_device_key(secret);
  return HalError::none;
}

}  // namespace hsn::psa
