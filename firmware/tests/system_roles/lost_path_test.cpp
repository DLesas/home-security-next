// B: losing a path (protocol §7 "No reply from the hub", "Siren command", "Gateway connection";
// DS6, D7, D73, D88, D106): with the gateway off the sensor sounds its own countdown and alarm and
// tells the hub later; a siren without Wi-Fi is commanded and answers over LoRa through the
// gateway; the gateway's link dropping during a countdown does not stop the sirens.

#include "system_site.hpp"

namespace hsn::test::system {
namespace {

/** The door opens here, after the start-up exchanges. */
constexpr std::int64_t kOpenAt = 60;
/** The sensor gives up a report's retries after 10 minutes (§7, §8). */
constexpr Duration kRetryRun = seconds(10 * 60);
/** The siren notices a dead Wi-Fi after 15 s without an answer to its ping (§7). */
constexpr Duration kWifiDeadAfter = seconds(15);
/** The longest a command waits for the gateway: one LoRa repeat (§7, §8). */
constexpr Duration kLoraCommandBound = kLoraRepeat + seconds(1);

/**
 * The gateway is off from before the opening until 5 minutes after; the site allows the data
 * rates in `allowed_mask` and the gateway listens at DR5, the fastest.
 */
void gateway_off_during_opening(std::uint8_t allowed_mask, Duration heard_again_within) {
  SystemSite site(site_allowing(allowed_mask));
  host::SimDevice& gateway = site.gateway("gateway");
  host::SimDevice& door = site.sensor("door");
  host::SimDevice& siren = site.siren("siren");
  site.hub.arm();
  // The gateway loses power before the door opens and is back 5 minutes later.
  constexpr std::int64_t kGatewayOff = 30;
  constexpr std::int64_t kGatewayBack = 360;
  gateway.power_loss(at_s(kGatewayOff), seconds(kGatewayBack - kGatewayOff));
  door.set_input(Input::door, true, at_s(kOpenAt));
  site.run_until(at_s(kOpenAt) + kRetryRun + seconds(60));
  INFO(site.dump());

  // The first try went unanswered: the stored countdown, from the opening, then about 3 minutes
  // of alarm (DS6, D88).
  const Instant opened = at_s(kOpenAt) + kBootTime;
  const auto countdown = buzzer_times(door, Sound::countdown);
  const auto alarm = buzzer_times(door, Sound::alarm);
  REQUIRE(countdown.size() == 1);
  REQUIRE(alarm.size() == 1);
  CHECK(countdown[0] < opened + seconds(5));
  CHECK(alarm[0] == opened + seconds(kCountdownSeconds));
  const auto quiet = buzzer_times(door, Sound::off);
  REQUIRE_FALSE(quiet.empty());
  CHECK(quiet.back() == alarm[0] + kLocalAlarm);

  // Back on, the gateway reconnected and the next retry got through, saying the local alarm
  // sounded (§6, flag bit 5); the hub took it as a report too late for the sirens (D106).
  const auto reports = site.hub.received_from("door", type::door_changed);
  REQUIRE(reports.size() == 1);
  CHECK(reports[0].at > at_s(kGatewayBack));
  if (allowed_mask == kTwoRates) {
    // The fall-back was exercised: some tries went at the slower rate (§7 "Data rate").
    CHECK(door.records()
              .kind(RecordKind::transmission)
              .where([](const Record& r) { return r.data_rate == protocol::DataRate::dr2; })
              .count() > 0);
  }
  const Duration heard_after = reports[0].at - at_s(kGatewayBack);
  MESSAGE("gateway off, " << rates_name(allowed_mask) << ": the hub hears the door "
                          << in_seconds(heard_after) << " s after the gateway's return (bound "
                          << in_seconds(heard_again_within) << " s)");
  CHECK(heard_after < heard_again_within);
  const auto status = reports[0].as<protocol::DoorChanged>();
  CHECK(status.flags.local_alarm_sounded);
  CHECK(status.flags.door_open);
  CHECK(site.hub.decisions(HubAction::local_alarm_reported, "door").size() == 1);
  CHECK(site.hub.decisions(HubAction::late_report_notification, "door").size() == 1);
  CHECK(site.hub.decisions(HubAction::alarm).empty());
  CHECK(sounder(siren).empty());
  // Answered, the sensor stopped retrying and went back to deep sleep.
  CHECK(sent(door, type::door_changed).back().at < reports[0].at);
  CHECK(sleeping_between_heartbeats(door, site.sim.now()));
  check_one_deep_sleep_per_wake(door);
}

TEST_CASE(
    "DS6 D88 D106: with the gateway off, the sensor sounds its own countdown and alarm; "
    "when it returns, the report gets through with the local alarm flag (one data rate)") {
  // One sending rate on the site, the one the gateway listens at (§2): the next retry gets
  // through, at most one late retry gap after the return.
  gateway_off_during_opening(kOnlyDr5, kLateRetryGap);
}

TEST_CASE(
    "DS6 D88 D106 LR4: the same on a site allowing DR5 and DR2: the sensor's fall-back comes "
    "round to the gateway's rate and the report gets through" HSN_NOT_ON_REAL_HUB(
        "the protocol gives a site one data rate until O14 is settled, so the real hub has no "
        "site allowing DR5 and DR2")) {
  // After four unanswered tries the sensor alternates two tries at DR2 and two at DR5 (§7
  // "Data rate": slower every two misses, from the slowest back to the fastest). At the return
  // it may have up to two tries left at DR2 before its next at DR5, so the hub hears it within
  // three late retry gaps.
  gateway_off_during_opening(kTwoRates, Duration{kLateRetryGap.us * kTriesToComeRound});
}

TEST_CASE(
    "D73 D36: with a siren's Wi-Fi down, the command reaches it over LoRa through the "
    "gateway and is answered that way") {
  SystemSite site;
  site.gateway("gateway");
  host::SimDevice& door = site.sensor("door");
  host::SimDevice& siren = site.siren("siren");
  site.hub.arm();
  // The siren's network goes away: its connection fails and every attempt to reconnect fails.
  constexpr std::int64_t kWifiGone = 20;
  site.sim.schedule(at_s(kWifiGone), [&]() { siren.wire(device::LinkKind::network).detach(); });
  door.set_input(Input::door, true, at_s(kOpenAt));
  site.run_until(at_s(kOpenAt + 2 * kCountdownSeconds));
  INFO(site.dump());

  // The siren reported Wi-Fi going down over LoRa, through the gateway (§7, siren reports).
  const auto failed = site.hub.received_from("siren", type::siren_report);
  bool told_on_lora = false;
  for (const host::HubPacket& report : failed) {
    told_on_lora =
        told_on_lora || (report.path == HubPath::gateway && report.at > at_s(kWifiGone) &&
                         report.at < at_s(kWifiGone) + kWifiDeadAfter + seconds(kCountdownSeconds));
  }
  CHECK(told_on_lora);

  const auto alarm = site.hub.decisions(HubAction::alarm, "door");
  REQUIRE(alarm.size() == 1);
  // Commanded on both paths; only the LoRa copy could arrive, and it did.
  const auto commands = site.hub.sent_to("siren", type::siren_command);
  REQUIRE_FALSE(commands.empty());
  CHECK(commands[0].path == HubPath::gateway);
  CHECK(siren.records().kind(RecordKind::link_received).type(type::siren_command).empty());
  const Instant on = sounding_from(siren, alarm[0].at);
  CHECK(on - alarm[0].at < kLoraCommandBound);
  // Its answer went on the air and the hub confirmed the command from it.
  const auto answers = site.hub.received_from("siren", type::siren_report);
  bool answered_on_lora = false;
  for (const host::HubPacket& report : answers) {
    const auto body = report.as<protocol::SirenReport>();
    answered_on_lora =
        answered_on_lora || (report.at > alarm[0].at && report.path == HubPath::gateway &&
                             body.reason == protocol::SirenReportReason::command_answer &&
                             body.state == protocol::SirenState::sounding_alarm);
  }
  CHECK(answered_on_lora);
  const auto confirmed = site.hub.decisions(HubAction::siren_confirmed, "siren");
  REQUIRE_FALSE(confirmed.empty());
  CHECK(confirmed.back().value == static_cast<std::int64_t>(HubPath::gateway));
  CHECK(site.hub.decisions(HubAction::siren_unreachable, "siren").empty());
}

TEST_CASE(
    "D73 D80 §7: the gateway's link to the hub drops during a countdown and comes back: "
    "every siren still sounds at the countdown's end") {
  SystemSite site;
  host::SimDevice& gateway = site.gateway("gateway");
  host::SimDevice& door = site.sensor("door");
  host::SimDevice& on_wifi = site.siren("siren_wifi");
  // A siren the hub can reach over LoRa alone, so the gateway's return matters.
  host::SirenConfig lora_only;
  lora_only.wifi = false;
  host::SimDevice& on_lora = site.siren("siren_lora", lora_only);
  site.hub.arm();
  door.set_input(Input::door, true, at_s(kOpenAt));
  // The network between the gateway and the hub fails 10 s into the countdown, for 10 s.
  constexpr std::int64_t kDropAt = kOpenAt + 10;
  constexpr std::int64_t kBackAt = kOpenAt + 20;
  site.sim.schedule(at_s(kDropAt), [&]() { gateway.wire(device::LinkKind::network).detach(); });
  site.sim.schedule(at_s(kBackAt), [&]() {
    gateway.wire(device::LinkKind::network).attach(site.hub, kLinkLatency);
  });
  site.run_until(at_s(kOpenAt + 3 * kCountdownSeconds));
  INFO(site.dump());

  REQUIRE(site.hub.decisions(HubAction::countdown_started, "door").size() == 1);
  // The gateway connected again before the countdown ended.
  const auto welcomes = site.hub.decisions(HubAction::gateway_welcomed, "gateway");
  REQUIRE(welcomes.size() == 2);
  const auto alarm = site.hub.decisions(HubAction::alarm, "door");
  REQUIRE(alarm.size() == 1);
  CHECK(welcomes[1].at < alarm[0].at);
  CHECK(sounding_from(on_wifi, alarm[0].at) - alarm[0].at <= kHubActsWithin + kLinkLatency);
  CHECK(sounding_from(on_lora, alarm[0].at) - alarm[0].at < kLoraCommandBound);
  CHECK(sounding_at(on_wifi, at_s(kOpenAt + 3 * kCountdownSeconds)));
  CHECK(sounding_at(on_lora, at_s(kOpenAt + 3 * kCountdownSeconds)));
}

}  // namespace
}  // namespace hsn::test::system
