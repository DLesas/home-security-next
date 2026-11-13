// Sleep (DS1, DS2, LR7, FW4, protocol section 10, design section 6): deep sleep whenever idle,
// woken by the door, cover, button, external power or the timer; exactly one deep sleep per
// wake; the radio asleep whenever the chip sleeps, except for a countdown; never deeper than
// light sleep on external power; and the longest awake time the role declares.

#include "sensor_bench.hpp"

namespace hsn::test::sensor {
namespace {

constexpr device::WakeMask kAllInputs = device::WakeMask::of(Input::door)
                                            .with(Input::cover)
                                            .with(Input::button)
                                            .with(Input::external_power);

TEST_CASE("DS1: idle, the sensor sleeps deep; the door, cover, button and USB each wake it") {
  Bench bench;
  host::SimDevice& door = bench.add();
  door.set_input(Input::door, true, at_s(20));
  door.set_input(Input::cover, true, at_s(40));
  door.hold_button(at_s(60), at_s(60.2));
  door.set_input(Input::external_power, true, at_s(80));
  door.set_input(Input::external_power, false, at_s(90));
  bench.run_to(100);
  INFO(door.records().kind(RecordKind::boot).kind(RecordKind::deep_sleep).dump());
  for (const Record& deep : door.records().kind(RecordKind::deep_sleep).records()) {
    CHECK(deep.value == kAllInputs.bits());
    CHECK_FALSE(deep.until.is_never());
  }
  // A boot 50 ms after each wake input, while the chip slept.
  for (const double when : {20.0, 40.0, 60.0, 80.0}) {
    CHECK(door.records()
              .kind(RecordKind::boot)
              .between(at_s(when + 0.05), at_s(when + 0.051))
              .count() == 1);
  }
}

TEST_CASE("DS2, FW4: one deep sleep per wake, no busy loop, never stuck awake, over a busy day") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  for (int i = 0; i < 40; ++i) {
    door.set_input(Input::door, i % 2 == 0, at_s(600 + 1800 * i));
  }
  bench.sim.schedule(at_s(30000), [&]() { bench.hub.disarm(); });
  bench.sim.schedule(at_s(40000),
                     [&]() { bench.sim.medium().cut(door.station(), bench.hub.station()); });
  bench.sim.schedule(at_s(50000), [&]() {
    bench.sim.medium().set_path_loss(door.station(), bench.hub.station(), 100.0);
  });
  bench.run_to(24 * 3600);
  check_sleep_discipline(door);
  const SleepCount count = sleep_count(door);
  CHECK(count.deep_sleeps + 1 >= count.boots);
  CHECK(count.deep_sleeps <= count.boots);
}

TEST_CASE("LR7: the radio is asleep at every deep sleep") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.hub.arm();
  door.set_input(Input::door, true, at_s(30));
  bench.sim.schedule(at_s(40), [&]() { bench.hub.disarm(); });
  door.set_input(Input::door, false, at_s(100));
  bench.run_to(1200);
  // The last radio call before each deep sleep put it to sleep (a timed receive that ended is
  // standby, not sleep).
  const auto calls = door.board().radio.calls;
  for (const Record& deep : door.records().kind(RecordKind::deep_sleep).records()) {
    const host::RadioCall* last = nullptr;
    for (const host::RadioCall& call : calls) {
      if (call.at <= deep.at) {
        last = &call;
      }
    }
    REQUIRE(last != nullptr);
    CHECK(last->kind == host::RadioCall::Kind::sleep);
  }
}

TEST_CASE("LR7: after a start-up the radio is put to sleep even when nothing could be sent") {
  Bench bench;
  host::SimDevice& door = bench.add();
  // Flash refuses the resume point, so Started cannot be sealed: no send, no listening.
  door.board().storage.fail_writes = true;
  bench.run_to(1);
  REQUIRE(door.state() == host::PowerState::deep_sleep);
  CHECK(sent(door).empty());
  const auto calls = door.board().radio.calls;
  REQUIRE_FALSE(calls.empty());
  CHECK(calls.back().kind == host::RadioCall::Kind::sleep);
}

