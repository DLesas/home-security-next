// Heartbeats (protocol sections 2, 6, 7, 8; DS4, LR3, LR11, D8, D72, D108): the interval from
// the settings, lengthened at slow rates; the hub's slot with the clock correction; ±10% at
// random without one; a reply wanted on every Nth; the brief listening at the reply moment;
// routine traffic, skipped when the budget runs low.

#include <limits>

#include "hsn/device/services/radio_plan.hpp"
#include "sensor_bench.hpp"
#include "test_transmitter.hpp"

namespace hsn::test::sensor {
namespace {

constexpr double kInfinite = std::numeric_limits<double>::infinity();

/** Gaps between consecutive heartbeats' starts, in true time. */
std::vector<device::Duration> gaps(host::SimDevice& door) {
  const auto beats = sent(door, type::heartbeat);
  std::vector<device::Duration> out;
  for (std::size_t i = 1; i < beats.size(); ++i) {
    out.push_back(beats[i].from - beats[i - 1].from);
  }
  return out;
}

host::HubOptions with_slots() {
  host::HubOptions options;
  options.heartbeat_slots = true;
  return options;
}

TEST_CASE("DS4, section 7: heartbeats every 3 minutes ±10% at random until the hub gives a slot") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(3 * 3600);
  const auto between = gaps(door);
  REQUIRE(between.size() >= 50);
  device::Duration shortest = seconds(1000);
  device::Duration longest{};
  for (const device::Duration gap : between) {
    shortest = gap < shortest ? gap : shortest;
    longest = gap > longest ? gap : longest;
  }
  CHECK(shortest >= seconds(162) - milliseconds(100));
  CHECK(longest <= seconds(198) + milliseconds(100));
  // Random, not fixed: the spread uses most of the ±10%.
  CHECK(longest - shortest > seconds(20));
}

TEST_CASE(
    "D72, LR3: a reply is wanted on every 5th heartbeat; the hub answers those and version "
    "changes only") {
  Bench bench;
  bench.add();
  bench.run_to(16 * 180);
  const auto beats = received<protocol::Heartbeat>(bench, "door");
  REQUIRE(beats.size() >= 15);
  for (std::size_t i = 0; i < beats.size(); ++i) {
    INFO("heartbeat " << i + 1);
    CHECK(beats[i].flags.reply_wanted == ((i + 1) % 5 == 0));
    CHECK(beats[i].settings_version == bench.hub.settings_version("door"));
    CHECK(beats[i].event_age_seconds == 0);
  }
  // Started's reply, then one per link check; each answered, so no miss is counted.
  CHECK(bench.hub.sent_to("door", type::reply).size() == 1 + beats.size() / 5);
  CHECK(retained_state(bench.sim.device("door")).misses == 0);
}

TEST_CASE("D8, D72: arming changes the version; the next heartbeat holds the old one and learns") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(100);
  bench.hub.arm();
  bench.run_to(250);
  // The first heartbeat after arming is answered at once, up to one interval late (D8).
  CHECK(retained_state(door).armed);
  const auto beats = received<protocol::Heartbeat>(bench, "door");
  REQUIRE_FALSE(beats.empty());
  CHECK_FALSE(beats[0].flags.reply_wanted);
  CHECK(beats[0].settings_version + 1 == bench.hub.settings_version("door"));
}

TEST_CASE(
    "section 8: after a heartbeat the sensor sleeps to the reply moment, then listens briefly "
    "at the reply rate") {
  Bench bench;
  host::SensorConfig settings;
  settings.send_data_rate = 2;
  settings.reply_data_rate = 5;
  host::SimDevice& door = bench.add("door", settings);
  bench.run_to(600);
  const auto beats = sent(door, type::heartbeat);
  REQUIRE(beats.size() >= 2);
  CHECK(beats[0].data_rate == 2);
  for (std::size_t i = 0; i < beats.size(); ++i) {
    const auto windows = door.records()
                             .kind(RecordKind::rx_window)
                             .between(beats[i].until, beats[i].until + seconds(2))
                             .records();
    REQUIRE(windows.size() == 1);
    // 20 ms before the reply moment, for 20 + 50 ms plus 8 symbols at SF7.
    CHECK(windows[0].at == beats[i].until + (seconds(1) - milliseconds(20)));
    CHECK(windows[0].until - windows[0].at ==
          heard_until(milliseconds(70) + device::microseconds(8 * 1024), 5));
    CHECK(windows[0].value == 1u << 5);
    // Asleep in between: no window from the end of the heartbeat to then.
  }
  // The version changes with arming, so a heartbeat reply comes, and is heard, at DR5.
  bench.hub.arm();
  bench.run_to(800);
  CHECK(retained_state(door).armed);
}

