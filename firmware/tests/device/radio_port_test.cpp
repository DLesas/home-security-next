// The radio port: listen before sending, the airtime budget, and the guard (protocol section 2).

#include "hsn/device/services/radio_port.hpp"
#include "device_support.hpp"
#include "hsn/host/fake_clock.hpp"
#include "hsn/host/fake_radio.hpp"
#include "hsn/host/fake_random.hpp"
#include "hsn/protocol/radio.hpp"

namespace hsn::test {
namespace {

using device::PortResult;
using device::PortState;
using device::Status;
using host::RadioCall;

struct Fixture {
  host::FakeClock clock;
  host::FakeRadio radio{clock};
  host::FakeRandom hardware{9};
  device::RandomSource random{hardware};
  device::AirtimeState airtime_state;
  device::AirtimeBudget airtime{airtime_state};
  device::LogState log_state;
  device::LogBuffer log{log_state};
  device::RadioPort port{radio, airtime, random, log};
  Bytes packet = Bytes(25, 0x10);

  device::Transmission sensor_at(std::uint8_t data_rate,
                                 device::TxClass tx_class = device::TxClass::essential) const {
    device::Transmission transmission;
    transmission.channel = {868300000, data_rate};
    transmission.tx_class = tx_class;
    return transmission;
  }

  /** Delivers a radio event at the current time. */
  device::PortReport deliver(const device::RadioEvent& event) {
    return port.on_radio(event, clock.now());
  }

  /** The siren's command receive: continuous, on 869.525 MHz at DR5. */
  static device::RxParams command_receive() {
    device::RxParams params;
    params.channel = {device::kReplyFrequencyHz, protocol::DataRate::dr5};
    return params;
  }

  /** Sends at DR5 and answers the first check busy: the port is then in its first busy wait. */
  void send_into_busy_wait() {
    REQUIRE(port.send(view_of(packet), sensor_at(protocol::DataRate::dr5), clock.now()) ==
            Status::ok);
    clock.advance(device::milliseconds(3));
    deliver(radio.cad_done(clock.now(), true));
    REQUIRE(port.state() == PortState::backing_off);
  }

