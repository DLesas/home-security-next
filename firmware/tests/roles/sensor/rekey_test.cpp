// The sensor's part of the key change after a hub restore (m3-updates-design.md section 7, protocol
// section 7 "Key change after a restore"): a Key change bound to any of its packets changes the key
// (SecureChannel::change_key), and the sensor says again, under the new key, what it was saying: a
// heartbeat asking for a reply after a heartbeat; its report after a report, a door report with its
// age still counting from the opening. Counters restart at one step (64), and nothing goes under
// the old key once the new one is in flash. Against the test hub's restore().

#include <cstring>
#include <map>
#include <string>

#include "sensor_bench.hpp"
#include "test_transmitter.hpp"

namespace hsn::test::sensor {
namespace {

using host::HubVerdict;

/** Cuts the path between the sensor and the hub's radio, both ways. */
void cut(Bench& bench, host::SimDevice& door) {
  bench.sim.medium().cut(door.station(), bench.hub.station());
}

void mend(Bench& bench, host::SimDevice& door) {
  bench.sim.medium().set_path_loss(door.station(), bench.hub.station(), 100.0);
}

/** The true instant the pairing record was last written whole. */
Instant key_written(host::SimDevice& door) {
  Instant last;
  for (const Record& record : door.records().kind(RecordKind::flash_write).records()) {
    if (record.value == static_cast<std::uint32_t>(device::StoreKey::pairing) && !record.flag) {
      last = record.at;
    }
  }
  return last;
}

/** Every packet the hub had from the sensor; none failed its tag, and old-key ones came first. */
void check_keys(Bench& bench, host::SimDevice& door) {
  const auto switched = bench.hub.decisions(HubAction::key_changed, "door");
  REQUIRE(switched.size() == 1);
  const Instant written = key_written(door);
  std::map<std::uint32_t, std::size_t> under_new;
  for (const host::HubPacket& packet : all_received(bench, "door")) {
    CAPTURE(packet.counter);
    CHECK(packet.verdict != HubVerdict::bad_tag);
    if (packet.verdict == HubVerdict::old_key) {
      // Nothing under the old key once the new one is in flash.
      CHECK(packet.at <= written);
    } else if (packet.at >= switched[0].at) {
      CHECK(packet.counter >= 64);
      under_new[packet.counter] += 1;
    }
  }
  for (const auto& entry : under_new) {
    CAPTURE(entry.first);
    CHECK(entry.second == 1);
  }
}

/**
 * True when the sensor logged a failed key change with `text` ("key change failed 3"): still in
 * its buffer, or already sent to the hub after a heartbeat.
 */
bool failure_logged(Bench& bench, host::SimDevice& door, const std::string& text) {
  for (const host::HubLogEntry& entry : bench.hub.log_entries_from("door")) {
    if (entry.code == device::log_code::key_change_failed && entry.text == text) {
      return true;
    }
  }
  device::CoreRetained core;
  std::memcpy(&core, door.board().retained.contents().data() + device::kRetainedHeaderSize,
              sizeof(core));
  for (std::size_t i = 0; i < core.log.count && i < device::kLogCapacity; ++i) {
    const device::LogRecord& record = core.log.records[(core.log.start + i) % device::kLogCapacity];
    if (record.code == device::log_code::key_change_failed &&
        std::string(record.text.begin(), record.text.begin() + record.text_size) == text) {
      return true;
    }
  }
  return false;
}

/** The sensor's packets of one type as the hub had them, whatever their verdict. */
std::vector<host::HubPacket> got(Bench& bench, std::uint8_t of_type) {
  std::vector<host::HubPacket> out;
  for (const host::HubPacket& packet : all_received(bench, "door")) {
    if (packet.type == of_type) {
      out.push_back(packet);
    }
  }
  return out;
}

/**
 * The hub answers a heartbeat at its reply moment (§7): the Key change for one, sealed with the
 * key the restored hub made and bound to that heartbeat, is sent from a second radio then. (The
 * test hub sends its own as soon as possible, when a sensor that sent a heartbeat is not
 * listening; that one goes unheard.)
 */
struct HeartbeatRekey {
  HeartbeatRekey() {
    door = &bench.add();
    bench.run_to(20);
    bench.hub.restore(bench.hub.snapshot());
    // The next heartbeat (3 minutes ± 10%), under the old key, makes the hub draw a new key.
    while (got(bench, type::heartbeat).empty()) {
      bench.run_to(static_cast<double>(bench.sim.now().us) / 1e6 + 1);
    }
    const host::HubPacket old = got(bench, type::heartbeat)[0];
    REQUIRE(old.verdict == HubVerdict::old_key);
    const auto next_key = bench.hub.next_key_of("door");
    REQUIRE(next_key.has_value());
    protocol::KeyChange change;
    change.new_key = *next_key;
    const auto heartbeat = sent(*door, type::heartbeat);
    REQUIRE(heartbeat.size() == 1);
    TransmitterConfig hub2;
    hub2.channel = {device::kReplyFrequencyHz, 5};
    hub2.packets = {forge(*door, change, old.counter)};
    hub2.start = heartbeat[0].until + seconds(1);
    hub2.stop = hub2.start + seconds(5);
    add_transmitter(bench.sim, "hub2", hub2, 0x0BADBEEF);
    reply_moment = hub2.start;
  }

