// The sensor's part of firmware updates (m3-updates-design.md sections 2, 5 and 6): healthy only on
// the reply to its Started; the update query over LoRa when a reply says "update available", and
// only then or at a start-up; the update service's packets on the network link while it is up for
// an update, and over LoRa otherwise, answered by an offer or a reply bound to them; its own
// refusals (armed, the battery floor) at their edges; and the door reported exactly as without an
// update. Against the test hub in direct radio mode, with the fake slots and bootloader.

#include <algorithm>

#include "hsn/host/test_image.hpp"
#include "sensor_bench.hpp"
#include "test_transmitter.hpp"

namespace hsn::test::sensor {
namespace {

using host::UpdateMethod;
using host::UpdateState;
using roles::sensor::kUpdateBatteryFloorMillivolts;

const protocol::FirmwareVersion kNew{1, 4, 0};

bool same(const protocol::FirmwareVersion& a, const protocol::FirmwareVersion& b) {
  return a.major == b.major && a.minor == b.minor && a.patch == b.patch;
}

/** The hub's update statuses from the sensor, decoded, with how each came. */
struct GotStatus {
  Instant at;
  host::HubPath path = host::HubPath::radio;
  protocol::UpdateStatus status;
};
std::vector<GotStatus> statuses(Bench& bench, const std::string& name = "door") {
  std::vector<GotStatus> out;
  for (const host::HubPacket& packet : bench.hub.received_from(name, type::update_status)) {
    out.push_back(GotStatus{packet.at, packet.path, packet.as<protocol::UpdateStatus>()});
  }
  return out;
}

/** The sensor's packets of one type on its network link. */
std::size_t on_link(host::SimDevice& device, std::uint8_t of_type) {
  return device.records().kind(RecordKind::link_sent).type(of_type).count();
}

/** Cuts the path between the sensor and the hub's radio, both ways. */
void cut(Bench& bench, host::SimDevice& door) {
  bench.sim.medium().cut(door.station(), bench.hub.station());
}

void mend(Bench& bench, host::SimDevice& door) {
  bench.sim.medium().set_path_loss(door.station(), bench.hub.station(), 100.0);
}

/** An offer of `action` for an image id, as a hub would make it. */
protocol::UpdateOffer offer_of(std::uint8_t action, std::uint8_t id_byte = 0x5A) {
  protocol::UpdateOffer offer;
  offer.action = action;
  offer.image_id.fill(id_byte);
  offer.file_bytes = 30000;
  offer.version = kNew;
  offer.bluetooth_window_units = 12;
  return offer;
}

TEST_CASE("update over Wi-Fi: a LoRa query at the reply's flag, the image on the link, a trial") {
  Bench bench;
  host::SimDevice& door = bench.add();
  const host::HubImage& image = bench.hub.add_image(host::make_test_image(kNew, 30000));
  bench.hub.offer_update("door", image.id, UpdateMethod::join_wifi);
  bench.run_to(120);
  INFO(door.records().dump() << bench.hub.dump());
  CHECK(bench.hub.update_of("door").state == UpdateState::confirmed);
  CHECK(same(door.boot_choice().image.version, kNew));
  CHECK_FALSE(door.board().slots.running().on_trial);
  // The query went over LoRa, once the reply to Started said "update available"; then on the link
  // the service joined, which identifies it to the hub (section 5).
  const auto lora_queries = sent(door, type::update_query);
  REQUIRE(lora_queries.size() == 1);
  CHECK(lora_queries[0].from > sent(door, type::started)[0].until);
  CHECK(on_link(door, type::update_query) >= 1);
  // The service leaves Wi-Fi once the image is verified (the go-ahead may wait for days): verified,
  // installing and, after the new image's Started, confirmed go over LoRa, each answered.
  const auto got = statuses(bench);
  std::vector<std::uint8_t> stages;
  for (const GotStatus& status : got) {
    stages.push_back(status.status.stage);
    CHECK(status.path == host::HubPath::radio);
  }
  CHECK(stages == std::vector<std::uint8_t>{protocol::UpdateStage::verified,
                                            protocol::UpdateStage::installing,
                                            protocol::UpdateStage::confirmed});
  CHECK(on_link(door, type::update_status) == 0);
  // "Installing" was on the air whole before the restart it announces.
  const auto lora_statuses = sent(door, type::update_status);
  REQUIRE(lora_statuses.size() == 3);
  const auto restarts = door.records().kind(RecordKind::restart).records();
  REQUIRE(restarts.size() == 1);
  CHECK(restarts[0].at >= lora_statuses[1].until);
  CHECK(restarts[0].at < lora_statuses[1].until + device::milliseconds(1));
  // Healthy only on the reply bound to the new image's Started: otadata's confirm comes after it.
  const auto started = sent(door, type::started);
  REQUIRE(started.size() == 2);
  const auto replies =
      door.records().kind(RecordKind::reception).between(started[1].until, at_s(120)).records();
  REQUIRE_FALSE(replies.empty());
  const auto otadata = door.records().kind(RecordKind::otadata_write).records();
  REQUIRE_FALSE(otadata.empty());
  CHECK(otadata.back().at >= replies.front().at);
  // The door's reports never left LoRa, and nothing was written on trial.
  CHECK(on_link(door, type::door_changed) == 0);
  CHECK(door.board().slots.writes_on_trial() == 0);
  // Asleep deep at the end, and never deep while it downloaded.
  CHECK(door.state() == host::PowerState::deep_sleep);
  CHECK(door.records()
            .kind(RecordKind::deep_sleep)
            .between(lora_queries[0].from, restarts[0].at)
            .count() == 0);
}

/** Runs a bench in steps of 10 ms until `done` holds; fails past `limit` seconds. */
template <typename Done>
double run_until_true(Bench& bench, double limit, Done done) {
  for (double t = 0.01; t <= limit; t += 0.01) {
    bench.run_to(t);
    if (done()) {
      return t;
    }
  }
  FAIL("the condition never held");
  return limit;
}

TEST_CASE("the trial: no reply to Started for 10 minutes rolls back; one inside them confirms") {
  for (const bool reply_late : {false, true}) {
    CAPTURE(reply_late);
    Bench bench;
    host::SimDevice& door = bench.add();
    const host::HubImage& image = bench.hub.add_image(host::make_test_image(kNew, 20000));
    bench.hub.offer_update("door", image.id, UpdateMethod::join_wifi);
    // The restart into the new image: from it on, the hub does not hear the sensor.
    const double trial_s = run_until_true(
        bench, 120, [&]() { return door.records().kind(RecordKind::restart).count() == 1; });
    cut(bench, door);
    const Instant trial = at_s(trial_s);
    if (reply_late) {
      // Heard again after nine minutes: the next Started (every 60 s) is answered in time.
      bench.sim.schedule(at_s(trial_s + 9 * 60), [&]() { mend(bench, door); });
    }
    bench.run_to(trial_s + 10 * 60 - 1);
    INFO(door.records().kind(RecordKind::transmission).dump() << bench.hub.dump());
    REQUIRE(door.board().slots.running().on_trial == !reply_late);
    REQUIRE(same(door.boot_choice().image.version, kNew));
    // Started is tried again and again, and the trial image never sleeps deep (D134): not until
    // it is confirmed (otadata's last write), or the deadline.
    const Instant trial_end =
        reply_late ? door.records().kind(RecordKind::otadata_write).records().back().at
                   : at_s(trial_s + 599);
    CHECK(trial_end > at_s(trial_s + 9 * 60));
    CHECK(door.records().kind(RecordKind::deep_sleep).between(trial, trial_end).count() == 0);
    CHECK(sent(door, type::started).size() >= 6);
    if (reply_late) {
      CHECK_FALSE(door.board().slots.running().on_trial);
      CHECK(same(door.boot_choice().image.version, kNew));
      bench.run_to(trial_s + 12 * 60);
      CHECK(same(door.boot_choice().image.version, kNew));
      CHECK(bench.hub.update_of("door").state == UpdateState::confirmed);
    } else {
      // Still on trial a second before the deadline, rolled back after it.
      CHECK(door.board().slots.running().on_trial);
      CHECK(same(door.boot_choice().image.version, kNew));
      bench.run_to(trial_s + 10 * 60 + 5);
      CHECK_FALSE(same(door.boot_choice().image.version, kNew));
      CHECK(door.boot_choice().image.rolled_back);
      mend(bench, door);
      bench.run_to(trial_s + 12 * 60);
      CHECK(bench.hub.update_of("door").state == UpdateState::rolled_back);
    }
  }
}

TEST_CASE("a door opening during a download is reported over LoRa exactly as without one") {
  struct Run {
    device::Duration first_try;
    device::Duration first_end;
    bool downloading = false;
    std::size_t answered = 0;
  };
  const auto run = [](bool update) {
    Bench bench;
    host::SimDevice& door = bench.add();
    const host::HubImage& image = bench.hub.add_image(host::make_test_image(kNew, 60000));
    if (update) {
      bench.hub.offer_update("door", image.id, UpdateMethod::join_wifi);
    }
    // The download runs from about 0.6 s to 1.6 s.
    door.set_input(Input::door, true, at_s(1));
    bench.run_to(60);
    INFO(door.records().between(at_s(0.9), at_s(3)).dump() << bench.hub.dump());
    Run out;
    const auto tries = sent(door, type::door_changed);
    REQUIRE_FALSE(tries.empty());
    out.first_try = tries[0].from - at_s(1);
    out.first_end = tries[0].until - at_s(1);
    // Pieces were served before and after the opening: it came in the middle of the download.
    bool before = false;
    bool after = false;
    for (const host::HubTransfer& transfer : bench.hub.transfers()) {
      before = before || transfer.at < at_s(1);
      after = after || transfer.at > tries[0].until;
    }
    out.downloading = before && after;
    out.answered = counters_of(bench, "door", type::door_changed).size();
    if (update) {
      CHECK(bench.hub.update_of("door").state == UpdateState::confirmed);
    }
    return out;
  };
  const Run plain = run(false);
  const Run updating = run(true);
  CHECK_FALSE(plain.downloading);
  CHECK(updating.downloading);
  // No later than without the update (awake for the download, it does not even boot first), at
  // the same rate and length.
  CHECK(updating.first_try <= plain.first_try);
  CHECK(updating.first_end - updating.first_try == plain.first_end - plain.first_try);
  CHECK(plain.answered == 1);
  CHECK(updating.answered == 1);
}

/**
 * A sensor that heard "armed" (or not) from the hub, then a cover report the hub does not hear,
 * answered by an offer the test seals with the sensor's key, bound to that report: the hub, heard
 * again, gets whatever the sensor then says.
 */
struct ForgedOffer {
  explicit ForgedOffer(bool armed, const protocol::UpdateOffer& offer,
                       std::uint16_t battery_mv = 3900, bool usb = false) {
    door = &bench.add();
    door->board().sensor_io.battery_mv = battery_mv;
    double from = 5;
    if (armed) {
      bench.hub.arm();
      // The next heartbeat (3 minutes ± 10%) is answered with the new version: armed.
      from = 210;
    }
    if (usb) {
      door->set_input(Input::external_power, true, at_s(from - 2));
    }
    bench.run_to(from);
    REQUIRE(retained_state(*door).armed == armed);
    cut(bench, *door);
    // Read while it waits: the cover report takes the next counter. With USB power it never
    // sleeps deep, so the counter comes from the running channel.
    const std::uint32_t counter =
        usb ? door->role<SensorRole>().state().last_counter + 1 : next_counter(*door);
    TransmitterConfig hub2;
    hub2.channel = {device::kReplyFrequencyHz, 5};
    hub2.packets = {forge(*door, offer, counter)};
    hub2.start = at_s(from + 10.4);
    hub2.stop = at_s(from + 20);
    add_transmitter(bench.sim, "hub2", hub2, 0x0BADBEEF);
    door->set_input(Input::cover, true, at_s(from + 10));
    // Heard again before the 5 s retry of the cover report.
    bench.sim.schedule(at_s(from + 14.5), [this]() { mend(bench, *door); });
    bench.run_to(from + 60);
  }

