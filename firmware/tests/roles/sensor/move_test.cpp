// Moving the site to another channel or sending rate over the air (protocol section 7,
// "Changing the site's channel or rate"; D115): the sensor stores the next settings it is told,
// asks for a reply on every heartbeat while it holds them, tries the other settings after an
// unanswered packet, and makes the next settings its own when a packet on them is answered.

#include <limits>
#include <string>

#include "sensor_bench.hpp"
#include "test_transmitter.hpp"

namespace hsn::test::sensor {
namespace {

using host::MoveStage;
using host::SiteMove;
using roles::sensor::kSettingsKey;

constexpr double kInfinite = std::numeric_limits<double>::infinity();

/** The site channels' frequencies (§2). */
std::uint32_t frequency(std::uint8_t channel) {
  return 868100000u + 200000u * channel;
}

/** Runs until every sensor has confirmed the announced move; returns when that was. */
Instant run_to_confirmed(Bench& bench) {
  for (int step = 0; step < 8000; ++step) {
    if (bench.hub.move_unconfirmed().empty()) {
      return bench.sim.now();
    }
    bench.sim.run_for(milliseconds(250));
  }
  FAIL("the move was never confirmed");
  return Instant{};
}

/** When the last sensor confirmed. */
Instant confirmed_at(Bench& bench) {
  const auto confirmed = bench.hub.decisions(HubAction::move_confirmed);
  REQUIRE_FALSE(confirmed.empty());
  return confirmed.back().at;
}

/** When the site switched: by itself, with the last confirmation (§7, step 2). */
Instant switched_at(Bench& bench) {
  const auto switched = bench.hub.decisions(HubAction::move_switched);
  REQUIRE(switched.size() == 1);
  return switched[0].at;
}

/** The first packet the hub accepted from a sensor at or after `from`. */
const host::HubPacket* first_heard(Bench& bench, const std::string& name, Instant from) {
  for (const host::HubPacket& packet : bench.hub.received()) {
    if (packet.from == name && packet.verdict == host::HubVerdict::accepted && packet.at >= from) {
      return &packet;
    }
  }
  return nullptr;
}

/** Announces `move`, waits for the confirmation and so the switch; returns the switch's instant. */
Instant announce_and_switch(Bench& bench, const SiteMove& move) {
  bench.hub.announce_move(move);
  run_to_confirmed(bench);
  return switched_at(bench);
}

struct MoveCase {
  const char* name;
  std::optional<std::uint8_t> channel;
  std::optional<std::uint8_t> rate;
};

TEST_CASE(
    "D115, section 7: an idle sensor follows a move within two heartbeats of the switch, "
    "with no door event: channel only, rate only, both") {
  for (const MoveCase& move_case : {MoveCase{"channel", 2, std::nullopt},
                                    MoveCase{"rate", std::nullopt, 2}, MoveCase{"both", 0, 2}}) {
    INFO(move_case.name);
    Bench bench;
    host::SimDevice& door = bench.add();
    bench.run_to(10);
    SiteMove move;
    move.site_channel = move_case.channel;
    move.send_data_rate = move_case.rate;
    const Instant announced = bench.sim.now();
    bench.hub.announce_move(move);
    const Instant confirmed = run_to_confirmed(bench);
    // The announcement came with the next heartbeat's reply; the following one confirmed it.
    CHECK(confirmed - announced <= seconds(2 * 198 + 10));
    const roles::sensor::SensorState holding = retained_state(door);
    CHECK(holding.settings.next_site_channel == move_case.channel.value_or(protocol::kStaysAsItIs));
    CHECK(holding.settings.next_send_data_rate == move_case.rate.value_or(protocol::kStaysAsItIs));
    // The switch came by itself with the confirmation (§7).
    const Instant switched = switched_at(bench);
    CHECK(switched == confirmed_at(bench));
    bench.sim.run_until(switched + seconds(3 * 198));
    INFO(door.records().kind(RecordKind::transmission).between(switched, bench.sim.now()).dump());
    const host::HubPacket* heard = first_heard(bench, "door", switched);
    REQUIRE(heard != nullptr);
    const device::Duration took = heard->at - switched;
    // Measured: about one to two heartbeat intervals.
    CHECK(took <= seconds(2 * 198 + 5));
    CHECK(bench.hub.move_followed("door"));
    CHECK(sent(door, type::door_changed).empty());
    // The new settings are its own, for good; nothing more is held.
    const roles::sensor::SensorState after = retained_state(door);
    const std::uint8_t channel = move_case.channel.value_or(1);
    const std::uint8_t rate = move_case.rate.value_or(5);
    CHECK(after.settings.site_channel == channel);
    CHECK(after.send_rate == rate);
    CHECK(after.settings.allowed_rate_mask ==
          (move_case.rate.has_value() ? static_cast<std::uint8_t>(1u << rate) : 0x24));
    CHECK(after.settings.next_site_channel == protocol::kStaysAsItIs);
    CHECK(after.settings.next_send_data_rate == protocol::kStaysAsItIs);
    const auto later = sent(door);
    CHECK(later.back().frequency_hz == frequency(channel));
    CHECK(later.back().data_rate == rate);
    // Answered, it listens at its reply rate again: no more flag bit 7.
    const auto beats = received<protocol::Heartbeat>(bench, "door");
    REQUIRE_FALSE(beats.empty());
    CHECK_FALSE(beats.back().flags.listening_at_send_rate);
    CHECK_FALSE(after.use_next);
    // A move costs few flash writes: the next settings, then their adoption.
    CHECK(door.board().storage.write_count(kSettingsKey) <= 3);
    CHECK(door.records().kind(RecordKind::transmission).busiest_hour() <= seconds(36));
    check_sleep_discipline(door);
  }
}

TEST_CASE(
    "D115, section 7: a door opening just after the switch while armed: the first try goes "
    "unanswered on the old settings, the retry is heard on the new ones") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  bench.run_to(10);
  SiteMove move;
  move.site_channel = 2;
  move.send_data_rate = 2;
  const Instant switched = announce_and_switch(bench, move);
  const Instant opened = switched + seconds(1);
  door.set_input(Input::door, true, opened);
  bench.sim.run_until(opened + seconds(60));
  INFO(
      door.records().kind(RecordKind::transmission).between(switched, opened + seconds(60)).dump());
  const auto tries = sent(door, type::door_changed);
  REQUIRE(tries.size() >= 2);
  CHECK(tries[0].frequency_hz == frequency(1));
  CHECK(tries[0].data_rate == 5);
  CHECK(tries[1].frequency_hz == frequency(2));
  CHECK(tries[1].data_rate == 2);
  // The first packet the hub had after the opening (the heartbeat that switched the site was
  // heard at the switch itself).
  const host::HubPacket* heard = first_heard(bench, "door", opened);
  REQUIRE(heard != nullptr);
  CHECK(heard->type == type::door_changed);
  const device::Duration delay = heard->at - opened;
  // Measured: the first try's 1.5 s window, then the retry about 2 s after the opening.
  CHECK(delay <= seconds(4));
  CHECK(bench.hub.decisions(HubAction::countdown_started, "door").size() == 1);
  CHECK_FALSE(sound_times(door, Sound::countdown).empty());
  CHECK(sound_times(door, Sound::alarm).empty());
}

TEST_CASE(
    "D115, section 7: a cancel before the switch clears the next settings; a sensor that "
    "missed the announcement keeps its own and is not disturbed") {
  Bench bench;
  host::SimDevice& door = bench.add("door");
  host::SimDevice& far = bench.add("far");
  bench.run_to(10);
  bench.sim.medium().cut(far.station(), bench.hub.station());
  SiteMove move;
  move.site_channel = 2;
  bench.hub.announce_move(move);
  bench.run_to(10 + 2 * 198 + 10);
  REQUIRE(retained_state(door).settings.next_site_channel == 2);
  bench.hub.cancel_move();
  bench.sim.medium().set_path_loss(far.station(), bench.hub.station(), 100.0);
  bench.run_to(10 + 6 * 198);
  for (host::SimDevice* device : {&door, &far}) {
    INFO(device->name());
    const roles::sensor::SensorState state = retained_state(*device);
    CHECK(state.settings.next_site_channel == protocol::kStaysAsItIs);
    CHECK(state.settings.site_channel == 1);
    CHECK(sent(*device).back().frequency_hz == frequency(1));
  }
  CHECK(bench.hub.move_stage() == MoveStage::none);
  // The far sensor never held the move: every packet it sent was on the site's own settings.
  for (const Record& record : sent(far)) {
    CHECK(record.frequency_hz == frequency(1));
  }
  // Heard again once back in reach.
  CHECK(first_heard(bench, "far", at_s(10 + 4 * 198)) != nullptr);
}

TEST_CASE(
    "D115, section 7: a restart or a power loss while holding the next settings keeps them, "
    "and the sensor still follows") {
  for (const bool power : {false, true}) {
    INFO((power ? "power loss" : "restart"));
    Bench bench;
    host::SimDevice& door = bench.add();
    bench.run_to(10);
    SiteMove move;
    move.site_channel = 2;
    move.send_data_rate = 2;
    bench.hub.announce_move(move);
    // It holds the next settings from the announcing reply; it resets before its next packet
    // would confirm them (and so switch the site, §7).
    for (int step = 0; step < 4000 && retained_state(door).settings.next_site_channel != 2;
         ++step) {
      bench.sim.run_for(milliseconds(250));
    }
    REQUIRE(retained_state(door).settings.next_site_channel == 2);
    REQUIRE(bench.hub.decisions(HubAction::move_confirmed).empty());
    const Instant reset = bench.sim.now() + seconds(5);
    if (power) {
      door.power_loss(reset, seconds(1));
    } else {
      door.restart(reset);
    }
    bench.sim.run_until(reset + seconds(30));
    const roles::sensor::SensorState after = retained_state(door);
    CHECK(after.settings.next_site_channel == 2);
    CHECK(after.settings.next_send_data_rate == 2);
    // Its Started after the reset shows the version it kept, which confirms: the switch follows.
    run_to_confirmed(bench);
    const Instant switched = switched_at(bench);
    bench.sim.run_until(switched + seconds(3 * 198));
    CHECK(bench.hub.move_followed("door"));
    CHECK(retained_state(door).settings.site_channel == 2);
  }
}

TEST_CASE("D115, section 7: a restart or a power loss just after moving keeps the new settings") {
  for (const bool power : {false, true}) {
    INFO((power ? "power loss" : "restart"));
    Bench bench;
    host::SimDevice& door = bench.add();
    bench.run_to(10);
    SiteMove move;
    move.site_channel = 2;
    move.send_data_rate = 2;
    const Instant switched = announce_and_switch(bench, move);
    bench.sim.run_until(switched + seconds(3 * 198));
    REQUIRE(bench.hub.move_followed("door"));
    const Instant reset = bench.sim.now();
    if (power) {
      door.power_loss(reset, seconds(1));
    } else {
      door.restart(reset);
    }
    bench.sim.run_until(reset + seconds(30));
    // Started goes on the new settings and is answered.
    const auto started = sent(door, type::started);
    CHECK(started.back().frequency_hz == frequency(2));
    CHECK(started.back().data_rate == 2);
    const host::HubPacket* heard = first_heard(bench, "door", reset);
    REQUIRE(heard != nullptr);
    CHECK(heard->type == type::started);
    CHECK(retained_state(door).settings.allowed_rate_mask == 1u << 2);
  }
}

TEST_CASE(
    "D115, section 7: one lost reply while holding the next settings: one packet on them, "
    "unheard, then back; nothing lost, no alarm") {
  Bench bench;
  host::SimDevice& door = bench.add();
  // A second sensor out of reach through it all never confirms, so the site does not switch and
  // the door goes on holding the next settings (§7).
  host::SimDevice& far = bench.add("far");
  bench.sim.medium().cut(far.station(), bench.hub.station());
  bench.hub.arm(host::OpenDoors::refuse);
  bench.run_to(10);
  SiteMove move;
  move.site_channel = 2;
  bench.hub.announce_move(move);
  while (bench.hub.decisions(HubAction::move_confirmed, "door").empty() &&
         bench.sim.now() < at_s(10 + 3 * 198)) {
    bench.sim.run_for(milliseconds(250));
  }
  REQUIRE(bench.hub.move_unconfirmed() == std::vector<std::string>{"far"});
  // One heartbeat's reply is lost: the window around the next reply moment.
  const Instant due = retained_state(door).timers.at(roles::sensor::SensorTimer::next_heartbeat);
  bench.sim.schedule(due, [&]() {
    bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(), kInfinite);
  });
  bench.sim.schedule(due + seconds(2), [&]() {
    bench.sim.medium().set_path_loss(bench.hub.station(), door.station(), 100.0);
  });
  bench.sim.run_until(due + seconds(3 * 198));
  const auto all = sent(door);
  std::size_t on_next = 0;
  for (const Record& record : all) {
    on_next += record.frequency_hz == frequency(2) ? 1u : 0u;
  }
  CHECK(on_next == 1);
  CHECK(all.back().frequency_hz == frequency(1));
  // Still holding the move, back in touch, nothing sounded.
  const roles::sensor::SensorState after = retained_state(door);
  CHECK(after.settings.next_site_channel == 2);
  CHECK(after.misses == 0);
  CHECK(after.settings.site_channel == 1);
  CHECK(sounds(door) == std::vector<Sound>{Sound::off});
  CHECK(bench.hub.move_stage() == MoveStage::announcing);
}

