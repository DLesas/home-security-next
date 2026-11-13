// Listening windows at every data rate (protocol section 8; hardware notes section 3): with stop
// on preamble a reply that starts inside a window is received to its end, however far past the
// window that is. The role never sleeps or restarts the radio while a timed receive runs or a
// packet is arriving; it waits for the port to say the receive is over.

#include <limits>
#include <optional>

#include "device_support.hpp"
#include "hsn/device/services/radio_plan.hpp"
#include "hsn/host/host_board.hpp"
#include "sensor_bench.hpp"
#include "test_transmitter.hpp"

namespace hsn::test::sensor {
namespace {

using roles::sensor::symbol_time;

constexpr double kInfinite = std::numeric_limits<double>::infinity();

/** The heartbeat reply window's late margin at a rate: 50 ms plus 8 symbols (§8). */
device::Duration late_margin(std::uint8_t rate) {
  return milliseconds(50) + device::Duration{symbol_time(rate).us * 8};
}

/** Runs until the sensor has sent `count` heartbeats. */
void run_to_heartbeats(Bench& bench, host::SimDevice& door, std::size_t count) {
  for (int step = 0; step < 2000 && sent(door, type::heartbeat).size() < count; ++step) {
    bench.sim.run_for(seconds(5));
  }
  REQUIRE(sent(door, type::heartbeat).size() >= count);
}

/** Replies the sensor heard, from the timeline. */
std::vector<Record> replies_heard(host::SimDevice& door) {
  return door.records().kind(RecordKind::reception).type(type::reply).records();
}

TEST_CASE("section 8: a heartbeat reply sent at the reply moment is heard at every reply rate") {
  for (std::uint8_t rate = 0; rate <= 5; ++rate) {
    INFO("reply rate DR" << static_cast<int>(rate));
    Bench bench;
    host::SensorConfig settings;
    settings.reply_data_rate = rate;
    host::SimDevice& door = bench.add("door", settings);
    bench.run_to(10);
    // New settings: the next heartbeat holds the old version, so the hub answers it at the
    // reply rate of the version it holds, at the reply moment.
    bench.hub.change_sensor("door", settings);
    run_to_heartbeats(bench, door, 1);
    bench.sim.run_for(seconds(5));
    const auto beat = sent(door, type::heartbeat)[0];
    const auto heard = replies_heard(door);
    REQUIRE(heard.size() == 2);
    CHECK(heard[1].data_rate == rate);
    CHECK(heard[1].from == beat.until + seconds(1));
    CHECK(retained_state(door).settings_version == bench.hub.settings_version("door"));
    CHECK(door.state() == host::PowerState::deep_sleep);
  }
}

TEST_CASE("section 8, flag bit 7: a heartbeat reply at the sending rate is heard at every rate") {
  for (std::uint8_t rate = 0; rate <= 5; ++rate) {
    INFO("sending rate DR" << static_cast<int>(rate));
    host::HubOptions options;
    options.allowed_data_rate_mask = static_cast<std::uint8_t>(1u << rate);
    Bench bench(options);
    host::SimDevice& door = bench.add();
    // The hub hears Started but its replies are lost, through the whole retry run: the sensor
    // holds no version, so it listens at its sending rate and says so with bit 7.
    bench.sim.schedule(at_s(0), [&]() {
      bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(), kInfinite);
    });
    bench.sim.schedule(at_s(700), [&]() {
      bench.sim.medium().set_path_loss(bench.hub.station(), door.station(), 100.0);
    });
    bench.run_to(700);
    const std::size_t before = sent(door, type::heartbeat).size();
    run_to_heartbeats(bench, door, before + 1);
    bench.sim.run_for(seconds(5));
    const Record beat = sent(door, type::heartbeat)[before];
    const auto decoded = received<protocol::Heartbeat>(bench, "door");
    REQUIRE_FALSE(decoded.empty());
    CHECK(decoded.back().flags.listening_at_send_rate);
    CHECK(decoded.back().flags.reply_wanted);
    // The reply to that heartbeat, at its reply moment, at the sending rate.
    const auto heard = door.records()
                           .kind(RecordKind::reception)
                           .type(type::reply)
                           .between(beat.until, beat.until + seconds(5))
                           .records();
    // (The log entries packet that follows is answered too.)
    REQUIRE_FALSE(heard.empty());
    CHECK(heard[0].data_rate == rate);
    CHECK(heard[0].from == beat.until + seconds(1));
    CHECK(retained_state(door).misses == 0);
  }
}

TEST_CASE(
    "section 8: a heartbeat reply starting at the end of the late margin is heard; one "
    "starting after it is not, and costs no more than the window") {
  for (std::uint8_t rate = 0; rate <= 5; ++rate) {
    for (const bool in_time : {true, false}) {
      INFO("reply rate DR" << static_cast<int>(rate) << (in_time ? ", in time" : ", too late"));
      host::HubOptions options;
      const device::Duration edge = seconds(1) + late_margin(rate);
      options.reply_moment = in_time ? edge - milliseconds(1) : edge + milliseconds(1);
      Bench bench(options);
      host::SensorConfig settings;
      settings.reply_data_rate = rate;
      host::SimDevice& door = bench.add("door", settings);
      bench.run_to(10);
      bench.hub.change_sensor("door", settings);
      run_to_heartbeats(bench, door, 1);
      bench.sim.run_for(seconds(5));
      const Record beat = sent(door, type::heartbeat)[0];
      const auto windows = door.records()
                               .kind(RecordKind::rx_window)
                               .between(beat.until, beat.until + seconds(2))
                               .records();
      REQUIRE(windows.size() == 1);
      // The window: 20 ms early to the late margin, plus the confirmation symbols.
      const device::Duration window = milliseconds(20) + late_margin(rate);
      CHECK(windows[0].until - windows[0].at == heard_until(window, rate));
      const auto heard = replies_heard(door);
      if (in_time) {
        REQUIRE(heard.size() == 2);
        CHECK(heard[1].data_rate == rate);
      } else {
        CHECK(heard.size() == 1);
        // It timed out at the window's end and the radio slept then: nothing more was spent.
        const auto timeouts = door.records()
                                  .kind(RecordKind::rx_timeout)
                                  .between(beat.until, beat.until + seconds(5))
                                  .records();
        REQUIRE(timeouts.size() == 1);
        CHECK(timeouts[0].at == windows[0].until);
        CHECK(door.records()
                  .kind(RecordKind::rx_window)
                  .between(windows[0].until, beat.until + seconds(5))
                  .count() == 0);
      }
    }
  }
}

TEST_CASE(
    "section 8: a reply to a door report that starts in the last 10 ms of the event listen "
    "time is heard, at every reply rate") {
  for (std::uint8_t rate = 0; rate <= 5; ++rate) {
    INFO("reply rate DR" << static_cast<int>(rate));
    Bench bench;
    host::SensorConfig settings;
    settings.reply_data_rate = rate;
    host::SimDevice& door = bench.add("door", settings);
    bench.run_to(20);
    REQUIRE(door.state() == host::PowerState::deep_sleep);
    const std::uint32_t counter = next_counter(door);
    bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(), kInfinite);
    // The door report ends 0.114696 s after the opening (boot, check, 61.7 ms on air); its window
    // is the 1.5 s event listen time at DR5. The reply starts 5 ms before the window's end.
    protocol::Reply reply;
    reply.settings_version = bench.hub.settings_version("door");
    reply.countdown_seconds = 30;
    reply.heartbeat_interval_units = 12;
    reply.link_check_every = 5;
    reply.send_data_rate = 5;
    reply.reply_data_rate = rate;
    TransmitterConfig late;
    late.channel = {device::kReplyFrequencyHz, rate};
    late.packets = {forge(door, reply, counter)};
    late.start = at_s(30.114696 + 1.5 - 0.005);
    late.stop = at_s(40);
    add_transmitter(bench.sim, "hub2", late, 0x0BADBEEF);
    door.set_input(Input::door, true, at_s(30));
    bench.run_to(40);
    INFO(door.records().between(at_s(29.9), at_s(40)).dump());
    REQUIRE(sent(door, type::door_changed)[0].until == at_s(30.114696));
    // Heard whole (labelled unknown: the test hub did not seal it), and it answered the report.
    CHECK(door.records().kind(RecordKind::reception).between(at_s(31.5), at_s(40)).count() == 1);
    CHECK(retained_state(door).waiting == 0);
  }
}

