// D, E, F: load with the real roles (design section 8 "System tests"; protocol §2 "Airtime
// budgets", §7 "Heartbeat slots", "Reply timing and a busy gateway", "Siren command"; D52, D72,
// D95, D107, D108, D110, D111; the gateway load spike). Real sensors follow the hub's heartbeat
// slots and listen for faster replies; the gateway is the real role. Long cases are in the test
// suite "long".

#include <algorithm>
#include <iomanip>
#include <map>
#include <memory>
#include <random>
#include <set>
#include <sstream>

#include "hsn/device/services/radio_plan.hpp"
#include "system_site.hpp"

namespace hsn::test::system {
namespace {

using roles::gateway::GatewayRole;

/**
 * A sensor counts as silent after 3 missed heartbeats at the least (D52, D107; "silent after 9
 * minutes" at a 3-minute interval): the hub must never go three heartbeat intervals without a
 * packet from it.
 */
constexpr std::int64_t kMissedBeforeSilent = 3;
/** Event listen time by sending rate, DR0 to DR5, ms (§8 †, the sensor's and hub's value). */
constexpr std::array<std::uint16_t, 6> kEventListenMs = roles::sensor::kEventListenMs;
/** A sensor saves its counter's resume point every 64 packets (§4 "Sending"). */
constexpr std::size_t kResumeStep = 64;
/**
 * Flash writes a sensor makes beside those resume points over a day: the first resume point at
 * its first packet and the settings once (design section 5, "Settings held": when a stored field
 * changes).
 */
constexpr std::size_t kFlashWritesBesideResume = 2;
/** Seeds the door moments, varied per case; fixed, so every run is the same. */
constexpr std::uint32_t kDoorSeed = 0x5EED;

/** The change count wraps at 256 (§6): a count at most half the range ahead includes a change. */
constexpr std::uint8_t kCountHalfRange = 128;
/** A report's retries run for 10 minutes (§7, §8). */
constexpr Duration kRetryRun = seconds(10 * 60);
/** An unslotted heartbeat comes at the interval ±10% (§7 "Heartbeat slots"). */
constexpr std::int64_t kJitterPercent = 10;

/**
 * The latest a change is covered: within the retry run, or, if every try failed, by the change
 * count in the next heartbeat after it (§7 "No reply from the hub").
 */
Duration cover_bound(std::uint8_t data_rate) {
  return kRetryRun + Duration{heartbeat_interval(data_rate).us * (100 + kJitterPercent) / 100};
}

/** What a load case measured. */
struct LoadFigures {
  std::size_t sent = 0;
  std::size_t heard = 0;
  std::size_t forwarded = 0;
  /** Heard, not forwarded, and not logged to the hub either: lost unseen. */
  std::size_t heard_not_recorded = 0;
  /** Heard, not forwarded, and logged to the hub by the gateway. */
  std::size_t lost_and_logged = 0;
  std::size_t door_changes = 0;
  std::size_t first_try_answered = 0;
  /** Changes no later accepted status covers by its change count. */
  std::size_t changes_uncovered = 0;
  /** Doors whose last accepted status is not their true state and count. */
  std::size_t final_state_wrong = 0;
  /** The longest from a change to the first accepted status covering it. */
  Duration longest_cover_delay;
  Duration longest_report_delay;
  std::uint8_t queue_highest = 0;
  std::uint32_t queue_full = 0;
  std::uint32_t displaced = 0;
  /** Transmit results by outcome: sent, too late, no airtime, radio busy, not valid (§6). */
  std::array<std::size_t, 5> results{};
  std::size_t most_flash_writes = 0;
  double mean_flash_writes = 0;
  /** Sensors that wrote flash more than their resume points and settings explain. */
  std::size_t over_flash_budget = 0;
  Duration busiest_sensor_hour;
  Duration busiest_gateway_hour;
  /** The longest gap between two packets the hub accepted from one sensor, in intervals. */
  double longest_gap_intervals = 0;
  /** Where it was: the sensor and the last packet before it. */
  std::string longest_gap_device;
  Instant longest_gap_from;
  std::size_t sounding_sensors = 0;
};

/** Measures a load run from the timeline and the hub's records. */
LoadFigures measure(LoadSite& load) {
  SystemSite& site = load.site;
  LoadFigures figures;
  std::set<std::pair<std::string, std::uint32_t>> recorded;
  for (const host::HubPacket& packet : site.hub.received()) {
    recorded.emplace(packet.from, packet.counter);
  }
  for (const Record& record : load.gateway.records().kind(RecordKind::reception).records()) {
    if (record.frequency_hz != kSiteHz) {
      continue;
    }
    figures.heard += 1;
    const auto key =
        std::make_pair(site.sim.timeline().actor_name(record.peer), record.label.counter);
    if (recorded.count(key) == 0) {
      const bool logged = hub_told_of_loss(site.hub, load.gateway.name(), record.at);
      figures.lost_and_logged += logged ? 1u : 0u;
      figures.heard_not_recorded += logged ? 0u : 1u;
    }
  }
  figures.forwarded = site.hub.received_from("gateway", type::forwarded_packet).size();
  const GatewayRole& gateway = load.gateway.role<GatewayRole>();
  figures.queue_highest = gateway.counts().queue_highest;
  figures.queue_full = gateway.counts().queue_full;
  figures.displaced = gateway.counts().displaced;
  for (const host::HubDecision& result : site.hub.decisions(HubAction::transmit_result)) {
    if (result.value >= 0 && static_cast<std::size_t>(result.value) < figures.results.size()) {
      figures.results[static_cast<std::size_t>(result.value)] += 1;
    }
  }
  figures.busiest_gateway_hour = busiest_hour_on(load.gateway, kHubHz);

  const Duration listen = milliseconds(kEventListenMs[load.rate]);
  const Duration interval = heartbeat_interval(load.rate);
  std::size_t flash_total = 0;
  for (host::SimDevice* door : load.doors) {
    const auto transmissions = sent(*door);
    figures.sent += transmissions.size();
    figures.busiest_sensor_hour =
        std::max(figures.busiest_sensor_hour, busiest_hour_on(*door, kSiteHz));
    const std::size_t writes = door->records().kind(RecordKind::flash_write).count();
    flash_total += writes;
    figures.over_flash_budget +=
        writes > transmissions.size() / kResumeStep + kFlashWritesBesideResume ? 1u : 0u;
    figures.most_flash_writes = std::max(figures.most_flash_writes, writes);
    for (const auto& change : buzzer(*door)) {
      if (change.second != Sound::off) {
        figures.sounding_sensors += 1;
        break;
      }
    }
    // Silence: the longest gap between packets the hub accepted, after the first.
    const auto accepted = site.hub.received_from(door->name());
    for (std::size_t i = 1; i < accepted.size(); ++i) {
      const double gap = static_cast<double>((accepted[i].at - accepted[i - 1].at).us) /
                         static_cast<double>(interval.us);
      if (gap > figures.longest_gap_intervals) {
        figures.longest_gap_intervals = gap;
        figures.longest_gap_device = door->name();
        figures.longest_gap_from = accepted[i - 1].at;
      }
    }
    if (!accepted.empty()) {
      const double tail = static_cast<double>((site.sim.now() - accepted.back().at).us) /
                          static_cast<double>(interval.us);
      figures.longest_gap_intervals = std::max(figures.longest_gap_intervals, tail);
    }
    // Door changes: the first try's answer, and the delay to the hub accepting a report.
    const auto changes = door->records()
                             .kind(RecordKind::input)
                             .where([](const Record& r) {
                               return r.value == static_cast<std::uint32_t>(Input::door);
                             })
                             .records();
    const auto reports = site.hub.received_from(door->name(), type::door_changed);
    const auto tries = sent(*door, type::door_changed);
    const auto replies = heard(*door, type::reply);
    // What the hub holds: every status packet it accepted, with the door's change count (§6).
    std::vector<std::pair<Instant, protocol::SensorStatus>> statuses;
    for (const host::HubPacket& packet : accepted) {
      if (packet.type == type::heartbeat) {
        statuses.emplace_back(packet.at, packet.as<protocol::Heartbeat>());
      } else if (packet.type == type::door_changed) {
        statuses.emplace_back(packet.at, packet.as<protocol::DoorChanged>());
      }
    }
    // The count before the first change, from the last status the hub had before it.
    std::uint8_t count_before = 0;
    bool known_before = false;
    for (const auto& status : statuses) {
      if (!changes.empty() && status.first < changes[0].at) {
        count_before = status.second.door_change_count;
        known_before = true;
      }
    }
    figures.changes_uncovered += !changes.empty() && !known_before ? 1u : 0u;
    for (std::size_t k = 0; k < changes.size(); ++k) {
      figures.door_changes += 1;
      const Instant from = changes[k].at;
      const Instant until = k + 1 < changes.size() ? changes[k + 1].at : Instant::never();
      // Measured as before: the first door report the hub accepted before the next change.
      const auto report =
          std::find_if(reports.begin(), reports.end(),
                       [&](const host::HubPacket& p) { return p.at >= from && p.at < until; });
      if (report != reports.end()) {
        figures.longest_report_delay = std::max(figures.longest_report_delay, report->at - from);
      }
      // What the protocol promises: a later accepted status whose change count includes this
      // change (DS3: the newest state goes; §7: the count tells the hub what it missed).
      const auto count = static_cast<std::uint8_t>(count_before + k + 1);
      const auto covering = std::find_if(statuses.begin(), statuses.end(), [&](const auto& st) {
        return st.first >= from &&
               static_cast<std::uint8_t>(st.second.door_change_count - count) < kCountHalfRange;
      });
      if (covering == statuses.end()) {
        figures.changes_uncovered += 1;
      } else {
        figures.longest_cover_delay = std::max(figures.longest_cover_delay, covering->first - from);
      }
      const auto first =
          std::find_if(tries.begin(), tries.end(), [&](const Record& r) { return r.at >= from; });
      if (first != tries.end() && first->at < until) {
        const Instant listened_until = first->until + listen;
        figures.first_try_answered +=
            std::any_of(
                replies.begin(), replies.end(),
                [&](const Record& r) { return r.at > first->until && r.at <= listened_until; })
                ? 1u
                : 0u;
      }
    }
    // After the last change the hub holds the door's true state and change count.
    if (!changes.empty() && !statuses.empty()) {
      const protocol::SensorStatus& last = statuses.back().second;
      const bool right =
          statuses.back().first >= changes.back().at &&
          last.flags.door_open == changes.back().flag &&
          last.door_change_count == static_cast<std::uint8_t>(count_before + changes.size());
      figures.final_state_wrong += right ? 0u : 1u;
    }
  }
  figures.mean_flash_writes =
      static_cast<double>(flash_total) / static_cast<double>(load.doors.size());
  return figures;
}

/** One line of the load table. */
std::string describe(const std::string& name, const LoadFigures& f, std::int64_t span_seconds) {
  std::ostringstream line;
  const double sent = static_cast<double>(f.sent);
  line << std::fixed << std::setprecision(1) << name << ", " << span_seconds / 3600 << " h: sent "
       << f.sent << ", heard " << f.heard << ", forwarded " << f.forwarded << " (lost but logged "
       << f.lost_and_logged << ")" << ", lost on the air "
       << (sent == 0 ? 0.0 : 100.0 * (sent - static_cast<double>(f.heard)) / sent)
       << "%, door reports answered first try "
       << (f.door_changes == 0 ? 0.0
                               : 100.0 * static_cast<double>(f.first_try_answered) /
                                     static_cast<double>(f.door_changes))
       << "% of " << f.door_changes << ", longest change to accepted "
       << in_seconds(f.longest_report_delay) << " s, to covered "
       << in_seconds(f.longest_cover_delay) << " s, uncovered " << f.changes_uncovered
       << ", final state wrong " << f.final_state_wrong << ", queue highest "
       << static_cast<int>(f.queue_highest) << ", results sent/late/no-air/busy/invalid "
       << f.results[0] << "/" << f.results[1] << "/" << f.results[2] << "/" << f.results[3] << "/"
       << f.results[4] << ", flash writes per sensor " << f.mean_flash_writes << " mean, "
       << f.most_flash_writes << " most, busiest hour sensor " << in_seconds(f.busiest_sensor_hour)
       << " s, gateway " << in_seconds(f.busiest_gateway_hour) << " s, longest silence "
       << std::setprecision(2) << f.longest_gap_intervals << " intervals (" << f.longest_gap_device
       << " from " << in_seconds(f.longest_gap_from - host::at(Duration{})) << " s)";
  return line.str();
}

/** D: a disarmed site under everyday load, checked and measured. */
void everyday_load(std::size_t sensors, std::uint8_t data_rate, std::int64_t span_seconds) {
  LoadSite load(data_rate, sensors);
  load.random_doors(span_seconds, kDoorSeed + static_cast<std::uint32_t>(sensors * 8 + data_rate));
  load.site.run_until(at_s(span_seconds));
  const LoadFigures figures = measure(load);
  const std::string line = describe(
      std::to_string(sensors) + " sensors DR" + std::to_string(data_rate), figures, span_seconds);
  MESSAGE(line);
  INFO(line);

  // Every packet the gateway heard reached the hub, and the hub accepted each forward (D110).
  CHECK(figures.heard > 0);
  CHECK(figures.heard_not_recorded == 0);
  CHECK(figures.forwarded + figures.lost_and_logged == figures.heard);
  // Disarmed: no sensor ever sounded.
  CHECK(figures.sounding_sensors == 0);
  // The hub never had cause to count a sensor silent (D52, D107).
  CHECK(figures.longest_gap_intervals < static_cast<double>(kMissedBeforeSilent));
  // Every device inside its legal hour (§2): sensors on the site channel, the gateway on
  // 869.525 MHz.
  CHECK(figures.busiest_sensor_hour <= kDeviceLegalHour);
  CHECK(figures.busiest_gateway_hour <= kGatewayLegalHour);
  // Every door change reached the hub: covered by an accepted status whose change count includes
  // it, at the latest by the next heartbeat after a failed retry run (§7 "No reply from the
  // hub"); and the hub ends holding every door's true state and count.
  CHECK(figures.changes_uncovered == 0);
  CHECK(figures.longest_cover_delay <= cover_bound(data_rate));
  CHECK(figures.final_state_wrong == 0);
  // The gateway refused no request for want of room (§6, D110). "Radio busy" for a heartbeat
  // reply whose moment found the radio receiving is the skip §7 asks for, and is not counted.
  CHECK(figures.queue_full == 0);
  CHECK(figures.displaced == 0);
  // Flash only for the resume points and the settings (design section 5).
  CHECK(figures.over_flash_budget == 0);
  // Exactly one deep sleep per wake (design section 6).
  for (host::SimDevice* door : load.doors) {
    check_one_deep_sleep_per_wake(*door);
  }
}

/** Airtime of a packet of `bytes` at `data_rate` (§2, "Time on air"). */
Duration airtime(std::uint8_t data_rate, std::size_t bytes) {
  return device::time_on_air(data_rate, bytes).value_or(Duration{});
}

/**
 * Radio packet sizes from §2's table: a sensor status, a siren command, a hub reply, and the
 * longest (a log entry).
 */
constexpr std::size_t kStatusBytes = 25;
constexpr std::size_t kSirenCommandBytes = 21;
constexpr std::size_t kReplyBytes = 30;
constexpr std::size_t kLongestRadioBytes = 50;

/** E: sensors whose doors open within one second. */
constexpr std::size_t kBurstSensors = 30;
/** E: the doors open within this long of each other. */
constexpr Duration kBurstSpread = seconds(1);

/**
 * E: 30 doors open within a second while armed, with `siren_count` real sirens on Wi-Fi; nobody
 * disarms until the alarm has sounded for a minute.
 */
void alarm_burst(std::size_t siren_count) {
  const std::uint8_t rate = protocol::DataRate::dr5;
  LoadSite load(rate, kBurstSensors);
  SystemSite& site = load.site;
  std::vector<host::SimDevice*> sirens;
  for (std::size_t i = 0; i < siren_count; ++i) {
    sirens.push_back(&site.siren("siren" + std::to_string(i)));
  }
  // After every sensor's start-up and first slotted heartbeat.
  const Instant burst = host::at(heartbeat_interval(rate) + heartbeat_interval(rate) + seconds(40));
  site.sim.schedule(burst + Duration{-seconds(60).us}, [&]() { site.hub.arm(); });
  std::mt19937 random(kDoorSeed);
  for (host::SimDevice* door : load.doors) {
    door->set_input(Input::door, true, burst + microseconds(draw(random, 0, kBurstSpread.us)));
  }
  const Instant disarm_at = burst + seconds(90);
  site.sim.schedule(disarm_at, [&]() { site.hub.disarm(); });
  // Long enough for every local alarm to be told "not armed" by a retry (§7).
  const Instant end = disarm_at + seconds(180);
  site.run_until(end);
  INFO(site.hub.dump());

  // Every sensor buzzed for a countdown: the hub's, or its own when its first try was lost.
  std::size_t buzzed = 0;
  std::size_t own_alarms = 0;
  for (host::SimDevice* door : load.doors) {
    const auto countdown = buzzer_times(*door, Sound::countdown);
    buzzed += !countdown.empty() && countdown[0] >= burst ? 1u : 0u;
    own_alarms += buzzer_times(*door, Sound::alarm).empty() ? 0u : 1u;
  }
  CHECK(buzzed == kBurstSensors);
  MESSAGE(
      "burst: "
      << site.hub.decisions(HubAction::countdown_started).size() << " countdowns started, "
      << own_alarms << " sensors sounded their own alarm, last report accepted +"
      << in_seconds(site.hub.received_from(load.doors.back()->name(), type::door_changed).at(0).at -
                    burst)
      << " s for the last sensor");
  const auto alarms = site.hub.decisions(HubAction::alarm);
  REQUIRE_FALSE(alarms.empty());
  const Instant first_end = alarms[0].at;

  // Every siren sounding within a bound of the first countdown's end. On Wi-Fi: one link
  // latency. On LoRa, through the gateway, which may be receiving the longest packet and sending
  // a reply when the commands arrive, then sends every siren's command first (§7 "Reply timing
  // and a busy gateway").
  const Duration wifi_bound = kLinkLatency;
  const Duration lora_bound =
      kLinkLatency + airtime(rate, kLongestRadioBytes) + airtime(rate, kReplyBytes) +
      Duration{airtime(rate, kSirenCommandBytes).us * static_cast<std::int64_t>(siren_count)};
  std::ostringstream timings;
  timings << std::fixed << std::setprecision(3) << "burst, " << siren_count
          << " sirens: first countdown end " << in_seconds(first_end - host::at(Duration{}))
          << " s; bounds Wi-Fi " << in_seconds(wifi_bound) << " s, LoRa " << in_seconds(lora_bound)
          << " s;";
  for (host::SimDevice* siren : sirens) {
    INFO(siren->name());
    const Instant on = sounding_from(*siren, first_end);
    const std::uint32_t address =
        address_in(site.hub.sent_to(siren->name(), type::siren_command).at(0).packet);
    const auto by_lora =
        siren->records()
            .kind(RecordKind::reception)
            .type(type::siren_command)
            .where([&](const Record& r) { return r.label.address == address && r.at >= first_end; })
            .records();
    REQUIRE(on != Instant::never());
    REQUIRE_FALSE(by_lora.empty());
    timings << " " << siren->name() << " sounding +" << in_seconds(on - first_end)
            << " s, LoRa copy +" << in_seconds(by_lora[0].at - first_end) << " s;";
    CHECK(on - first_end <= wifi_bound);
    CHECK(by_lora[0].at - first_end <= lora_bound);
    // One sound command per siren for the whole alarm (D95), then the disarm's off.
    CHECK(site.hub.decisions(HubAction::siren_command, siren->name()).size() == 2);
    CHECK_FALSE(sounding_at(*siren, end));
    const auto changes = sounder(*siren);
    REQUIRE_FALSE(changes.empty());
    CHECK(changes.back().first - disarm_at <= kLinkLatency);
  }
  MESSAGE(timings.str());

  // The gateway's queue stayed within its size and refused nothing (§6, D110).
  const auto& counts = load.gateway.role<GatewayRole>().counts();
  MESSAGE("burst, " << siren_count << " sirens: gateway queue highest "
                    << static_cast<int>(counts.queue_highest) << " of "
                    << roles::gateway::kTransmitQueueSize);
  CHECK(counts.queue_highest <= roles::gateway::kTransmitQueueSize);
  CHECK(counts.queue_full == 0);
  CHECK(counts.displaced == 0);
  // The disarm stopped everything: no buzzer sounding, every sensor in deep sleep again.
  for (host::SimDevice* door : load.doors) {
    INFO(door->name());
    const auto changes = buzzer(*door);
    REQUIRE_FALSE(changes.empty());
    CHECK(changes.back().second == Sound::off);
    CHECK(door->state() == host::PowerState::deep_sleep);
    check_one_deep_sleep_per_wake(*door);
  }
}

TEST_CASE(
    "D95 D110 §7: 30 doors open within a second while armed: every sensor buzzes, 4 real "
    "sirens sound at the first countdown's end, the gateway refuses nothing, a disarm stops "
    "everything") {
  alarm_burst(4);
}

TEST_CASE("D95 D110 §7: the same burst with 8 real sirens") {
  alarm_burst(8);
}

/** Recovery: the gateway is off this long, after every sensor has taken its slot. */
constexpr Duration kOutage = seconds(20 * 60);
/**
 * From the gateway's power coming back to it forwarding: its boot, hello, welcome and settings
 * over two link latencies, with room to spare (§7 "Gateway connection").
 */
constexpr Duration kGatewayBackWithin = seconds(1);

TEST_CASE(
    "§7 Data rate, D52 D107: 10 sensors at DR5, the gateway off for 20 minutes and back: every "
    "sensor is heard again within one heartbeat, none sounds, all inside their airtime") {
  const std::uint8_t rate = protocol::DataRate::dr5;
  constexpr std::size_t kSensors = 10;
  LoadSite load(rate, kSensors);
  SystemSite& site = load.site;
  const Duration interval = heartbeat_interval(rate);
  const Instant off_at = at_s(3600);
  const Instant back_at = off_at + kOutage;
  const Instant end = back_at + seconds(3600);
  load.gateway.power_loss(off_at, kOutage);
  site.run_until(end);

  // Every heartbeat asks for a reply while the sensor is out of touch (§7 "Data rate"), and any
  // packet is heard, so each sensor is heard at its next heartbeat after the return: at most
  // one interval with its jitter, plus the gateway's reconnection.
  const Duration bound = Duration{interval.us * (100 + kJitterPercent) / 100} + kGatewayBackWithin;
  Duration longest;
  for (host::SimDevice* door : load.doors) {
    INFO(door->name());
    const auto accepted = site.hub.received_from(door->name());
    const auto first = std::find_if(accepted.begin(), accepted.end(),
                                    [&](const host::HubPacket& p) { return p.at >= back_at; });
    REQUIRE(first != accepted.end());
    const Duration heard_after = first->at - back_at;
    longest = std::max(longest, heard_after);
    CHECK(heard_after <= bound);
    // Back in touch: answered after the return, and never silent from then on (D52, D107).
    const auto replies = heard(*door, type::reply);
    CHECK((!replies.empty() && replies.back().at > back_at));
    for (auto it = first + 1; it != accepted.end(); ++it) {
      CHECK(it->at - (it - 1)->at < Duration{interval.us * kMissedBeforeSilent});
    }
    CHECK(end - accepted.back().at < Duration{interval.us * kMissedBeforeSilent});
    CHECK(buzzer_times(*door, Sound::countdown).empty());
    CHECK(buzzer_times(*door, Sound::alarm).empty());
    CHECK(busiest_hour_on(*door, kSiteHz) <= kDeviceLegalHour);
    check_one_deep_sleep_per_wake(*door);
  }
  MESSAGE("recovery: every sensor heard again within "
          << in_seconds(longest) << " s of the gateway's return (bound " << in_seconds(bound)
          << " s)");
}

/** F: the faulty door changes this often (D111, §2 "Airtime budgets"). */
constexpr Duration kFaultyEvery = seconds(2);
/** F: for this long before the system is armed. */
constexpr Duration kFaultyFor = seconds(3600);
/**
 * Past its legal hour a device waits nine times a packet's airtime after its last one, so it is
 * on air at most a tenth of the rest of the hour (§2, D111).
 */
constexpr std::int64_t kPastLimitShare = 10;

TEST_CASE(
    "D111 §2: a door changing every 2 s for an hour at DR0 does not block another: its "
    "report reaches the hub and its countdown starts") {
  const std::uint8_t rate = protocol::DataRate::dr0;
  LoadSite load(rate, 2);
  SystemSite& site = load.site;
  host::SimDevice& faulty = *load.doors[0];
  host::SimDevice& door = *load.doors[1];
  const Instant from = host::at(heartbeat_interval(rate) + heartbeat_interval(rate));
  const Instant arm_at = from + kFaultyFor;
  const Instant open_at = arm_at + seconds(60);
  const Instant end = open_at + seconds(2 * kCountdownSeconds);
  bool level = false;
  for (Instant t = from; t < end; t = t + kFaultyEvery) {
    level = !level;
    faulty.set_input(Input::door, level, t);
  }
  site.sim.schedule(arm_at, [&]() { site.hub.arm(); });
  door.set_input(Input::door, true, open_at);
  site.run_until(end);
  INFO(site.hub.dump());

  // The faulty sensor went past its legal hour and was held to about a tenth after it.
  const Duration faulty_hour = busiest_hour_on(faulty, kSiteHz);
  const Duration past_limit_bound =
      kDeviceLegalHour + Duration{(seconds(3600) - kDeviceLegalHour).us / kPastLimitShare} +
      airtime(rate, kReplyBytes);
  // The other door's report reached the hub and its countdown started.
  const auto started = site.hub.decisions(HubAction::countdown_started, door.name());
  REQUIRE(started.size() == 1);
  const Duration delay = started[0].at - open_at;
  // A justified bound: the first try waits at most 5 busy channel checks of 2 s (§2 "Listening
  // before sending"), is on air for a status packet's time at SF12, and reaches the hub after
  // one link latency.
  constexpr std::int64_t kBusyChecks = 5;
  const Duration bound = kBootTime + Duration{seconds(2).us * kBusyChecks} +
                         airtime(rate, kStatusBytes) + kLinkLatency;
  MESSAGE("faulty door: busiest hour "
          << in_seconds(faulty_hour) << " s (bound " << in_seconds(past_limit_bound)
          << " s); other door opening to countdown " << in_seconds(delay) << " s (bound "
          << in_seconds(bound) << " s), tries " << sent(door, type::door_changed).size());
  CHECK(faulty_hour > kDeviceLegalHour);
  CHECK(faulty_hour <= past_limit_bound);
  CHECK(delay <= bound);
  CHECK(buzzer_times(door, Sound::countdown).size() == 1);
}

TEST_SUITE("long") {
  TEST_CASE(
      "D108 D110 D52: 10 sensors at DR5, disarmed, a day: everything heard reaches the hub, "
      "nobody silent, every device inside its airtime") {
    everyday_load(10, protocol::DataRate::dr5, kDay);
  }

  TEST_CASE("D108 D110 D52: 30 sensors at DR5, disarmed, a day") {
    everyday_load(30, protocol::DataRate::dr5, kDay);
  }

  TEST_CASE("D108 D110 D52: 10 sensors at DR2, disarmed, a day") {
    everyday_load(10, protocol::DataRate::dr2, kDay);
  }

  // Once caught heartbeat replies at SF9 and slower going unheard, with neighbours lost to them.
  TEST_CASE("D108 D110 D52: 5 sensors at DR0, disarmed, a day") {
    everyday_load(5, protocol::DataRate::dr0, kDay);
  }

  // Once caught the same.
  TEST_CASE("D108 D110 D52: 10 sensors at DR0, disarmed, a day") {
    everyday_load(10, protocol::DataRate::dr0, kDay);
  }
}

}  // namespace
}  // namespace hsn::test::system
