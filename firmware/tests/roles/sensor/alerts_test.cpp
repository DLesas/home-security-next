// The buzzer and the radio during an armed opening (DS6, DS12, DS13, DS14, LR7, D24, D71, D86,
// D88): the hub's countdown with continuous listening for the disarmed notice; and when the hub
// does not answer, the stored countdown counted from the opening, then about 3 minutes of the
// sensor's own alarm, stopped by a "not armed" reply or the button, and reported with flag bit 5.

#include <limits>

#include "sensor_bench.hpp"
#include "test_transmitter.hpp"

namespace hsn::test::sensor {
namespace {

constexpr double kInfinite = std::numeric_limits<double>::infinity();

void cut(Bench& bench, host::SimDevice& door, Instant when) {
  bench.sim.schedule(
      when, [&bench, &door]() { bench.sim.medium().cut(door.station(), bench.hub.station()); });
}

void mend(Bench& bench, host::SimDevice& door, Instant when) {
  bench.sim.schedule(when, [&bench, &door]() {
    bench.sim.medium().set_path_loss(door.station(), bench.hub.station(), 100.0);
  });
}

/** The true time of the receive windows that never time out (continuous). */
std::vector<Record> continuous_windows(host::SimDevice& door) {
  return door.records()
      .kind(RecordKind::rx_window)
      .where([](const Record& record) { return record.until.is_never(); })
      .records();
}

TEST_CASE("DS13, D24: buzzing for the hub's countdown, listening, stopped by the disarmed notice") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  door.set_input(Input::door, true, at_s(30));
  bench.sim.schedule(at_s(40), [&]() { bench.hub.disarm(); });
  bench.run_to(60);
  const auto notices = hub_sent(bench, type::disarmed_notice);
  REQUIRE(notices.size() == 2);
  CHECK(sounds(door) == std::vector<Sound>{Sound::off, Sound::countdown, Sound::off});
  CHECK(sound_times(door, Sound::off).back() == notices[0].until);
  // The radio listened continuously from the reply to the notice, and then slept with the chip.
  const auto windows = continuous_windows(door);
  REQUIRE(windows.size() == 1);
  CHECK(windows[0].at == sound_times(door, Sound::countdown)[0]);
  CHECK(door.state() == host::PowerState::deep_sleep);
  CHECK(door.records().kind(RecordKind::reception).type(type::disarmed_notice).count() == 1);
}

TEST_CASE(
    "section 4, D86: closing the door does not end the countdown; the notice, bound to the "
    "opening's report, is still accepted") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  door.set_input(Input::door, true, at_s(30));
  // Closed during the countdown: a new report, a newer counter, answered "countdown started".
  door.set_input(Input::door, false, at_s(35));
  bench.sim.schedule(at_s(45), [&]() { bench.hub.disarm(); });
  bench.run_to(60);
  INFO(bench.hub.dump());
  const auto reports = sent(door, type::door_changed);
  REQUIRE(reports.size() == 2);
  // Flag bit 6: the closing report says the sensor is buzzing; the opening's did not.
  const auto decoded = received<protocol::DoorChanged>(bench, "door");
  REQUIRE(decoded.size() == 2);
  CHECK_FALSE(decoded[0].flags.buzzing);
  CHECK(decoded[1].flags.buzzing);
  // The notice answers the opening, not the newest packet: the sensor tries its counters newest
  // first and accepts the older one.
  const auto notices = bench.hub.decisions(HubAction::disarmed_notice, "door");
  REQUIRE_FALSE(notices.empty());
  CHECK(notices[0].value == reports[0].label.counter);
  CHECK(sounds(door) == std::vector<Sound>{Sound::off, Sound::countdown, Sound::off});
  CHECK(sound_times(door, Sound::off).back() == hub_sent(bench, type::disarmed_notice)[0].until);
}