/** One sensor board driven by hand, as in radio_faults_test.cpp. */
struct Hand {
  Hand() {
    pair_board(board, protocol::Role::sensor);
  }
  void boot(Instant when) {
    instance.reset();
    instance.emplace(board, board.sensor_io);
    board.clock.set(when);
    instance->runner.start(board.boot_event(device::BootKind::power_on));
  }
  void deliver(device::Event event, Instant when) {
    board.clock.set(when);
    event.now = when;
    instance->runner.deliver(event);
  }
  void radio(const device::RadioEvent& event, Instant when) {
    deliver(device::Event::from_radio(when, event), when);
  }
  void door(bool open, Instant when) {
    board.sensor_io.door = open;
    device::InputEvent input;
    input.input = Input::door;
    input.active = open;
    input.at = when;
    deliver(device::Event::from_input(when, input), when);
  }
  void wait_until(Instant when) {
    board.clock.set(when);
    instance->runner.timed_out(when);
  }
  std::uint32_t last_counter() const {
    const auto sends = board.radio.calls_of(host::RadioCall::Kind::transmit);
    const Bytes& packet = sends.back().packet;
    return static_cast<std::uint32_t>(packet[5]) | (static_cast<std::uint32_t>(packet[6]) << 8) |
           (static_cast<std::uint32_t>(packet[7]) << 16) |
           (static_cast<std::uint32_t>(packet[8]) << 24);
  }
  void send(Instant check, Instant end) {
    radio(board.radio.cad_done(check, false), check);
    radio(board.radio.tx_done(end), end);
  }
  std::size_t calls(host::RadioCall::Kind kind) const {
    return board.radio.calls_of(kind).size();
  }
  host::HostBoard board;
  std::optional<host::HostInstance<SensorRole>> instance;
};

