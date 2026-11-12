#include "hsn/psa/hub_identity.hpp"

#include <psa/crypto.h>

#include <array>

namespace hsn::psa {

protocol::Error compute_hub_identity(const protocol::SigningKey& signing_key,
                                     protocol::HubIdentity& out) {
  if (psa_crypto_init() != PSA_SUCCESS) {
    return protocol::Error::cipher_failure;
  }
  std::array<std::uint8_t, PSA_HASH_LENGTH(PSA_ALG_SHA_256)> hash{};
  std::size_t length = 0;
  const psa_status_t status = psa_hash_compute(
      PSA_ALG_SHA_256, signing_key.data(), signing_key.size(), hash.data(), hash.size(), &length);
  if (status != PSA_SUCCESS || length != hash.size()) {
    return protocol::Error::cipher_failure;
  }
  for (std::size_t i = 0; i < out.size(); ++i) {
    out[i] = hash[i];
  }
  return protocol::Error::none;
}

}  // namespace hsn::psa
