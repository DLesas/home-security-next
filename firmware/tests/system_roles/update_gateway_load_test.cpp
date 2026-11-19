// A gateway that updates under load, through the real hub in lockstep (m3-updates-design.md
// section 8: update_gateway_load_test.cpp; section 5, "What a gateway does with radio traffic while
// it updates"; R11, D110): thirty real sensors, their doors changing, through one real gateway on
// Wi-Fi that fetches, installs and confirms its new image; nothing is lost inside the gateway
// unseen, and every door change reaches the hub. On the real hub only.
//
// Not here: the gateway that is always busy (radioBusy after its 10-minute bound, held, offered
// again after an hour, forced): the simulated radio cannot keep a transmit request always waiting
// with the real roles; the gateway role's own tests (tests/roles/gateway/update_test.cpp) and the
// hub's (U7) cover it.

#ifdef HSN_LOCKSTEP

#include <random>

#include "update_site.hpp"

namespace hsn::test::system {
namespace {

TEST_CASE(
    "R11 D110 GW7: thirty sensors through a gateway that updates: it confirms, nothing is lost "
    "inside it unseen, and every door change reaches the hub") {
  LoadSite load(protocol::DataRate::dr5, 30);
  SystemSite& site = load.site;
  constexpr std::int64_t kSpan = 2 * 3600;
  // Six changes a sensor between 20 minutes and the span's end: the gateway's download and its
  // restart fall among them.
  constexpr std::int64_t kChanges = 6;
  std::mt19937 random(11);
  for (host::SimDevice* door : load.doors) {
    std::vector<std::int64_t> moments;
    for (std::int64_t k = 0; k < kChanges; ++k) {
      moments.push_back(draw(random, 20 * 60 * 1'000'000LL, kSpan * 1'000'000LL));
    }
    std::sort(moments.begin(), moments.end());
    for (std::size_t k = 0; k < moments.size(); ++k) {
      door->set_input(Input::door, k % 2 == 0, host::at(microseconds(moments[k])));
    }
  }
  site.run_until(at_s(20 * 60));
  const host::RemoteImage& image =
      site.hub.add_own_build(host::make_test_image(kNewVersion, 60000), kNewVersion);
  site.hub.rollout_start(image.id, {"gateway"}, {"gateway"});
  site.run_until(at_s(kSpan + 15 * 60));
  INFO(site.sim.timeline().select().kind(RecordKind::transmission).count());
  INFO(site.hub.dump());
  CHECK(runs_new_confirmed(load.gateway));
  CHECK(site.hub.update_state("gateway") == kConfirmed);
  const Instant installed = first(site.hub, HubAction::firmware_installing, "gateway");
  REQUIRE_FALSE(installed.is_never());
  // D110: every packet a device sent on a link, and every packet the gateway heard, is in the
  // hub's records, or the gateway told the hub it could not forward it.
  const HubAccount account = check_hub_recorded_everything(site);
  MESSAGE("checked " << account.checked << " packets, " << account.lost_and_logged
                     << " lost and logged by the gateway");
  // Every door change the boards made reached the hub, its last state included.
  for (host::SimDevice* door : load.doors) {
    CAPTURE(door->name());
    CHECK(site.hub.received_from(door->name(), type::door_changed).size() >=
          static_cast<std::size_t>(kChanges));
  }
  CHECK(critical_events(site.hub).empty());
}

}  // namespace
}  // namespace hsn::test::system

#endif
