// Holds through the real hub in lockstep (m3-updates-design.md section 8: update_held_test.cpp;
// section 4, "Before any offer", "Before the go-ahead", "While a countdown or alarm runs",
// "Arming during a download"; D91, D139, UP7, UP9): a sensor armed throughout is held, reminded
// after a day, and updates once disarmed; a countdown, and an alarm, during a download pause every
// transfer and the download resumes after, with no install meanwhile; a low battery holds; a site
// move holds the go-ahead. On the real hub only, with the real roles.

#ifdef HSN_LOCKSTEP

#include "update_site.hpp"

namespace hsn::test::system {
namespace {

/** A slow Wi-Fi link for a sensor's download, so a countdown can start in its middle. */
constexpr Duration kSlowLink = milliseconds(400);

/** A held device's hold by name in `rollout.status` ("armed", "battery"…), or "" for none. */
std::string held_of(host::RemoteHub& hub, const std::string& name) {
  const json::Value row = hub.update_of(name);
  if (row.is_null() || row.at("held").is_null()) {
    return "";
  }
  return row.at("held").as_string();
}

/** Every Data and Gone the hub served `name` in [from, to). */
Served served_between(const host::RemoteHub& hub, const std::string& name, Instant from,
                      Instant to) {
  return served(hub, name, from, to);
}

TEST_CASE(
    "D91 UP9: a sensor armed throughout is held, reminded after 24 hours, and updates once "
    "disarmed") {
  SystemSite site;
  site.gateway("gateway");
  host::SimDevice& pilot = site.sensor("door0");
  host::SimDevice& armed = site.sensor("door1");
  site.run_until(at_s(20));
  const std::int64_t group = site.hub.create_group("back", {"door1"});
  site.hub.arm_group(group);
  const host::RemoteImage& image =
      site.hub.add_own_build(host::make_test_image(kNewVersion, 60000), kNewVersion);
  site.hub.rollout_start(image.id, {"door0", "door1"}, {"door0"});
  INFO(site.dump());
  // The pilot, then the soak; the armed sensor is held, and stays held.
  site.run_until(at_s(2 * 3600));
  CHECK(runs_new_confirmed(pilot));
  CHECK(held_of(site.hub, "door1") == "armed");
  Instant held_at = Instant::never();
  for (const auto& hold : site.hub.decisions_named("firmware_held", "door1")) {
    if (hold.value == 1 && held_at.is_never()) {  // armed (device_updates.held)
      held_at = hold.at;
    }
  }
  REQUIRE_FALSE(held_at.is_never());
  // A day armed: one reminder (D91), none before; it is still held, never told to fetch.
  site.run_until(held_at + seconds(24 * 3600 - 600));
  CHECK(site.hub.decisions_named("firmware_reminder", "door1").empty());
  site.run_until(held_at + seconds(24 * 3600 + 900));
  const auto reminders = site.hub.decisions_named("firmware_reminder", "door1");
  REQUIRE(reminders.size() == 1);
  CHECK(reminders[0].value == 1);
  for (const host::HubDecision& offer : site.hub.decisions(HubAction::firmware_offer, "door1")) {
    CHECK_FALSE((offer.value >= 1 && offer.value <= 3));
  }
  CHECK(same_version(armed.boot_choice().image.version, kOldVersion));
  CHECK(armed.records().kind(RecordKind::slot_write).count() == 0);
  // Disarmed: it updates at its next heartbeat or two.
  const Instant disarmed = site.sim.now();
  site.hub.disarm_group(group);
  site.run_until(disarmed + seconds(10 * 60));
  CHECK(runs_new_confirmed(armed));
  CHECK(site.hub.update_state("door1") == kConfirmed);
  CHECK(first(site.hub, HubAction::firmware_installing, "door1") > disarmed);
  CHECK(critical_events(site.hub).empty());
}

/** A sensor whose download is slow, and an armed one whose door opens in its middle. */
struct CountdownSite {
  CountdownSite() : door(site.sensor("door0")), trigger(site.sensor("door1")) {
    site.gateway("gateway");
    site.siren("siren");
    site.run_until(at_s(20));
    group = site.hub.create_group("back", {"door1"});
    site.hub.arm_group(group);
    // A slow Wi-Fi link: about 0.8 s a round of four pieces, so 60 KB take about 12 s.
    site.hub.set_network_latency("door0", kSlowLink);
    image = &site.hub.add_own_build(host::make_test_image(kNewVersion, 60000), kNewVersion);
    site.hub.rollout_start(image->id, {"door0"}, {"door0"});
    found = run_until_true(
        site, at_s(20 * 60), [&]() { return served(site.hub, "door0").data >= 10; },
        milliseconds(100));
    if (found) {
      opened = site.sim.now() + milliseconds(500);
      trigger.set_input(Input::door, true, opened);
    }
  }

