// The bench's flash and power (m3-updates-design.md section 8): SimFlash behaves as NOR flash, a
// PowerCut counts every flash operation and cuts at the one it is armed for, and while the power
// is cut no fake leaves anything behind.

#include <doctest/doctest.h>

#include <algorithm>
#include <array>
#include <cstdint>

#include "hsn/host/fake_link.hpp"
#include "hsn/host/fake_radio.hpp"
#include "hsn/host/fake_storage.hpp"
#include "hsn/host/host_board.hpp"
#include "hsn/host/power_cut.hpp"
#include "hsn/host/sim_flash.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using device::HalError;
using host::CutPoint;
using host::FlashFate;
using host::FlashOp;
using host::PowerCut;
using host::SimFlash;

constexpr std::size_t kSector = SimFlash::kSectorSize;

Bytes read(const SimFlash& flash, std::uint32_t address, std::size_t size) {
  Bytes out(size);
  flash.read(address, protocol::MutableByteView(out.data(), out.size()));
  return out;
}

bool all_of(const Bytes& bytes, std::uint8_t value) {
  return std::all_of(bytes.begin(), bytes.end(), [value](std::uint8_t b) { return b == value; });
}

TEST_CASE("SimFlash: erased reads 0xFF, a program only clears bits, an erase sets them again") {
  SimFlash flash(4 * kSector, 1);
  CHECK(all_of(read(flash, 0, flash.size()), 0xFF));
  const Bytes first{0xF0, 0x0F, 0xAA};
  CHECK(flash.program(10, view(first), FlashOp::slot_write) == HalError::none);
  CHECK(read(flash, 10, 3) == first);
  CHECK(flash.unerased_programs == 0);
  // Programming again ANDs: 0xF0 & 0x0F = 0, and a 0 bit never comes back as 1.
  const Bytes second{0x0F, 0xFF, 0x55};
  CHECK(flash.program(10, view(second), FlashOp::slot_write) == HalError::none);
  CHECK(read(flash, 10, 3) == Bytes{0x00, 0x0F, 0x00});
  CHECK(flash.unerased_programs == 3);
  // Bytes around it are untouched.
  CHECK(read(flash, 9, 1) == Bytes{0xFF});
  CHECK(read(flash, 13, 1) == Bytes{0xFF});
  CHECK(flash.erase(0, FlashOp::slot_erase) == HalError::none);
  CHECK(all_of(read(flash, 0, kSector), 0xFF));
}

TEST_CASE("SimFlash refuses erases off a sector or past the end, and programs past the end") {
  SimFlash flash(2 * kSector, 1);
  CHECK(flash.erase(1, FlashOp::slot_erase) == HalError::invalid);
  CHECK(flash.erase(kSector - 1, FlashOp::slot_erase) == HalError::invalid);
  CHECK(flash.erase(2 * kSector, FlashOp::slot_erase) == HalError::invalid);
  CHECK(flash.erase(kSector, FlashOp::slot_erase) == HalError::none);
  const Bytes two{0, 0};
  CHECK(flash.program(2 * kSector - 1, view(two), FlashOp::slot_write) == HalError::invalid);
  CHECK(flash.program(2 * kSector - 2, view(two), FlashOp::slot_write) == HalError::none);
  CHECK(flash.rewrite(1, view(two), FlashOp::otadata_write) == HalError::invalid);
}

TEST_CASE("SimFlash fault switches fail an operation and change nothing") {
  SimFlash flash(kSector, 1);
  const Bytes zeros(8, 0);
  flash.fail_programs = true;
  CHECK(flash.program(0, view(zeros), FlashOp::slot_write) == HalError::io);
  CHECK(all_of(read(flash, 0, 8), 0xFF));
  flash.fail_programs = false;
  CHECK(flash.program(0, view(zeros), FlashOp::slot_write) == HalError::none);
  flash.fail_erases = true;
  CHECK(flash.erase(0, FlashOp::slot_erase) == HalError::io);
  CHECK(all_of(read(flash, 0, 8), 0x00));
  flash.fail_erases = false;
  flash.fail_next = 1;
  CHECK(flash.erase(0, FlashOp::slot_erase) == HalError::io);
  CHECK(flash.erase(0, FlashOp::slot_erase) == HalError::none);
  CHECK(all_of(read(flash, 0, 8), 0xFF));
}

