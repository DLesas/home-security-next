#pragma once

#include "hsn/esp/pairing_logic.hpp"
#include "protocomm_security.h"

namespace hsn::esp {

/** Makes ESP-IDF Security 2 credentials with a full-length salt. */
bool make_credentials(const PairCode& code, protocomm_security2_params_t& credentials);
/** Frees the buffers returned by ESP-IDF's SRP generator. */
void free_credentials(protocomm_security2_params_t& credentials);

}  // namespace hsn::esp
