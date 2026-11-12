#pragma once

#include "hsn/protocol/error.hpp"
#include "hsn/protocol/setup.hpp"

namespace hsn::psa {

/**
 * Computes a hub identity: the first 8 bytes of SHA-256 over the 64-byte signing key (section 9).
 */
[[nodiscard]] protocol::Error compute_hub_identity(const protocol::SigningKey& signing_key,
                                                   protocol::HubIdentity& out);

}  // namespace hsn::psa
