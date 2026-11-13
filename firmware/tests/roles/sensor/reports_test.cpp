// The report exchange (protocol sections 2 and 7; DS3, DS9, DS12, LR3, LR5, FW7, D23, D106):
// every door, cover and button change goes at once with a reply wanted, the newest state, the
// change count and the event's age; unanswered tries follow the retry schedule with its random
// wait, never before the last try's listening ended, for up to 10 minutes; an essential report
// that does not fit the airtime budget waits and is never dropped.

#include <limits>

#include "sensor_bench.hpp"

namespace hsn::test::sensor {
namespace {

constexpr double kInfinite = std::numeric_limits<double>::infinity();

/** Loses every reply from the hub to the sensor from `when` on. */
void lose_replies(Bench& bench, host::SimDevice& door, Instant when) {
  bench.sim.schedule(when, [&bench, &door]() {
    bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(), kInfinite);
  });
}

/** A site that also allows DR0, the slowest rate, for long listening windows. */
host::HubOptions slow_site() {
  host::HubOptions options;
  options.allowed_data_rate_mask = 0x25;
  return options;
}

TEST_CASE("DS12, D23: a door change is sent at once, reply wanted, and answered") {
  Bench bench;
  host::SimDevice& door = bench.add();
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(40);
  const auto reports = sent(door, type::door_changed);
  REQUIRE(reports.size() == 1);
  // The 50 ms boot from deep sleep and the 3 ms channel check at SF7, nothing more.
  CHECK(reports[0].from == at_s(30.053));
  const auto decoded = received<protocol::DoorChanged>(bench, "door");
  REQUIRE(decoded.size() == 1);
  CHECK(decoded[0].flags.door_open);
  CHECK(decoded[0].flags.reply_wanted);
  CHECK(decoded[0].door_change_count == 1);
  CHECK(decoded[0].event_age_seconds == 0);
  CHECK(retained_state(door).waiting == 0);
}

TEST_CASE("DS9: a cover change is reported at once, with the door's state too") {
  Bench bench;
  host::SimDevice& door = bench.add();
  door.set_input(Input::cover, true, at_s(30));
  bench.run_to(40);
  const auto covers = received<protocol::CoverChanged>(bench, "door");
  REQUIRE(covers.size() == 1);
  CHECK(covers[0].flags.cover_open);
  CHECK_FALSE(covers[0].flags.door_open);
  CHECK(covers[0].flags.reply_wanted);
  CHECK(sent(door, type::cover_changed)[0].from == at_s(30.053));
}

TEST_CASE("DS3: a door change while a report is in flight sends the newest state before sleeping") {
  Bench bench;
  host::SimDevice& door = bench.add();
  door.set_input(Input::door, true, at_s(30));
  // Closed again while the first report is on the air.
  door.set_input(Input::door, false, at_s(30.08));
  bench.run_to(40);
  INFO(door.records().between(at_s(29), at_s(40)).dump());
  const auto decoded = received<protocol::DoorChanged>(bench, "door");
  REQUIRE(decoded.size() == 2);
  CHECK(decoded[0].flags.door_open);
  CHECK_FALSE(decoded[1].flags.door_open);
  CHECK(decoded[1].door_change_count == 2);
  // The second went once the first's reply came, and before the sensor slept again.
  const auto deep =
      door.records().kind(RecordKind::deep_sleep).between(at_s(30), at_s(40)).records();
  REQUIRE(deep.size() == 1);
  CHECK(sent(door, type::door_changed)[1].until < deep[0].at);
}

TEST_CASE(
    "DS3: while retries run, every try carries the newest state, and a change restarts the "
    "run") {
  Bench bench;
  host::SimDevice& door = bench.add();
  lose_replies(bench, door, at_s(20));
  door.set_input(Input::door, true, at_s(30));
  door.set_input(Input::door, false, at_s(36));
  bench.run_to(60);
  INFO(door.records().kind(RecordKind::transmission).between(at_s(29), at_s(60)).dump());
  const auto decoded = received<protocol::DoorChanged>(bench, "door");
  const auto tries = sent(door, type::door_changed);
  REQUIRE(tries.size() >= 6);
  // Tries before 36 s say open; every one after says closed, with the newest count.
  for (std::size_t i = 0; i < tries.size(); ++i) {
    INFO("try " << i);
    const bool before = tries[i].from < at_s(36);
    CHECK(decoded[i].flags.door_open == before);
    CHECK(decoded[i].door_change_count == (before ? 1 : 2));
  }
  // The close goes as soon as the listening of the try before it ended, and the next retries
  // count from the close: about 2 s after it, and so on.
  std::size_t first_closed = 0;
  while (first_closed < tries.size() && tries[first_closed].from < at_s(36)) {
    ++first_closed;
  }
  REQUIRE(first_closed + 1 < tries.size());
  CHECK(tries[first_closed + 1].from >= at_s(36 + 2));
  CHECK(tries[first_closed + 1].from <= at_s(36 + 3.2));
}

TEST_CASE("LR3, FW7, section 7: the retry schedule, its random wait, and the 10-minute limit") {
  Bench bench;
  host::SimDevice& door = bench.add();
  lose_replies(bench, door, at_s(20));
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(30 + 900);
  INFO(door.records().kind(RecordKind::transmission).dump());
  const auto tries = sent(door, type::door_changed);
  const Instant origin = at_s(30.05);
  // About 2, 5, 10 s, then every 60 s, the base offsets up to 600 s: 2, 5, 10, 70, …, 550.
  const std::int64_t base[] = {0, 2, 5, 10, 70, 130, 190, 250, 310, 370, 430, 490, 550};
  const std::int64_t gap[] = {0, 2, 3, 5, 60, 60, 60, 60, 60, 60, 60, 60, 60};
  REQUIRE(tries.size() == 13);
  bool some_wait = false;
  for (std::size_t i = 1; i < tries.size(); ++i) {
    INFO("try " << i);
    const Instant earliest = origin + seconds(base[i]);
    // Never before its base time, at most half the gap after it (plus the channel check).
    CHECK(tries[i].from >= earliest);
    CHECK(tries[i].from <= earliest + device::Duration{seconds(gap[i]).us / 2} + milliseconds(10));
    some_wait = some_wait || tries[i].from > earliest + seconds(1);
  }
  // The extra wait is random: not every try lands at its base time.
  CHECK(some_wait);
  // DS2: every wake of the run sends a try; none is spent on a heartbeat that would say nothing.
  const auto boots =
      door.records().kind(RecordKind::boot).between(origin, origin + seconds(620)).records();
  for (const Record& boot : boots) {
    INFO("boot at " << boot.at);
    CHECK(door.records()
              .kind(RecordKind::transmission)
              .between(boot.at, boot.at + seconds(1))
              .count() == 1);
  }
  // Then it gives up, and says so in its log (FW6).
  CHECK(retained_state(door).waiting == 0);
  CHECK(door.board().radio.calls_of(host::RadioCall::Kind::transmit).size() >= 13);
}

TEST_CASE("section 7: a retry never starts before the previous try's listening has ended") {
  // At DR0 the event listen time is 3 s and a report takes 1.5 s on air, so the 2 s retry
  // cannot start on time: it waits for the window's end.
  Bench bench(slow_site());
  host::SensorConfig settings;
  settings.send_data_rate = 0;
  settings.reply_data_rate = 0;
  host::SimDevice& door = bench.add("door", settings);
  lose_replies(bench, door, at_s(20));
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(60);
  const auto tries = sent(door, type::door_changed);
  const auto windows =
      door.records().kind(RecordKind::rx_window).between(at_s(30), at_s(60)).records();
  REQUIRE(tries.size() >= 4);
  REQUIRE(windows.size() >= 3);
  for (std::size_t i = 1; i < 4; ++i) {
    INFO("try " << i);
    CHECK(tries[i - 1].data_rate == 0);
    CHECK(windows[i - 1].until == tries[i - 1].until + heard_until(seconds(3), 0));
    CHECK(tries[i].from >= windows[i - 1].until);
  }
}

TEST_CASE("D106: a report that waits carries its age; the hub counts from the opening") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  lose_replies(bench, door, at_s(20));
  door.set_input(Input::door, true, at_s(30));
  // The hub hears nothing until 40 s.
  bench.sim.schedule(at_s(20), [&]() {
    bench.sim.medium().set_path_loss_one_way(door.station(), bench.hub.station(), kInfinite);
  });
  bench.sim.schedule(at_s(40), [&]() {
    bench.sim.medium().set_path_loss(door.station(), bench.hub.station(), 100.0);
  });
  bench.run_to(60);
  const auto decoded = received<protocol::DoorChanged>(bench, "door");
  REQUIRE_FALSE(decoded.empty());
  // The try at about 40 s says the door opened about 10 s before.
  CHECK(decoded[0].event_age_seconds >= 9);
  CHECK(decoded[0].event_age_seconds <= 11);
  const auto countdown = bench.hub.decisions(HubAction::countdown_started, "door");
  REQUIRE(countdown.size() == 1);
  CHECK(countdown[0].value <= 21);
}

