#include "update_bench.hpp"

namespace hsn::test::update {
namespace {

TEST_CASE("a verified rebuild with the running version survives a reset before install") {
  Bench bench;
  bench.boot();
  const ImageFile file =
      make_file(make_image(bench.options.old_version, 1000, 42), 0x0E,
                [](protocol::ImageHeader& header) { header.flags.own_build = true; });
  Source hub(bench, LinkKind::network, file.file());
  bench.update().offer(make_offer(protocol::UpdateAction::fetch, file), device::UpdatePath::network,
                       bench.now);
  hub.serve_all();

  const auto verified = bench.take_packet();
  REQUIRE(verified.has_value());
  REQUIRE(verified->status.stage == protocol::UpdateStage::verified);
  REQUIRE(bench.storage.has(device::StoreKey::update));
  REQUIRE(bench.slots.select_calls == 0);

  bench.boot(device::BootKind::other_reset);
  const auto query = bench.update().next_packet(bench.now);
  CHECK(query.kind == device::UpdatePacketKind::query);
  CHECK(query.query.held == protocol::UpdateHeld::verified);
}

}  // namespace
}  // namespace hsn::test::update
