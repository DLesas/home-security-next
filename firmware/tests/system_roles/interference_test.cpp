// H: interference on the site channel (GW11, D82, DS6; protocol §6 "Interference", §8, §13
// "Transmits on the radio"): the gateway reports the jamming to the hub, and an armed door that
// opens meanwhile, its report lost to the noise, sounds the sensor's own countdown and alarm.

#include "system_site.hpp"

namespace hsn::test::system {
namespace {

/** The plain noise floor of the Medium, dBm (§6 gateway status, the normal level learned). */
constexpr double kFloorDbm = -117.0;
/**
 * The jammer: 47 dB above the floor, so a sensor heard at -86 dBm (100 dB path loss, 14 dBm)
 * is 16 dB under it, below every spreading factor's demodulation SNR (hardware notes section 3).
 */
constexpr double kJammerDbm = -70.0;
/** The jamming runs from here for this long. */
constexpr std::int64_t kJamFrom = 100;
constexpr std::int64_t kJamFor = 300;
/** The interference alert: 10 dB above normal for 30 s (§8 †, the gateway's default). */
constexpr Duration kAlertAfter = seconds(30);
/** The door opens after the alert. */
constexpr std::int64_t kOpenAt = kJamFrom + 60;

/** The scenario on a site allowing the data rates in `allowed_mask`; the gateway hears DR5. */
void jammed_opening(std::uint8_t allowed_mask, Duration heard_again_within) {
  SystemSite site(site_allowing(allowed_mask));
  site.gateway("gateway");
  host::SimDevice& door = site.sensor("door");
  host::SimDevice& siren = site.siren("siren");
  site.hub.arm();
  site.sim.medium().script_noise(kSiteHz, at_s(kJamFrom), at_s(kJamFrom + kJamFor), kJammerDbm);
  door.set_input(Input::door, true, at_s(kOpenAt));
  // Until the door's retries end, 10 minutes after the opening (§7).
  site.run_until(at_s(kOpenAt + 10 * 60 + 60));
  INFO(site.dump());

  // The gateway told the hub when the interference started and when it ended (§6).
  std::vector<std::pair<Instant, protocol::Interference>> alerts;
  for (const host::HubPacket& packet : site.hub.received_from("gateway", type::interference)) {
    alerts.emplace_back(packet.at, packet.as<protocol::Interference>());
  }
  REQUIRE(alerts.size() == 2);
  CHECK(alerts[0].second.event == protocol::InterferenceEvent::started);
  CHECK(alerts[0].second.noise_dbm == static_cast<std::int8_t>(kJammerDbm));
  CHECK(alerts[0].first > at_s(kJamFrom) + kAlertAfter);
  CHECK(alerts[0].first < at_s(kJamFrom) + kAlertAfter + seconds(2));
  CHECK(alerts[1].second.event == protocol::InterferenceEvent::ended);
  CHECK(alerts[1].first > at_s(kJamFrom + kJamFor));
  CHECK(static_cast<double>(alerts[1].second.noise_dbm) > kFloorDbm);

  // The door's tries were lost in the noise: nothing reached the hub while it lasted.
  for (const host::HubPacket& packet : site.hub.received_from("door")) {
    CHECK_FALSE((packet.at > at_s(kJamFrom) && packet.at < at_s(kJamFrom + kJamFor)));
  }
  CHECK(sent(door, type::door_changed).size() > 1);
  // Armed and unanswered, the sensor sounded its stored countdown from the opening, then its alarm.
  const Instant opened = at_s(kOpenAt) + kBootTime;
  CHECK(buzzer_times(door, Sound::countdown).size() == 1);
  const auto alarm = buzzer_times(door, Sound::alarm);
  REQUIRE(alarm.size() == 1);
  CHECK(alarm[0] == opened + seconds(kCountdownSeconds));
  // When the jamming stopped, a retry got through, saying the local alarm sounded (§6).
  const auto reports = site.hub.received_from("door", type::door_changed);
  REQUIRE_FALSE(reports.empty());
  CHECK(reports[0].as<protocol::DoorChanged>().flags.local_alarm_sounded);
  if (allowed_mask == kTwoRates) {
    // The fall-back was exercised: some tries went at the slower rate (§7 "Data rate").
    CHECK(door.records()
              .kind(RecordKind::transmission)
              .where([](const Record& r) { return r.data_rate == protocol::DataRate::dr2; })
              .count() > 0);
  }
  const Duration heard_after = reports[0].at - at_s(kJamFrom + kJamFor);
  MESSAGE("jamming, " << rates_name(allowed_mask) << ": the hub hears the door "
                      << in_seconds(heard_after) << " s after the noise ends (bound "
                      << in_seconds(heard_again_within) << " s)");
  CHECK(heard_after < heard_again_within);
  CHECK(site.hub.decisions(HubAction::local_alarm_reported, "door").size() == 1);
  // A report that late sounds no siren (D106).
  CHECK(sounder(siren).empty());
}

TEST_CASE(
    "GW11 D82 DS6: jamming on the site channel is reported by the gateway, and an armed "
    "door opening during it sounds the sensor's own alarm (one data rate)") {
  // One sending rate (§2): the next retry after the noise gets through.
  jammed_opening(kOnlyDr5, kLateRetryGap);
}

TEST_CASE(
    "GW11 D82 DS6 LR4: the same on a site allowing DR5 and DR2: the fall-back comes round to "
    "the gateway's rate and the report gets through after the jamming" HSN_NOT_ON_REAL_HUB(
        "the protocol gives a site one data rate until O14 is settled, so the real hub has no "
        "site allowing DR5 and DR2")) {
  jammed_opening(kTwoRates, Duration{kLateRetryGap.us * kTriesToComeRound});
}

}  // namespace
}  // namespace hsn::test::system
