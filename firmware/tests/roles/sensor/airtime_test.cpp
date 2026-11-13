// Airtime past the legal hour (protocol section 2, "Airtime budgets"; D111, LR5): urgent reports
// still go once the device has used its whole hour, each after a gap of nine times its airtime
// since the last transmission, and each is logged; regular traffic (heartbeats, log entries) stays
// inside four fifths of the hour and resumes when the hour is back inside it. A chattering door
// can then take at most a tenth of the channel.

#include <algorithm>
#include <cstdint>
#include <vector>

#include "hsn/device/services/radio_plan.hpp"
#include "sensor_bench.hpp"

namespace hsn::test::sensor {
namespace {

/** A site that allows DR5, DR2 and DR0. */
host::HubOptions slow_site() {
  host::HubOptions options;
  options.allowed_data_rate_mask = 0x25;
  return options;
}

/** The legal hour on the site channel (§2), and the part regular traffic may use. */
constexpr device::Duration kLegalHour = seconds(36);
constexpr device::Duration kRoutineHour = milliseconds(28800);

/** The D111 gap's factor (§2). */
constexpr std::int64_t kGapFactor = 9;

/** The device's exact airtime in the hour before `until`. */
device::Duration hour_before(const std::vector<Record>& sent, Instant until) {
  device::Duration total{};
  const Instant from = until + (Instant{} - (Instant{} + seconds(3600)));
  for (const Record& record : sent) {
    if (record.until <= from || record.from >= until) {
      continue;
    }
    const Instant start = record.from < from ? from : record.from;
    const Instant end = record.until < until ? record.until : until;
    total = total + (end - start);
  }
  return total;
}

/** Every heartbeat and log packet went inside the four fifths of the hour that regular traffic
 * may use: the budget over-counts, so the exact sum is never above it. */
void check_routine_inside(host::SimDevice& door) {
  const auto all = sent(door);
  for (const Record& record : all) {
    if (record.label.type != type::heartbeat && record.label.type != type::log_entries) {
      continue;
    }
    INFO("routine packet at " << record.from);
    CHECK(hour_before(all, record.from) + (record.until - record.from) <= kRoutineHour);
  }
}

/**
 * The legal hour used up by door activity while disarmed, then an armed opening: at DR2 a report
 * takes 0.41 s and the hour holds about 87; at DR0 1.48 s and about 24.
 */
void past_the_hour(std::uint8_t rate, int changes, double every) {
  Bench bench(slow_site());
  host::SensorConfig settings;
  settings.send_data_rate = rate;
  settings.reply_data_rate = rate;
  host::SimDevice& door = bench.add("door", settings);
  const double first = 20;
  for (int i = 0; i < changes; ++i) {
    door.set_input(Input::door, i % 2 == 0, at_s(first + every * i));
  }
  const double last = first + every * (changes - 1);
  bench.sim.schedule(at_s(last + 0.5), [&]() { bench.hub.arm(); });
  door.set_input(Input::door, true, at_s(last + 1));
  bench.run_to(last + 3 * 3600);
  INFO(bench.hub.dump());
  const auto all = sent(door);
  const auto reports = sent(door, type::door_changed);
  REQUIRE(reports.size() == static_cast<std::size_t>(changes + 1));
  // The legal hour was used up: urgent traffic went past it (D111).
  CHECK(door.records().kind(RecordKind::transmission).busiest_hour() > kLegalHour);
  // The opening's report goes the moment the gap after the last transmission ends, after its
  // channel check: the sensor waited in light sleep.
  const Record& opening = reports.back();
  const Record& before = all[static_cast<std::size_t>(
      std::find_if(all.begin(), all.end(),
                   [&](const Record& record) { return record.from == opening.from; }) -
      all.begin() - 1)];
  const device::Duration air = opening.until - opening.from;
  const device::Duration check = device::cad_duration(rate).value();
  CHECK(opening.data_rate == rate);
  CHECK(opening.from == before.until + device::Duration{kGapFactor * air.us} + check);
  CHECK(door.records().kind(RecordKind::deep_sleep).between(at_s(last + 1), opening.from).count() ==
        0);
  // The hub's countdown starts, and the buzzer sounds.
  CHECK(bench.hub.decisions(HubAction::countdown_started, "door").size() == 1);
  const auto countdown = sound_times(door, Sound::countdown);
  REQUIRE(countdown.size() == 1);
  CHECK(countdown[0] > opening.until);
  CHECK(countdown[0] < opening.until + seconds(4));
  // Every packet past the hour was logged, and the hub had the entry after a later heartbeat.
  const auto past = bench.hub.log_entries_from("door");
  std::size_t logged_past = 0;
  for (const host::HubLogEntry& entry : past) {
    if (entry.code == device::log_code::airtime_past_limit) {
      ++logged_past;
      CHECK(entry.made_at < opening.until + seconds(1));
    }
  }
  CHECK(logged_past >= 1);
  // Heartbeats and log entries stayed inside the regular part of the hour, then resumed.
  check_routine_inside(door);
  CHECK(door.records()
            .kind(RecordKind::transmission)
            .type(type::heartbeat)
            .between(at_s(last + 3600), at_s(last + 3 * 3600))
            .count() >= 10);
  const bool skip_recorded =
      logged(door, roles::sensor::sensor_log::routine_skipped) ||
      !sensor_logs(bench, "door", roles::sensor::sensor_log::routine_skipped).empty();
  CHECK(skip_recorded);
}

TEST_CASE(
    "D111, section 2: past the legal hour at DR2, an armed opening still goes after the "
    "gap, the countdown starts, and it is logged; regular traffic waits") {
  past_the_hour(2, 120, 10);
}

TEST_CASE("D111, section 2: past the legal hour at DR0, the same, with the 13 s gap") {
  past_the_hour(0, 40, 20);
}

TEST_CASE("D111: after waiting for the gap, the sensor sleeps deep again between later retries") {
  Bench bench(slow_site());
  host::SensorConfig settings;
  settings.send_data_rate = 2;
  settings.reply_data_rate = 2;
  host::SimDevice& door = bench.add("door", settings);
  for (int i = 0; i < 120; ++i) {
    door.set_input(Input::door, i % 2 == 0, at_s(20 + 10 * i));
  }
  const double last = 20 + 10 * 119;
  // Disarmed, and the hub out of reach for the next opening: its first try waits for the gap,
  // then the retries run unanswered.
  bench.sim.schedule(at_s(last + 0.8),
                     [&]() { bench.sim.medium().cut(door.station(), bench.hub.station()); });
  door.set_input(Input::door, true, at_s(last + 1));
  bench.run_to(last + 400);
  const auto tries = sent(door, type::door_changed);
  REQUIRE(tries.size() >= 120 + 6);
  // The opening's first try waited for the gap in light sleep.
  CHECK(door.records()
            .kind(RecordKind::deep_sleep)
            .between(at_s(last + 1), tries[120].from)
            .count() == 0);
  // Between the minute-apart retries (from the fourth on), it sleeps deep.
  CHECK(door.records()
            .kind(RecordKind::deep_sleep)
            .between(tries[124].until, tries[125].from)
            .count() == 1);
}

TEST_CASE(
    "D111: a door chattering every 2 s for an hour at DR0 takes at most a tenth of the "
    "channel, every report carries the newest state, and the sensor settles afterwards") {
  Bench bench(slow_site());
  host::SensorConfig settings;
  settings.send_data_rate = 0;
  settings.reply_data_rate = 0;
  host::SimDevice& door = bench.add("door", settings);
  const double start = 20;
  const int changes = 1800;
  for (int i = 0; i < changes; ++i) {
    door.set_input(Input::door, i % 2 == 0, at_s(start + 2.0 * i));
  }
  const double stop = start + 2.0 * changes;
  bench.run_to(stop + 2 * 3600);
  const auto all = sent(door);
  // Past the legal hour the gap holds it to a tenth of the time; an hour that also holds the
  // legal 36 s before it reaches about 36 s + a tenth of the rest: 384 s here (10.7%).
  const device::Duration busiest = door.records().kind(RecordKind::transmission).busiest_hour();
  CHECK(busiest <= kLegalHour + device::Duration{(seconds(3600) - kLegalHour).us / 10});
  // Past the legal hour, every packet left the gap after the one before.
  std::size_t gapped = 0;
  for (std::size_t i = 1; i < all.size(); ++i) {
    const device::Duration air = all[i].until - all[i].from;
    if (hour_before(all, all[i].from) + air > kLegalHour) {
      INFO("packet at " << all[i].from);
      CHECK(all[i].from - all[i - 1].until >= device::Duration{kGapFactor * air.us});
      ++gapped;
    }
  }
  CHECK(gapped > 100);
  // The packets past the legal hour, on their own, fill at most a tenth of any hour.
  std::vector<Record> past;
  for (std::size_t i = 0; i < all.size(); ++i) {
    if (hour_before(all, all[i].from) + (all[i].until - all[i].from) > kLegalHour) {
      past.push_back(all[i]);
    }
  }
  for (const Record& record : past) {
    CHECK(hour_before(past, record.until) <= seconds(360));
  }
  // Every report carries the newest state and change count at the moment it was sealed, which
  // is its channel check's start.
  const auto inputs = door.records().kind(RecordKind::input).records();
  const auto heard = received<protocol::DoorChanged>(bench, "door");
  const auto reports = sent(door, type::door_changed);
  REQUIRE(heard.size() == reports.size());
  const device::Duration check = device::cad_duration(0).value();
  for (std::size_t k = 0; k < reports.size(); ++k) {
    const Instant sealed = reports[k].from + (Instant{} - (Instant{} + check));
    std::size_t before = 0;
    for (const Record& input : inputs) {
      before += input.at < sealed ? 1u : 0u;
    }
    INFO("report " << k << " at " << reports[k].from);
    CHECK(heard[k].door_change_count == static_cast<std::uint8_t>(before));
    CHECK(heard[k].flags.door_open == (before % 2 == 1));
  }
  // The last report gave the final state.
  CHECK(heard.back().door_change_count == static_cast<std::uint8_t>(changes));
  CHECK_FALSE(heard.back().flags.door_open);
  // Afterwards: deep sleep and heartbeats again, and never a fatal restart.
  CHECK(door.records().kind(RecordKind::deep_sleep).between(at_s(stop), at_s(stop + 600)).count() >=
        1);
  CHECK(door.records()
            .kind(RecordKind::transmission)
            .type(type::heartbeat)
            .between(at_s(stop + 3600), at_s(stop + 2 * 3600))
            .count() >= 10);
  check_routine_inside(door);
  check_sleep_discipline(door);
}

}  // namespace
}  // namespace hsn::test::sensor