TEST_CASE("DS13, section 7: with nobody disarming, the buzzer stops when the countdown ends") {
  Bench bench;
  host::SensorConfig settings;
  settings.countdown_seconds = 20;
  host::SimDevice& door = bench.add("door", settings);
  bench.hub.arm();
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(80);
  const auto alarm = bench.hub.decisions(HubAction::alarm, "door");
  REQUIRE(alarm.size() == 1);
  const auto stops = sound_times(door, Sound::off);
  REQUIRE(stops.size() == 2);
  // At the hub's moment, to within the reply's whole seconds.
  CHECK(stops[1] >= alarm[0].at);
  CHECK(stops[1] <= alarm[0].at + seconds(1));
  CHECK(door.state() == host::PowerState::deep_sleep);
}

TEST_CASE("DS12, D71: the buzzer starts on the hub's word, even if the sensor believes disarmed") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  REQUIRE_FALSE(retained_state(door).armed);
  // Armed at 20 s; the sensor learns it only from the reply to its door report.
  bench.sim.schedule(at_s(20), [&]() { bench.hub.arm(); });
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(35);
  CHECK(sound_times(door, Sound::countdown).size() == 1);
  CHECK(retained_state(door).armed);
}

TEST_CASE("D86: a countdown of zero does not buzz") {
  Bench bench;
  host::SensorConfig settings;
  settings.countdown_seconds = 0;
  host::SimDevice& door = bench.add("door", settings);
  bench.hub.arm();
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(40);
  CHECK(sound_times(door, Sound::countdown).empty());
  CHECK(continuous_windows(door).empty());
}

TEST_CASE("D86, DS6: with a countdown of zero and no reply, the local alarm sounds at once") {
  Bench bench;
  host::SensorConfig settings;
  settings.countdown_seconds = 0;
  host::SimDevice& door = bench.add("door", settings);
  bench.hub.arm();
  bench.run_to(10);
  cut(bench, door, at_s(20));
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(100);
  CHECK(sound_times(door, Sound::countdown).empty());
  const auto alarm = sound_times(door, Sound::alarm);
  REQUIRE(alarm.size() == 1);
  CHECK(alarm[0] == sent(door, type::door_changed)[0].until + heard_until(milliseconds(1500), 5));
}

TEST_CASE(
    "DS6, DS14, D88: no reply while armed: stored countdown from the opening, then ~3 min "
    "of alarm while the retries go on") {
  Bench bench;
  host::SensorConfig settings;
  settings.countdown_seconds = 45;
  host::SimDevice& door = bench.add("door", settings);
  bench.hub.arm();
  bench.run_to(10);
  // DS14: the countdown length came in the reply and was stored.
  REQUIRE(retained_state(door).settings.countdown_seconds == 45);
  cut(bench, door, at_s(20));
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(30 + 400);
  INFO(door.records().kind(RecordKind::buzzer).kind(RecordKind::transmission).dump());
  const Instant opened = at_s(30.05);
  const auto countdown = sound_times(door, Sound::countdown);
  const auto alarm = sound_times(door, Sound::alarm);
  REQUIRE(countdown.size() == 1);
  REQUIRE(alarm.size() == 1);
  // After the first try's listening ended unanswered.
  const auto tries = sent(door, type::door_changed);
  CHECK(countdown[0] == tries[0].until + heard_until(milliseconds(1500), 5));
  // The stored countdown, counted from the opening, then about 3 minutes.
  CHECK(alarm[0] == opened + seconds(45));
  const auto offs = sound_times(door, Sound::off);
  CHECK(offs.back() == opened + seconds(45 + 180));
  // The retries went on while it sounded, and the radio slept between them (LR7).
  CHECK(sent(door, type::door_changed).size() >= 8);
  CHECK(continuous_windows(door).empty());
  // Light sleep while it sounded, deep again after.
  CHECK(
      door.records().kind(RecordKind::deep_sleep).between(opened, opened + seconds(225)).count() ==
      0);
  CHECK_FALSE(sensor_logs(bench, "door", roles::sensor::sensor_log::local_alarm).size() > 1);
}

