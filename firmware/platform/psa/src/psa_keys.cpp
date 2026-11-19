#include "psa_keys.hpp"

#include "psa_call.hpp"

namespace hsn::psa::detail {
namespace {

psa_status_t import_volatile(const protocol::DeviceKey& key, psa_key_type_t type,
                             psa_algorithm_t algorithm, psa_key_usage_t usage, psa_key_id_t& out) {
  out = PSA_KEY_ID_NULL;
  const psa_status_t initialised = HSN_PSA(psa_crypto_init());
  if (initialised != PSA_SUCCESS) {
    return initialised;
  }
  psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
  psa_set_key_type(&attributes, type);
  psa_set_key_bits(&attributes, PSA_BYTES_TO_BITS(protocol::kKeySize));
  psa_set_key_algorithm(&attributes, algorithm);
  psa_set_key_usage_flags(&attributes, usage);
  psa_key_id_t imported = PSA_KEY_ID_NULL;
  const psa_status_t status =
      HSN_PSA(psa_import_key(&attributes, key.data(), key.size(), &imported));
  psa_reset_key_attributes(&attributes);
  if (status != PSA_SUCCESS) {
    return status;
  }
  out = imported;
  return PSA_SUCCESS;
}

}  // namespace

psa_status_t import_packet_key(const protocol::DeviceKey& key, psa_key_id_t& out) {
  return import_volatile(key, PSA_KEY_TYPE_AES, kPacketAlgorithm,
                         PSA_KEY_USAGE_ENCRYPT | PSA_KEY_USAGE_DECRYPT, out);
}

psa_status_t import_session_secret(const protocol::DeviceKey& key, psa_key_id_t& out) {
  return import_volatile(key, PSA_KEY_TYPE_DERIVE, kSessionAlgorithm, PSA_KEY_USAGE_DERIVE, out);
}

void destroy(psa_key_id_t& key) {
  if (key != PSA_KEY_ID_NULL) {
    // Destroying a key we imported cannot fail in a way we could act on.
    static_cast<void>(psa_destroy_key(key));
    key = PSA_KEY_ID_NULL;
  }
}

}  // namespace hsn::psa::detail
