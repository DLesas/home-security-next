// Radio faults on a hand-driven board (design sections 3 and 4, RadioPort): a transmission whose
// end never comes, a fault while a report is listened for, and a fault during the hub's
// countdown. The radio's events are built by the fake and delivered by the test, so an event
// can be withheld or replaced by a fault.

#include <optional>

#include "device_support.hpp"
#include "hsn/device/services/radio_plan.hpp"
#include "hsn/host/host_board.hpp"
#include "hsn/roles/sensor/data_rates.hpp"
#include "hsn/roles/sensor/sensor_role.hpp"

namespace hsn::test {
namespace {

using device::Event;
using device::Instant;
using host::RadioCall;
using roles::sensor::SensorRole;

Instant at_ms(std::int64_t ms) {
  return Instant{} + device::milliseconds(ms);
}

/** One sensor board driven by hand: events go in at chosen instants. */
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

  void deliver(Event event, Instant when) {
    board.clock.set(when);
    event.now = when;
    instance->runner.deliver(event);
  }

  void radio(const device::RadioEvent& event, Instant when) {
    deliver(Event::from_radio(when, event), when);
  }

  void door(bool open, Instant when) {
    board.sensor_io.door = open;
    device::InputEvent input;
    input.input = device::Input::door;
    input.active = open;
    input.at = when;
    deliver(Event::from_input(when, input), when);
  }

  /** The Runner's wait reaches `when`: a timer event if the role is due. */
  void wait_until(Instant when) {
    board.clock.set(when);
    instance->runner.timed_out(when);
  }

  /** The counter of the latest packet the radio was given. */
  std::uint32_t last_counter() const {
    const auto sends = board.radio.calls_of(RadioCall::Kind::transmit);
    REQUIRE_FALSE(sends.empty());
    const Bytes& packet = sends.back().packet;
    return static_cast<std::uint32_t>(packet[5]) | (static_cast<std::uint32_t>(packet[6]) << 8) |
           (static_cast<std::uint32_t>(packet[7]) << 16) |
           (static_cast<std::uint32_t>(packet[8]) << 24);
  }

  /** True when the core's log holds an entry with `code`. */
  bool logged(std::uint16_t code) const {
    const device::LogState& log = instance->services.core.log;
    for (std::size_t i = 0; i < log.count; ++i) {
      if (log.records[(log.start + i) % device::kLogCapacity].code == code) {
        return true;
      }
    }
    return false;
  }

  /** Lets the channel check pass and the packet go out, ending at `end`. */
  void send(Instant check, Instant end) {
    radio(board.radio.cad_done(check, false), check);
    radio(board.radio.tx_done(end), end);
  }

