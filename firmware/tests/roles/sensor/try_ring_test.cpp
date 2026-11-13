// The ring of recent counters a hub packet may answer (protocol section 4, "Bindings"): at most
// 16, the oldest replaced first, offered newest first.

#include "sensor_bench.hpp"

namespace hsn::test::sensor {
namespace {

using roles::sensor::TryKind;
using roles::sensor::TryRing;

TEST_CASE("section 4: the ring offers its counters newest first, at most 16, oldest replaced") {
  TryRing ring;
  std::array<std::uint32_t, device::kMaxBoundCandidates> out{};
  CHECK(ring.newest_first(out) == 0);
  for (std::uint32_t counter = 100; counter < 120; ++counter) {
    ring.add(counter, counter % 2 == 0 ? TryKind::door : TryKind::heartbeat);
  }
  REQUIRE(ring.newest_first(out) == 16);
  for (std::size_t i = 0; i < 16; ++i) {
    CHECK(out[i] == 119 - i);
  }
  CHECK(ring.kind_of(103) == TryKind::none);
  CHECK(ring.kind_of(104) == TryKind::door);
  CHECK(ring.kind_of(0) == TryKind::none);
  ring.retag(TryKind::door, TryKind::countdown);
  CHECK(ring.kind_of(104) == TryKind::countdown);
  ring.add(200, TryKind::cover);
  ring.remove_reports();
  // The countdown's and the heartbeats' stay; the report exchange's go.
  CHECK(ring.kind_of(200) == TryKind::none);
  CHECK(ring.kind_of(118) == TryKind::countdown);
  ring.remove(TryKind::heartbeat);
  CHECK(ring.newest_first(out) == 7);
  CHECK(out[0] == 118);
}

TEST_CASE("bounded counters stop at their largest value") {
  CHECK(roles::sensor::saturating_increment(0) == 1);
  CHECK(roles::sensor::saturating_increment(254) == 255);
  CHECK(roles::sensor::saturating_increment(255) == 255);
}

}  // namespace
}  // namespace hsn::test::sensor
