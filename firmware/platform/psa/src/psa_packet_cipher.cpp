#include "hsn/psa/psa_packet_cipher.hpp"

#include <cstring>

#include "psa_call.hpp"
#include "psa_keys.hpp"

namespace hsn::psa {
namespace {

using protocol::Error;

void wipe(protocol::MutableByteView bytes) {
  if (!bytes.empty()) {
    std::memset(bytes.data(), 0, bytes.size());
  }
}

}  // namespace

PsaPacketCipher::~PsaPacketCipher() {
  detail::destroy(key_);
}

Error PsaPacketCipher::set_key(const protocol::DeviceKey& key) {
  psa_key_id_t imported = PSA_KEY_ID_NULL;
  if (detail::import_packet_key(key, imported) != PSA_SUCCESS) {
    return Error::cipher_failure;
  }
  adopt(imported);
  return Error::none;
}

void PsaPacketCipher::adopt(psa_key_id_t key) {
  detail::destroy(key_);
  key_ = key;
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
  const psa_status_t status =
      HSN_PSA(psa_aead_encrypt(key_, detail::kPacketAlgorithm, nonce.data(), nonce.size(),
                               associated_data.data(), associated_data.size(), plaintext.data(),
                               plaintext.size(), sealed.data(), sealed.size(), &length));
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
  const psa_status_t status =
      HSN_PSA(psa_aead_decrypt(key_, detail::kPacketAlgorithm, nonce.data(), nonce.size(),
                               associated_data.data(), associated_data.size(), sealed.data(),
                               sealed.size(), plaintext.data(), plaintext.size(), &length));
  if (status == PSA_SUCCESS && length == plaintext.size()) {
    return Error::none;
  }
  // PSA leaves the output unspecified on failure; the interface promises it zeroed.
  wipe(plaintext);
  return status == PSA_ERROR_INVALID_SIGNATURE ? Error::bad_tag : Error::cipher_failure;
}

}  // namespace hsn::psa
