// Moving a whole site to another channel or sending rate with the real roles together (protocol
// section 7, "Changing the site's channel or rate"; section 6, the reply's next-setting fields and
// the siren settings' site channel; D115): every sensor confirms the announcement, the hub
// switches the gateway and the sirens, and every device is heard again on the new settings.

#include <algorithm>
#include <iomanip>
#include <sstream>

#include "hsn/device/services/radio_plan.hpp"
#include "system_site.hpp"

namespace hsn::test::system {
namespace {

using host::MoveStage;
using host::SiteMove;

/** Sensors and sirens on the moving site (the task's site; O11 capacity at DR5). */
constexpr std::size_t kSensors = 10;
constexpr std::size_t kSirens = 2;
/** The slow rate the site moves to, and the far channel, 868.5 MHz (§2). */
constexpr std::uint8_t kSlowRate = protocol::DataRate::dr2;
constexpr std::uint8_t kFarChannel = 2;
constexpr std::uint32_t kFarHz = 868500000;
/** The announcement starts after every sensor has had its Started answered and a heartbeat. */
constexpr std::int64_t kAnnounceAfterIntervals = 2;
/** How finely it looks whether the switch has come (it comes by itself, §7). */
constexpr Duration kSwitchPoll = milliseconds(250);
/** An unslotted heartbeat comes at the interval ±10% (§7 "Heartbeat slots"). */
constexpr std::int64_t kJitterPercent = 10;
/**
 * A reply that gives a sensor a new slot may put its next heartbeat up to one and a half
 * intervals away (§7 "Heartbeat slots": spread over the cycle, at least half an interval on).
 */
constexpr std::int64_t kReslotPercent = 150;
/**
 * Slack for one exchange: a channel check's waits (§2, at most 5 of 2 s), the packet's airtime at
 * the slow rate, and the link.
 */
constexpr Duration kExchangeSlack = seconds(11);
/** After the switch the hub holds back silence for four intervals (§7 †); the run lasts that. */
constexpr std::int64_t kFollowIntervals = 4;

/** The heartbeat interval with its jitter, as a sensor out of its slot sends. */
Duration jittered(Duration interval) {
  return Duration{interval.us * (100 + kJitterPercent) / 100};
}

/** A site at DR5: the load site's sensors and gateway, and `sirens` real sirens on Wi-Fi. */
struct MoveSite {
  explicit MoveSite(std::size_t sensors = kSensors, std::size_t sirens = kSirens,
                    std::size_t lora_only_sirens = 0)
      : load(protocol::DataRate::dr5, sensors), site(load.site) {
    for (std::size_t i = 0; i < sirens; ++i) {
      host::SirenConfig settings;
      // The last `lora_only_sirens` have no Wi-Fi: the hub reaches them over LoRa alone.
      settings.wifi = i + lora_only_sirens < sirens;
      siren_devices.push_back(&site.siren("siren" + std::to_string(i), settings));
    }
  }

  Duration interval() const {
    return heartbeat_interval(load.rate);
  }

  /**
   * Runs until the switch, which comes by itself once every sensor has confirmed (§7), or
   * `limit`; returns its instant, or never.
   */
  Instant run_to_switch(Instant limit) {
    while (site.hub.move_stage() == MoveStage::announcing && site.sim.now() < limit) {
      site.sim.run_for(kSwitchPoll);
    }
    return decided(HubAction::move_switched);
  }

  /** Runs until `count` sensors have confirmed, or `limit`. */
  void run_to_confirmations(std::size_t count, Instant limit) {
    while (site.hub.decisions(HubAction::move_confirmed).size() < count && site.sim.now() < limit) {
      site.sim.run_for(kSwitchPoll);
    }
  }

  /** The instant of the only decision of one kind, or never. */
  Instant decided(HubAction action, const std::string& device = "") const {
    const auto found = site.hub.decisions(action, device);
    return found.empty() ? Instant::never() : found.front().at;
  }