Instant at_ms(std::int64_t ms) {
  return Instant{} + milliseconds(ms);
}

protocol::Reply hand_reply(bool armed, std::uint8_t remaining) {
  protocol::Reply out;
  out.settings_version = 2;
  out.flags.armed = armed;
  out.flags.countdown_started = remaining != 0;
  out.countdown_seconds = 30;
  out.countdown_remaining_seconds = remaining;
  out.heartbeat_interval_units = 12;
  out.link_check_every = 5;
  out.send_data_rate = 5;
  out.reply_data_rate = 5;
  return out;
}

void hand_started(Hand& hand, bool armed) {
  hand.boot(at_ms(0));
  hand.send(at_ms(3), at_ms(65));
  const std::uint32_t counter = hand.last_counter();
  hand.radio(
      hand.board.radio.rx_done(at_ms(200), hub_packet(hand_reply(armed, 0), 1,
                                                      protocol::Binding::sensor_packet(counter))),
      at_ms(200));
  REQUIRE(hand.instance->role.state().waiting == 0);
}

TEST_CASE("section 8: a reply still arriving when its window ends is received whole") {
  Hand hand;
  hand_started(hand, false);
  hand.door(true, at_ms(10000));
  hand.send(at_ms(10003), at_ms(10065));
  const std::uint32_t counter = hand.last_counter();
  const std::size_t receives = hand.calls(host::RadioCall::Kind::receive);
  const std::size_t sleeps = hand.calls(host::RadioCall::Kind::sleep);
  // Its header comes just before the window's end; the window ends; the packet goes on.
  hand.radio(hand.board.radio.header_seen(at_ms(11550)), at_ms(11550));
  hand.wait_until(at_ms(11700));
  CHECK(hand.calls(host::RadioCall::Kind::receive) == receives);
  CHECK(hand.calls(host::RadioCall::Kind::sleep) == sleeps);
  CHECK(hand.instance->role.next_wake().deepest == device::SleepDepth::light);
  hand.radio(
      hand.board.radio.rx_done(at_ms(11800), hub_packet(hand_reply(false, 0), 2,
                                                        protocol::Binding::sensor_packet(counter))),
      at_ms(11800));
  CHECK(hand.instance->role.state().waiting == 0);
  CHECK(hand.board.radio.calls.back().kind == host::RadioCall::Kind::sleep);
}