TEST_CASE("PowerCut counts every operation and cuts at the Nth, during or after it") {
  PowerCut power;
  CHECK(power.operation(FlashOp::record_write) == FlashFate::done);
  CHECK(power.count() == 1);
  power.arm(3, CutPoint::during);
  CHECK(power.count() == 0);
  int cuts = 0;
  power.on_cut = [&cuts]() { cuts += 1; };
  CHECK(power.operation(FlashOp::slot_erase) == FlashFate::done);
  CHECK(power.operation(FlashOp::slot_write) == FlashFate::done);
  CHECK_FALSE(power.cut());
  CHECK(power.operation(FlashOp::otadata_write) == FlashFate::interrupted);
  CHECK(power.cut());
  CHECK(cuts == 1);
  REQUIRE(power.has_cut());
  CHECK(power.cut_at().number == 3);
  CHECK(power.cut_at().op == FlashOp::otadata_write);
  // Nothing is counted while the power is gone.
  CHECK(power.operation(FlashOp::record_write) == FlashFate::lost);
  CHECK(power.count() == 3);
  power.restore();
  CHECK(power.operation(FlashOp::record_write) == FlashFate::done);
  CHECK(cuts == 1);

  power.arm(1, CutPoint::after);
  CHECK(power.operation(FlashOp::record_erase) == FlashFate::done_then_cut);
  CHECK(power.cut());
  CHECK(cuts == 2);
  // Armed at 0: counts, never cuts.
  power.restore();
  power.arm(0, CutPoint::during);
  for (int i = 0; i < 10; ++i) {
    CHECK(power.operation(FlashOp::slot_write) == FlashFate::done);
  }
  CHECK(power.count() == 10);
  CHECK(power.counted().size() == 10);
  CHECK_FALSE(power.has_cut());
}

TEST_CASE("an interrupted erase leaves its sector's first half erased and the rest garbage") {
  // The same mess on every run, and the garbage is ORed into the old bytes (an erase only sets).
  const auto run = [](std::uint64_t seed) {
    PowerCut power;
    SimFlash flash(2 * kSector, seed);
    flash.set_power(&power);
    const Bytes zeros(2 * kSector, 0);
    flash.load(0, view(zeros));
    power.arm(1, CutPoint::during);
    CHECK(flash.erase(kSector, FlashOp::slot_erase) == HalError::io);
    return flash.contents();
  };
  const std::vector<std::uint8_t> once = run(7);
  CHECK(once == run(7));
  CHECK(once != run(8));
  const Bytes first_sector(once.begin(), once.begin() + kSector);
  const Bytes first_half(once.begin() + kSector, once.begin() + kSector + kSector / 2);
  const Bytes second_half(once.begin() + kSector + kSector / 2, once.end());
  CHECK(all_of(first_sector, 0x00));  // another sector is untouched
  CHECK(all_of(first_half, 0xFF));
  CHECK_FALSE(all_of(second_half, 0xFF));
  CHECK_FALSE(all_of(second_half, 0x00));
}

TEST_CASE("an interrupted program writes its first half, part of the next byte, and no more") {
  PowerCut power;
  SimFlash flash(kSector, 1);
  flash.set_power(&power);
  const Bytes data{0x00, 0x11, 0x22, 0x33, 0x00, 0x55, 0x66, 0x77};
  power.arm(1, CutPoint::during);
  CHECK(flash.program(0, view(data), FlashOp::slot_write) == HalError::io);
  // Bytes 0–3 whole; byte 4 (0x00) only its high nibble: 0x0F; bytes 5–7 left erased.
  CHECK(read(flash, 0, 8) == Bytes{0x00, 0x11, 0x22, 0x33, 0x0F, 0xFF, 0xFF, 0xFF});
  // From the cut, every operation is lost.
  CHECK(flash.erase(0, FlashOp::slot_erase) == HalError::io);
  CHECK(read(flash, 0, 1) == Bytes{0x00});
  CHECK(flash.power_gone());
  power.restore();
  CHECK(flash.erase(0, FlashOp::slot_erase) == HalError::none);
}

TEST_CASE(
    "an operation cut after it is whole; a rewrite cut during it is erased then half written") {
  PowerCut power;
  SimFlash flash(2 * kSector, 1);
  flash.set_power(&power);
  const Bytes data{0x01, 0x02, 0x03, 0x04};
  power.arm(1, CutPoint::after);
  CHECK(flash.program(0, view(data), FlashOp::slot_write) == HalError::none);
  CHECK(read(flash, 0, 4) == data);
  CHECK(flash.power_gone());
  power.restore();
  const Bytes old(8, 0x00);
  flash.load(kSector, view(old));
  power.arm(1, CutPoint::during);
  CHECK(flash.rewrite(kSector, view(data), FlashOp::otadata_write) == HalError::io);
  CHECK(read(flash, kSector, 8) == Bytes{0x01, 0x02, 0x0F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF});
}

TEST_CASE("load and blank are a factory programmer's: never cut, never counted") {
  PowerCut power;
  SimFlash flash(2 * kSector, 1);
  flash.set_power(&power);
  power.arm(1, CutPoint::during);
  const Bytes data(10, 0x5A);
  flash.load(100, view(data));
  CHECK(read(flash, 100, 10) == data);
  CHECK(all_of(read(flash, 0, 100), 0xFF));
  flash.blank(0, kSector);
  CHECK(all_of(read(flash, 0, kSector), 0xFF));
  CHECK(power.count() == 0);
  CHECK_FALSE(power.cut());
  const std::uint64_t generation = flash.generation();
  CHECK(flash.erase(0, FlashOp::slot_erase) == HalError::io);
  CHECK(flash.generation() > generation);
}