TEST_CASE("D88: a press of the button stops the local alarm") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  bench.run_to(10);
  cut(bench, door, at_s(20));
  door.set_input(Input::door, true, at_s(30));
  door.hold_button(at_s(100), at_s(100.3));
  bench.run_to(400);
  // Stopped for good: the retries that follow, unanswered, do not start it again.
  REQUIRE(sound_times(door, Sound::alarm).size() == 1);
  CHECK(sound_times(door, Sound::off).back() == at_s(100));
  CHECK(sent(door, type::door_changed).back().from > at_s(150));
  CHECK(retained_state(door).alert == roles::sensor::Alert::none);
}

TEST_CASE("D88: a press during the local countdown stops it too, and no alarm follows") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  bench.run_to(10);
  cut(bench, door, at_s(20));
  door.set_input(Input::door, true, at_s(30));
  door.hold_button(at_s(40), at_s(40.2));
  bench.run_to(300);
  CHECK(sound_times(door, Sound::countdown).size() == 1);
  CHECK(sound_times(door, Sound::alarm).empty());
}

TEST_CASE(
    "DS6, D88: a reply that says not armed stops the local alarm; flag bit 5 reaches the hub") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  bench.run_to(10);
  cut(bench, door, at_s(20));
  door.set_input(Input::door, true, at_s(30));
  // The owner disarms in the app while the radio path is down, and the path comes back at 90 s.
  bench.sim.schedule(at_s(80), [&]() { bench.hub.disarm(); });
  mend(bench, door, at_s(90));
  bench.run_to(200);
  INFO(door.records().kind(RecordKind::buzzer).kind(RecordKind::transmission).dump()
       << bench.hub.dump());
  const auto alarm = sound_times(door, Sound::alarm);
  REQUIRE(alarm.size() == 1);
  // The first try after 90 s is answered "not armed": the alarm stops with that reply.
  const auto replies = door.records().kind(RecordKind::reception).type(type::reply).records();
  REQUIRE(replies.size() >= 2);
  CHECK(sound_times(door, Sound::off).back() == replies[1].until);
  CHECK(sound_times(door, Sound::off).back() < at_s(30 + 30 + 180));
  // The report that got through had bit 5 set, and the hub took note (§7).
  CHECK(bench.hub.decisions(HubAction::local_alarm_reported, "door").size() == 1);
  CHECK_FALSE(retained_state(door).local_alarm_sounded);
  // Later packets no longer say so.
  door.set_input(Input::door, false, at_s(250));
  bench.run_to(260);
  const auto decoded = received<protocol::DoorChanged>(bench, "door");
  CHECK_FALSE(decoded.back().flags.local_alarm_sounded);
}

TEST_CASE("DS6: an opening the hub answered does not sound the local alarm later") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  door.set_input(Input::door, true, at_s(30));
  // The countdown runs out (the hub's sirens), then the hub goes out of reach and the door is
  // closed: that report goes unanswered, but the opening itself was answered.
  cut(bench, door, at_s(90));
  door.set_input(Input::door, false, at_s(100));
  bench.run_to(400);
  CHECK(sound_times(door, Sound::alarm).empty());
  CHECK(sound_times(door, Sound::countdown).size() == 1);
}

TEST_CASE("DS6: the local alarm counts from the door report's first unanswered try") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  bench.run_to(10);
  // A restart sends Started; the door opens while Started is listened for, all unanswered.
  cut(bench, door, at_s(15));
  door.restart(at_s(20));
  door.set_input(Input::door, true, at_s(20.5));
  bench.run_to(60);
  const auto doors = sent(door, type::door_changed);
  REQUIRE_FALSE(doors.empty());
  const auto countdown = sound_times(door, Sound::countdown);
  REQUIRE(countdown.size() == 1);
  CHECK(countdown[0] == doors[0].until + heard_until(milliseconds(1500), 5));
}

TEST_CASE("DS6: an armed opening answered in time sounds no local alarm") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  door.set_input(Input::door, true, at_s(30));
  bench.sim.schedule(at_s(35), [&]() { bench.hub.disarm(); });
  bench.run_to(300);
  CHECK(sound_times(door, Sound::alarm).empty());
  CHECK_FALSE(retained_state(door).local_alarm_sounded);
}