  LoadSite load;
  SystemSite& site;
  std::vector<host::SimDevice*> siren_devices;
};

/** The first transmission of a device on `frequency` at `rate` that the gateway heard, after
 * `from`. */
Instant first_heard_on(const MoveSite& s, const host::SimDevice& device, std::uint32_t frequency,
                       std::uint8_t rate, Instant from) {
  for (const Record& record : s.load.gateway.records().kind(RecordKind::reception).records()) {
    if (record.peer == device.actor() && record.frequency_hz == frequency &&
        record.data_rate == rate && record.at >= from) {
      return record.at;
    }
  }
  return Instant::never();
}

/** True when the device sent anything on `frequency` at `rate` at or after `from`. */
bool sent_on(const host::SimDevice& device, std::uint32_t frequency, std::uint8_t rate,
             Instant from) {
  return device.records()
             .kind(RecordKind::transmission)
             .between(from, Instant::never())
             .where([&](const Record& r) {
               return r.frequency_hz == frequency && r.data_rate == rate;
             })
             .count() > 0;
}

/** The bound on the announcement: one heartbeat for the reply, one for the confirmation (§7). */
Duration announce_bound(Duration interval) {
  return jittered(interval) + Duration{interval.us * kReslotPercent / 100} + kExchangeSlack;
}

/**
 * The bound on a sensor unheard after the switch: its first heartbeat on the old settings goes
 * unanswered, the next goes on the new ones (§7, "What a sensor does").
 */
Duration sensor_follow_bound(Duration interval) {
  return jittered(interval) + jittered(interval) + kExchangeSlack;
}

/**
 * The bound on a siren unheard on LoRa after the switch. It answers its settings' LoRa copy on
 * the new settings at once (§7 "Siren command", step 3), but the hub sends the sirens' copies
 * back to back and the gateway is deaf while it sends (§7 "Reply timing"), so every answer but
 * the last is lost; confirmed on Wi-Fi, nothing is repeated. Its 5-minute LoRa check (§7 "Siren
 * reports", §8) is then the next packet, wherever its random phase put it.
 */
constexpr Duration kSirenLoraCheck = seconds(5 * 60);
constexpr Duration kSirenFollowBound = kSirenLoraCheck + kExchangeSlack;

TEST_CASE(
    "D115 §7: ten sensors and two sirens move from DR5 to DR2: every sensor confirms, the hub "
    "switches, every device is heard on the new settings") {
  MoveSite s;
  SystemSite& site = s.site;
  const Instant announce_at = host::at(Duration{s.interval().us * kAnnounceAfterIntervals});
  site.run_until(announce_at);
  SiteMove move;
  move.send_data_rate = kSlowRate;
  site.hub.announce_move(move);
  const Instant switch_at = s.run_to_switch(announce_at + Duration{s.interval().us * 4});
  INFO(site.hub.dump());
  REQUIRE(switch_at != Instant::never());
  CHECK(site.hub.decisions(HubAction::move_confirmed).size() == kSensors);
  // The switch came by itself, with the last confirmation (§7, step 2).
  const Instant last_confirmation = site.hub.decisions(HubAction::move_confirmed).back().at;
  CHECK(switch_at == last_confirmation);
  site.run_until(switch_at + Duration{s.interval().us * kFollowIntervals});

  // Every device followed, and the move is done.
  CHECK(site.hub.decisions(HubAction::move_done).size() == 1);
  CHECK(site.hub.move_stage() == MoveStage::none);
  Duration sensor_longest;
  for (host::SimDevice* door : s.load.doors) {
    INFO(door->name());
    CHECK(site.hub.move_followed(door->name()));
    const Instant heard = first_heard_on(s, *door, kSiteHz, kSlowRate, switch_at);
    REQUIRE(heard != Instant::never());
    sensor_longest = std::max(sensor_longest, heard - switch_at);
    // Nothing on the old rate after it moved; nobody sounds; inside the legal hour.
    CHECK_FALSE(sent_on(*door, kSiteHz, protocol::DataRate::dr5, heard));
    CHECK(buzzer_times(*door, Sound::countdown).empty());
    CHECK(busiest_hour_on(*door, kSiteHz) <= kDeviceLegalHour);
    check_one_deep_sleep_per_wake(*door);
  }
  Duration siren_longest;
  for (host::SimDevice* siren : s.siren_devices) {
    INFO(siren->name());
    CHECK(site.hub.move_followed(siren->name()));
    const Instant heard = first_heard_on(s, *siren, kSiteHz, kSlowRate, switch_at);
    REQUIRE(heard != Instant::never());
    siren_longest = std::max(siren_longest, heard - switch_at);
    CHECK_FALSE(sent_on(*siren, kSiteHz, protocol::DataRate::dr5, heard));
  }
  // The gateway listens at the new rate from the switch on.
  const auto windows = s.load.gateway.records()
                           .kind(RecordKind::rx_window)
                           .between(switch_at, Instant::never())
                           .records();
  REQUIRE_FALSE(windows.empty());
  const Duration gateway_after = windows.front().at - switch_at;
  CHECK(windows.front().value == (1u << kSlowRate));
  CHECK(gateway_after <= kHubActsWithin + kLinkLatency + kLinkLatency);
  CHECK(busiest_hour_on(s.load.gateway, kHubHz) <= kGatewayLegalHour);

  const Duration announced = last_confirmation - announce_at;
  std::ostringstream line;
  line << std::fixed << std::setprecision(3) << "move DR5 to DR2: announcement "
       << in_seconds(announced) << " s (bound " << in_seconds(announce_bound(s.interval()))
       << " s); unheard after the switch, longest: sensors " << in_seconds(sensor_longest)
       << " s (bound " << in_seconds(sensor_follow_bound(s.interval())) << " s), sirens on LoRa "
       << in_seconds(siren_longest) << " s (bound " << in_seconds(kSirenFollowBound)
       << " s); gateway listening at DR2 " << in_seconds(gateway_after) << " s after it";
  MESSAGE(line.str());
  CHECK(announced <= announce_bound(s.interval()));
  CHECK(sensor_longest <= sensor_follow_bound(s.interval()));
  CHECK(siren_longest <= kSirenFollowBound);
  CHECK(check_hub_recorded_everything(site).checked > 0);
}

/**
 * Announces `move` at two intervals in and runs until every sensor has confirmed, or, when one
 * never does, the limit; returns when the switch came by itself (§7), or never.
 */
Instant announce_and_switch(MoveSite& s, const SiteMove& move) {
  s.site.run_until(host::at(Duration{s.interval().us * kAnnounceAfterIntervals}));
  s.site.hub.announce_move(move);
  return s.run_to_switch(s.site.sim.now() + Duration{s.interval().us * kFollowIntervals});
}

/** A sensor status packet's airtime at a rate (§2, "Time on air": 25 bytes). */
Duration status_airtime(std::uint8_t rate) {
  constexpr std::size_t kStatusBytes = 25;
  return device::time_on_air(rate, kStatusBytes).value_or(Duration{});
}

/** The first retry of a report comes about 2 s after the event, plus up to half that (§7, §8). */
constexpr Duration kFirstRetry = seconds(2);

TEST_CASE(
    "D115 §7 AL3: armed, a door opens a second after the switch: its retry on the new settings "
    "starts the countdown, and the sirens sound at its end on Wi-Fi and over LoRa") {
  MoveSite s;
  SystemSite& site = s.site;
  site.hub.arm();
  SiteMove move;
  move.send_data_rate = kSlowRate;
  const Instant switch_at = announce_and_switch(s, move);
  INFO(site.hub.dump());
  REQUIRE(switch_at != Instant::never());
  const Instant open_at = switch_at + seconds(1);
  host::SimDevice& door = *s.load.doors[0];
  door.set_input(Input::door, true, open_at);
  site.run_until(open_at + seconds(kCountdownSeconds + 30));

  // Its first try went on the old settings, unheard; the retry on the new ones was accepted.
  const auto tries = sent(door, type::door_changed);
  REQUIRE(tries.size() >= 2);
  CHECK(tries[0].data_rate == protocol::DataRate::dr5);
  CHECK(tries[1].data_rate == kSlowRate);
  const auto reports = site.hub.received_from(door.name(), type::door_changed);
  REQUIRE_FALSE(reports.empty());
  CHECK(reports[0].data_rate == kSlowRate);
  const Duration delay = reports[0].at - open_at;
  // The bound: boot, the first retry with its largest random extra, a status at the new rate,
  // the link (§7 "No reply from the hub"; "So ... a door report for about two seconds").
  const Duration bound = kBootTime + kFirstRetry + Duration{kFirstRetry.us / 2} +
                         status_airtime(kSlowRate) + kLinkLatency;
  MESSAGE("door opened 1 s after the switch: accepted " << in_seconds(delay) << " s after the "
                                                        << "opening (bound " << in_seconds(bound)
                                                        << " s)");
  CHECK(delay <= bound);
  const auto started = site.hub.decisions(HubAction::countdown_started, door.name());
  REQUIRE(started.size() == 1);
  CHECK(buzzer_times(door, Sound::countdown).size() == 1);
  const auto alarm = site.hub.decisions(HubAction::alarm, door.name());
  REQUIRE(alarm.size() == 1);
  for (host::SimDevice* siren : s.siren_devices) {
    INFO(siren->name());
    CHECK(sounding_from(*siren, alarm[0].at) - alarm[0].at <= kHubActsWithin + kLinkLatency);
    const auto commands = site.hub.sent_to(siren->name(), type::siren_command);
    REQUIRE(commands.size() >= 2);
    const std::uint32_t address = address_in(commands[0].packet);
    CHECK(siren->records()
              .kind(RecordKind::link_received)
              .type(type::siren_command)
              .between(alarm[0].at, Instant::never())
              .count() >= 1);
    const auto by_lora =
        siren->records()
            .kind(RecordKind::reception)
            .type(type::siren_command)
            .between(alarm[0].at, Instant::never())
            .where([address](const Record& r) { return r.label.address == address; })
            .records();
    REQUIRE_FALSE(by_lora.empty());
    // Its answer to the LoRa copy went on the new settings, and nothing on the old.
    CHECK(sent_on(*siren, kSiteHz, kSlowRate, by_lora[0].at));
    CHECK_FALSE(sent_on(*siren, kSiteHz, protocol::DataRate::dr5, switch_at));
  }
  // The gateway, on the new settings, heard the last siren's answer (the others' came while it
  // sent the next copy: see kSirenFollowBound).
  CHECK(first_heard_on(s, *s.siren_devices.back(), kSiteHz, kSlowRate, alarm[0].at) !=
        Instant::never());
}

/** A move on a small site; checks every device follows to `frequency` and `rate`. */
void small_move(const SiteMove& move, std::uint32_t frequency, std::uint8_t rate,
                std::uint32_t old_frequency, std::uint8_t old_rate) {
  constexpr std::size_t kFewSensors = 3;
  MoveSite s(kFewSensors, 1);
  SystemSite& site = s.site;
  const Instant switch_at = announce_and_switch(s, move);
  INFO(site.hub.dump());
  REQUIRE(switch_at != Instant::never());
  site.run_until(switch_at + Duration{s.interval().us * kFollowIntervals});
  CHECK(site.hub.decisions(HubAction::move_done).size() == 1);
  CHECK(site.hub.site_channel() == move.site_channel.value_or(1));
  std::vector<host::SimDevice*> devices = s.load.doors;
  devices.insert(devices.end(), s.siren_devices.begin(), s.siren_devices.end());
  for (host::SimDevice* device : devices) {
    INFO(device->name());
    CHECK(site.hub.move_followed(device->name()));
    const Instant heard = first_heard_on(s, *device, frequency, rate, switch_at);
    REQUIRE(heard != Instant::never());
    CHECK(heard - switch_at <= sensor_follow_bound(s.interval()));
    CHECK_FALSE(sent_on(*device, old_frequency, old_rate, heard));
  }
}

TEST_CASE("D115 §7: a channel-only move, 868.3 to 868.5 MHz at DR5") {
  SiteMove move;
  move.site_channel = kFarChannel;
  small_move(move, kFarHz, protocol::DataRate::dr5, kSiteHz, protocol::DataRate::dr5);
}

TEST_CASE("D115 §7: a rate-only move, DR5 to DR2 on 868.3 MHz") {
  SiteMove move;
  move.send_data_rate = kSlowRate;
  small_move(move, kSiteHz, kSlowRate, kSiteHz, protocol::DataRate::dr5);
}

TEST_CASE(
    "D115 §7: a sensor out of range through the announcement stops the switch until it is "
    "forced; it is named as left behind and the others follow") {
  MoveSite s;
  SystemSite& site = s.site;
  host::SimDevice& far = *s.load.doors.back();
  constexpr double kNormalLossDb = 100;
  const Instant announce_at = host::at(Duration{s.interval().us * kAnnounceAfterIntervals});
  site.sim.schedule(announce_at + Duration{-seconds(1).us},
                    [&]() { site.sim.medium().cut(far.station(), s.load.gateway.station()); });
  SiteMove move;
  move.send_data_rate = kSlowRate;
  // It never confirms, so the switch does not come by itself.
  CHECK(announce_and_switch(s, move) == Instant::never());
  INFO(site.hub.dump());
  CHECK(site.hub.move_unconfirmed() == std::vector<std::string>{far.name()});
  // The user's force without "--yes" names it; nothing switched.
  CHECK_FALSE(site.hub.switch_move());
  CHECK(site.hub.decisions(HubAction::move_unconfirmed, far.name()).size() == 1);
  CHECK(site.hub.decisions(HubAction::move_switched).empty());
  CHECK(site.hub.move_stage() == MoveStage::announcing);
  // Forced: named as left behind; back in range, it is still on the old rate and unheard.
  REQUIRE(site.hub.switch_move(true));
  const Instant switch_at = site.sim.now();
  CHECK(site.hub.decisions(HubAction::move_forced, far.name()).size() == 1);
  site.sim.medium().set_path_loss(far.station(), s.load.gateway.station(), kNormalLossDb);
  site.run_until(switch_at + Duration{s.interval().us * kFollowIntervals});
  CHECK(site.hub.decisions(HubAction::move_done).size() == 1);
  CHECK_FALSE(site.hub.move_followed(far.name()));
  CHECK(sent_on(far, kSiteHz, protocol::DataRate::dr5, switch_at));
  CHECK_FALSE(sent_on(far, kSiteHz, kSlowRate, switch_at));
  CHECK(site.hub.received_from(far.name()).back().at < switch_at);
  for (host::SimDevice* door : s.load.doors) {
    if (door != &far) {
      INFO(door->name());
      CHECK(site.hub.move_followed(door->name()));
    }
  }
}

TEST_CASE("D115 §7: a move cancelled before the switch changes nothing and disturbs no sensor") {
  MoveSite s;
  SystemSite& site = s.site;
  SiteMove move;
  move.send_data_rate = kSlowRate;
  const Instant announce_at = host::at(Duration{s.interval().us * kAnnounceAfterIntervals});
  site.run_until(announce_at);
  site.hub.announce_move(move);
  // Half the sensors have heard the announcement by then.
  site.run_until(announce_at + Duration{s.interval().us / 2});
  site.hub.cancel_move();
  const Instant cancel_at = site.sim.now();
  const Instant end = cancel_at + Duration{s.interval().us * kFollowIntervals};
  site.run_until(end);
  INFO(site.hub.dump());
  CHECK(site.hub.decisions(HubAction::move_cancelled).size() == 1);
  CHECK(site.hub.decisions(HubAction::move_switched).empty());
  CHECK(site.hub.move_stage() == MoveStage::none);
  CHECK(site.hub.site_channel() == 1);
  // The gateway never left DR5, no device sent on the next settings, nobody sounded or went
  // silent.
  CHECK(s.load.gateway.records()
            .kind(RecordKind::rx_window)
            .where([](const Record& r) { return r.value != (1u << protocol::DataRate::dr5); })
            .empty());
  for (host::SimDevice* door : s.load.doors) {
    INFO(door->name());
    CHECK_FALSE(sent_on(*door, kSiteHz, kSlowRate, Instant{}));
    CHECK(buzzer(*door).size() <= 1);
    const auto accepted = site.hub.received_from(door->name());
    for (std::size_t i = 1; i < accepted.size(); ++i) {
      CHECK(accepted[i].at - accepted[i - 1].at < Duration{s.interval().us * 3});
    }
    CHECK(end - accepted.back().at < Duration{s.interval().us * 3});
  }
  for (host::SimDevice* siren : s.siren_devices) {
    CHECK_FALSE(sent_on(*siren, kSiteHz, kSlowRate, Instant{}));
  }
}

TEST_CASE("D115 §7: a switch due during a countdown waits for it to end") {
  MoveSite s;
  SystemSite& site = s.site;
  site.hub.arm();
  SiteMove move;
  move.send_data_rate = kSlowRate;
  site.run_until(host::at(Duration{s.interval().us * kAnnounceAfterIntervals}));
  site.hub.announce_move(move);
  // All but one have confirmed; a door that has opens, and the last confirms during its countdown.
  s.run_to_confirmations(kSensors - 1, site.sim.now() + Duration{s.interval().us * 3});
  INFO(site.hub.dump());
  const auto confirmed = site.hub.decisions(HubAction::move_confirmed);
  REQUIRE(confirmed.size() == kSensors - 1);
  host::SimDevice* door = nullptr;
  for (host::SimDevice* candidate : s.load.doors) {
    door = candidate->name() == confirmed.front().device ? candidate : door;
  }
  REQUIRE(door != nullptr);
  const Instant open_at = site.sim.now() + seconds(1);
  door->set_input(Input::door, true, open_at);
  s.run_to_confirmations(kSensors, open_at + seconds(kCountdownSeconds - 2));
  REQUIRE(site.hub.decisions(HubAction::move_confirmed).size() == kSensors);
  const Instant due_at = site.hub.decisions(HubAction::move_confirmed).back().at;
  REQUIRE(site.hub.countdown_running(door->name()));
  // Due, it waits: nothing switched.
  const auto waiting = site.hub.decisions(HubAction::move_switch_waiting);
  REQUIRE(waiting.size() == 1);
  CHECK(waiting[0].at == due_at);
  CHECK(site.hub.move_stage() == MoveStage::announcing);
  const Instant disarm_at = site.sim.now() + seconds(1);
  site.sim.schedule(disarm_at, [&]() { site.hub.disarm(); });
  site.run_until(disarm_at + Duration{s.interval().us * kFollowIntervals});
  // The switch went when the countdown ended, at the disarm, and not before.
  const auto switched = site.hub.decisions(HubAction::move_switched);
  REQUIRE(switched.size() == 1);
  CHECK(switched[0].at == disarm_at);
  CHECK(s.load.gateway.records()
            .kind(RecordKind::rx_window)
            .between(Instant{}, disarm_at)
            .where([](const Record& r) { return r.value == (1u << kSlowRate); })
            .empty());
  // The disarmed notice reached the buzzing sensor on the old settings, then everyone followed.
  CHECK(buzzer_times(*door, Sound::off).back() < disarm_at + seconds(5));
  CHECK(site.hub.decisions(HubAction::move_done).size() == 1);
  CHECK(site.hub.decisions(HubAction::alarm).empty());
}

TEST_CASE(
    "D115 §7: the gateway restarts between the announcement and the switch, a sensor loses "
    "power just after the switch: the move still completes") {
  MoveSite s;
  SystemSite& site = s.site;
  SiteMove move;
  move.send_data_rate = kSlowRate;
  const Instant announce_at = host::at(Duration{s.interval().us * kAnnounceAfterIntervals});
  s.load.gateway.restart(announce_at + seconds(60));
  const Instant switch_at = announce_and_switch(s, move);
  INFO(site.hub.dump());
  REQUIRE(switch_at != Instant::never());
  REQUIRE(site.hub.decisions(HubAction::gateway_welcomed, "gateway").size() == 2);
  host::SimDevice& lost = *s.load.doors[3];
  lost.power_loss(switch_at + seconds(1));
  site.run_until(switch_at + Duration{s.interval().us * kFollowIntervals});
  CHECK(site.hub.decisions(HubAction::move_done).size() == 1);
  for (host::SimDevice* door : s.load.doors) {
    INFO(door->name());
    CHECK(site.hub.move_followed(door->name()));
    const Instant heard = first_heard_on(s, *door, kSiteHz, kSlowRate, switch_at);
    REQUIRE(heard != Instant::never());
    CHECK(heard - switch_at <= sensor_follow_bound(s.interval()));
  }
  // The sensor that lost power came back holding the next settings from flash, and followed.
  const auto started = site.hub.received_from(lost.name(), type::started);
  REQUIRE(started.size() == 2);
  CHECK(started[1].data_rate == kSlowRate);
  for (host::SimDevice* siren : s.siren_devices) {
    CHECK(site.hub.move_followed(siren->name()));
  }
}

}  // namespace
}  // namespace hsn::test::system