TEST_CASE("storage under a cut: during keeps the old record, after keeps the new, then nothing") {
  for (const CutPoint point : {CutPoint::during, CutPoint::after}) {
    CAPTURE(static_cast<int>(point));
    host::FakeClock clock;
    host::FakeStorage storage(clock);
    PowerCut power;
    storage.set_power(&power);
    const Bytes old_value{1, 2, 3};
    const Bytes new_value{4, 5, 6, 7};
    REQUIRE(storage.write(device::StoreKey::pairing, view(old_value)) == HalError::none);
    power.arm(1, point);
    const HalError result = storage.write(device::StoreKey::pairing, view(new_value));
    CHECK(power.cut());
    if (point == CutPoint::during) {
      CHECK(result == HalError::io);
      CHECK(storage.records.at(device::StoreKey::pairing) == old_value);
      REQUIRE(storage.operations.size() == 2);
      CHECK(storage.operations.back().failed);
      CHECK(storage.operations.back().interrupted);
    } else {
      CHECK(result == HalError::none);
      CHECK(storage.records.at(device::StoreKey::pairing) == new_value);
      CHECK_FALSE(storage.operations.back().interrupted);
    }
    // After the cut: no write, erase or factory reset lands, and none is recorded.
    const std::size_t recorded = storage.operations.size();
    CHECK(storage.write(device::StoreKey::fatal_error, view(old_value)) == HalError::io);
    CHECK(storage.erase(device::StoreKey::pairing) == HalError::io);
    CHECK(storage.erase_all_but_role() == HalError::io);
    CHECK(storage.operations.size() == recorded);
    CHECK_FALSE(storage.has(device::StoreKey::fatal_error));
    CHECK(storage.has(device::StoreKey::pairing));
    // Erases are operations too.
    power.restore();
    power.arm(1, CutPoint::during);
    CHECK(storage.erase(device::StoreKey::pairing) == HalError::io);
    CHECK(storage.has(device::StoreKey::pairing));
    power.restore();
    power.arm(1, CutPoint::during);
    CHECK(storage.erase_all_but_role() == HalError::io);
    CHECK(storage.has(device::StoreKey::pairing));
  }
}

TEST_CASE("while the power is cut the radio and the links do nothing and record nothing") {
  host::HostBoard board;
  board.power_cut.arm(1, CutPoint::during);
  REQUIRE(board.storage.write(device::StoreKey::fatal_error, view(Bytes{1})) == HalError::io);
  REQUIRE(board.power_cut.cut());
  device::RadioChannel channel{868300000u, 5};
  const Bytes packet(20, 0x18);
  CHECK(board.radio.transmit(channel, 14, view(packet)) == HalError::none);
  CHECK(board.radio.calls.empty());
  CHECK(board.radio.mode() == host::RadioMode::sleeping);
  static_cast<void>(board.usb.up_event());
  CHECK(board.usb.send(view(packet)) == HalError::none);
  CHECK(board.usb.sent.empty());
  CHECK(board.network.connect(device::LinkTarget{}) == HalError::none);
  CHECK(board.network.connects == 0);
  // The slots' flash is on the same supply.
  CHECK(board.slots.erase(0) == HalError::io);
  board.power_cut.restore();
  CHECK(board.radio.transmit(channel, 14, view(packet)) == HalError::none);
  CHECK(board.radio.calls.size() == 1);
  CHECK(board.usb.send(view(packet)) == HalError::none);
  CHECK(board.usb.sent.size() == 1);
}

TEST_CASE("a network or Bluetooth link sends only while up; USB whenever asked") {
  host::FakeClock clock;
  host::FakeLink usb(clock, device::LinkKind::usb);
  host::FakeLink network(clock, device::LinkKind::network);
  host::FakeLink bluetooth(clock, device::LinkKind::bluetooth);
  const Bytes packet{0xF2, 0x01};
  CHECK(usb.send(view(packet)) == HalError::none);
  CHECK(network.send(view(packet)) == HalError::io);
  CHECK(bluetooth.send(view(packet)) == HalError::io);
  static_cast<void>(bluetooth.up_event());
  CHECK(bluetooth.send(view(packet)) == HalError::none);
  bluetooth.wifi_signal_dbm = -40;
  network.wifi_signal_dbm = -40;
  usb.wifi_signal_dbm = -40;
  CHECK(bluetooth.signal_dbm() == 0);
  CHECK(usb.signal_dbm() == 0);
  CHECK(network.signal_dbm() == -40);
}

}  // namespace
}  // namespace hsn::test
