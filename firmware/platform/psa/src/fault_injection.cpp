#include "hsn/psa/fault_injection.hpp"

#include "psa_call.hpp"

#if defined(HSN_PSA_FAULT_INJECTION)

namespace hsn::psa {
namespace {

struct Faults {
  std::uint32_t calls = 0;
  std::uint32_t armed_at = 0;
  psa_status_t status = PSA_ERROR_HARDWARE_FAILURE;
  bool fired = false;
};

Faults& faults() {
  static Faults state;
  return state;
}

}  // namespace

namespace detail {

bool fail_this_call() {
  Faults& state = faults();
  state.calls += 1;
  if (state.armed_at == 0 || state.calls != state.armed_at) {
    return false;
  }
  state.fired = true;
  return true;
}

psa_status_t injected_status() {
  return faults().status;
}

}  // namespace detail

namespace fault_injection {

void arm(std::uint32_t nth, psa_status_t status) {
  Faults& state = faults();
  state.calls = 0;
  state.armed_at = nth;
  state.status = status;
  state.fired = false;
}

void disarm() {
  arm(0);
}

std::uint32_t calls() {
  return faults().calls;
}

bool fired() {
  return faults().fired;
}

}  // namespace fault_injection
}  // namespace hsn::psa

#endif
