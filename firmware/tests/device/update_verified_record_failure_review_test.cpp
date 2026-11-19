#include "update_bench.hpp"

namespace hsn::test::update {
namespace {

TEST_CASE("a failed verified-record write never advertises an installable image") {
  Bench bench;
  bench.boot();
  const ImageFile file = make_file(make_image({1, 1, 0}, 1000));
  Source hub(bench, LinkKind::network, file.file());

  // Let the header checkpoint and sole slot write succeed, then fail the verified record write.
  bench.slots.after_write = [&] { bench.storage.fail_writes = true; };
  bench.update().offer(make_offer(protocol::UpdateAction::fetch, file), device::UpdatePath::network,
                       bench.now);
  hub.serve_all();

  const auto packet = bench.take_packet();
  REQUIRE(packet.has_value());
  REQUIRE(packet->kind == device::UpdatePacketKind::status);
  CHECK(packet->status.stage == protocol::UpdateStage::refused);
  CHECK(packet->status.reason == protocol::UpdateReason::flash);
}

}  // namespace
}  // namespace hsn::test::update
