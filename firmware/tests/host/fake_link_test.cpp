// The fake links' Wi-Fi signal strength, as the gateway status reads it (protocol section 6).

#include <doctest/doctest.h>

#include "hsn/host/fake_clock.hpp"
#include "hsn/host/fake_link.hpp"

namespace hsn::test {
namespace {

TEST_CASE("a network link reports its set signal strength; USB, or unknown, says 0") {
  host::FakeClock clock;
  host::FakeLink network(clock, device::LinkKind::network);
  host::FakeLink usb(clock, device::LinkKind::usb);
  CHECK(network.signal_dbm() == 0);
  network.wifi_signal_dbm = -67;
  CHECK(network.signal_dbm() == -67);
  usb.wifi_signal_dbm = -50;
  CHECK(usb.signal_dbm() == 0);
  // Through the core's interface, as a role calls it.
  const device::Link& link = network;
  CHECK(link.signal_dbm() == -67);
}

}  // namespace
}  // namespace hsn::test