TEST_CASE(
    "section 3: next settings naming a channel or rate the sensor does not know are "
    "ignored, and logged") {
  for (const bool bad_channel : {true, false}) {
    INFO((bad_channel ? "unknown channel" : "unknown rate"));
    Bench bench;
    host::SimDevice& door = bench.add();
    bench.run_to(20);
    const std::uint32_t counter = next_counter(door);
    bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(), kInfinite);
    protocol::Reply reply;
    reply.settings_version = static_cast<std::uint8_t>(bench.hub.settings_version("door") + 1);
    reply.countdown_seconds = 30;
    reply.heartbeat_interval_units = 12;
    reply.link_check_every = 5;
    reply.send_data_rate = 5;
    reply.reply_data_rate = 5;
    reply.next_site_channel = bad_channel ? 7 : 2;
    reply.next_send_data_rate = bad_channel ? protocol::kStaysAsItIs : 9;
    TransmitterConfig sender;
    sender.channel = {device::kReplyFrequencyHz, 5};
    sender.packets = {forge(door, reply, counter)};
    sender.start = at_s(30.6);
    sender.stop = at_s(31);
    add_transmitter(bench.sim, "hub2", sender, 0x0BADBEEF);
    door.set_input(Input::door, true, at_s(30));
    bench.run_to(40);
    const roles::sensor::SensorState after = retained_state(door);
    CHECK(after.waiting == 0);
    CHECK(after.settings.next_site_channel == protocol::kStaysAsItIs);
    CHECK(after.settings.next_send_data_rate == protocol::kStaysAsItIs);
    CHECK(logged(door, roles::sensor::sensor_log::setting_ignored));
  }
}

}  // namespace
}  // namespace hsn::test::sensor
