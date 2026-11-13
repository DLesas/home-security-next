// The button (DS7, DS8, D88, D89, PR3, PR4): short press, the 5-second pairing hold, the
// 15-second factory-reset hold, armed and not armed.

#include "sensor_bench.hpp"

namespace hsn::test::sensor {
namespace {

using device::Blink;

std::vector<Blink> blinks(host::SimDevice& door) {
  std::vector<Blink> out;
  for (const Record& record : door.records().kind(RecordKind::led).records()) {
    out.push_back(static_cast<Blink>(record.value));
  }
  return out;
}

void cut(Bench& bench, host::SimDevice& door, Instant when) {
  bench.sim.schedule(
      when, [&bench, &door]() { bench.sim.medium().cut(door.station(), bench.hub.station()); });
}

void mend(Bench& bench, host::SimDevice& door, Instant when) {
  bench.sim.schedule(when, [&bench, &door]() {
    bench.sim.medium().set_path_loss(door.station(), bench.hub.station(), 100.0);
  });
}

/** Button packets the hub accepted, as their actions. */
std::vector<std::uint8_t> actions(Bench& bench) {
  std::vector<std::uint8_t> out;
  for (const protocol::Button& button : received<protocol::Button>(bench, "door")) {
    out.push_back(button.button_action);
  }
  return out;
}

/** True instants of the board's erase of everything but the role. */
std::vector<Instant> erases(host::SimDevice& door) {
  std::vector<Instant> out;
  for (const Record& record : door.records().kind(RecordKind::flash_erase).records()) {
    if (record.value == 0xFF) {
      out.push_back(record.at);
    }
  }
  return out;
}

TEST_CASE("DS7, PR3: a 5-second hold while not armed opens the pairing window for 2 minutes") {
  Bench bench;
  host::SimDevice& door = bench.add();
  door.hold_button(at_s(30), at_s(36));
  bench.run_to(300);
  // The LED blinks at the 5 s mark, then shows the pairing window from the release to +2 min.
  // The press woke the chip, which booted 50 ms later; it then stayed in light sleep.
  CHECK(blinks(door) == std::vector<Blink>{Blink::short_once, Blink::pairing, Blink::off});
  const auto leds = door.records().kind(RecordKind::led).records();
  CHECK(leds[0].at == at_s(35.05));
  CHECK(leds[1].at == at_s(36));
  CHECK(leds[2].at == at_s(36 + 120));
  // Nothing is reported, and the sensor stays in light sleep while the window is open.
  CHECK(actions(bench).empty());
  CHECK(door.records().kind(RecordKind::deep_sleep).between(at_s(36), at_s(156)).count() == 0);
  CHECK(door.state() == host::PowerState::deep_sleep);
}

TEST_CASE("DS8: a pairing hold while armed is reported, and does nothing else") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  door.hold_button(at_s(30), at_s(37));
  bench.run_to(60);
  CHECK(actions(bench) == std::vector<std::uint8_t>{protocol::ButtonAction::pairing_hold_ignored});
  CHECK(blinks(door) == std::vector<Blink>{Blink::short_once});
  CHECK_FALSE(retained_state(door).pairing);
}

TEST_CASE("PR4, DS7: a 15-second hold while not armed: action 4 once, its listen window, erase") {
  Bench bench;
  host::SimDevice& door = bench.add();
  door.hold_button(at_s(30), at_s(46));
  bench.run_to(100);
  INFO(door.records().between(at_s(29), at_s(100)).dump());
  CHECK(blinks(door) == std::vector<Blink>{Blink::short_once, Blink::short_once});
  CHECK(actions(bench) ==
        std::vector<std::uint8_t>{protocol::ButtonAction::factory_reset_going_ahead});
  CHECK(received<protocol::Button>(bench, "door")[0].flags.reply_wanted);
  // Told just before erasing: the erase comes once the reply came, then the restart.
  const auto replies = door.records().kind(RecordKind::reception).type(type::reply).records();
  const auto erased = erases(door);
  REQUIRE(erased.size() == 1);
  CHECK(erased[0] == replies.back().until);
  CHECK(door.records().kind(RecordKind::restart).count() == 1);
  // Keys and settings gone, the role kept; setup-only mode now sends nothing.
  CHECK_FALSE(door.board().storage.has(device::StoreKey::pairing));
  CHECK_FALSE(door.board().storage.has(roles::sensor::kSettingsKey));
  CHECK(door.board().storage.has(device::StoreKey::role));
  CHECK(sent(door).back().label.type == type::button);
}

TEST_CASE("PR4: unanswered, action 4 goes once and the erase follows its listen window") {
  Bench bench;
  host::SimDevice& door = bench.add();
  cut(bench, door, at_s(20));
  door.hold_button(at_s(30), at_s(46));
  bench.run_to(100);
  const auto buttons = sent(door, type::button);
  REQUIRE(buttons.size() == 1);
  const auto erased = erases(door);
  REQUIRE(erased.size() == 1);
  CHECK(erased[0] == buttons[0].until + heard_until(milliseconds(1500), 5));
}

TEST_CASE(
    "D89: a reset hold while armed is reported and buzzes; the hub's armed answer refuses it") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  door.hold_button(at_s(30), at_s(46));
  bench.run_to(100);
  CHECK(actions(bench) ==
        std::vector<std::uint8_t>{protocol::ButtonAction::factory_reset_hold_while_armed});
  CHECK(sounds(door) == std::vector<Sound>{Sound::off, Sound::reset_warning, Sound::off});
  const auto replies = door.records().kind(RecordKind::reception).type(type::reply).records();
  CHECK(sound_times(door, Sound::off).back() == replies.back().until);
  CHECK(erases(door).empty());
  CHECK(door.board().storage.has(device::StoreKey::pairing));
  CHECK(retained_state(door).reset == roles::sensor::ResetPhase::none);
  CHECK(logged(door, roles::sensor::sensor_log::factory_reset_refused));
}

