// G: restarts (protocol §6 "Started", §7 "Gateway connection", "Siren command"; D80, DS5, SR5):
// a gateway restarting during a countdown does not stop the alarm; a sensor that lost power is
// armed again once its Started is answered; a siren restarting while it sounds resumes for the
// time that was left.

#include "system_site.hpp"

namespace hsn::test::system {
namespace {

/** The door opens here, after the start-up exchanges. */
constexpr std::int64_t kOpenAt = 60;
/** The longest a command waits for a gateway to carry it: one LoRa repeat (§7, §8). */
constexpr Duration kLoraCommandBound = kLoraRepeat + seconds(1);
/** How long sirens sound for an alarm (HubOptions::alarm_seconds, within D40's 5 minutes). */
constexpr Duration kAlarmLength = seconds(180);

TEST_CASE("D80 §7: the gateway restarts during a countdown; the sirens still sound at its end") {
  SystemSite site;
  host::SimDevice& gateway = site.gateway("gateway");
  host::SimDevice& door = site.sensor("door");
  host::SimDevice& on_wifi = site.siren("siren_wifi");
  host::SirenConfig lora_only;
  lora_only.wifi = false;
  host::SimDevice& on_lora = site.siren("siren_lora", lora_only);
  site.hub.arm();
  door.set_input(Input::door, true, at_s(kOpenAt));
  constexpr std::int64_t kRestartAt = kOpenAt + 15;
  gateway.restart(at_s(kRestartAt));
  site.run_until(at_s(kOpenAt + 3 * kCountdownSeconds));
  INFO(site.dump());

  REQUIRE(site.hub.decisions(HubAction::countdown_started, "door").size() == 1);
  // The gateway came back with a new connection (a new hello) before the countdown ended.
  const auto welcomes = site.hub.decisions(HubAction::gateway_welcomed, "gateway");
  REQUIRE(welcomes.size() == 2);
  CHECK(welcomes[1].at > at_s(kRestartAt));
  const auto alarm = site.hub.decisions(HubAction::alarm, "door");
  REQUIRE(alarm.size() == 1);
  CHECK(welcomes[1].at < alarm[0].at);
  CHECK(sounding_from(on_wifi, alarm[0].at) - alarm[0].at <= kHubActsWithin + kLinkLatency);
  CHECK(sounding_from(on_lora, alarm[0].at) - alarm[0].at < kLoraCommandBound);
  // The sensor's countdown, started before the restart, ended with the hub's.
  const auto quiet = buzzer_times(door, Sound::off);
  REQUIRE_FALSE(quiet.empty());
  CHECK(apart(quiet.back(), alarm[0].at) < seconds(1));
  check_one_deep_sleep_per_wake(door);
}

TEST_CASE(
    "§6 Started, DS5: a sensor that loses power while armed starts disarmed and is armed "
    "again once its Started is answered") {
  SystemSite site;
  host::SimDevice& gateway = site.gateway("gateway");
  host::SimDevice& door = site.sensor("door");
  site.hub.arm();
  // Power is lost with the door closed; the retained memory, and the armed state, go with it.
  constexpr std::int64_t kPowerLossAt = 30;
  door.power_loss(at_s(kPowerLossAt), seconds(1));
  // Once it is armed again, the gateway goes away and the door opens: an armed sensor that gets
  // no answer sounds its own countdown and alarm (DS6), which is how an outsider sees the state.
  constexpr std::int64_t kGatewayOff = 60;
  gateway.power_loss(at_s(kGatewayOff), seconds(600));
  door.set_input(Input::door, true, at_s(kOpenAt + 10));
  site.run_until(at_s(kOpenAt + 10 + kCountdownSeconds + 10));
  INFO(site.dump());

  // Two Started: the first power-on, and the one after the power loss, which holds no settings
  // version: no retained memory, so no armed state (§6).
  const auto started = site.hub.received_from("door", type::started);
  REQUIRE(started.size() == 2);
  CHECK(started[1].at > at_s(kPowerLossAt));
  CHECK(started[1].as<protocol::Started>().settings_version == 0);
  const auto replies = heard(door, type::reply);
  REQUIRE_FALSE(replies.empty());
  CHECK(replies.back().at > started[1].at);
  // Answered, it holds the armed settings again: it sounds its own countdown, then its alarm.
  const Instant opened = at_s(kOpenAt + 10) + kBootTime;
  CHECK(buzzer_times(door, Sound::countdown).size() == 1);
  const auto alarm = buzzer_times(door, Sound::alarm);
  REQUIRE(alarm.size() == 1);
  CHECK(alarm[0] == opened + seconds(kCountdownSeconds));
  check_one_deep_sleep_per_wake(door, 1);
}

TEST_CASE("D80 SR5: a siren that restarts while sounding resumes for the time left") {
  SystemSite site;
  site.gateway("gateway");
  host::SimDevice& door = site.sensor("door");
  host::SimDevice& siren = site.siren("siren");
  site.hub.arm();
  door.set_input(Input::door, true, at_s(kOpenAt));
  constexpr std::int64_t kRestartAt = kOpenAt + kCountdownSeconds + 40;
  siren.restart(at_s(kRestartAt));
  site.run_until(at_s(kOpenAt + kCountdownSeconds) + kAlarmLength + seconds(30));
  INFO(site.dump());

  const auto alarm = site.hub.decisions(HubAction::alarm, "door");
  REQUIRE(alarm.size() == 1);
  // On at the alarm, low while the board resets, on again as it boots, and off by itself when
  // the time the command gave runs out, not that time counted again from the restart.
  const auto changes = sounder(siren);
  REQUIRE(changes.size() == 4);
  CHECK(changes[0].second);
  CHECK(changes[0].first - alarm[0].at <= kHubActsWithin + kLinkLatency);
  CHECK_FALSE(changes[1].second);
  CHECK(changes[1].first == at_s(kRestartAt));
  CHECK(changes[2].second);
  CHECK(changes[2].first == at_s(kRestartAt) + kBootTime);
  CHECK_FALSE(changes[3].second);
  CHECK(apart(changes[3].first, changes[0].first + kAlarmLength) < seconds(1));
  // The hub did not command it again: the siren resumed on its own (D80).
  const auto commands = site.hub.decisions(HubAction::siren_command, "siren");
  CHECK(commands.size() == 1);
  // Its reports after the restart say it is sounding, with the time left.
  bool reported = false;
  for (const host::HubPacket& packet : site.hub.received_from("siren", type::siren_report)) {
    const auto report = packet.as<protocol::SirenReport>();
    if (!reported && packet.at > at_s(kRestartAt) + kBootTime) {
      reported = true;
      CHECK(report.state == protocol::SirenState::sounding_alarm);
      const Duration left = changes[0].first + kAlarmLength - packet.at;
      CHECK(apart(at(seconds(report.sounding_seconds_left)), at(left)) <= seconds(1));
    }
  }
  CHECK(reported);
}

}  // namespace
}  // namespace hsn::test::system
