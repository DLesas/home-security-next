// The sensor's log over LoRa (protocol section 6, log entries; FW6, D110): after a heartbeat,
// one entry at warning or above goes as routine traffic, the hub always answers, and the entry
// leaves the buffer only when that answer arrives. Every failure path records a sensor code.

#include <limits>

#include "sensor_bench.hpp"

namespace hsn::test::sensor {
namespace {

using roles::sensor::sensor_log::setting_ignored;

constexpr double kInfinite = std::numeric_limits<double>::infinity();

/** A hub that tells the sensor to send at DR3, which the default pairing (DR5, DR2) forbids. */
host::SensorConfig forbidden_rate() {
  host::SensorConfig settings;
  settings.send_data_rate = 3;
  return settings;
}

TEST_CASE(
    "D110: a warning reaches the hub after the next heartbeat, and is released on its reply") {
  Bench bench;
  host::SimDevice& door = bench.add("door", forbidden_rate());
  bench.run_to(10);
  // The Started reply's forbidden rate was refused and logged.
  CHECK(logged(door, setting_ignored));
  bench.run_to(400);
  INFO(door.records().kind(RecordKind::transmission).dump() << bench.hub.dump());
  const auto logs = sensor_logs(bench, "door", setting_ignored);
  REQUIRE(logs.size() == 1);
  CHECK(logs[0].level == static_cast<std::uint8_t>(device::LogLevel::warning));
  CHECK(logs[0].text == "send rate ignored 3");
  // Made at the Started reply, about 0.24 s after power-on.
  CHECK(logs[0].made_at >= at_s(0.1));
  CHECK(logs[0].made_at <= at_s(0.4));
  // It went right after the first heartbeat's reply window, as routine traffic, and was
  // answered; then it left the buffer, and no second packet carried it.
  const auto beats = sent(door, type::heartbeat);
  const auto packets = sent(door, type::log_entries);
  REQUIRE(packets.size() == 1);
  CHECK(packets[0].from > beats[0].until + seconds(1));
  CHECK(packets[0].from < beats[0].until + seconds(2));
  CHECK_FALSE(logged(door, setting_ignored));
  // Logged once per settings version, not on every reply carrying the same refusal.
  CHECK(bench.hub.sent_to("door", type::reply).size() >= 2);
}

TEST_CASE("D110: without the hub's reply the entry stays, and goes again after a later heartbeat") {
  Bench bench;
  host::SimDevice& door = bench.add("door", forbidden_rate());
  bench.run_to(10);
  // The hub hears the sensor but its replies are lost for the first log packet.
  bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(), kInfinite);
  bench.run_to(250);
  CHECK(logged(door, setting_ignored));
  bench.sim.medium().set_path_loss(bench.hub.station(), door.station(), 100.0);
  bench.run_to(800);
  const auto logs = sensor_logs(bench, "door", setting_ignored);
  REQUIRE(logs.size() >= 2);
  // The hub keeps both copies and knows the second for a repeat of the first.
  CHECK(logs[1].repeat_of == logs[0].counter);
  CHECK_FALSE(logged(door, setting_ignored));
}

TEST_CASE("D110: a reply to another packet does not release the entry; only its own reply does") {
  Bench bench;
  host::SimDevice& door = bench.add("door", forbidden_rate());
  bench.run_to(10);
  // The first log packet's reply is lost, then a door report is answered.
  bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(), kInfinite);
  bench.run_to(250);
  REQUIRE(sent(door, type::log_entries).size() == 1);
  bench.sim.medium().set_path_loss(bench.hub.station(), door.station(), 100.0);
  door.set_input(Input::door, true, at_s(260));
  bench.run_to(270);
  REQUIRE(retained_state(door).waiting == 0);
  CHECK(logged(door, setting_ignored));
}