TEST_CASE("DS4: the interval arrives in a reply, is stored, and outlives a power loss") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  host::SensorConfig faster;
  faster.heartbeat_interval_units = 4;
  bench.hub.change_sensor("door", faster);
  bench.run_to(2000);
  // Learned at the next heartbeat, then every minute ±10%.
  const auto before = gaps(door);
  REQUIRE(before.size() >= 10);
  CHECK(before.back() <= seconds(66) + milliseconds(100));
  CHECK(before.back() >= seconds(54) - milliseconds(100));
  const roles::sensor::StoredSettings stored = retained_state(door).settings;
  CHECK(stored.heartbeat_interval_units == 4);
  // A power loss keeps the flash record: still every minute, before any reply.
  door.power_loss(at_s(2000), seconds(1));
  bench.sim.schedule(at_s(2000.5),
                     [&]() { bench.sim.medium().cut(door.station(), bench.hub.station()); });
  // Started is retried for 10 minutes, during which heartbeats would say nothing new.
  bench.run_to(2000 + 900);
  const auto beats = sent(door, type::heartbeat);
  const auto last = beats.back().from - beats[beats.size() - 2].from;
  CHECK(last <= seconds(66) + milliseconds(100));
  CHECK(beats.back().from > at_s(2000));
}

TEST_CASE("section 7: at slow rates the heartbeat is at least 3 minutes at SF11, 5 at SF12") {
  host::HubOptions options;
  options.allowed_data_rate_mask = 0x23;
  Bench bench(options);
  host::SensorConfig sf11;
  sf11.heartbeat_interval_units = 4;
  sf11.send_data_rate = 1;
  sf11.reply_data_rate = 4;
  host::SensorConfig sf12 = sf11;
  sf12.send_data_rate = 0;
  host::SimDevice& slow = bench.add("slow", sf11);
  host::SimDevice& slowest = bench.add("slowest", sf12);
  bench.run_to(3 * 3600);
  for (const auto gap : gaps(slow)) {
    CHECK(gap >= seconds(162) - milliseconds(100));
  }
  for (const auto gap : gaps(slowest)) {
    CHECK(gap >= seconds(270) - milliseconds(100));
  }
  CHECK(sent(slowest, type::heartbeat)[0].data_rate == 0);
  // Both stay inside the airtime (§2).
  CHECK(slowest.records().kind(RecordKind::transmission).busiest_hour() <= seconds(36));
}

TEST_CASE("LR11, D108: the hub's slot and clock correction set the next heartbeat") {
  // A clock 3% fast: the hub sees it and sends a correction of +30,000 ppm.
  Bench bench(with_slots());
  host::SensorConfig settings;
  settings.clock_correction_ten_ppm = 3000;
  host::SimDevice& door = bench.add("door", settings, 30000);
  bench.run_to(3 * 3600);
  INFO(bench.hub.dump());
  const auto replies = bench.hub.sent_to("door", type::reply);
  REQUIRE(replies.size() >= 3);
  // After a link-check reply, the next heartbeat starts at the slot: its tenths after the end
  // of the heartbeat answered, in true time, plus the 50 ms boot and the 3 ms channel check.
  const auto beats = sent(door, type::heartbeat);
  const auto counters = counters_of(bench, "door", type::heartbeat);
  std::size_t slots = 0;
  for (const host::HubSent& reply : replies) {
    const auto opened = open_reply(door, reply.packet, counters);
    if (!opened.has_value() || opened->reply.next_heartbeat_tenths == 0) {
      continue;
    }
    std::size_t k = 0;
    while (k < beats.size() && beats[k].label.counter != opened->answered) {
      ++k;
    }
    REQUIRE(k + 1 < beats.size());
    const Instant slot = beats[k].until + milliseconds(100LL * opened->reply.next_heartbeat_tenths);
    const device::Duration late = beats[k + 1].from - slot;
    CHECK(late >= milliseconds(52));
    CHECK(late <= milliseconds(54));
    ++slots;
  }
  CHECK(slots >= 3);
  // Slotted: every gap is the interval, corrected so it holds in true time (no ±10%).
  const auto between = gaps(door);
  REQUIRE(between.size() >= 40);
  std::size_t exact = 0;
  for (std::size_t i = 6; i < between.size(); ++i) {
    const device::Duration error =
        between[i] > seconds(180) ? between[i] - seconds(180) : seconds(180) - between[i];
    exact += error < milliseconds(5) ? 1u : 0u;
  }
  // The hub may move a slot at a link check; every other gap is exact.
  CHECK(exact * 4 >= (between.size() - 6) * 3);
  CHECK(retained_state(door).slotted);
}

