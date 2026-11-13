// What the gateway cannot do yet because something outside its folder is missing. Each case is
// the test that should pass, skipped, with what it needs.

#include "gateway_bench.hpp"

namespace hsn::test {
namespace {

// BLOCKED: firmware updates over Wi-Fi are defined in M3 (protocol section 14, "Firmware
// transfer"); the core has no update service and the protocol no update messages yet. Needed:
// the M3 update protocol and service.
TEST_CASE("GW7 the gateway is updated over Wi-Fi like the sensors" * doctest::skip()) {
  CHECK(false);
}

}  // namespace
}  // namespace hsn::test