  SystemSite site;
  host::SimDevice& door;
  host::SimDevice& trigger;
  std::int64_t group = 0;
  const host::RemoteImage* image = nullptr;
  bool found = false;
  Instant opened;
};

TEST_CASE(
    "D139 R12: a countdown during a download pauses the transfer (Gone paused), nothing is "
    "installed meanwhile, and the download resumes from its checkpoint once disarmed") {
  CountdownSite world;
  SystemSite& site = world.site;
  INFO(site.dump());
  REQUIRE(world.found);
  site.run_until(world.opened + seconds(10));
  const auto countdowns = site.hub.decisions(HubAction::countdown_started, "door1");
  REQUIRE(countdowns.size() == 1);
  const Instant began = countdowns[0].at;
  const Instant disarmed = site.sim.now();
  site.hub.disarm_group(world.group);
  site.run_until(disarmed + seconds(5 * 60));

  // During the countdown: every Get answered Gone paused, no Data, no go-ahead; still not done.
  Served during = served_between(site.hub, "door0", began + milliseconds(1), disarmed);
  CHECK(during.data == 0);
  CHECK(during.gone[protocol::GoneReason::paused] >= 1);
  const Instant installed = first(site.hub, HubAction::firmware_installing, "door0");
  CHECK((installed < began || installed >= disarmed));
  // Resumed after, from its checkpoint (not from zero), and done.
  const Served after = served_between(site.hub, "door0", disarmed, Instant::never());
  CHECK(after.data >= 1);
  std::uint32_t lowest_after = 0xFFFFFFFF;
  for (const host::HubTransfer& t : site.hub.transfers()) {
    if (t.device == "door0" && t.at >= disarmed && t.answer == protocol::transfer_kind::data) {
      lowest_after = std::min(lowest_after, t.offset);
    }
  }
  CHECK(lowest_after > 0);
  CHECK(runs_new_confirmed(world.door));
  CHECK(site.hub.update_state("door0") == kConfirmed);
  // The door of the countdown was watched throughout, its countdown disarmed.
  CHECK(site.hub.decisions(HubAction::alarm, "door1").empty());
  CHECK(critical_events(site.hub).empty());
}

TEST_CASE(
    "D139 R12: an alarm during a download: transfers stay paused through it and the install "
    "waits for its end") {
  CountdownSite world;
  SystemSite& site = world.site;
  INFO(site.dump());
  REQUIRE(world.found);
  // The countdown (30 s) runs out: the alarm; disarmed a minute into it.
  site.run_until(world.opened + seconds(kCountdownSeconds + 60));
  const auto alarms = site.hub.decisions(HubAction::alarm, "door1");
  REQUIRE(alarms.size() == 1);
  const Instant alarm = alarms[0].at;
  const Instant disarmed = site.sim.now();
  site.hub.disarm_group(world.group);
  site.run_until(disarmed + seconds(5 * 60));
  // From the countdown's start to the disarm: no Data; the device was told it is paused.
  const Instant began = site.hub.decisions(HubAction::countdown_started, "door1")[0].at;
  Served during = served_between(site.hub, "door0", began + milliseconds(1), disarmed);
  CHECK(during.data == 0);
  CHECK(during.gone[protocol::GoneReason::paused] >= 1);
  CHECK(served_between(site.hub, "door0", alarm, disarmed).data == 0);
  CHECK(first(site.hub, HubAction::firmware_installing, "door0") >= disarmed);
  CHECK(runs_new_confirmed(world.door));
  CHECK(critical_events(site.hub).empty());
}

TEST_CASE("UP7 P9: a sensor below the battery floor is held (battery) and updates once charged") {
  SystemSite site;
  site.gateway("gateway");
  host::SimDevice& door = site.sensor("door0");
  door.board().sensor_io.battery_mv = 3500;
  site.run_until(at_s(20));
  const host::RemoteImage& image =
      site.hub.add_own_build(host::make_test_image(kNewVersion, 60000), kNewVersion);
  site.hub.rollout_start(image.id, {"door0"}, {"door0"});
  INFO(site.dump());
  REQUIRE(run_until_true(
      site, at_s(20 * 60), [&]() { return held_of(site.hub, "door0") == "battery"; }, seconds(30)));
  site.run_until(site.sim.now() + seconds(20 * 60));
  CHECK(held_of(site.hub, "door0") == "battery");
  CHECK(door.records().kind(RecordKind::slot_write).count() == 0);
  CHECK(same_version(door.boot_choice().image.version, kOldVersion));
  // Charged: it updates.
  door.board().sensor_io.battery_mv = 3900;
  site.run_until(site.sim.now() + seconds(15 * 60));
  CHECK(runs_new_confirmed(door));
  CHECK(critical_events(site.hub).empty());
}

TEST_CASE("SR8 UP7: a siren off mains is held (battery) and fetches nothing") {
  SystemSite site;
  site.gateway("gateway");
  host::DeviceSpec spec;
  spec.name = "siren";
  spec.role = role_factory(protocol::Role::siren);
  host::SimDevice& siren = site.sim.add_device(spec);
  siren.board().power.external = false;  // on its cell: RemoteHub gives it back after pairing
  site.hub.add_siren(siren);
  site.run_until(at_s(20));
  const host::RemoteImage& image =
      site.hub.add_own_build(host::make_test_image(kNewVersion, 60000), kNewVersion);
  site.hub.rollout_start(image.id, {"siren"}, {"siren"});
  INFO(site.dump());
  site.run_until(at_s(20 * 60));
  CHECK(held_of(site.hub, "siren") == "battery");
  CHECK(siren.records().kind(RecordKind::slot_write).count() == 0);
  CHECK(critical_events(site.hub).empty());
}

TEST_CASE(
    "D115 D139: a site move holds the go-ahead (countdown, alarm or site move) until it is done; "
    "the sensor updates after") {
  SystemSite site;
  site.gateway("gateway");
  host::SimDevice& door = site.sensor("door0");
  site.run_until(at_s(20));
  host::SiteMove move;
  move.site_channel = 2;
  site.hub.announce_move(move);
  const host::RemoteImage& image =
      site.hub.add_own_build(host::make_test_image(kNewVersion, 60000), kNewVersion);
  site.hub.rollout_start(image.id, {"door0"}, {"door0"});
  INFO(site.dump());
  REQUIRE(run_until_true(
      site, at_s(20 * 60),
      [&]() { return held_of(site.hub, "door0") == "countdownAlarmOrSiteMove"; }, seconds(10)));
  CHECK(site.hub.decisions(HubAction::firmware_installing, "door0").empty());
  REQUIRE(run_until_true(
      site, at_s(3600), [&]() { return site.hub.move_stage() == host::MoveStage::none; },
      seconds(30)));
  const Instant done = site.hub.decisions(HubAction::move_done).back().at;
  site.run_until(site.sim.now() + seconds(15 * 60));
  CHECK(runs_new_confirmed(door));
  CHECK(first(site.hub, HubAction::firmware_installing, "door0") > done);
  CHECK(critical_events(site.hub).empty());
}

}  // namespace
}  // namespace hsn::test::system

#endif
