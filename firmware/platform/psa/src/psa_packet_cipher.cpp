#include "hsn/psa/psa_packet_cipher.hpp"

#include <cstring>

namespace hsn::psa {
namespace {

using protocol::Error;

constexpr psa_algorithm_t kAlgorithm =
    PSA_ALG_AEAD_WITH_SHORTENED_TAG(PSA_ALG_CCM, protocol::kTagSize);

void wipe(protocol::MutableByteView bytes) {
  if (!bytes.empty()) {
    std::memset(bytes.data(), 0, bytes.size());
  }
}

}  // namespace

PsaPacketCipher::~PsaPacketCipher() {
  destroy_key();
}

Error PsaPacketCipher::set_key(const protocol::DeviceKey& key) {
  destroy_key();
  if (psa_crypto_init() != PSA_SUCCESS) {
    return Error::cipher_failure;
  }
  psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
  psa_set_key_type(&attributes, PSA_KEY_TYPE_AES);
  psa_set_key_bits(&attributes, 8 * protocol::kKeySize);
  psa_set_key_algorithm(&attributes, kAlgorithm);
  psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_ENCRYPT | PSA_KEY_USAGE_DECRYPT);
  const psa_status_t status = psa_import_key(&attributes, key.data(), key.size(), &key_);
  psa_reset_key_attributes(&attributes);
  if (status != PSA_SUCCESS) {
    key_ = PSA_KEY_ID_NULL;
    return Error::cipher_failure;
  }
  return Error::none;
}

Error PsaPacketCipher::seal(const protocol::Nonce& nonce, protocol::ByteView associated_data,
                            protocol::ByteView plaintext, protocol::MutableByteView sealed) const {
  if (key_ == PSA_KEY_ID_NULL) {
    return Error::cipher_failure;
  }
  if (sealed.size() != plaintext.size() + protocol::kTagSize) {
    return Error::buffer_too_small;
  }
  std::size_t length = 0;
  const psa_status_t status = psa_aead_encrypt(
      key_, kAlgorithm, nonce.data(), nonce.size(), associated_data.data(), associated_data.size(),
      plaintext.data(), plaintext.size(), sealed.data(), sealed.size(), &length);
  if (status != PSA_SUCCESS || length != sealed.size()) {
    wipe(sealed);
    return Error::cipher_failure;
  }
  return Error::none;
}

Error PsaPacketCipher::open(const protocol::Nonce& nonce, protocol::ByteView associated_data,
                            protocol::ByteView sealed, protocol::MutableByteView plaintext) const {
  if (sealed.size() < protocol::kTagSize ||
      plaintext.size() != sealed.size() - protocol::kTagSize) {
    wipe(plaintext);
    return Error::buffer_too_small;
  }
  if (key_ == PSA_KEY_ID_NULL) {
    wipe(plaintext);
    return Error::cipher_failure;
  }
  std::size_t length = 0;
  const psa_status_t status = psa_aead_decrypt(
      key_, kAlgorithm, nonce.data(), nonce.size(), associated_data.data(), associated_data.size(),
      sealed.data(), sealed.size(), plaintext.data(), plaintext.size(), &length);
  if (status == PSA_SUCCESS && length == plaintext.size()) {
    return Error::none;
  }
  // PSA leaves the output unspecified on failure; the interface promises it zeroed.
  wipe(plaintext);
  return status == PSA_ERROR_INVALID_SIGNATURE ? Error::bad_tag : Error::cipher_failure;
}

void PsaPacketCipher::destroy_key() {
  if (key_ != PSA_KEY_ID_NULL) {
    // Destroying a key we imported cannot fail in a way we could act on.
    static_cast<void>(psa_destroy_key(key_));
    key_ = PSA_KEY_ID_NULL;
  }
}

}  // namespace hsn::psa