  host::HostBoard board;
  std::optional<host::HostInstance<SensorRole>> instance;
};

/** A reply, armed or not, optionally with a countdown started. */
protocol::Reply reply(bool armed, std::uint8_t remaining = 0) {
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

/** Boots, sends Started and has it answered; returns the hand with the sensor idle. */
void started(Hand& hand, bool armed) {
  hand.boot(at_ms(0));
  hand.send(at_ms(3), at_ms(65));
  const std::uint32_t counter = hand.last_counter();
  hand.radio(
      hand.board.radio.rx_done(
          at_ms(200), hub_packet(reply(armed), 1, protocol::Binding::sensor_packet(counter))),
      at_ms(200));
  REQUIRE(hand.instance->role.state().waiting == 0);
}

TEST_CASE(
    "fault: a transmission whose end never comes: the guard recovers, logs, and the report "
    "is tried again on the schedule") {
  Hand hand;
  started(hand, false);
  hand.door(true, at_ms(10000));
  REQUIRE(hand.board.radio.calls_of(RadioCall::Kind::detect_activity).size() == 2);
  hand.radio(hand.board.radio.cad_done(at_ms(10003), false), at_ms(10003));
  REQUIRE(hand.board.radio.calls_of(RadioCall::Kind::transmit).size() == 2);
  // No tx_done. The guard: the time on air plus 100 ms.
  const device::Duration air = device::time_on_air(5, 25).value();
  const Instant guard = at_ms(10003) + air + device::milliseconds(100);
  CHECK(hand.instance->role.next_wake().at == guard);
  hand.wait_until(guard);
  CHECK(hand.board.radio.calls_of(RadioCall::Kind::recover).size() == 1);
  CHECK(hand.logged(device::log_code::radio_guard));
  CHECK(hand.logged(roles::sensor::sensor_log::radio_failed));
  // The next try is the schedule's first retry: about 2 s after the opening, plus up to 1 s.
  const Instant retry = hand.instance->role.state().timers.at(roles::sensor::SensorTimer::retry);
  CHECK(retry >= at_ms(12000));
  CHECK(retry <= at_ms(13000));
  CHECK(hand.instance->role.next_wake().at == retry);
  hand.wait_until(retry);
  CHECK(hand.board.radio.calls_of(RadioCall::Kind::detect_activity).size() == 3);
  CHECK(hand.instance->role.state().waiting != 0);
}

TEST_CASE(
    "fault: a radio fault while a report is listened for: listening starts again for the "
    "rest of the window, and the reply is heard") {
  Hand hand;
  started(hand, false);
  hand.door(true, at_ms(10000));
  hand.send(at_ms(10003), at_ms(10065));
  const std::uint32_t counter = hand.last_counter();
  REQUIRE(hand.board.radio.calls_of(RadioCall::Kind::receive).size() == 2);
  hand.radio(hand.board.radio.fault(at_ms(10565)), at_ms(10565));
  CHECK(hand.board.radio.calls_of(RadioCall::Kind::recover).size() == 1);
  const auto receives = hand.board.radio.calls_of(RadioCall::Kind::receive);
  REQUIRE(receives.size() == 3);
  // The window ran 1.5 s from the end of the transmission: 1 s of it is left.
  CHECK(receives.back().rx.timeout ==
        device::milliseconds(1000) + device::Duration{roles::sensor::symbol_time(5).us *
                                                      roles::sensor::kPreambleConfirmSymbols});
  CHECK(receives.back().rx.channel.frequency_hz == device::kReplyFrequencyHz);
  hand.radio(
      hand.board.radio.rx_done(
          at_ms(10800), hub_packet(reply(false), 2, protocol::Binding::sensor_packet(counter))),
      at_ms(10800));
  CHECK(hand.instance->role.state().waiting == 0);
  CHECK(hand.instance->role.next_wake().deepest == device::SleepDepth::deep);
}

TEST_CASE(
    "fault: a radio fault during the hub's countdown: continuous listening starts again, "
    "and the disarmed notice is still heard") {
  Hand hand;
  started(hand, true);
  hand.door(true, at_ms(10000));
  hand.send(at_ms(10003), at_ms(10065));
  const std::uint32_t counter = hand.last_counter();
  hand.radio(
      hand.board.radio.rx_done(
          at_ms(10300), hub_packet(reply(true, 29), 2, protocol::Binding::sensor_packet(counter))),
      at_ms(10300));
  REQUIRE(hand.instance->role.state().alert == roles::sensor::Alert::hub_countdown);
  REQUIRE(hand.board.radio.calls_of(RadioCall::Kind::receive).back().rx.timeout.us == 0);
  const std::size_t listens = hand.board.radio.calls_of(RadioCall::Kind::receive).size();
  hand.radio(hand.board.radio.fault(at_ms(15000)), at_ms(15000));
  CHECK(hand.board.radio.calls_of(RadioCall::Kind::recover).size() == 1);
  const auto receives = hand.board.radio.calls_of(RadioCall::Kind::receive);
  REQUIRE(receives.size() == listens + 1);
  CHECK(receives.back().rx.timeout.us == 0);
  CHECK(hand.board.sensor_io.sounds.back().value == device::Sound::countdown);
  hand.radio(
      hand.board.radio.rx_done(at_ms(20000), hub_packet(protocol::DisarmedNotice{}, 3,
                                                        protocol::Binding::sensor_packet(counter))),
      at_ms(20000));
  CHECK(hand.board.sensor_io.sounds.back().value == device::Sound::off);
  CHECK(hand.instance->role.state().alert == roles::sensor::Alert::none);
  CHECK_FALSE(hand.instance->role.state().armed);
  CHECK(hand.board.radio.calls.back().kind == RadioCall::Kind::sleep);
}

}  // namespace
}  // namespace hsn::test