TEST_CASE("LR11: without the clock correction the same fast clock drifts off its slot") {
  Bench bench(with_slots());
  host::SimDevice& door = bench.add("door", {}, 30000);
  bench.run_to(3 * 3600);
  const auto between = gaps(door);
  REQUIRE(between.size() >= 40);
  // Every unslotted-free gap is 3% short of 180 s in true time.
  std::size_t short_gaps = 0;
  for (const auto gap : between) {
    short_gaps += gap < seconds(178) ? 1u : 0u;
  }
  CHECK(short_gaps >= between.size() / 2);
}

TEST_CASE("section 7: after several lost replies the sensor drops its slot for the interval ±10%") {
  Bench bench(with_slots());
  host::SimDevice& door = bench.add();
  bench.run_to(3600);
  REQUIRE(retained_state(door).slotted);
  bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(), kInfinite);
  bench.run_to(3600 + 25 * 180);
  CHECK_FALSE(retained_state(door).slotted);
  const auto between = gaps(door);
  std::size_t off_slot = 0;
  for (std::size_t i = between.size() - 8; i < between.size(); ++i) {
    const device::Duration error =
        between[i] > seconds(180) ? between[i] - seconds(180) : seconds(180) - between[i];
    off_slot += error > milliseconds(500) ? 1u : 0u;
  }
  CHECK(off_slot >= 4);
}

TEST_CASE("DS2: a heartbeat that fell due during an exchange is skipped, not sent when it ends") {
  // The hub answers late, so a door report sent just before a heartbeat is due is answered
  // just after: the exchange ends with the heartbeat overdue.
  host::HubOptions options;
  options.processing = milliseconds(1200);
  Bench bench(options);
  host::SimDevice& door = bench.add();
  bench.run_to(100);
  REQUIRE(door.state() == host::PowerState::deep_sleep);
  const Instant due = retained_state(door).timers.at(roles::sensor::SensorTimer::next_heartbeat);
  door.set_input(Input::door, true, due + (Instant{} - (Instant{} + milliseconds(500))));
  bench.sim.run_until(due + seconds(200));
  const auto answered = door.records().kind(RecordKind::reception).type(type::reply).records();
  REQUIRE(answered.size() == 2);
  CHECK(answered[1].until > due);
  // The overdue heartbeat was skipped while the reply arrived, not sent after it.
  const auto beats = sent(door, type::heartbeat);
  REQUIRE_FALSE(beats.empty());
  CHECK(beats[0].from > answered[1].until + seconds(160));
}

TEST_CASE("D110: no log entries packet while a report waits for its reply") {
  Bench bench;
  host::SensorConfig settings;
  // Refused by the pairing: a warning waits in the log for the first heartbeat.
  settings.send_data_rate = 3;
  host::SimDevice& door = bench.add("door", settings);
  bench.run_to(100);
  bench.sim.medium().cut(door.station(), bench.hub.station());
  const Instant due = retained_state(door).timers.at(roles::sensor::SensorTimer::next_heartbeat);
  // The door opens between that heartbeat and its reply moment, so the report exchange is
  // already running when the heartbeat's window closes and the log entry falls due.
  door.set_input(Input::door, true, due + milliseconds(600));
  bench.sim.run_until(due + seconds(700));
  const auto beats = sent(door, type::heartbeat);
  REQUIRE_FALSE(beats.empty());
  const auto doors = sent(door, type::door_changed);
  REQUIRE(doors.size() >= 10);
  CHECK(doors[0].from < beats[0].until + seconds(1));
  CHECK(door.records()
            .kind(RecordKind::transmission)
            .type(type::log_entries)
            .between(beats[0].from, doors.back().until)
            .count() == 0);
}

TEST_CASE(
    "section 2: heartbeats are routine, skipped once less than a fifth of the budget is left") {
  host::HubOptions options;
  options.allowed_data_rate_mask = 0x25;
  Bench bench(options);
  host::SensorConfig settings;
  settings.send_data_rate = 0;
  settings.reply_data_rate = 0;
  settings.heartbeat_interval_units = 20;
  host::SimDevice& door = bench.add("door", settings);
  // 22 door reports of 1.5 s: past four fifths of the hour's 36 s.
  for (int i = 0; i < 22; ++i) {
    door.set_input(Input::door, i % 2 == 0, at_s(100 + 8 * i));
  }
  bench.run_to(100 + 8 * 22 + 1800);
  INFO(door.records().kind(RecordKind::transmission).dump());
  CHECK(door.records().kind(RecordKind::transmission).busiest_hour() <= seconds(36));
  // The heartbeats due in the next half hour were skipped and logged; the reports all went.
  CHECK(sent(door, type::heartbeat).empty());
  CHECK(logged(door, roles::sensor::sensor_log::routine_skipped));
  CHECK(received<protocol::DoorChanged>(bench, "door").size() == 22);
  CHECK(door.board().storage.write_count(device::StoreKey::counter_resume) <= 2);
}