TEST_CASE(
    "section 8: the countdown ends while a reply arrives: the receive is not restarted, and "
    "the reply is heard whole") {
  Hand hand;
  hand_started(hand, true);
  hand.door(true, at_ms(10000));
  hand.send(at_ms(10003), at_ms(10065));
  const std::uint32_t opening = hand.last_counter();
  hand.radio(
      hand.board.radio.rx_done(at_ms(10300), hub_packet(hand_reply(true, 5), 2,
                                                        protocol::Binding::sensor_packet(opening))),
      at_ms(10300));
  REQUIRE(hand.instance->role.state().alert == roles::sensor::Alert::hub_countdown);
  // The door closes during the countdown: its report, then continuous listening again.
  hand.door(false, at_ms(12000));
  hand.send(at_ms(12003), at_ms(12065));
  const std::uint32_t closing = hand.last_counter();
  REQUIRE(hand.board.radio.calls_of(host::RadioCall::Kind::receive).back().rx.timeout.us == 0);
  const std::size_t receives = hand.calls(host::RadioCall::Kind::receive);
  // The closing's reply is arriving when the countdown ends at 15.3 s.
  hand.radio(hand.board.radio.header_seen(at_ms(15250)), at_ms(15250));
  hand.wait_until(at_ms(15300));
  CHECK(hand.instance->role.state().alert == roles::sensor::Alert::none);
  CHECK(hand.calls(host::RadioCall::Kind::receive) == receives);
  hand.radio(
      hand.board.radio.rx_done(at_ms(15400), hub_packet(hand_reply(true, 0), 3,
                                                        protocol::Binding::sensor_packet(closing))),
      at_ms(15400));
  CHECK(hand.instance->role.state().waiting == 0);
}

TEST_CASE(
    "DS6, section 8: an armed opening whose reply is still arriving when the window ends "
    "is answered, not unanswered: no local countdown") {
  Hand hand;
  hand_started(hand, true);
  hand.door(true, at_ms(10000));
  hand.send(at_ms(10003), at_ms(10065));
  const std::uint32_t counter = hand.last_counter();
  // The window ends at about 11.569 s; the reply started in it, and its header comes after.
  hand.radio(hand.board.radio.header_seen(at_ms(11620)), at_ms(11620));
  hand.wait_until(at_ms(11700));
  // Armed, and no countdown (the hub's ran out already, D106): nothing to sound.
  hand.radio(
      hand.board.radio.rx_done(at_ms(11800), hub_packet(hand_reply(true, 0), 2,
                                                        protocol::Binding::sensor_packet(counter))),
      at_ms(11800));
  CHECK(hand.instance->role.state().alert == roles::sensor::Alert::none);
  CHECK(hand.instance->role.state().misses == 0);
  CHECK(hand.board.sensor_io.sounds.back().value == device::Sound::off);
}

/** Lets the next heartbeat go and returns its counter; `end` is when its sending ended. */
std::uint32_t hand_heartbeat(Hand& hand, Instant& end) {
  const Instant due =
      hand.instance->role.state().timers.at(roles::sensor::SensorTimer::next_heartbeat);
  hand.wait_until(due);
  end = due + milliseconds(65);
  hand.send(due + milliseconds(3), end);
  return hand.last_counter();
}

