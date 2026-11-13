// Radio trouble (protocol sections 2, 4, 7): a lost reply, a link cut for minutes, a hub that
// answers late, a busy channel, packets out of range, and a recorded reply played back.

#include <limits>

#include "hsn/device/services/radio_plan.hpp"
#include "sensor_bench.hpp"
#include "test_transmitter.hpp"

namespace hsn::test::sensor {
namespace {

constexpr double kInfinite = std::numeric_limits<double>::infinity();

/** A 255-byte packet: about 0.4 s on air at SF7. */
std::vector<std::uint8_t> long_packet() {
  std::vector<std::uint8_t> packet(255, 0x5A);
  packet[0] = 0x10;
  return packet;
}

TEST_CASE(
    "a single lost reply: the retry is answered, the local countdown gives way to the hub's") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  bench.run_to(10);
  // Replies are lost for 2 s around the first try only.
  bench.sim.schedule(at_s(29), [&]() {
    bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(), kInfinite);
  });
  bench.sim.schedule(at_s(31.7), [&]() {
    bench.sim.medium().set_path_loss(bench.hub.station(), door.station(), 100.0);
  });
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(80);
  INFO(door.records().between(at_s(29), at_s(80)).dump());
  CHECK(sent(door, type::door_changed).size() == 2);
  // The first unanswered try started the local countdown; the answered retry said "countdown
  // started", and the buzzer went on for the hub's countdown with the radio listening.
  CHECK(sounds(door) == std::vector<Sound>{Sound::off, Sound::countdown, Sound::off});
  CHECK(sound_times(door, Sound::alarm).empty());
  // One loss is not a reason to slow down (§7): still DR5, no bit 7.
  const roles::sensor::SensorState after = retained_state(door);
  CHECK(after.send_rate == 5);
  CHECK_FALSE(after.listen_at_send_rate);
  // The countdown ran to its end, and the sensor stopped with it.
  CHECK(bench.hub.decisions(HubAction::alarm, "door").size() == 1);
}

TEST_CASE("a link cut for minutes: retries go on, and the newest state gets through after") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  bench.sim.schedule(at_s(20),
                     [&]() { bench.sim.medium().cut(door.station(), bench.hub.station()); });
  bench.sim.schedule(at_s(320), [&]() {
    bench.sim.medium().set_path_loss(door.station(), bench.hub.station(), 100.0);
  });
  door.set_input(Input::door, true, at_s(30));
  door.set_input(Input::cover, true, at_s(90));
  door.set_input(Input::door, false, at_s(200));
  bench.run_to(800);
  INFO(door.records().kind(RecordKind::transmission).dump() << bench.hub.dump());
  // After the cut, the next try carries the newest state: closed, three door... two changes.
  const auto doors = received<protocol::DoorChanged>(bench, "door");
  REQUIRE_FALSE(doors.empty());
  CHECK_FALSE(doors.back().flags.door_open);
  CHECK(doors.back().door_change_count == 2);
  CHECK(doors.back().event_age_seconds >= 120);
  const auto covers = received<protocol::CoverChanged>(bench, "door");
  REQUIRE(covers.size() == 1);
  CHECK(covers[0].flags.cover_open);
  CHECK(retained_state(door).waiting == 0);
  // Heartbeats resume after the exchange.
  CHECK_FALSE(bench.hub.received_from("door", type::heartbeat).empty());
  check_sleep_discipline(door);
}

TEST_CASE(
    "the hub answering late: inside the listen time it is heard, after it the sensor retries") {
  for (const int processing_ms : {1300, 2500}) {
    INFO("processing " << processing_ms << " ms");
    host::HubOptions options;
    options.processing = milliseconds(processing_ms);
    Bench bench(options);
    host::SimDevice& door = bench.add();
    door.set_input(Input::door, true, at_s(30));
    bench.run_to(100);
    const bool in_time = processing_ms + 72 < 1500;
    if (in_time) {
      CHECK(sent(door, type::door_changed).size() == 1);
      CHECK(retained_state(door).waiting == 0);
    } else {
      // The hub cannot start its reply while the sensor still listens: it says "too late", and
      // the sensor's retries cover it, through the whole run (§7, reply timing).
      CHECK_FALSE(bench.hub.decisions(HubAction::too_late, "door").empty());
      CHECK(sent(door, type::door_changed).size() >= 4);
      CHECK(retained_state(door).waiting != 0);
    }
  }
}

TEST_CASE(
    "section 2: a busy channel: wait 0.2 to 2 s at random and check again; after 5 send anyway") {
  Bench bench;
  host::SimDevice& door = bench.add();
  TransmitterConfig jam;
  jam.channel = {868300000u, 5};
  jam.packets = {long_packet()};
  jam.start = at_s(29);
  jam.stop = at_s(60);
  jam.repeat = true;
  host::SimDevice& jammer = add_transmitter(bench.sim, "jammer", jam, 0x0BADBEEF);
  // The jammer is heard by the sensor, but the hub hears the sensor 10 dB above it.
  bench.sim.medium().set_path_loss(jammer.station(), bench.hub.station(), 110.0);
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(60);
  INFO(door.records()
           .kind(RecordKind::channel_check)
           .kind(RecordKind::transmission)
           .between(at_s(29), at_s(60))
           .dump());
  const auto checks =
      door.records().kind(RecordKind::channel_check).between(at_s(30), at_s(45)).records();
  REQUIRE(checks.size() >= 5);
  for (std::size_t i = 0; i < 5; ++i) {
    CHECK(checks[i].flag);
  }
  for (std::size_t i = 1; i < 5; ++i) {
    const device::Duration wait = checks[i].from - checks[i - 1].at;
    CHECK(wait >= milliseconds(200));
    CHECK(wait <= milliseconds(2000));
  }
  // After the fifth busy check, it sends anyway, at once.
  const auto reports = sent(door, type::door_changed);
  REQUIRE_FALSE(reports.empty());
  CHECK(reports[0].from == checks[4].at);
  CHECK_FALSE(received<protocol::DoorChanged>(bench, "door").empty());
}

