// Groups with their own sirens (m2-design.md sections 7 and 10; AL2a, D41, D74, D95): two groups,
// each sounding only its own siren; a second trigger adds its group's siren, and the siren already
// sounding is neither commanded again nor given longer. On the real hub only: the test hub has no
// groups or modes (they are M2's, the hub's own).

#ifdef HSN_LOCKSTEP

#include "system_site.hpp"

namespace hsn::test::system {
namespace {

/** The first door opens here; the second after the first alarm has started. */
constexpr std::int64_t kFirstOpenAt = 60;
constexpr std::int64_t kSecondOpenAt = 110;
/** From a decision to a siren on Wi-Fi switching: the hub's own time, then the link. */
constexpr Duration kWifiBound = kHubActsWithin + kLinkLatency;

TEST_CASE(
    "M2 AL2a D95: two groups with their own sirens: each trigger sounds its own, and the "
    "second adds its group's without the first's being commanded again") {
  SystemSite site;
  site.gateway("gateway");
  host::SimDevice& front_door = site.sensor("front_door");
  host::SimDevice& back_door = site.sensor("back_door");
  host::SimDevice& front_siren = site.siren("front_siren");
  host::SimDevice& back_siren = site.siren("back_siren");
  // Every board paired, then the groups, then Away (`hsn arm --all`, D90).
  site.run_until(at_s(5));
  site.hub.create_group("front", {"front_door"}, {"front_siren"});
  site.hub.create_group("back", {"back_door"}, {"back_siren"});
  site.hub.arm();
  front_door.set_input(Input::door, true, at_s(kFirstOpenAt));
  back_door.set_input(Input::door, true, at_s(kSecondOpenAt));
  site.run_until(at_s(kSecondOpenAt + 2 * kCountdownSeconds));
  INFO(site.dump());

  // The first trigger: only its group's siren sounds.
  const auto first = site.hub.decisions(HubAction::alarm, "front_door");
  REQUIRE(first.size() == 1);
  CHECK(sounding_from(front_siren, first[0].at) - first[0].at <= kWifiBound);
  CHECK_FALSE(sounding_at(back_siren, at_s(kSecondOpenAt)));
  const auto back_commands = site.hub.decisions(HubAction::siren_command, "back_siren");
  const bool back_quiet_first = back_commands.empty() || back_commands[0].at > at_s(kSecondOpenAt);
  CHECK(back_quiet_first);

  // The second trigger joins the alarm and adds its own siren.
  const auto added = site.hub.decisions_named("alarm_trigger_added", "back_door");
  REQUIRE(added.size() == 1);
  CHECK(added[0].at > at_s(kSecondOpenAt));
  const Instant back_on = sounding_from(back_siren, added[0].at);
  CHECK(back_on - added[0].at <= kWifiBound);
  // The first siren was commanded once and sounds on, its time not counted again (D95, D114).
  CHECK(site.hub.decisions(HubAction::siren_command, "front_siren").size() == 1);
  CHECK(site.hub.decisions(HubAction::siren_command, "back_siren").size() == 1);
  const auto front_changes = sounder(front_siren);
  REQUIRE(front_changes.size() == 1);
  CHECK(front_changes[0].second);
  CHECK(sounding_at(front_siren, at_s(kSecondOpenAt + 2 * kCountdownSeconds)));
}

}  // namespace
}  // namespace hsn::test::system

#endif
