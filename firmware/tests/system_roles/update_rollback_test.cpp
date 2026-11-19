// A device that fails its update, at each stage, and what the real hub then does (m3-updates-
// design.md section 8: update_rollback_test.cpp; section 4, "How a failed update is reported";
// section 2, "Healthy, per role"; D134, D139): refused before any write, lost after the go-ahead,
// a trial that fails on a sensor, a siren and a gateway. Each rolls back or keeps its image, the
// rollout pauses with the reason, nothing more is offered until a person resumes it. On the real
// hub only, with the real roles in lockstep.

#ifdef HSN_LOCKSTEP

#include "update_site.hpp"

namespace hsn::test::system {
namespace {

/** The default path loss between stations (Medium), to mend a cut. */
constexpr double kPathLossDb = 100;

/** The rollout's state from `rollout.status`. */
struct RolloutState {
  std::string stage;
  std::string reason;
  std::int64_t device = 0;
};

RolloutState rollout_state(host::RemoteHub& hub) {
  const json::Value status = hub.rollout_status();
  const json::Value& rollout = status.at("rollout");
  RolloutState out;
  out.stage = rollout.at("stage").as_string();
  const json::Value& paused = rollout.at("paused");
  if (!paused.is_null()) {
    out.reason = paused.at("reason").as_string();
    out.device = paused.at("device").is_null() ? 0 : paused.at("device").as_int();
  }
  return out;
}

/** What every failure must leave: the device on a working image off trial, nothing on trial. */
void check_working_old_image(host::SimDevice& device) {
  CAPTURE(device.name());
  CHECK(device.state() != host::PowerState::off);
  CHECK(device.boot_choice().bootable);
  CHECK_FALSE(device.board().slots.running().on_trial);
  CHECK(same_version(device.boot_choice().image.version, kOldVersion));
}

/** An armed door still raises its countdown on the hub after the failure. */
void check_door_still_watched(SystemSite& site, host::SimDevice& door) {
  site.hub.arm();
  const Instant open = site.sim.now() + seconds(5);
  door.set_input(Input::door, true, open);
  site.run_until(open + seconds(10));
  CHECK_FALSE(decisions_since(site.hub, HubAction::countdown_started, open, door.name()).empty());
  site.hub.disarm();
  site.run_until(site.sim.now() + seconds(5));
}

TEST_CASE(
    "UP2 D134 D139: a sensor pilot whose new image hangs rolls back by the watchdog; the rollout "
    "pauses (rolledBack) and offers nothing until resumed; resumed, the sensor is offered again") {
  SystemSite site;
  site.gateway("gateway");
  host::SimDevice& bad = add_board(site, protocol::Role::sensor, "door0", NewImage::hangs);
  site.sensor("door1");
  site.run_until(at_s(20));
  const host::RemoteImage& image =
      site.hub.add_own_build(host::make_test_image(kNewVersion, 60000), kNewVersion);
  const std::int64_t rollout = site.hub.rollout_start(image.id, {"door0", "door1"}, {"door0"});
  INFO(site.dump());
  REQUIRE(run_until_true(site, at_s(20 * 60),
                         [&]() { return !site.hub.decisions(HubAction::rollout_paused).empty(); }));
  const Instant paused = site.hub.decisions(HubAction::rollout_paused).front().at;

  // The board went back to its old image and said so in its Started; the hub recorded the failed
  // version and paused, naming the device and the reason.
  check_working_old_image(bad);
  CHECK(bad.boot_choice().image.rolled_back);
  CHECK(bad.records().kind(RecordKind::restart).count() >= 1);
  const auto rolled = site.hub.decisions(HubAction::firmware_rolled_back, "door0");
  REQUIRE(rolled.size() == 1);
  CHECK(rolled[0].value == version_value(kNewVersion));
  CHECK(site.hub.decisions(HubAction::rollout_paused).front().value == rollout);
  CHECK(site.hub.decisions(HubAction::rollout_paused).front().device == "door0");
  const RolloutState state = rollout_state(site.hub);
  CHECK(state.stage == "paused");
  CHECK(state.reason == "rolledBack");
  CHECK(state.device == site.hub.device_number("door0"));
  CHECK(site.hub.update_state("door0") == "rolledBack");

  // Nothing is offered to anyone while it is paused, for an hour (past the soak).
  site.run_until(paused + seconds(3600 + 600));
  CHECK(fetch_offers_since(site.hub, paused + seconds(1)) == 0);
  CHECK(site.hub.decisions(HubAction::firmware_confirmed).empty());
  check_door_still_watched(site, bad);

  // Resumed: the update is offered again (section 2: "a person resumes it; the update is offered
  // again"); it rolls back again and the rollout pauses again.
  const Instant resumed = site.sim.now();
  site.hub.rollout_resume();
  site.run_until(resumed + seconds(15 * 60));
  CHECK(fetch_offers_since(site.hub, resumed) >= 1);
  CHECK(decisions_since(site.hub, HubAction::firmware_rolled_back, resumed, "door0").size() == 1);
  CHECK(decisions_since(site.hub, HubAction::rollout_paused, resumed).size() == 1);
  check_working_old_image(bad);
  CHECK(critical_events(site.hub).empty());
}

TEST_CASE(
    "UP3 D139: an image too large for the sensor's slot is refused before any write (tooLarge); "
    "the hub records the refusal and pauses the rollout: the image is wrong, not the device") {
  SystemSite site;
  site.gateway("gateway");
  host::SimDevice& door = site.sensor("door0");
  site.run_until(at_s(20));
  // Over the board's 64 KB test slot, well under the hub's 3.5 MB (section 3).
  const host::RemoteImage& image =
      site.hub.add_own_build(host::make_test_image(kNewVersion, 70000), kNewVersion);
  const std::int64_t rollout = site.hub.rollout_start(image.id);
  INFO(site.dump());
  REQUIRE(run_until_true(site, at_s(20 * 60),
                         [&]() { return !site.hub.decisions(HubAction::rollout_paused).empty(); }));
  CHECK(door.records().kind(RecordKind::slot_erase).count() == 0);
  CHECK(door.records().kind(RecordKind::slot_write).count() == 0);
  check_working_old_image(door);
  const auto statuses = site.hub.decisions(HubAction::firmware_status, "door0");
  REQUIRE_FALSE(statuses.empty());
  CHECK(statuses.back().value ==
        protocol::UpdateStage::refused * 256 + protocol::UpdateReason::too_large);
  const auto refused = site.hub.decisions(HubAction::firmware_refused, "door0");
  REQUIRE(refused.size() == 1);
  CHECK(refused[0].value == protocol::UpdateReason::too_large);
  CHECK(site.hub.decisions(HubAction::rollout_paused).front().value == rollout);
  const RolloutState state = rollout_state(site.hub);
  CHECK(state.stage == "paused");
  CHECK(state.reason == "tooLarge");
  CHECK(site.hub.update_state("door0") == "refused");
  CHECK(critical_events(site.hub).empty());
}

/**
 * A sensor lost to the hub from just after its go-ahead: its installing status may still get
 * through; nothing after its restart does, until `mend()`.
 */
struct LostSensor {
  LostSensor() : gateway(site.gateway("gateway")), door(site.sensor("door0")) {
    site.run_until(at_s(20));
    const host::RemoteImage& image =
        site.hub.add_own_build(host::make_test_image(kNewVersion, 60000), kNewVersion);
    site.hub.rollout_start(image.id, {"door0"});
    found = run_until_true(
        site, at_s(20 * 60),
        [&]() { return !site.hub.decisions(HubAction::firmware_installing, "door0").empty(); },
        milliseconds(10));
    if (found) {
      go_ahead = site.hub.decisions(HubAction::firmware_installing, "door0")[0].at;
      site.run_until(go_ahead + milliseconds(300));
      site.sim.medium().cut(door.station(), gateway.station());
    }
  }