TEST_CASE("section 10: on USB power the sensor never sleeps deeper than light, and is not stuck") {
  Bench bench;
  host::SimDevice& door = bench.add();
  door.set_input(Input::external_power, true, at_s(5));
  door.set_input(Input::door, true, at_s(600));
  door.set_input(Input::external_power, false, at_s(2 * 3600));
  bench.run_to(2 * 3600 + 400);
  CHECK(door.records().kind(RecordKind::deep_sleep).between(at_s(5.1), at_s(2 * 3600)).count() ==
        0);
  // Heartbeats and reports go on as usual.
  CHECK(sent(door, type::heartbeat).size() >= 30);
  CHECK(sent(door, type::door_changed).size() == 1);
  // Two hours awake on USB do not count as stuck (design section 6), and on the cell again it
  // sleeps deep.
  check_sleep_discipline(door);
  CHECK(door.records()
            .kind(RecordKind::deep_sleep)
            .between(at_s(2 * 3600), at_s(2 * 3600 + 400))
            .count() >= 1);
}

TEST_CASE("design section 6: 40 minutes awake, kept so by inputs, are not stuck awake") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  // A pairing hold every 100 s keeps the 2-minute pairing window, and light sleep, going for
  // 40 minutes; each hold is an input, which restarts the 20-minute bound.
  for (int i = 0; i < 24; ++i) {
    door.hold_button(at_s(20 + 100 * i), at_s(20 + 100 * i + 6));
  }
  bench.run_to(20 + 100 * 24);
  CHECK(
      door.records().kind(RecordKind::deep_sleep).between(at_s(26), at_s(20 + 100 * 23)).count() ==
      0);
  check_sleep_discipline(door);
}

TEST_CASE("design section 6: the role declares its longest awake time, 20 minutes") {
  Bench bench;
  host::SimDevice& door = bench.add();
  door.set_input(Input::external_power, true, at_s(5));
  // While Started is listened for, before USB power comes.
  bench.run_to(0.1);
  CHECK(role(door).longest_awake() == seconds(20 * 60));
  bench.run_to(600);
  // On USB, the time on external power, up to the latest event handled, does not count.
  CHECK(role(door).longest_awake() > seconds(20 * 60 + 500));
}

}  // namespace
}  // namespace hsn::test::sensor

namespace hsn::test::sensor {
namespace {

/** The computer at the other end of the sensor's USB port: keeps what the sensor sends. */
class UsbHost final : public host::LinkPeer {
public:
  void link_up(host::LinkWire&) override {}
  void link_down(host::LinkWire&) override {}
  void link_packet(host::LinkWire&, const host::Bytes& packet) override {
    packets.push_back(packet);
  }
  std::vector<host::Bytes> packets;
};

TEST_CASE(
    "FW9, section 10: on USB power the sensor's USB port answers setup messages; on its cell "
    "it sleeps deep and does not") {
  Bench bench;
  host::SimDevice& door = bench.add();
  UsbHost computer;
  door.wire(device::LinkKind::usb).attach(computer, milliseconds(5));
  const host::Bytes identify{protocol::kSetupMarker, 0x01};
  // On the cell, asleep: the message is lost.
  bench.sim.schedule(at_s(30),
                     [&]() { door.wire(device::LinkKind::usb).send_to_device(identify); });
  door.set_input(Input::external_power, true, at_s(60));
  bench.sim.schedule(at_s(90),
                     [&]() { door.wire(device::LinkKind::usb).send_to_device(identify); });
  bench.run_to(100);
  REQUIRE(computer.packets.size() == 1);
  CHECK(computer.packets[0][0] == protocol::kSetupMarker);
  CHECK(computer.packets[0][1] == 0x02);
  CHECK(computer.packets[0][2] == protocol::Role::sensor);
  // The setup message never reached the role: its radio traffic went on as before.
  CHECK(sent_names(door) == "started");
}

}  // namespace
}  // namespace hsn::test::sensor
