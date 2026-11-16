// A scheduled Away (m2-design.md sections 7 and 10; D8, D45, D87, D116, HB31): at 22:00 in the
// hub's time zone, on a trusted clock, the hub switches to Away and every sensor learns it at its
// next heartbeat; on an untrusted clock the entry waits, and is missed rather than run late. On the
// real hub only: the test hub has no schedules (they are M2's, the hub's own).

#ifdef HSN_LOCKSTEP

#include "system_site.hpp"

namespace hsn::test::system {
namespace {

/**
 * The hub computer's time zone (HB31): one with daylight saving, and in November five hours
 * behind UTC, so a hub that worked in UTC would run the entry at the wrong hour.
 */
constexpr const char* kZone = "America/New_York";
/**
 * The run's wall clock starts at 2026-11-13 00:00 UTC (RemoteHub), which is 19:00 on the 12th in
 * New York (EST, UTC-5): its 22:00 that evening is 3 h in.
 */
constexpr std::int64_t kTwentyTwo = 3 * 3600;

/** The site, its hub in kZone. */
host::HubOptions in_new_york() {
  host::HubOptions options = one_rate_site();
  options.time_zone = kZone;
  return options;
}
/** A heartbeat comes within an interval of the switch: 3 minutes at DR5, and the reply's slack. */
constexpr Duration kHeartbeatBound = seconds(3 * 60 + 15);

TEST_CASE(
    "M2 D8 D87: a scheduled Away at 22:00 on a trusted clock: every sensor learns it at "
    "its next heartbeat") {
  SystemSite site(in_new_york());
  site.gateway("gateway");
  host::SimDevice& front = site.sensor("front");
  host::SimDevice& back = site.sensor("back");
  site.run_until(at_s(5));
  const std::int64_t away = site.hub.fixed_mode("away");
  const json::Value entry = site.hub.create_schedule(
      "night", "switchMode", json::Value::object().set("mode", away), "22:00", "everyDay");
  INFO(json::write(entry));
  // Its next run is tonight at 22:00.
  REQUIRE_FALSE(entry.at("nextMs").is_null());
  CHECK(entry.at("nextMs").as_int() == site.hub.wall_at(at_s(kTwentyTwo)));

  site.run_until(at_s(kTwentyTwo) + kHeartbeatBound);
  INFO(site.hub.dump());
  const auto ran = site.hub.decisions_named("schedule_ran");
  REQUIRE(ran.size() == 1);
  CHECK(ran[0].at == at_s(kTwentyTwo));
  const auto switched = site.hub.decisions_named("mode_switched");
  REQUIRE_FALSE(switched.empty());
  CHECK(switched.back().value == away);
  for (host::SimDevice* door : {&front, &back}) {
    INFO(door->name());
    REQUIRE(site.hub.decisions(HubAction::armed, door->name()).size() == 1);
    CHECK(site.hub.decisions(HubAction::armed, door->name())[0].at == at_s(kTwentyTwo));
    // Its next heartbeat after the switch was answered with the armed settings (D8)...
    const auto replies = heard(*door, type::reply);
    REQUIRE_FALSE(replies.empty());
    CHECK(replies.back().at > at_s(kTwentyTwo));
    CHECK(replies.back().at - at_s(kTwentyTwo) <= kHeartbeatBound);
  }
  // ... so an opening now is an armed opening: the countdown, on the hub and the buzzer.
  const Instant open_at = site.sim.now() + seconds(1);
  front.set_input(Input::door, true, open_at);
  site.run_until(open_at + seconds(5));
  CHECK(site.hub.decisions(HubAction::countdown_started, "front").size() == 1);
  CHECK(buzzer_times(front, Sound::countdown).size() == 1);
}

TEST_CASE(
    "M2 D116: on an untrusted clock the scheduled Away waits: nothing runs at 22:00, and "
    "the hub says it waits for the clock") {
  SystemSite site(in_new_york());
  site.gateway("gateway");
  site.sensor("front");
  site.run_until(at_s(5));
  const std::int64_t away = site.hub.fixed_mode("away");
  site.hub.create_schedule("night", "switchMode", json::Value::object().set("mode", away), "22:00",
                           "everyDay");
  // The clock is no longer trusted: the same reading, untrusted (a Pi with no network, HD 5).
  site.hub.set_clock(site.hub.wall_at(site.sim.now()), false);
  site.run_until(at_s(kTwentyTwo) + kHeartbeatBound);
  INFO(site.hub.dump());
  CHECK(site.hub.decisions_named("schedule_ran").empty());
  CHECK(site.hub.decisions_named("mode_switched").empty());
  CHECK(site.hub.decisions(HubAction::armed, "front").empty());
  CHECK(site.hub.decisions_named("schedules_waiting_for_clock").size() == 1);
}

}  // namespace
}  // namespace hsn::test::system

#endif
