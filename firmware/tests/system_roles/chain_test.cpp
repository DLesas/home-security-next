// A: the chain of M1a's "done when" with the real roles (build plan M1a; protocol §7 "Door opens
// while armed", "Siren command"; D24, D71, D73, D110): an armed door opens, the sensor buzzes, the
// countdown ends, every siren sounds, commanded on Wi-Fi and through the gateway, a disarm stops
// them, and the sensor sleeps deep again. Then a disarm inside the countdown.

#include <algorithm>

#include "system_site.hpp"

namespace hsn::test::system {
namespace {

/** The door opens here, well after every device's start-up exchange (§7). */
constexpr std::int64_t kOpenAt = 60;
/** The user disarms here, after the countdown has ended. */
constexpr std::int64_t kDisarmAfterAlarmAt = 120;
/** The user disarms here, inside the countdown. */
constexpr std::int64_t kDisarmInCountdownAt = 75;
/** The longest a door report waits for its reply: the event listen time at DR5 (§8). */
constexpr Duration kEventListen = milliseconds(1500);
/**
 * The reply's "countdown remaining" is whole seconds (§6, reply), so the sensor's countdown may
 * end up to a second away from the hub's.
 */
constexpr Duration kWholeSecond = seconds(1);
/**
 * From the hub deciding a command to the siren switching: the hub's own time to send it, then one
 * link latency on Wi-Fi; the siren acts on the first copy at once (§7 "Siren command", step 2).
 */
constexpr Duration kWifiCommandBound = kHubActsWithin + kLinkLatency;

/** A gateway, one sensor with the default countdown, and two sirens on Wi-Fi. */
struct ChainSite {
  ChainSite()
      : gateway(site.gateway("gateway")),
        door(site.sensor("door")),
        sirens{&site.siren("siren_a"), &site.siren("siren_b")} {}