  void mend() {
    site.sim.medium().set_path_loss(door.station(), gateway.station(), kPathLossDb);
  }

  SystemSite site;
  host::SimDevice& gateway;
  host::SimDevice& door;
  bool found = false;
  Instant go_ahead;
};

TEST_CASE(
    "D134 D139: a sensor lost to the hub right after the go-ahead: its trial gets no reply and "
    "rolls back at 10 minutes; the hub refuses it noContact at 12 and pauses") {
  LostSensor world;
  SystemSite& site = world.site;
  INFO(site.dump());
  REQUIRE(world.found);
  site.run_until(world.go_ahead + seconds(11 * 60));
  // The trial ran out: the board is back on its old image, on its own, with nothing from the hub.
  check_working_old_image(world.door);
  CHECK(world.door.boot_choice().image.rolled_back);
  CHECK(site.hub.decisions(HubAction::firmware_refused, "door0").empty());
  site.run_until(world.go_ahead + seconds(12 * 60 + 30));
  const auto refused = site.hub.decisions(HubAction::firmware_refused, "door0");
  REQUIRE(refused.size() == 1);
  CHECK(refused[0].value == 18);  // noContact (core/firmware/codes.ts)
  CHECK(refused[0].at >= world.go_ahead + seconds(12 * 60));
  CHECK(refused[0].at <= world.go_ahead + seconds(12 * 60) + seconds(1));
  const RolloutState state = rollout_state(site.hub);
  CHECK(state.stage == "paused");
  CHECK(state.reason == "noContact");
  CHECK(critical_events(site.hub).empty());
}

TEST_CASE(
    "D134: the sensor refused noContact comes back in range: its Started says it rolled back, "
    "and the hub records the rollback") {
  LostSensor world;
  SystemSite& site = world.site;
  INFO(site.dump());
  REQUIRE(world.found);
  site.run_until(world.go_ahead + seconds(12 * 60 + 30));
  REQUIRE(site.hub.decisions(HubAction::firmware_refused, "door0").size() == 1);
  // Back in range: its next Started (it retries every 60 s) tells the hub it rolled back.
  world.mend();
  site.run_until(site.sim.now() + seconds(5 * 60));
  REQUIRE(world.door.boot_choice().image.rolled_back);
  CHECK(site.hub.decisions(HubAction::firmware_rolled_back, "door0").size() == 1);
  CHECK(site.hub.update_state("door0") == "rolledBack");
}

TEST_CASE(
    "SR8 D134 D139: a siren pilot whose new image hangs rolls back; the rollout pauses and no "
    "gateway is offered") {
  SystemSite site;
  site.gateway("gateway");
  host::SimDevice& siren = add_board(site, protocol::Role::siren, "siren0", NewImage::hangs);
  site.run_until(at_s(20));
  const host::RemoteImage& image =
      site.hub.add_own_build(host::make_test_image(kNewVersion, 60000), kNewVersion);
  site.hub.rollout_start(image.id, {}, {"siren0"});
  INFO(site.dump());
  REQUIRE(run_until_true(site, at_s(20 * 60),
                         [&]() { return !site.hub.decisions(HubAction::rollout_paused).empty(); }));
  const Instant paused = site.hub.decisions(HubAction::rollout_paused).front().at;
  check_working_old_image(siren);
  CHECK(siren.boot_choice().image.rolled_back);
  CHECK(site.hub.decisions(HubAction::firmware_rolled_back, "siren0").size() == 1);
  CHECK(rollout_state(site.hub).reason == "rolledBack");
  site.run_until(paused + seconds(30 * 60));
  CHECK(fetch_offers_since(site.hub, paused + seconds(1)) == 0);
  // It still sounds when told to (its job).
  const Instant test = site.sim.now();
  site.hub.command_siren("siren0", protocol::SirenAction::test, 2);
  site.run_until(test + seconds(1));
  CHECK(sounding_from(siren, test) - test <= kHubActsWithin + kLinkLatency);
  CHECK(critical_events(site.hub).empty());
}

TEST_CASE(
    "GW7 D134 D139: a gateway pilot on USB whose new image hangs rolls back; the rollout pauses; "
    "the gateway forwards again") {
  SystemSite site;
  host::GatewayConfig usb;
  usb.usb = true;
  usb.network = false;
  host::SimDevice& gateway =
      add_board(site, protocol::Role::gateway, "gateway", NewImage::hangs, {}, usb);
  host::SimDevice& door = site.sensor("door0");
  site.run_until(at_s(20));
  const host::RemoteImage& image =
      site.hub.add_own_build(host::make_test_image(kNewVersion, 60000), kNewVersion);
  site.hub.rollout_start(image.id, {"gateway"}, {"gateway"});
  INFO(site.dump());
  REQUIRE(run_until_true(site, at_s(20 * 60),
                         [&]() { return !site.hub.decisions(HubAction::rollout_paused).empty(); }));
  check_working_old_image(gateway);
  CHECK(gateway.boot_choice().image.rolled_back);
  CHECK(site.hub.decisions(HubAction::firmware_rolled_back, "gateway").size() == 1);
  CHECK(rollout_state(site.hub).reason == "rolledBack");
  CHECK(data_links(gateway, at_s(20)) == std::set<std::string>{"usb"});
  check_door_still_watched(site, door);
  CHECK(critical_events(site.hub).empty());
}

}  // namespace
}  // namespace hsn::test::system

#endif