TEST_CASE("section 8: a door change while a heartbeat's reply arrives waits for it, then goes") {
  Hand hand;
  hand_started(hand, false);
  Instant end;
  const std::uint32_t beat = hand_heartbeat(hand, end);
  // The reply window opens 0.98 s after the heartbeat; the reply's header comes in it.
  const Instant open = end + milliseconds(980);
  hand.wait_until(open);
  REQUIRE(hand.board.radio.calls.back().kind == host::RadioCall::Kind::receive);
  hand.radio(hand.board.radio.header_seen(open + milliseconds(40)), open + milliseconds(40));
  const std::size_t checks = hand.calls(host::RadioCall::Kind::detect_activity);
  hand.door(true, open + milliseconds(50));
  // Not over the arriving reply.
  CHECK(hand.calls(host::RadioCall::Kind::detect_activity) == checks);
  hand.radio(hand.board.radio.rx_done(
                 open + milliseconds(120),
                 hub_packet(hand_reply(true, 0), 4, protocol::Binding::sensor_packet(beat))),
             open + milliseconds(120));
  CHECK(hand.instance->role.state().armed);
  // Then at once.
  CHECK(hand.calls(host::RadioCall::Kind::detect_activity) == checks + 1);
}

TEST_CASE("section 8: a heartbeat falling due while the disarmed notice arrives does not cut it") {
  Hand hand;
  hand_started(hand, true);
  const Instant due =
      hand.instance->role.state().timers.at(roles::sensor::SensorTimer::next_heartbeat);
  // An opening 60 s before the heartbeat, with 120 s of countdown: listening continuously.
  const Instant open = due + (Instant{} - (Instant{} + seconds(60)));
  hand.door(true, open);
  hand.send(open + milliseconds(3), open + milliseconds(65));
  const std::uint32_t opening = hand.last_counter();
  hand.radio(hand.board.radio.rx_done(
                 open + milliseconds(300),
                 hub_packet(hand_reply(true, 120), 2, protocol::Binding::sensor_packet(opening))),
             open + milliseconds(300));
  REQUIRE(hand.instance->role.state().alert == roles::sensor::Alert::hub_countdown);
  // The notice's header comes just before the heartbeat is due.
  const Instant header = due + (Instant{} - (Instant{} + milliseconds(10)));
  hand.radio(hand.board.radio.header_seen(header), header);
  const std::size_t checks = hand.calls(host::RadioCall::Kind::detect_activity);
  hand.wait_until(due);
  CHECK(hand.calls(host::RadioCall::Kind::detect_activity) == checks);
  hand.radio(hand.board.radio.rx_done(due + milliseconds(40),
                                      hub_packet(protocol::DisarmedNotice{}, 3,
                                                 protocol::Binding::sensor_packet(opening))),
             due + milliseconds(40));
  CHECK(hand.board.sensor_io.sounds.back().value == device::Sound::off);
  CHECK_FALSE(hand.instance->role.state().armed);
}

TEST_CASE(
    "hardware notes section 3: a preamble with no packet behind it: the port's guard ends "
    "the receive, the radio sleeps, and the sensor sleeps deep") {
  Hand hand;
  hand_started(hand, false);
  hand.door(true, at_ms(10000));
  hand.send(at_ms(10003), at_ms(10065));
  hand.radio(hand.board.radio.header_seen(at_ms(10500)), at_ms(10500));
  // Nothing more comes. The guard: the longest packet at DR5 plus 100 ms after the header.
  const Instant guard = at_ms(10500) +
                        device::time_on_air(5, protocol::kMaxRadioPacketSize).value() +
                        milliseconds(100);
  CHECK(hand.instance->role.next_wake().at == guard);
  hand.wait_until(guard);
  CHECK(hand.calls(host::RadioCall::Kind::recover) == 1);
  // The window still has time: listening starts again for the rest of it, and times out.
  const auto receive = hand.board.radio.calls_of(host::RadioCall::Kind::receive).back();
  REQUIRE(receive.at == guard);
  const Instant end = guard + receive.rx.timeout;
  hand.radio(hand.board.radio.rx_timeout(end), end);
  CHECK(hand.board.radio.calls.back().kind == host::RadioCall::Kind::sleep);
  const device::Wake wake = hand.instance->role.next_wake();
  CHECK(wake.deepest == device::SleepDepth::deep);
  // The report is tried again on the schedule.
  CHECK(wake.at == hand.instance->role.state().timers.at(roles::sensor::SensorTimer::retry));
}

}  // namespace
}  // namespace hsn::test::sensor
