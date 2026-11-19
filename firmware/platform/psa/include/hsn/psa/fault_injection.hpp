#pragma once

#include <psa/crypto.h>

#include <cstdint>

// The host build's way to make one PSA call of hsn_psa fail, so each failure path is tested
// (platform/psa/src/psa_call.hpp). Compiled only with HSN_PSA_FAULT_INJECTION, which the host
// build of hsn_psa defines and the target's does not. One thread only: the state is global.

#if defined(HSN_PSA_FAULT_INJECTION)

namespace hsn::psa::fault_injection {

/**
 * Restarts the count of PSA calls at zero and arms the `nth` call from now (1 is the next) to fail
 * with `status` without being made. 0 counts calls and fails none.
 */
void arm(std::uint32_t nth, psa_status_t status = PSA_ERROR_HARDWARE_FAILURE);

/** Stops any armed failure and the count. */
void disarm();

/** PSA calls counted since the last arm(). */
std::uint32_t calls();

/** True once the armed failure has been returned. */
bool fired();

}  // namespace hsn::psa::fault_injection

#endif