TEST_CASE("checklist item 27: opened and closed while the chip boots: both changes count") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(20);
  REQUIRE(door.state() == host::PowerState::deep_sleep);
  // The wake fires on the opening; the door is shut again before the role reads it.
  door.set_input(Input::door, true, at_s(30));
  door.set_input(Input::door, false, at_s(30.02));
  bench.run_to(40);
  const auto decoded = received<protocol::DoorChanged>(bench, "door");
  REQUIRE(decoded.size() == 1);
  CHECK_FALSE(decoded[0].flags.door_open);
  CHECK(decoded[0].door_change_count == 2);
}

TEST_CASE("DS7: a short press is reported with action 1") {
  Bench bench;
  host::SimDevice& door = bench.add();
  door.hold_button(at_s(30), at_s(30.5));
  bench.run_to(40);
  const auto buttons = received<protocol::Button>(bench, "door");
  REQUIRE(buttons.size() == 1);
  CHECK(buttons[0].button_action == protocol::ButtonAction::short_press);
  CHECK(buttons[0].flags.reply_wanted);
}

TEST_CASE("one exchange: door, cover and button at once go one after another, door first") {
  Bench bench;
  host::SimDevice& door = bench.add();
  door.set_input(Input::cover, true, at_s(30));
  door.set_input(Input::door, true, at_s(30));
  door.hold_button(at_s(30.1), at_s(30.3));
  bench.run_to(40);
  CHECK(sent_names(door) == "started, door_changed, cover_changed, button");
  CHECK(retained_state(door).waiting == 0);
}

}  // namespace
}  // namespace hsn::test::sensor