  /** Moves the clock to the port's deadline and runs it. */
  device::PortReport run_deadline() {
    clock.set(port.next_deadline());
    return port.on_timer(clock.now());
  }
};

TEST_CASE("a clear channel check is followed by the transmission, which is counted") {
  Fixture f;
  f.clock.set(at_seconds(100));
  REQUIRE(f.port.send(view_of(f.packet), f.sensor_at(protocol::DataRate::dr3), f.clock.now()) ==
          Status::ok);
  const auto cads = f.radio.calls_of(RadioCall::Kind::detect_activity);
  REQUIRE(cads.size() == 1);
  CHECK(cads[0].cad.symbols == 4);
  CHECK(cads[0].cad.detect_peak == 23);
  CHECK(cads[0].cad.detect_min == 10);
  CHECK(f.port.state() == PortState::checking);
  f.clock.advance(device::milliseconds(20));
  CHECK(f.deliver(f.radio.cad_done(f.clock.now(), false)).result == PortResult::none);
  const auto sent = f.radio.calls_of(RadioCall::Kind::transmit);
  REQUIRE(sent.size() == 1);
  CHECK(sent[0].packet == f.packet);
  CHECK(sent[0].channel.frequency_hz == 868300000u);
  CHECK(f.airtime.used_last_hour(device::Band::g1, f.clock.now()) ==
        device::milliseconds(210));  // 206 ms, rounded up to 10 ms
  f.clock.advance(device::milliseconds(206));
  const auto report = f.deliver(f.radio.tx_done(f.clock.now()));
  CHECK(report.result == PortResult::sent);
  CHECK(report.at == f.clock.now());
  CHECK(f.port.state() == PortState::idle);
}

TEST_CASE("a busy channel is checked five times with random waits, then the packet goes anyway") {
  Fixture f;
  REQUIRE(f.port.send(view_of(f.packet), f.sensor_at(protocol::DataRate::dr5), f.clock.now()) ==
          Status::ok);
  for (int check = 1; check < 5; ++check) {
    f.clock.advance(device::milliseconds(3));
    f.deliver(f.radio.cad_done(f.clock.now(), true));
    REQUIRE(f.port.state() == PortState::backing_off);
    const device::Duration wait = f.port.next_deadline() - f.clock.now();
    CHECK(wait >= device::milliseconds(200));
    CHECK(wait <= device::milliseconds(2000));
    f.clock.set(f.port.next_deadline());
    f.port.on_timer(f.clock.now());
    REQUIRE(f.port.state() == PortState::checking);
  }
  f.clock.advance(device::milliseconds(3));
  f.deliver(f.radio.cad_done(f.clock.now(), true));
  CHECK(f.radio.calls_of(RadioCall::Kind::detect_activity).size() == 5);
  CHECK(f.radio.calls_of(RadioCall::Kind::transmit).size() == 1);
  CHECK(f.port.state() == PortState::sending);
}

TEST_CASE("over budget: routine traffic is skipped, essential traffic is told when it fits") {
  Fixture f;
  f.clock.set(at_seconds(7200));
  f.airtime.record(device::Band::g1, f.clock.now(), device::milliseconds(29000));
  CHECK(f.port.send(view_of(f.packet),
                    f.sensor_at(protocol::DataRate::dr0, device::TxClass::routine),
                    f.clock.now()) == Status::deferred);
  CHECK(f.port.send(view_of(f.packet), f.sensor_at(protocol::DataRate::dr0), f.clock.now()) ==
        Status::ok);
  f.deliver(f.radio.cad_done(f.clock.now(), false));
  f.deliver(f.radio.tx_done(f.clock.now() + device::milliseconds(1483)));
  f.airtime.record(device::Band::g1, f.clock.now(), device::milliseconds(5000));
  const device::Admission later =
      f.port.check(f.sensor_at(protocol::DataRate::dr0), f.packet.size(), f.clock.now());
  CHECK_FALSE(later.allowed);
  CHECK(later.earliest > f.clock.now());
  CHECK(f.port.send(view_of(f.packet), f.sensor_at(protocol::DataRate::dr0), f.clock.now()) ==
        Status::deferred);
  CHECK(f.radio.calls_of(RadioCall::Kind::transmit).size() == 1);
}

TEST_CASE("an operation whose event never comes is recovered at its guard deadline") {
  Fixture f;
  device::Transmission direct = f.sensor_at(protocol::DataRate::dr5);
  direct.listen_first = false;
  REQUIRE(f.port.send(view_of(f.packet), direct, f.clock.now()) == Status::ok);
  CHECK(f.port.send(view_of(f.packet), direct, f.clock.now()) == Status::busy);
  f.clock.set(f.port.next_deadline());
  CHECK(f.port.on_timer(f.clock.now()).result == PortResult::recovered);
  CHECK(f.radio.calls_of(RadioCall::Kind::recover).size() == 1);
  CHECK(f.port.state() == PortState::idle);
  CHECK(f.log.size() == 1);
}

TEST_CASE("timed and continuous receives") {
  Fixture f;
  device::RxParams timed;
  timed.channel = {device::kReplyFrequencyHz, protocol::DataRate::dr5};
  timed.timeout = device::seconds(2);
  REQUIRE(f.port.listen(timed, f.clock.now()) == Status::ok);
  CHECK(f.port.next_deadline() > f.clock.now() + device::seconds(2));
  const Bytes reply(30, 0x18);
  f.clock.advance(device::milliseconds(700));
  CHECK(f.deliver(f.radio.rx_done(f.clock.now(), reply)).result == PortResult::received);
  CHECK(f.port.state() == PortState::idle);
  REQUIRE(f.port.listen(timed, f.clock.now()) == Status::ok);
  CHECK(f.deliver(f.radio.rx_timeout(f.clock.now())).result == PortResult::rx_timeout);

  device::RxParams continuous = timed;
  continuous.timeout = device::Duration{};
  REQUIRE(f.port.listen(continuous, f.clock.now()) == Status::ok);
  CHECK(f.port.next_deadline().is_never());
  CHECK(f.deliver(f.radio.rx_done(f.clock.now(), reply)).result == PortResult::received);
  CHECK(f.port.state() == PortState::receiving);
  f.port.sleep(f.clock.now());
  CHECK(f.radio.mode() == host::RadioMode::sleeping);
}

TEST_CASE("a refused radio command is reported, not hidden") {
  Fixture f;
  f.radio.fail_next = device::HalError::io;
  CHECK(f.port.send(view_of(f.packet), f.sensor_at(protocol::DataRate::dr5), f.clock.now()) ==
        Status::radio_error);
  CHECK(f.port.state() == PortState::idle);
  const Bytes too_short(5);
  CHECK(f.port.send(view_of(too_short), f.sensor_at(protocol::DataRate::dr5), f.clock.now()) ==
        Status::refused);
}

TEST_CASE("a continuous receive running at send() is resumed in every busy wait") {
  Fixture f;
  REQUIRE(f.port.listen(Fixture::command_receive(), f.clock.now()) == Status::ok);
  f.send_into_busy_wait();
  const auto receives = f.radio.calls_of(RadioCall::Kind::receive);
  REQUIRE(receives.size() == 2);
  CHECK(receives[1].rx.channel.frequency_hz == device::kReplyFrequencyHz);
  CHECK(receives[1].rx.channel.data_rate == protocol::DataRate::dr5);
  CHECK(receives[1].rx.timeout == device::Duration{});
  CHECK(f.radio.mode() == host::RadioMode::receiving);
  CHECK(f.port.listening_while_waiting());
  // The wait ends: the next check runs as before; busy again, and the receive resumes again.
  CHECK(f.run_deadline().result == PortResult::none);
  CHECK(f.port.state() == PortState::checking);
  CHECK(f.radio.calls_of(RadioCall::Kind::detect_activity).size() == 2);
  f.deliver(f.radio.cad_done(f.clock.now(), true));
  CHECK(f.port.state() == PortState::backing_off);
  CHECK(f.radio.calls_of(RadioCall::Kind::receive).size() == 3);
}

TEST_CASE("a packet arriving during a busy wait is reported as received; the wait goes on") {
  Fixture f;
  REQUIRE(f.port.listen(Fixture::command_receive(), f.clock.now()) == Status::ok);
  f.send_into_busy_wait();
  const device::Instant wait_end = f.port.next_deadline();
  f.clock.advance(device::milliseconds(100));
  f.deliver(f.radio.header_seen(f.clock.now()));
  f.clock.advance(device::milliseconds(40));
  const Bytes command(30, 0x18);
  const device::PortReport heard = f.deliver(f.radio.rx_done(f.clock.now(), command));
  CHECK(heard.result == PortResult::received);
  CHECK(heard.at == f.clock.now());
  CHECK(f.port.state() == PortState::backing_off);
  CHECK(f.port.next_deadline() == wait_end);
  CHECK(f.radio.mode() == host::RadioMode::receiving);
  // A damaged packet is reported too.
  f.deliver(f.radio.header_seen(f.clock.now()));
  CHECK(f.deliver(f.radio.rx_crc_error(f.clock.now())).result == PortResult::rx_error);
  CHECK(f.port.state() == PortState::backing_off);
}

TEST_CASE("receiving comes first: a reception under way holds the next check until it ends") {
  Fixture f;
  REQUIRE(f.port.listen(Fixture::command_receive(), f.clock.now()) == Status::ok);
  f.send_into_busy_wait();
  const device::Instant wait_end = f.port.next_deadline();
  // A header arrives just before the wait would end.
  f.clock.set(wait_end + device::milliseconds(-1));
  f.deliver(f.radio.header_seen(f.clock.now()));
  CHECK(f.port.next_deadline() > wait_end);
  f.clock.set(wait_end);
  CHECK(f.port.on_timer(f.clock.now()).result == PortResult::none);
  CHECK(f.radio.calls_of(RadioCall::Kind::detect_activity).size() == 1);
  // The packet ends after the wait: the check follows at once.
  f.clock.advance(device::milliseconds(50));
  CHECK(f.deliver(f.radio.rx_done(f.clock.now(), Bytes(30, 0x18))).result == PortResult::received);
  CHECK(f.port.next_deadline() <= f.clock.now());
  f.port.on_timer(f.clock.now());
  CHECK(f.port.state() == PortState::checking);
  CHECK(f.radio.calls_of(RadioCall::Kind::detect_activity).size() == 2);
}

TEST_CASE("a reception that never ends holds the check only up to its guard") {
  Fixture f;
  REQUIRE(f.port.listen(Fixture::command_receive(), f.clock.now()) == Status::ok);
  f.send_into_busy_wait();
  f.deliver(f.radio.header_seen(f.clock.now()));
  const auto longest =
      device::time_on_air(protocol::DataRate::dr5, protocol::kMaxRadioPacketSize).value();
  const device::Instant guard = f.clock.now() + longest + device::kRadioGuardMargin;
  CHECK(f.port.next_deadline() == guard);
  f.clock.set(guard + device::milliseconds(-1));
  f.port.on_timer(f.clock.now());
  CHECK(f.port.state() == PortState::backing_off);
  f.clock.set(guard);
  f.port.on_timer(f.clock.now());
  CHECK(f.port.state() == PortState::checking);
  CHECK(f.log.size() == 1);
}

TEST_CASE("after the transmission the port is idle and does not listen; the role restarts it") {
  Fixture f;
  REQUIRE(f.port.listen(Fixture::command_receive(), f.clock.now()) == Status::ok);
  f.send_into_busy_wait();
  f.run_deadline();
  f.deliver(f.radio.cad_done(f.clock.now(), false));
  REQUIRE(f.port.state() == PortState::sending);
  CHECK(f.radio.mode() == host::RadioMode::transmitting);
  const std::size_t receives = f.radio.calls_of(RadioCall::Kind::receive).size();
  CHECK(f.deliver(f.radio.tx_done(f.clock.now() + device::milliseconds(62))).result ==
        PortResult::sent);
  CHECK(f.port.state() == PortState::idle);
  CHECK_FALSE(f.port.listening_while_waiting());
  CHECK(f.radio.calls_of(RadioCall::Kind::receive).size() == receives);
}

TEST_CASE("a send that began asleep or in a timed receive waits with the radio idle, as before") {
  for (const bool timed : {false, true}) {
    INFO("timed receive first: " << timed);
    Fixture f;
    if (timed) {
      device::RxParams params = Fixture::command_receive();
      params.timeout = device::seconds(2);
      REQUIRE(f.port.listen(params, f.clock.now()) == Status::ok);
    } else {
      f.port.sleep(f.clock.now());
    }
    const std::size_t receives = f.radio.calls_of(RadioCall::Kind::receive).size();
    f.send_into_busy_wait();
    CHECK_FALSE(f.port.listening_while_waiting());
    CHECK(f.radio.calls_of(RadioCall::Kind::receive).size() == receives);
    CHECK(f.radio.mode() == host::RadioMode::standby);
    // Radio events during the wait mean nothing to the port.
    CHECK(f.deliver(f.radio.rx_timeout(f.clock.now())).result == PortResult::none);
    CHECK(f.port.state() == PortState::backing_off);
  }
}

TEST_CASE("past the legal hour an essential packet goes after its gap, and each one is logged") {
  Fixture f;
  f.clock.set(at_seconds(7200));
  // The hour is spent; the last transmission ended now.
  f.airtime.record(device::Band::g1, f.clock.now() + device::seconds(-36), device::seconds(36));
  const auto transmission = f.sensor_at(protocol::DataRate::dr5);
  const auto airtime = device::time_on_air(protocol::DataRate::dr5, f.packet.size()).value();
  // check() and send() agree: refused, waiting for the gap.
  const device::Admission waiting = f.port.check(transmission, f.packet.size(), f.clock.now());
  CHECK_FALSE(waiting.allowed);
  CHECK(waiting.past_limit);
  CHECK(waiting.earliest == f.clock.now() + device::Duration{9 * airtime.us});
  CHECK(f.port.send(view_of(f.packet), transmission, f.clock.now()) == Status::deferred);
  // A routine packet is refused for the hour, not the gap.
  const device::Admission routine =
      f.port.check(f.sensor_at(protocol::DataRate::dr5, device::TxClass::routine), f.packet.size(),
                   f.clock.now());
  CHECK_FALSE(routine.past_limit);
  CHECK(routine.earliest > f.clock.now() + device::seconds(3000));
  // After the gap it goes, past the limit, logged as a warning.
  for (int packet = 0; packet < 3; ++packet) {
    f.clock.set(f.port.check(transmission, f.packet.size(), f.clock.now()).earliest);
    const device::Admission past = f.port.check(transmission, f.packet.size(), f.clock.now());
    CHECK(past.allowed);
    CHECK(past.past_limit);
    REQUIRE(f.port.send(view_of(f.packet), transmission, f.clock.now()) == Status::ok);
    f.deliver(f.radio.cad_done(f.clock.now(), false));
    REQUIRE(f.port.state() == PortState::sending);
    f.clock.advance(airtime);
    REQUIRE(f.deliver(f.radio.tx_done(f.clock.now())).result == PortResult::sent);
  }
  CHECK(f.radio.calls_of(RadioCall::Kind::transmit).size() == 3);
  // One entry: the log merges the repeats of one code.
  REQUIRE(f.log.size() == 1);
  protocol::LogEntries entries;
  REQUIRE(f.log.prepare(f.clock.now(), entries) == 1);
  protocol::LogEntryReader reader(entries.entries);
  protocol::LogEntry entry;
  REQUIRE(reader.next(entry));
  CHECK(entry.code == device::log_code::airtime_past_limit);
  CHECK(entry.level == static_cast<std::uint8_t>(device::LogLevel::warning));
}

}  // namespace
}  // namespace hsn::test
