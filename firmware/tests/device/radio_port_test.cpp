// The radio port: listen before sending, the airtime budget, and the guard (protocol section 2).

#include "hsn/device/services/radio_port.hpp"
#include "device/device_support.hpp"
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

}  // namespace
}  // namespace hsn::test