TEST_CASE("design section 4: a sensor keeps warnings and above only") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(0.1);
  device::Services* services = door.services();
  REQUIRE(services != nullptr);
  const std::size_t before = services->log.size();
  services->log.add(door.local_now(), device::LogLevel::info, 0x1FFF, "info");
  CHECK(services->log.size() == before);
  services->log.add(door.local_now(), device::LogLevel::warning, 0x1FFE, "warning");
  CHECK(services->log.size() == before + 1);
}

TEST_CASE("D110, section 6: one entry per heartbeat, the oldest first") {
  Bench bench;
  host::SimDevice& door = bench.add("door", forbidden_rate());
  bench.run_to(10);
  // A second warning: a report given up while the hub is out of reach.
  bench.sim.medium().cut(door.station(), bench.hub.station());
  door.set_input(Input::door, true, at_s(20));
  bench.run_to(20 + 700);
  bench.sim.medium().set_path_loss(door.station(), bench.hub.station(), 100.0);
  bench.run_to(20 + 700 + 1200);
  INFO(bench.hub.dump());
  const auto entries = bench.hub.log_entries_from("door");
  REQUIRE(entries.size() >= 2);
  CHECK(entries[0].code == setting_ignored);
  // Each log packet carried exactly one entry, each sent after a heartbeat.
  const auto packets = received<protocol::LogEntries>(bench, "door");
  CHECK(packets.size() == entries.size());
  CHECK_FALSE(sensor_logs(bench, "door", roles::sensor::sensor_log::report_given_up).empty());
}

TEST_CASE("D110, section 2: a log packet over the budget is not sent, and no warning is added") {
  // At DR0 a status packet takes 1.48 s and the log packet about 2.3 s. After 18 door reports
  // a heartbeat still fits the routine four fifths of the hour; the log packet after it does not.
  host::HubOptions options;
  options.allowed_data_rate_mask = 0x25;
  Bench bench(options);
  host::SensorConfig settings;
  settings.send_data_rate = 0;
  settings.reply_data_rate = 0;
  settings.heartbeat_interval_units = 20;
  host::SimDevice& door = bench.add("door", settings);
  // A low battery: one warning in the log.
  door.board().sensor_io.battery_mv = 3400;
  for (int i = 0; i < 18; ++i) {
    door.set_input(Input::door, i % 2 == 0, at_s(10 + 8 * i));
  }
  bench.run_to(400);
  INFO(door.records().kind(RecordKind::transmission).dump());
  REQUIRE(sent(door, type::heartbeat).size() == 1);
  CHECK(sent(door, type::log_entries).empty());
  // The entry waits for a later heartbeat; nothing was logged about the skip.
  CHECK(logged(door, roles::sensor::sensor_log::low_battery));
  CHECK_FALSE(logged(door, roles::sensor::sensor_log::routine_skipped));
}

TEST_CASE(
    "section 6: out of touch for 24 hours at DR0, the warning waits: no log packet, and no "
    "heartbeat skipped for airtime") {
  host::HubOptions options;
  options.allowed_data_rate_mask = 0x01;
  host::SimulationOptions simulation;
  simulation.keep_fake_records = false;
  Bench bench(options, simulation);
  host::SimDevice& door = bench.add();
  door.board().sensor_io.battery_mv = 3400;
  bench.sim.schedule(at_s(0),
                     [&]() { bench.sim.medium().cut(door.station(), bench.hub.station()); });
  bench.run_to(24 * 3600);
  CHECK(sent(door, type::log_entries).empty());
  CHECK(logged(door, roles::sensor::sensor_log::low_battery));
  // Started's 10-minute retry run fills the first hour with urgent tries, and regular traffic
  // gives way then (§2); after it, every heartbeat goes, 5 minutes ±10% apart.
  const auto beats = sent(door, type::heartbeat);
  std::size_t later = 0;
  for (std::size_t i = 1; i < beats.size(); ++i) {
    if (beats[i - 1].from > at_s(3600 + 600)) {
      CHECK(beats[i].from - beats[i - 1].from <= seconds(330) + milliseconds(100));
      ++later;
    }
  }
  CHECK(later >= (20 * 3600) / 330);
}