  Bench bench;
  host::SimDevice* door = nullptr;
};

TEST_CASE("an armed sensor refuses to join Wi-Fi, open Bluetooth or install, and says so") {
  for (const std::uint8_t action :
       {protocol::UpdateAction::join_wifi_and_fetch, protocol::UpdateAction::open_bluetooth,
        protocol::UpdateAction::install_now}) {
    CAPTURE(static_cast<int>(action));
    ForgedOffer world(true, offer_of(action));
    INFO(world.door->records().kind(RecordKind::transmission).dump() << world.bench.hub.dump());
    const auto got = statuses(world.bench);
    REQUIRE(got.size() == 1);
    CHECK(got[0].path == host::HubPath::radio);
    CHECK(got[0].status.stage == protocol::UpdateStage::refused);
    CHECK(got[0].status.reason == protocol::UpdateReason::armed);
    CHECK(got[0].status.image_id == offer_of(action).image_id);
    // Nothing of it happened: no Wi-Fi, no Bluetooth window, nothing selected.
    CHECK(world.door->board().network.connects == 0);
    CHECK(world.door->board().bluetooth.connects == 0);
    CHECK(world.door->records().kind(RecordKind::otadata_write).count() == 0);
    // The cover report it answered still went, and was answered once heard.
    CHECK(counters_of(world.bench, "door", type::cover_changed).size() >= 1);
  }
}

TEST_CASE("armed, the sensor passes on what does not take it from its door: wait, discard") {
  for (const std::uint8_t action :
       {protocol::UpdateAction::wait, protocol::UpdateAction::nothing}) {
    CAPTURE(static_cast<int>(action));
    ForgedOffer world(true, offer_of(action));
    // Neither is refused by the sensor, and neither held anything to cancel.
    CHECK(statuses(world.bench).empty());
  }
}

TEST_CASE(
    "the battery floor: refused below it, taken at it, taken on USB power whatever the cell") {
  struct Case {
    std::uint16_t millivolts;
    bool usb;
    bool refused;
  };
  for (const Case c :
       {Case{static_cast<std::uint16_t>(kUpdateBatteryFloorMillivolts - 1), false, true},
        Case{kUpdateBatteryFloorMillivolts, false, false}, Case{3000, true, false}}) {
    CAPTURE(c.millivolts);
    CAPTURE(c.usb);
    ForgedOffer world(false, offer_of(protocol::UpdateAction::open_bluetooth), c.millivolts, c.usb);
    INFO(world.bench.hub.dump());
    const auto got = statuses(world.bench);
    if (c.refused) {
      REQUIRE(got.size() == 1);
      CHECK(got[0].status.stage == protocol::UpdateStage::refused);
      CHECK(got[0].status.reason == protocol::UpdateReason::battery);
      CHECK(world.door->board().bluetooth.connects == 0);
    } else {
      // Taken: the update window opened (and, with no phone near, ended).
      CHECK(world.door->board().bluetooth.connects == 1);
      for (const GotStatus& status : got) {
        CHECK(status.status.reason != protocol::UpdateReason::battery);
      }
    }
  }
}

TEST_CASE("out of Wi-Fi range: noWifi over LoRa, answered, and the sensor sleeps deep again") {
  Bench bench;
  host::SensorConfig settings;
  settings.wifi_in_range = false;
  host::SimDevice& door = bench.add("door", settings);
  const host::HubImage& image = bench.hub.add_image(host::make_test_image(kNew, 20000));
  bench.hub.offer_update("door", image.id, UpdateMethod::join_wifi);
  bench.run_to(120);
  INFO(door.records().dump() << bench.hub.dump());
  const auto got = statuses(bench);
  REQUIRE(got.size() == 1);
  CHECK(got[0].path == host::HubPath::radio);
  CHECK(got[0].status.stage == protocol::UpdateStage::refused);
  CHECK(got[0].status.reason == protocol::UpdateReason::no_wifi);
  CHECK(bench.hub.update_of("door").state == UpdateState::refused);
  // The hub answered it, and the sensor went back to deep sleep.
  CHECK(door.records().kind(RecordKind::deep_sleep).between(got[0].at, at_s(120)).count() >= 1);
  CHECK(door.state() == host::PowerState::deep_sleep);
}

TEST_CASE("a part held: no query at deep-sleep wakes, one at the next start-up") {
  Bench bench;
  host::SimDevice& door = bench.add();
  const host::HubImage& image = bench.hub.add_image(host::make_test_image(kNew, 60000));
  bench.hub.offer_update("door", image.id, UpdateMethod::join_wifi);
  // Mid-download the network goes away for good: after two minutes, linkLost, the part kept.
  static_cast<void>(run_until_true(
      bench, 10, [&]() { return door.records().kind(RecordKind::slot_write).count() >= 2; }));
  REQUIRE(bench.hub.update_of("door").state == UpdateState::fetching);
  door.board().network.fail_connect = true;
  bench.hub.drop_link("door", device::LinkKind::network);
  bench.run_to(200);
  INFO(door.records().kind(RecordKind::transmission).dump() << bench.hub.dump());
  const auto got = statuses(bench);
  REQUIRE_FALSE(got.empty());
  CHECK(got.back().status.reason == protocol::UpdateReason::link_lost);
  CHECK(door.board().storage.has(device::StoreKey::update));
  const std::size_t queries = sent(door, type::update_query).size();
  // Ten minutes of heartbeats, each a deep-sleep wake with the part held: no query.
  bench.run_to(800);
  CHECK(door.records().kind(RecordKind::deep_sleep).between(at_s(200), at_s(800)).count() >= 3);
  CHECK(sent(door, type::update_query).size() == queries);
  // A reset is a start-up: Started, then one query saying what it holds.
  door.restart(at_s(801));
  bench.run_to(830);
  const auto after = bench.hub.received_from("door", type::update_query);
  REQUIRE_FALSE(after.empty());
  CHECK(after.back().at > at_s(801));
  CHECK(after.back().as<protocol::UpdateQuery>().held == protocol::UpdateHeld::part);
  CHECK(sent(door, type::update_query).size() == queries + 1);
}

}  // namespace
}  // namespace hsn::test::sensor