TEST_CASE("DS6: while disarmed, an unanswered opening sounds nothing") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  cut(bench, door, at_s(20));
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(300);
  CHECK(sound_times(door, Sound::countdown).empty());
  CHECK(sound_times(door, Sound::alarm).empty());
  // The reports are still retried (LR3).
  CHECK(sent(door, type::door_changed).size() >= 5);
  static_cast<void>(kInfinite);
}

TEST_CASE(
    "section 6: the disarmed notice says not armed: a later unanswered opening sounds nothing, "
    "and a reply that says armed arms the sensor again") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  door.set_input(Input::door, true, at_s(30));
  bench.sim.schedule(at_s(40), [&]() { bench.hub.disarm(); });
  door.set_input(Input::door, false, at_s(50));
  // The closing is answered before the hub is cut off: its reply says not armed anyway; the
  // notice alone must do it, so lose every reply after the notice.
  bench.sim.schedule(at_s(40.5),
                     [&]() { bench.sim.medium().cut(door.station(), bench.hub.station()); });
  bench.run_to(45);
  REQUIRE(door.records().kind(RecordKind::reception).type(type::disarmed_notice).count() == 1);
  const roles::sensor::SensorState after = retained_state(door);
  CHECK_FALSE(after.armed);
  // The settings version is kept; the next reply corrects both.
  CHECK(after.settings_version == bench.hub.settings_version("door") - 1);
  // The hub is out of reach: the door reopens and goes unanswered, and nothing sounds.
  door.set_input(Input::door, true, at_s(60));
  bench.run_to(200);
  CHECK(sound_times(door, Sound::alarm).empty());
  CHECK(sound_times(door, Sound::countdown).size() == 1);
  // Armed again and back in reach: the hub last heard the door open, so it is armed when its
  // closing is heard (D114); that reply says so, and the sensor is armed.
  bench.hub.arm(host::OpenDoors::arm_when_closed);
  bench.sim.medium().set_path_loss(door.station(), bench.hub.station(), 100.0);
  door.set_input(Input::door, false, at_s(700));
  bench.run_to(710);
  CHECK(retained_state(door).armed);
}

TEST_CASE(
    "DS6, D106: an armed reply without a countdown leaves the local alarm sounding to its end, "
    "and flag bit 5 is delivered") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  bench.run_to(10);
  cut(bench, door, at_s(20));
  door.set_input(Input::door, true, at_s(30));
  // Back in reach while the local alarm sounds: the retry at about 100 s is answered "armed",
  // but the hub's countdown ran out long ago, so no countdown started (late report, D106).
  mend(bench, door, at_s(95));
  bench.run_to(300);
  INFO(bench.hub.dump());
  CHECK(bench.hub.decisions(HubAction::late_report_sirens, "door").size() == 1);
  const auto replies = door.records().kind(RecordKind::reception).type(type::reply).records();
  REQUIRE(replies.size() >= 2);
  const auto alarm = sound_times(door, Sound::alarm);
  REQUIRE(alarm.size() == 1);
  CHECK(replies[1].until > alarm[0]);
  // Still sounding to its end, 3 minutes after the stored countdown from the opening.
  CHECK(sound_times(door, Sound::off).back() == at_s(30.05 + 30 + 180));
  CHECK(bench.hub.decisions(HubAction::local_alarm_reported, "door").size() == 1);
  CHECK_FALSE(retained_state(door).local_alarm_sounded);
}

TEST_CASE("section 6: the second disarmed notice is recognised and ignored, not logged") {
  // A hub that answers 1.2 s after a report, so the closing's window is still open when the
  // second notice comes.
  host::HubOptions options;
  options.processing = milliseconds(1200);
  Bench bench(options);
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  door.set_input(Input::door, true, at_s(30));
  bench.sim.schedule(at_s(40), [&]() { bench.hub.disarm(); });
  // The person closes the door just after the first notice; the second comes at 42 s.
  door.set_input(Input::door, false, at_s(41.8));
  bench.run_to(60);
  INFO(door.records().between(at_s(39), at_s(46)).dump());
  CHECK(door.records().kind(RecordKind::reception).type(type::disarmed_notice).count() == 2);
  CHECK_FALSE(logged(door, roles::sensor::sensor_log::hub_packet_rejected));
  CHECK_FALSE(retained_state(door).armed);
  CHECK(sounds(door) == std::vector<Sound>{Sound::off, Sound::countdown, Sound::off});
  // The closing is still answered.
  CHECK(retained_state(door).waiting == 0);
}