TEST_CASE(
    "section 6: when the hub returns, the entry follows the first answered heartbeat and is "
    "released on its reply") {
  Bench bench;
  host::SimDevice& door = bench.add();
  door.board().sensor_io.battery_mv = 3400;
  bench.run_to(10);
  bench.sim.medium().cut(door.station(), bench.hub.station());
  // The first heartbeat makes the warning; the log packet after it goes unanswered, and from
  // then on the entry waits: no more log packets while the hub is away.
  bench.run_to(3600);
  REQUIRE(retained_state(door).misses > 0);
  CHECK(sent(door, type::log_entries).size() == 1);
  bench.sim.medium().set_path_loss(door.station(), bench.hub.station(), 100.0);
  bench.run_to(3600 + 600);
  const auto answered = bench.hub.received_from("door", type::heartbeat);
  const auto packets = sent(door, type::log_entries);
  REQUIRE_FALSE(answered.empty());
  // One during the outage; after the return, the oldest entry first (the outage's own rate
  // steps follow after later heartbeats).
  REQUIRE(packets.size() >= 2);
  CHECK(packets[1].from > at_s(3600));
  // After the first heartbeat heard (and answered, since it asked), within its few seconds.
  const host::HubPacket* first = nullptr;
  for (const host::HubPacket& packet : answered) {
    if (first == nullptr && packet.at > at_s(3600)) {
      first = &packet;
    }
  }
  REQUIRE(first != nullptr);
  CHECK(packets[1].from > first->at);
  CHECK(packets[1].from < first->at + seconds(3));
  CHECK(sensor_logs(bench, "door", roles::sensor::sensor_log::low_battery).size() == 1);
  CHECK_FALSE(logged(door, roles::sensor::sensor_log::low_battery));
}

TEST_CASE(
    "section 6: one lost link-check reply already holds the entry; the next answered "
    "heartbeat brings it") {
  Bench bench;
  host::SimDevice& door = bench.add();
  // Four heartbeats in touch; the fifth asks for a reply.
  for (int step = 0; step < 200 && sent(door, type::heartbeat).size() < 4; ++step) {
    bench.sim.run_for(seconds(10));
  }
  REQUIRE(sent(door, type::heartbeat).size() == 4);
  bench.sim.run_for(seconds(15));
  const Instant fifth = retained_state(door).timers.at(roles::sensor::SensorTimer::next_heartbeat);
  const Instant before = fifth + (Instant{} - (Instant{} + seconds(1)));
  // The battery reads low at the fifth (a warning), and only that heartbeat's reply is lost.
  bench.sim.schedule(before, [&]() {
    door.board().sensor_io.battery_mv = 3400;
    bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(),
                                             std::numeric_limits<double>::infinity());
  });
  bench.sim.schedule(fifth + milliseconds(1180), [&]() {
    bench.sim.medium().set_path_loss(bench.hub.station(), door.station(), 100.0);
  });
  bench.sim.run_until(fifth + seconds(600));
  const auto beats = sent(door, type::heartbeat);
  REQUIRE(beats.size() >= 6);
  CHECK(received<protocol::Heartbeat>(bench, "door")[4].flags.reply_wanted);
  // Held after the fifth (one miss); it goes after the sixth, which asks and is answered.
  CHECK(door.records()
            .kind(RecordKind::transmission)
            .type(type::log_entries)
            .between(beats[4].from, beats[5].from)
            .count() == 0);
  const auto packets = sent(door, type::log_entries);
  REQUIRE_FALSE(packets.empty());
  CHECK(packets[0].from > beats[5].until);
  CHECK(packets[0].from < beats[5].until + seconds(2));
  CHECK(sensor_logs(bench, "door", roles::sensor::sensor_log::low_battery).size() == 1);
}

}  // namespace
}  // namespace hsn::test::sensor