  Bench bench;
  host::SimDevice* door = nullptr;
  Instant reply_moment;
};

TEST_CASE("after a heartbeat, the Key change brings a heartbeat asking for a reply, at 64") {
  HeartbeatRekey world;
  Bench& bench = world.bench;
  host::SimDevice& door = *world.door;
  bench.run_to(260);
  INFO(door.records().kind(RecordKind::transmission).dump() << bench.hub.dump());
  CHECK_FALSE(bench.hub.rekey_pending("door"));
  // At once, a heartbeat with "reply wanted", counter 64, and the hub's reply heard.
  const auto switched = bench.hub.decisions(HubAction::key_changed, "door");
  REQUIRE(switched.size() == 1);
  const auto beats = got(bench, type::heartbeat);
  REQUIRE(beats.size() >= 2);
  const host::HubPacket& again = beats[1];
  CHECK(again.verdict == HubVerdict::accepted);
  CHECK(again.counter == 64);
  CHECK(again.as<protocol::Heartbeat>().flags.reply_wanted);
  CHECK(again.at - world.reply_moment < milliseconds(500));
  CHECK(switched[0].at == again.at);
  // Answered (at its reply moment) and heard: the sensor holds the restored hub's settings.
  CHECK(door.records().kind(RecordKind::reception).between(again.at, at_s(260)).count() >= 1);
  CHECK(retained_state(door).settings_version == bench.hub.settings_version("door"));
  CHECK(retained_state(door).heartbeat_again_at.is_never());
  check_keys(bench, door);
  // A change that worked logs no failure.
  CHECK_FALSE(logged(door, device::log_code::key_change_failed));
}

TEST_CASE("the new key's import refused at the change: the next seal imports it, at 64") {
  HeartbeatRekey world;
  world.door->board().key_import.fail_next = true;
  world.bench.run_to(260);
  INFO(world.door->records().kind(RecordKind::transmission).dump() << world.bench.hub.dump());
  // The import failed (step 3, logged at error, which a sensor keeps); the heartbeat's seal
  // imported the key, and it went at once.
  CHECK(failure_logged(world.bench, *world.door, "key change failed 3"));
  CHECK_FALSE(world.bench.hub.rekey_pending("door"));
  const auto beats = got(world.bench, type::heartbeat);
  REQUIRE(beats.size() >= 2);
  CHECK(beats[1].counter == 64);
  CHECK(beats[1].at - world.reply_moment < milliseconds(500));
  check_keys(world.bench, *world.door);
}

TEST_CASE("a heartbeat that cannot be sealed after the change goes a second later, at 64") {
  // Where the Key change is heard: a first run, the same as the second (the bench is exact).
  Instant heard;
  {
    HeartbeatRekey first;
    first.bench.run_to(200);
    const auto receptions = first.door->records()
                                .kind(RecordKind::reception)
                                .between(first.reply_moment, at_s(200))
                                .records();
    REQUIRE_FALSE(receptions.empty());
    heard = receptions[0].at;
  }
  HeartbeatRekey world;
  host::SimDevice& door = *world.door;
  // The change's own import is refused, and so is the one the heartbeat's seal makes, in the
  // event after the Key change's (scheduled from within that instant, so after its reception).
  door.board().key_import.fail_next = true;
  world.bench.sim.schedule(heard, [&]() {
    world.bench.sim.schedule(heard, [&]() { door.board().key_import.fail_next = true; });
  });
  world.bench.run_to(260);
  INFO(door.records().kind(RecordKind::transmission).dump() << world.bench.hub.dump());
  CHECK_FALSE(door.board().key_import.fail_next);
  const auto beats = got(world.bench, type::heartbeat);
  REQUIRE(beats.size() >= 2);
  CHECK(beats[1].counter == 64);
  // kHeartbeatAgainRetry after the failed try, which came the moment the Key change was heard.
  CHECK(beats[1].at - heard >= roles::sensor::kHeartbeatAgainRetry);
  CHECK(beats[1].at - heard < roles::sensor::kHeartbeatAgainRetry + milliseconds(200));
  CHECK_FALSE(world.bench.hub.rekey_pending("door"));
  check_keys(world.bench, door);
}

TEST_CASE("after a door report, the Key change brings it again with its age from the opening") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  bench.run_to(20);
  const host::HubSnapshot backup = bench.hub.snapshot();
  bench.hub.restore(backup);
  // The door opens at 60 s; its first tries go unheard, the one about 5 s on draws the Key change.
  bench.sim.schedule(at_s(59), [&]() { cut(bench, door); });
  bench.sim.schedule(at_s(64.5), [&]() { mend(bench, door); });
  door.set_input(Input::door, true, at_s(60));
  bench.run_to(80);
  INFO(door.records().kind(RecordKind::transmission).dump() << bench.hub.dump());
  const auto reports = got(bench, type::door_changed);
  REQUIRE(reports.size() >= 2);
  CHECK(reports[0].verdict == HubVerdict::old_key);
  const host::HubPacket& again = reports[1];
  CHECK(again.verdict == HubVerdict::accepted);
  CHECK(again.counter == 64);
  // Said again at once: the listening kept for old-key answers ends with the change.
  const auto changes = bench.hub.sent_to("door", type::key_change);
  REQUIRE(changes.size() == 1);
  CHECK(again.at - changes[0].at < milliseconds(400));
  // Its age counts from the opening, so the countdown does too (D106).
  const auto report = again.as<protocol::DoorChanged>();
  const std::int64_t elapsed = (again.at - at_s(60)).us / 1000000;
  CHECK(report.event_age_seconds == elapsed);
  CHECK(report.event_age_seconds >= 5);
  const auto countdown = bench.hub.decisions(HubAction::countdown_started, "door");
  REQUIRE(countdown.size() == 1);
  CHECK(countdown[0].value <= 30 - 5);
  // And the sensor heard the countdown under the new key: it buzzes.
  CHECK(retained_state(door).alert == roles::sensor::Alert::hub_countdown);
  check_keys(bench, door);
}

TEST_CASE("a Key change whose pairing record cannot be written changes nothing: drawn again") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(20);
  bench.hub.restore(bench.hub.snapshot());
  // Flash refuses every write from 59 s to 66 s: the first Key change, in answer to the door
  // report at 60 s, fails at step 1 and changes nothing.
  bench.sim.schedule(at_s(59), [&]() { door.board().storage.fail_writes = true; });
  bench.sim.schedule(at_s(66), [&]() { door.board().storage.fail_writes = false; });
  door.set_input(Input::door, true, at_s(60));
  bench.run_to(120);
  INFO(door.records().kind(RecordKind::transmission).dump() << bench.hub.dump());
  CHECK(failure_logged(bench, door, "key change failed 1"));
  // Its retries under the old key draw the Key change again (one every 10 s at most), which
  // then goes through, and the report is said again under the new key.
  const auto changes = bench.hub.sent_to("door", type::key_change);
  REQUIRE(changes.size() >= 2);
  CHECK(changes[1].at - changes[0].at >= seconds(10));
  CHECK_FALSE(bench.hub.rekey_pending("door"));
  const auto reports = got(bench, type::door_changed);
  REQUIRE_FALSE(reports.empty());
  CHECK(reports.back().verdict == HubVerdict::accepted);
  CHECK(reports.back().counter == 64);
  check_keys(bench, door);
}

}  // namespace
}  // namespace hsn::test::sensor