  SystemSite site;
  host::SimDevice& gateway;
  host::SimDevice& door;
  std::vector<host::SimDevice*> sirens;
};

TEST_CASE(
    "M1a done when, AL3 D24 D73: an armed door buzzes, every siren sounds on both paths "
    "at the countdown's end, a disarm stops them, the sensor sleeps deep "
    "again") {
  ChainSite chain;
  SystemSite& site = chain.site;
  site.hub.arm();
  chain.door.set_input(Input::door, true, at_s(kOpenAt));
  site.sim.schedule(at_s(kDisarmAfterAlarmAt), [&]() { site.hub.disarm(); });
  site.run_until(at_s(kDisarmAfterAlarmAt + 60));
  INFO(site.dump());

  // The report went through the gateway and the hub started one countdown.
  const auto started = site.hub.decisions(HubAction::countdown_started, "door");
  REQUIRE(started.size() == 1);
  CHECK(started[0].value == kCountdownSeconds);
  CHECK(started[0].at - at_s(kOpenAt) < kEventListen);
  const auto reports = site.hub.received_from("door", type::door_changed);
  REQUIRE(reports.size() == 1);
  CHECK(reports[0].path == HubPath::gateway);
  CHECK(reports[0].via == "gateway");

  // The sensor buzzed on the hub's reply, inside its listening, until the countdown's end.
  const auto replies = heard(chain.door, type::reply);
  const auto countdown = buzzer_times(chain.door, Sound::countdown);
  REQUIRE(countdown.size() == 1);
  CHECK(countdown[0] - at_s(kOpenAt) < kEventListen);
  CHECK(std::find_if(replies.begin(), replies.end(),
                     [&](const Record& r) { return r.at == countdown[0]; }) != replies.end());
  CHECK(buzzer_times(chain.door, Sound::alarm).empty());

  // The countdown ended once, about 30 s after the opening; the sensor stopped buzzing then.
  const auto alarm = site.hub.decisions(HubAction::alarm, "door");
  REQUIRE(alarm.size() == 1);
  CHECK(alarm[0].at - started[0].at == seconds(kCountdownSeconds));
  const auto quiet = buzzer_times(chain.door, Sound::off);
  REQUIRE_FALSE(quiet.empty());
  CHECK(quiet.back() > countdown[0]);
  CHECK(apart(quiet.back(), alarm[0].at) < kWholeSecond);

  for (host::SimDevice* siren : chain.sirens) {
    INFO(siren->name());
    // Every siren sounded at the countdown's end, until the disarm.
    const Instant on = sounding_from(*siren, alarm[0].at);
    CHECK(on - alarm[0].at <= kWifiCommandBound);
    CHECK_FALSE(sounding_at(*siren, at_s(kDisarmAfterAlarmAt + 60)));
    const auto changes = sounder(*siren);
    REQUIRE(changes.size() == 2);
    CHECK_FALSE(changes[1].second);
    CHECK(changes[1].first - at_s(kDisarmAfterAlarmAt) <= kWifiCommandBound);
    // Commanded on both paths with the same packet (D73): on Wi-Fi, and on the air through the
    // gateway, where the siren heard it too.
    const auto commands = site.hub.sent_to(siren->name(), type::siren_command);
    REQUIRE(commands.size() >= 2);
    CHECK(commands[0].path == HubPath::link);
    CHECK(commands[1].path == HubPath::gateway);
    CHECK(commands[0].packet == commands[1].packet);
    const std::uint32_t address = address_in(commands[0].packet);
    const auto on_air =
        chain.gateway.records()
            .kind(RecordKind::transmission)
            .type(type::siren_command)
            .where([&](const Record& r) {
              return r.label.address == address && r.label.counter == commands[0].counter;
            })
            .records();
    REQUIRE(on_air.size() == 1);
    CHECK(on_air[0].frequency_hz == kHubHz);
    CHECK(siren->records()
              .kind(RecordKind::link_received)
              .type(type::siren_command)
              .between(alarm[0].at, at_s(kDisarmAfterAlarmAt))
              .count() == 1);
    CHECK(siren->records()
              .kind(RecordKind::reception)
              .type(type::siren_command)
              .between(alarm[0].at, at_s(kDisarmAfterAlarmAt))
              .where([&](const Record& r) { return r.label.address == address; })
              .count() == 1);
    CHECK_FALSE(site.hub.decisions(HubAction::siren_confirmed, siren->name()).empty());
  }

  // The sensor is back in deep sleep, and kept the discipline (design section 6).
  CHECK(sleeping_between_heartbeats(chain.door, site.sim.now()));
  const auto sleeps = chain.door.records().kind(RecordKind::deep_sleep).records();
  REQUIRE_FALSE(sleeps.empty());
  CHECK(sleeps.back().at >= quiet.back());
  check_one_deep_sleep_per_wake(chain.door);
  // The hub holds a record of every packet that reached it (D110).
  CHECK(check_hub_recorded_everything(site).checked > 0);
}

TEST_CASE(
    "D24 §7: a disarm inside the countdown stops the buzzer by the disarmed notice, and no "
    "siren sounds") {
  ChainSite chain;
  SystemSite& site = chain.site;
  site.hub.arm();
  chain.door.set_input(Input::door, true, at_s(kOpenAt));
  site.sim.schedule(at_s(kDisarmInCountdownAt), [&]() { site.hub.disarm(); });
  site.run_until(at_s(kOpenAt + 3 * kCountdownSeconds));
  INFO(site.dump());

  REQUIRE(site.hub.decisions(HubAction::countdown_started, "door").size() == 1);
  CHECK(site.hub.decisions(HubAction::alarm).empty());
  // The notice went twice, 2 s apart, through the gateway that carried the report.
  const auto notices = site.hub.sent_to("door", type::disarmed_notice);
  REQUIRE(notices.size() == 2);
  CHECK(notices[1].at - notices[0].at == kNoticeGap);
  CHECK(notices[0].via == "gateway");
  // The buzzer stopped the moment the first notice arrived, long before the countdown's end.
  const auto heard_notices = heard(chain.door, type::disarmed_notice);
  REQUIRE_FALSE(heard_notices.empty());
  const auto quiet = buzzer_times(chain.door, Sound::off);
  REQUIRE_FALSE(quiet.empty());
  CHECK(quiet.back() == heard_notices[0].at);
  CHECK(quiet.back() < at_s(kOpenAt + kCountdownSeconds));
  CHECK(buzzer_times(chain.door, Sound::countdown).size() == 1);
  CHECK(buzzer_times(chain.door, Sound::alarm).empty());
  // No siren sounded, and none was commanded.
  for (host::SimDevice* siren : chain.sirens) {
    INFO(siren->name());
    CHECK(sounder(*siren).empty());
    CHECK(site.hub.sent_to(siren->name(), type::siren_command).empty());
  }
  CHECK(sleeping_between_heartbeats(chain.door, site.sim.now()));
  check_one_deep_sleep_per_wake(chain.door);
  CHECK(check_hub_recorded_everything(site).checked > 0);
}

}  // namespace
}  // namespace hsn::test::system