TEST_CASE(
    "D89: anything that answers armed refuses the reset: a door report answered while the "
    "reset's own report still waits") {
  // The hub answers 1.2 s after a report, so the door's reply comes after the hold ends.
  host::HubOptions options;
  options.processing = milliseconds(1200);
  Bench bench(options);
  host::SimDevice& door = bench.add();
  // Open at power-on (no report), armed from the start.
  door.set_input(Input::door, true, at_s(0));
  bench.hub.arm();
  door.hold_button(at_s(15.1), at_s(30.3));
  // Closed just before the release: its report's window is open when the hold ends, so the
  // reset's report cannot go yet.
  door.set_input(Input::door, false, at_s(30.2));
  bench.run_to(30.31);
  REQUIRE(retained_state(door).reset == roles::sensor::ResetPhase::armed_wait);
  CHECK(sent(door, type::button).empty());
  bench.run_to(800);
  INFO(door.records().between(at_s(29), at_s(40)).dump());
  const auto replies = door.records().kind(RecordKind::reception).type(type::reply).records();
  REQUIRE(replies.size() >= 2);
  // The door's reply said armed: refused at once, the warning stops with it, no erase ever.
  const auto warning = sound_times(door, Sound::reset_warning);
  REQUIRE(warning.size() == 1);
  CHECK(sound_times(door, Sound::off).back() == replies[1].until);
  CHECK(retained_state(door).reset == roles::sensor::ResetPhase::none);
  // Recorded, and by now sent to the hub after a heartbeat (D110).
  CHECK(sensor_logs(bench, "door", roles::sensor::sensor_log::factory_reset_refused).size() == 1);
  CHECK(erases(door).empty());
  // The hold is still reported (DS8).
  CHECK(actions(bench) ==
        std::vector<std::uint8_t>{protocol::ButtonAction::factory_reset_hold_while_armed});
}

TEST_CASE("D89: armed and nothing answers through the whole retry run: then the reset goes ahead") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  bench.run_to(10);
  cut(bench, door, at_s(20));
  door.hold_button(at_s(30), at_s(46));
  bench.run_to(46 + 700);
  INFO(door.records().kind(RecordKind::transmission).kind(RecordKind::buzzer).dump());
  const auto buttons = received<protocol::Button>(bench, "door");
  CHECK(buttons.empty());
  const auto tries = sent(door, type::button);
  REQUIRE(tries.size() == 14);
  // Thirteen tries of action 3 over the 10 minutes, the reset warning throughout, then action 4.
  const auto warning = sound_times(door, Sound::reset_warning);
  REQUIRE(warning.size() == 1);
  // Past the 15 s mark the chip may sleep deep again (a jammed button cannot keep it awake), so
  // the release at 46 s wakes it and the warning starts 50 ms later.
  CHECK(warning[0] == at_s(46.05));
  CHECK(tries[12].from < at_s(46 + 600));
  const auto erased = erases(door);
  REQUIRE(erased.size() == 1);
  // After the misses it sends at DR2, whose listen time is 2.2 s.
  CHECK(tries[13].data_rate == 2);
  CHECK(erased[0] == tries[13].until + heard_until(milliseconds(2200), 2));
  // The warning stops when the reset goes ahead, before action 4.
  std::size_t stops = 0;
  for (const Instant off : sound_times(door, Sound::off)) {
    if (off > warning[0]) {
      ++stops;
      CHECK(off < tries[13].from);
    }
  }
  CHECK(stops == 1);
  CHECK(door.records().kind(RecordKind::deep_sleep).between(at_s(46), erased[0]).count() == 0);
}

TEST_CASE("D89: armed, and a reply that says not armed lets the reset go ahead") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  bench.run_to(10);
  cut(bench, door, at_s(20));
  door.hold_button(at_s(30), at_s(46));
  bench.sim.schedule(at_s(60), [&]() { bench.hub.disarm(); });
  mend(bench, door, at_s(100));
  bench.run_to(300);
  INFO(bench.hub.dump());
  const auto heard = actions(bench);
  REQUIRE(heard.size() == 2);
  CHECK(heard[0] == protocol::ButtonAction::factory_reset_hold_while_armed);
  CHECK(heard[1] == protocol::ButtonAction::factory_reset_going_ahead);
  CHECK(erases(door).size() == 1);
}

TEST_CASE("D88: a short press during a reset is not a new report") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  bench.run_to(10);
  cut(bench, door, at_s(20));
  door.hold_button(at_s(30), at_s(46));
  door.hold_button(at_s(50), at_s(50.2));
  bench.run_to(60);
  CHECK(retained_state(door).button_action ==
        protocol::ButtonAction::factory_reset_hold_while_armed);
}

}  // namespace
}  // namespace hsn::test::sensor