TEST_CASE("section 6: the second notice does not undo a re-arming that came between the two") {
  host::HubOptions options;
  options.processing = milliseconds(1200);
  Bench bench(options);
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  door.set_input(Input::door, true, at_s(30));
  bench.sim.schedule(at_s(40), [&]() { bench.hub.disarm(); });
  // Re-armed at once, the door still open: armed by the closing (D114), whose reply (at about
  // 41.6 s) tells the sensor so.
  bench.sim.schedule(at_s(40.2), [&]() { bench.hub.arm(host::OpenDoors::arm_when_closed); });
  door.set_input(Input::door, false, at_s(40.3));
  // A cover report's window is open when the second notice comes at 42 s.
  door.set_input(Input::cover, true, at_s(41.8));
  bench.run_to(42.5);
  INFO(door.records().between(at_s(39), at_s(42.5)).dump());
  CHECK(door.records().kind(RecordKind::reception).type(type::disarmed_notice).count() == 2);
  CHECK(retained_state(door).armed);
}

TEST_CASE("section 6: a packet for this sensor failing for any other reason is still a warning") {
  // After the countdown's settled counters are gone (a new opening), its notices no longer open.
  host::HubOptions options;
  options.processing = milliseconds(1200);
  Bench bench(options);
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  door.set_input(Input::door, true, at_s(30));
  bench.sim.schedule(at_s(40), [&]() { bench.hub.disarm(); });
  door.set_input(Input::door, false, at_s(41.0));
  // Reopened just before the second notice: its report's window is open when the copy comes.
  door.set_input(Input::door, true, at_s(41.8));
  bench.run_to(60);
  INFO(door.records().between(at_s(39), at_s(46)).dump());
  // The second notice is heard in the reopening's window, and no longer opens.
  CHECK(door.records()
            .kind(RecordKind::reception)
            .type(type::disarmed_notice)
            .between(at_s(41.8), at_s(43))
            .count() == 1);
  CHECK(logged(door, roles::sensor::sensor_log::hub_packet_rejected));
}

TEST_CASE(
    "section 2: buzzing for the countdown, the door closes on a busy channel; the notice "
    "comes during the busy wait, is heard, and the buzzer stops") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  door.set_input(Input::door, true, at_s(30));
  // Another device keeps the site channel busy from 39.5 s to 45 s.
  TransmitterConfig jam;
  jam.channel = {868300000u, 5};
  jam.packets = {std::vector<std::uint8_t>(255, 0x5A)};
  jam.start = at_s(39.5);
  jam.stop = at_s(45);
  jam.repeat = true;
  bench.run_to(39);
  add_transmitter(bench.sim, "jammer", jam, 0x0BADBEEF);
  door.set_input(Input::door, false, at_s(40));
  bench.sim.schedule(at_s(40.3), [&]() { bench.hub.disarm(); });
  bench.run_to(60);
  INFO(door.records().between(at_s(39.9), at_s(47)).dump());
  const auto checks =
      door.records().kind(RecordKind::channel_check).between(at_s(40), at_s(45)).records();
  REQUIRE_FALSE(checks.empty());
  CHECK(checks[0].flag);
  const auto notices =
      door.records().kind(RecordKind::reception).type(type::disarmed_notice).records();
  REQUIRE_FALSE(notices.empty());
  const auto closing = sent(door, type::door_changed);
  REQUIRE(closing.size() == 2);
  // Heard while the closing report still waited for a clear channel.
  CHECK(notices[0].at > checks[0].at);
  CHECK(notices[0].at < closing[1].from);
  CHECK(sound_times(door, Sound::off).back() == notices[0].at);
  CHECK_FALSE(retained_state(door).armed);
  CHECK(retained_state(door).waiting == 0);
}

}  // namespace
}  // namespace hsn::test::sensor
