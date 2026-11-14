#pragma once

// Where the real hub is, for the lockstep tests (tests/CMakeLists.txt finds Bun and the hub's
// sources; without them these tests are not built).

#include "hsn/host/lockstep.hpp"

namespace hsn::test {

inline host::lockstep::HubProgram hub_program() {
  return host::lockstep::HubProgram{HSN_BUN, HSN_HUB_MAIN};
}

}  // namespace hsn::test
