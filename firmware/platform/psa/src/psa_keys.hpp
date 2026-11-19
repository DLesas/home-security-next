#pragma once

// How hsn_psa imports the device key: once for the packet cipher (AES-128-CCM with an 8-byte tag)
// and once for the Bluetooth session key (HKDF-SHA256). Each is a volatile key usable only for its
// algorithm, so the raw key stays in PSA's key store and nowhere in our memory.

#include <psa/crypto.h>

#include "hsn/protocol/cipher.hpp"

namespace hsn::psa::detail {

/** The packet cipher's algorithm (protocol section 3). */
constexpr psa_algorithm_t kPacketAlgorithm =
    PSA_ALG_AEAD_WITH_SHORTENED_TAG(PSA_ALG_CCM, protocol::kTagSize);

/** The session key's algorithm (m3-updates-design.md section 5). */
constexpr psa_algorithm_t kSessionAlgorithm = PSA_ALG_HKDF(PSA_ALG_SHA_256);

/**
 * Imports `key` for the packet cipher into `out`; on failure `out` is PSA_KEY_ID_NULL. Initialises
 * PSA Crypto first, which is harmless when already done.
 */
psa_status_t import_packet_key(const protocol::DeviceKey& key, psa_key_id_t& out);

/** Imports `key` as the session key's HKDF secret into `out`, as import_packet_key does. */
psa_status_t import_session_secret(const protocol::DeviceKey& key, psa_key_id_t& out);

/** Destroys a key we imported, if any, and sets it to PSA_KEY_ID_NULL. */
void destroy(psa_key_id_t& key);

}  // namespace hsn::psa::detail
