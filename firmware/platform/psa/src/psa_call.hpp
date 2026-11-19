#pragma once

// Every PSA call in hsn_psa whose status the code acts on goes through HSN_PSA, so that a host test
// can make any one of them fail (hsn/psa/fault_injection.hpp) and see the failure handled. Built
// without HSN_PSA_FAULT_INJECTION, as the target is, HSN_PSA(call) is the call itself.
//
// Clean-up calls (psa_hash_abort, psa_key_derivation_abort, psa_destroy_key) are not wrapped: their
// status is never acted on, so their failure is no case to test, and skipping one would only leak
// a key slot.

#include <psa/crypto.h>

#if defined(HSN_PSA_FAULT_INJECTION)

namespace hsn::psa::detail {

/** Counts one PSA call; true when it is the one armed to fail, which then is not made. */
bool fail_this_call();

/** The status an injected failure returns. */
psa_status_t injected_status();

}  // namespace hsn::psa::detail

#define HSN_PSA(call) \
  (::hsn::psa::detail::fail_this_call() ? ::hsn::psa::detail::injected_status() : (call))

#else

#define HSN_PSA(call) (call)

#endif