TEST_CASE("packets out of range at every rate: retries, the fall-back, then giving up, in budget") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  bench.sim.medium().set_path_loss(door.station(), bench.hub.station(), 170.0);
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(30 + 3600);
  CHECK(received<protocol::DoorChanged>(bench, "door").empty());
  const auto tries = sent(door, type::door_changed);
  CHECK(tries.size() == 13);
  CHECK(tries.back().data_rate == 2);
  CHECK(door.records().kind(RecordKind::transmission).busiest_hour() <= seconds(36));
  CHECK(logged(door, roles::sensor::sensor_log::report_given_up));
  check_sleep_discipline(door);
}

TEST_CASE("section 4: recorded replies played back fail their binding and are ignored") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  door.set_input(Input::door, true, at_s(30));
  bench.sim.schedule(at_s(40), [&]() { bench.hub.disarm(); });
  door.set_input(Input::door, false, at_s(60));
  bench.run_to(70);
  // What an attacker could have recorded: the reply that started the countdown, and the reply
  // to the closing (each but Started's).
  const auto replies = bench.hub.sent_to("door", type::reply);
  REQUIRE(replies.size() == 3);
  bench.hub.arm();
  // The next opening's replies are lost; the recordings are played into the sensor's window.
  bench.sim.schedule(at_s(96), [&]() {
    bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(), kInfinite);
  });
  TransmitterConfig replay;
  replay.channel = {device::kReplyFrequencyHz, 5};
  replay.packets = {replies[1].packet, replies[2].packet};
  replay.start = at_s(100.3);
  replay.stop = at_s(101.4);
  add_transmitter(bench.sim, "attacker", replay, 0x0BADBEEF);
  door.set_input(Input::door, true, at_s(100));
  bench.run_to(101.6);
  INFO(door.records().between(at_s(99), at_s(102)).dump());
  CHECK(door.records().kind(RecordKind::reception).between(at_s(100), at_s(102)).count() == 2);
  // Bound to old packets, both fail the tag check: logged; no countdown, and the report still
  // waits for a real answer.
  CHECK(logged(door, roles::sensor::sensor_log::hub_packet_rejected));
  CHECK(retained_state(door).alert != roles::sensor::Alert::hub_countdown);
  CHECK(retained_state(door).waiting != 0);
}

TEST_CASE("section 4: an old heartbeat's reply played into a later heartbeat's window is refused") {
  Bench bench;
  host::SimDevice& door = bench.add();
  // The first heartbeat holds the old version... make it answered: arm before it goes.
  bench.run_to(100);
  bench.hub.arm();
  bench.run_to(260);
  const auto first = bench.hub.sent_to("door", type::reply);
  REQUIRE(first.size() == 2);
  const host::Bytes recorded = first[1].packet;
  REQUIRE(retained_state(door).armed);
  // Disarmed now; the next heartbeat's reply is lost and the recording, which says armed, is
  // played at its reply moment instead.
  bench.hub.disarm();
  const Instant due = retained_state(door).timers.at(roles::sensor::SensorTimer::next_heartbeat);
  bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(), kInfinite);
  TransmitterConfig replay;
  replay.channel = {device::kReplyFrequencyHz, 5};
  replay.packets = {recorded};
  // The heartbeat ends about 115 ms after its timer; its window opens 0.98 s after that.
  replay.start = due + milliseconds(1115);
  replay.stop = due + milliseconds(1300);
  add_transmitter(bench.sim, "attacker", replay, 0x0BADBEEF);
  bench.sim.run_until(due + seconds(3));
  INFO(door.records().between(due, due + seconds(3)).dump());
  CHECK(door.records().kind(RecordKind::reception).between(due, due + seconds(3)).count() == 1);
  CHECK(logged(door, roles::sensor::sensor_log::hub_packet_rejected));
}

TEST_CASE("section 4: after a run gives up, replies to its tries are no longer accepted") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  // The hub hears the tries and answers each; every answer is lost on its way.
  bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(), kInfinite);
  door.set_input(Input::door, true, at_s(20));
  bench.run_to(20 + 700);
  REQUIRE(retained_state(door).waiting == 0);
  const auto replies = bench.hub.sent_to("door", type::reply);
  REQUIRE(replies.size() >= 13);
  // Later, the newest of those answers is played into a new report's window, at the rate the
  // sensor then listens at (its fall-back keeps going round while replies are lost).
  bench.run_to(799);
  TransmitterConfig replay;
  replay.channel = {device::kReplyFrequencyHz, retained_state(door).send_rate};
  replay.packets = {replies.back().packet};
  replay.start = at_s(800.6);
  replay.stop = at_s(801);
  add_transmitter(bench.sim, "attacker", replay, 0x0BADBEEF);
  door.set_input(Input::door, false, at_s(800));
  bench.run_to(803);
  INFO(door.records().between(at_s(799), at_s(803)).dump());
  CHECK(door.records().kind(RecordKind::reception).between(at_s(800), at_s(803)).count() == 1);
  CHECK(logged(door, roles::sensor::sensor_log::hub_packet_rejected));
  CHECK(retained_state(door).waiting != 0);
}

}  // namespace
}  // namespace hsn::test::sensor