TEST_CASE(
    "LR11, section 6: a heartbeat's reply heard after a later packet counts the slot from "
    "the heartbeat's own end") {
  Bench bench(with_slots());
  host::SimDevice& door = bench.add();
  bench.run_to(100);
  // New settings, so the next heartbeat holds an old version and its reply carries a slot.
  bench.hub.change_sensor("door", host::SensorConfig{});
  const Instant due = retained_state(door).timers.at(roles::sensor::SensorTimer::next_heartbeat);
  // The door opens between the heartbeat and its reply moment: its report is the latest packet
  // when the heartbeat's reply arrives.
  door.set_input(Input::door, true, due + milliseconds(400));
  bench.sim.run_until(due + seconds(400));
  const auto beats = sent(door, type::heartbeat);
  REQUIRE(beats.size() >= 2);
  const auto doors = sent(door, type::door_changed);
  REQUIRE(doors.size() == 1);
  CHECK(doors[0].from > beats[0].until);
  const auto replies = bench.hub.sent_to("door", type::reply);
  const auto opened = open_reply(door, replies.back().packet, {beats[0].label.counter});
  REQUIRE(opened.has_value());
  REQUIRE(opened->reply.next_heartbeat_tenths != 0);
  // The slot counts from the heartbeat's end, plus the 50 ms boot and the 3 ms check.
  const Instant slot = beats[0].until + milliseconds(100LL * opened->reply.next_heartbeat_tenths);
  CHECK(beats[1].from == slot + milliseconds(53));
  CHECK(retained_state(door).slotted);
}

/** Runs the sensor to sleep, then opens the door with the hub unable to reach it. */
Instant open_unanswered(Bench& bench, host::SimDevice& door) {
  bench.run_to(20);
  bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(),
                                           std::numeric_limits<double>::infinity());
  door.set_input(Input::door, true, at_s(30));
  return at_s(30);
}

/** A reply with a slot of `tenths`, the defaults otherwise. */
protocol::Reply slot_reply(std::uint8_t version, std::uint16_t tenths) {
  protocol::Reply reply;
  reply.settings_version = version;
  reply.countdown_seconds = 30;
  reply.heartbeat_interval_units = 12;
  reply.link_check_every = 5;
  reply.send_data_rate = 5;
  reply.reply_data_rate = 5;
  reply.next_heartbeat_tenths = tenths;
  return reply;
}

TEST_CASE("section 6: a slot in a reply to the latest packet counts from that packet's end") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(20);
  const std::uint32_t first = next_counter(door);
  open_unanswered(bench, door);
  TransmitterConfig sender;
  sender.channel = {device::kReplyFrequencyHz, 5};
  sender.packets = {forge(door, slot_reply(bench.hub.settings_version("door"), 600), first)};
  sender.start = at_s(30.6);
  sender.stop = at_s(31);
  add_transmitter(bench.sim, "hub2", sender, 0x0BADBEEF);
  bench.run_to(200);
  const auto doors = sent(door, type::door_changed);
  REQUIRE(doors.size() == 1);
  CHECK(doors[0].label.counter == first);
  const auto beats = sent(door, type::heartbeat);
  REQUIRE_FALSE(beats.empty());
  CHECK(beats[0].from == doors[0].until + seconds(60) + milliseconds(53));
}

TEST_CASE(
    "section 6: a slot in a reply to an earlier try, a later try being the latest, is not "
    "taken") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(20);
  const std::uint32_t first = next_counter(door);
  const Instant planned =
      retained_state(door).timers.at(roles::sensor::SensorTimer::next_heartbeat);
  open_unanswered(bench, door);
  // Played in the second try's window (about 2 to 3 s after the opening), bound to the first.
  TransmitterConfig sender;
  sender.channel = {device::kReplyFrequencyHz, 5};
  sender.packets = {forge(door, slot_reply(bench.hub.settings_version("door"), 600), first)};
  sender.start = at_s(33.3);
  sender.stop = at_s(34);
  add_transmitter(bench.sim, "hub2", sender, 0x0BADBEEF);
  bench.run_to(34);
  const auto doors = sent(door, type::door_changed);
  REQUIRE(doors.size() == 2);
  REQUIRE(doors[1].until < at_s(33.3));
  // The reply answered the opening, but gave no slot: the heartbeat keeps its plan.
  const roles::sensor::SensorState after = retained_state(door);
  CHECK(after.waiting == 0);
  CHECK_FALSE(after.slotted);
  CHECK(after.timers.at(roles::sensor::SensorTimer::next_heartbeat) == planned);
}

}  // namespace
}  // namespace hsn::test::sensor
