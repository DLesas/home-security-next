// The boot path of a simulated board (m3-updates-design.md sections 2 and 8): the fake bootloader
// at every reset, the role the booted image maps to, an image that hangs and trips the watchdog, a
// power cut inside a handle(), and a Bluetooth link's advertising on its wire.

#include <doctest/doctest.h>

#include <vector>

#include "hsn/host/fake_update.hpp"
#include "hsn/host/link_wire.hpp"
#include "hsn/host/provisioning.hpp"
#include "hsn/host/simulation.hpp"
#include "hsn/host/test_image.hpp"
#include "sim_support.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using device::HalError;
using host::RecordKind;
using host::SimDevice;
using host::Simulation;

const protocol::FirmwareVersion kOld{0, 1, 0};
const protocol::FirmwareVersion kNew{1, 4, 0};

bool same(const protocol::FirmwareVersion& a, const protocol::FirmwareVersion& b) {
  return a.major == b.major && a.minor == b.minor && a.patch == b.patch;
}

/** Writes and selects an image in the other slot, before the board's first boot. */
void stage(host::HostBoard& board, const protocol::FirmwareVersion& version) {
  const Bytes image = host::make_test_image(version, 5000);
  for (std::uint32_t offset = 0; offset < image.size(); offset += device::kSlotSectorSize) {
    REQUIRE(board.slots.erase(offset) == HalError::none);
    const std::size_t length =
        std::min<std::size_t>(device::kSlotSectorSize, image.size() - offset);
    REQUIRE(board.slots.write(offset, protocol::ByteView(image.data() + offset, length)) ==
            HalError::none);
  }
  REQUIRE(board.slots.select() == HalError::none);
}

/** A light-sleeping probe that wakes every second, for each image. */
struct TwoImages {
  explicit TwoImages(std::optional<device::Duration> new_hangs_after = std::nullopt) {
    ProbeConfig config;
    config.deep = false;
    config.period = seconds(1);
    host::DeviceSpec spec;
    spec.name = "board";
    spec.role = probe(config, old_log);
    spec.images.push_back(host::ImageRole{kOld, probe(config, old_log), std::nullopt});
    spec.images.push_back(host::ImageRole{kNew, probe(config, new_log), new_hangs_after});
    board = &sim.add_device(spec);
    host::provision(board->board(), sensor_pairing());
  }
  Simulation sim;
  ProbeLog old_log;
  ProbeLog new_log;
  SimDevice* board = nullptr;
};

TEST_CASE("a board boots the image its bootloader chooses, with that image's role") {
  TwoImages world;
  stage(world.board->board(), kNew);
  world.sim.run_until(at(seconds(5)));
  INFO(world.sim.timeline().select().dump());
  // Booted on trial into 1.4.0: only its role ran, and the build says 1.4.0.
  CHECK(world.old_log.entries.empty());
  CHECK_FALSE(world.new_log.entries.empty());
  CHECK(world.board->boot_choice().slot == 1);
  CHECK(world.board->boot_choice().image.on_trial);
  CHECK(same(world.board->board().hal().build.version, kNew));
  REQUIRE(world.board->services() != nullptr);
  CHECK(world.board->services()->update.on_trial());
  // The bootloader's write (NEW to PENDING_VERIFY) is on the timeline.
  const auto otadata = world.board->records().kind(RecordKind::otadata_write).records();
  REQUIRE(otadata.size() == 1);
  CHECK(otadata[0].value == host::ota_state::pending_verify);
  CHECK(otadata[0].at == at(milliseconds(50)));
  CHECK_FALSE(otadata[0].flag);

  // A reset on trial rolls back: the old image's role runs, and says so.
  world.board->restart(at(seconds(6)));
  world.sim.run_until(at(seconds(10)));
  CHECK_FALSE(world.old_log.entries.empty());
  CHECK(world.board->boot_choice().slot == 0);
  CHECK(world.board->boot_choice().image.rolled_back);
  CHECK(same(world.board->boot_choice().image.failed, kNew));
  CHECK(same(world.board->board().hal().build.version, kOld));
  CHECK(world.board->records().kind(RecordKind::otadata_write).count() == 2);
}

TEST_CASE("a version not listed runs the spec's role; a board with no images keeps its one role") {
  Simulation sim;
  ProbeConfig config;
  config.deep = false;
  ProbeLog log;
  host::DeviceSpec spec;
  spec.name = "plain";
  spec.role = probe(config, log);
  SimDevice& plain = sim.add_device(spec);
  host::provision(plain.board(), sensor_pairing());
  stage(plain.board(), kNew);
  sim.run_until(at(seconds(2)));
  CHECK_FALSE(log.entries.empty());
  CHECK(same(plain.board().hal().build.version, kNew));
}

TEST_CASE("an image that hangs is reset by the watchdog, and on trial that rolls it back") {
  TwoImages world(seconds(3));
  stage(world.board->board(), kNew);
  world.sim.run_until(at(seconds(20)));
  INFO(world.sim.timeline().select().dump());
  // The new image ran from 0.05 s; the first event at or after 3.05 s never returned.
  REQUIRE_FALSE(world.new_log.entries.empty());
  const device::Instant last_new = world.new_log.entries.back().local;
  CHECK(last_new < device::Instant{} + seconds(3) + milliseconds(50));
  const auto restarts = world.board->records().kind(RecordKind::restart).records();
  REQUIRE(restarts.size() == 1);
  CHECK(restarts[0].flag);  // the watchdog
  // Its timeout (5 s, started by the Runner) after the last feed, at the last event handled.
  CHECK(restarts[0].at == world.board->clock().true_time(last_new) + seconds(5));
  // The old image booted with the watchdog's reset and reports the rollback.
  REQUIRE_FALSE(world.old_log.entries.empty());
  const device::BootInfo& boot = world.old_log.entries.front().boot;
  CHECK(world.old_log.entries.front().kind == device::EventKind::boot);
  CHECK(boot.watchdog_reset);
  CHECK(boot.reset_cause == 6);
  CHECK(world.board->boot_choice().image.rolled_back);
  CHECK(same(world.board->boot_choice().image.failed, kNew));
  // Nothing was delivered to the hung image after the hang.
  for (const ProbeLog::Entry& entry : world.new_log.entries) {
    CHECK(entry.local <= last_new);
  }
}

TEST_CASE("SimDevice::hang on a confirmed image resets it into the same image") {
  Simulation sim;
  ProbeConfig config;
  config.deep = false;
  config.period = seconds(1);
  ProbeLog log;
  host::DeviceSpec spec;
  spec.name = "board";
  spec.role = probe(config, log);
  SimDevice& board = sim.add_device(spec);
  host::provision(board.board(), sensor_pairing());
  board.hang(at(seconds(10)));
  sim.run_until(at(seconds(30)));
  const auto restarts = board.records().kind(RecordKind::restart).records();
  REQUIRE(restarts.size() == 1);
  CHECK(restarts[0].flag);
  CHECK(restarts[0].at > at(seconds(10)));
  CHECK(restarts[0].at <= at(seconds(15) + milliseconds(50)));
  CHECK(board.boots() == 2);
  CHECK(board.boot_choice().slot == 0);
  CHECK_FALSE(board.boot_choice().image.rolled_back);
}

TEST_CASE("a power cut inside a handle(): nothing after the cut happens, then the board returns") {
  // A probe that writes its wake count and then transmits, at every wake.
  const auto build = [](Simulation& sim, ProbeLog& log) -> SimDevice& {
    ProbeConfig config;
    config.deep = true;
    config.period = seconds(10);
    config.transmit = true;
    config.flash_every = 1;
    host::DeviceSpec spec;
    spec.name = "board";
    spec.role = probe(config, log);
    spec.off_after_cut = seconds(2);
    SimDevice& board = sim.add_device(spec);
    host::provision(board.board(), sensor_pairing());
    return board;
  };
  Simulation uncut;
  ProbeLog uncut_log;
  SimDevice& reference = build(uncut, uncut_log);
  reference.board().power_cut.arm(0, host::CutPoint::during);
  uncut.run_until(at(seconds(35)));
  const std::uint64_t operations = reference.board().power_cut.count();
  REQUIRE(operations >= 4);
  const auto writes = reference.records().kind(RecordKind::flash_write).records();
  REQUIRE(writes.size() >= 2);

  Simulation sim;
  ProbeLog log;
  SimDevice& board = build(sim, log);
  board.board().power_cut.arm(2, host::CutPoint::during);
  sim.run_until(at(seconds(35)));
  INFO(sim.timeline().select().dump());
  CHECK(board.power_cuts() == 1);
  const auto losses = board.records().kind(RecordKind::power_loss).records();
  REQUIRE(losses.size() == 1);
  CHECK(losses[0].flag);
  CHECK(losses[0].value == 2);
  const device::Instant cut_at = losses[0].at;
  // The interrupted write is the last thing recorded, as failed; nothing after it in that
  // handle() happened, the transmission included.
  const auto at_cut = board.records().between(cut_at, cut_at + device::microseconds(1));
  CHECK(at_cut.kind(RecordKind::transmission).count() == 0);
  REQUIRE(at_cut.kind(RecordKind::flash_write).count() >= 1);
  CHECK(at_cut.kind(RecordKind::flash_write).records().back().flag);
  // Off for two seconds, then power and a boot, and the board goes on with its wakes.
  const auto powered = board.records().kind(RecordKind::power_on).records();
  REQUIRE(powered.size() == 2);
  CHECK(powered[1].at == cut_at + seconds(2));
  // Nothing on the air from the cut to the power's return; without the cut, that wake sent.
  CHECK(board.records()
            .between(cut_at, powered[1].at)
            .kind(RecordKind::transmission)
            .kind(RecordKind::channel_check)
            .kind(RecordKind::rx_window)
            .count() == 0);
  CHECK(reference.records()
            .between(cut_at, cut_at + seconds(1))
            .kind(RecordKind::transmission)
            .count() == 1);
  CHECK(board.records().kind(RecordKind::transmission).between(cut_at, at(seconds(35))).count() >=
        2);
  // Power is back for good: later operations happen.
  CHECK_FALSE(board.board().power_cut.cut());
}

TEST_CASE("a power cut during the bootloader's own write keeps the board off, then boots it") {
  TwoImages world;
  stage(world.board->board(), kNew);
  world.board->board().power_cut.arm(1, host::CutPoint::during);
  world.sim.run_until(at(seconds(5)));
  INFO(world.sim.timeline().select().dump());
  CHECK(world.board->power_cuts() == 1);
  // The torn NEW → PENDING_VERIFY write: the old image boots once power returns, not on trial.
  CHECK(world.new_log.entries.empty());
  CHECK_FALSE(world.old_log.entries.empty());
  CHECK(world.board->boot_choice().slot == 0);
  CHECK_FALSE(world.board->boot_choice().image.on_trial);
  CHECK(world.board->records().kind(RecordKind::otadata_write).records()[0].flag);
}

/** A bare wire for a board's Bluetooth link: events go to `events`. */
struct BluetoothWire {
  BluetoothWire()
      : link(clock, device::LinkKind::bluetooth),
        wire(scheduler, timeline, labels, timeline.add_actor("board"), link,
             [this](const host::LinkWire::Build& build) {
               events.push_back(build());
               return true;
             }) {}
  host::Scheduler scheduler;
  host::Timeline timeline;
  host::PacketLabels labels;
  host::FakeClock clock;
  host::FakeLink link;
  std::vector<device::LinkEvent> events;
  host::LinkWire wire;
};

/** A far end that only counts. */
struct CountingPeer final : host::LinkPeer {
  void link_up(host::LinkWire&) override {
    ups += 1;
  }
  void link_down(host::LinkWire&) override {
    downs += 1;
  }
  void link_packet(host::LinkWire&, const Bytes& packet) override {
    packets.push_back(packet);
  }
  int ups = 0;
  int downs = 0;
  std::vector<Bytes> packets;
};

TEST_CASE("a Bluetooth link advertises until a phone comes, and nothing comes back without one") {
  BluetoothWire bench;
  REQUIRE(bench.link.connect(device::LinkTarget{}) == HalError::none);
  CHECK(bench.wire.advertising());
  bench.scheduler.run_until(device::Instant{} + seconds(60));
  // Unlike a network link, no `down` after 15 s: it advertises on.
  CHECK(bench.events.empty());
  CountingPeer phone;
  bench.wire.attach(phone, milliseconds(10));
  bench.scheduler.run_until(device::Instant{} + seconds(61));
  CHECK(phone.ups == 1);
  REQUIRE(bench.events.size() == 1);
  CHECK(bench.events[0].kind == device::LinkEventKind::up);
  CHECK(bench.events[0].link == device::LinkKind::bluetooth);
  CHECK(bench.link.up());
  // A frame each way while connected.
  const Bytes frame{0xF2, 0x01};
  REQUIRE(bench.link.send(view(frame)) == HalError::none);
  bench.wire.send_to_device(frame);
  bench.scheduler.run_until(device::Instant{} + seconds(62));
  CHECK(phone.packets.size() == 1);
  CHECK(bench.events.back().kind == device::LinkEventKind::packet);
  // The phone drops: the board sees it go down and still advertises; the phone connects again.
  bench.wire.drop();
  bench.scheduler.run_until(device::Instant{} + seconds(63));
  CHECK(bench.events.back().kind == device::LinkEventKind::down);
  CHECK(bench.wire.advertising());
  CHECK(bench.link.send(view(frame)) == HalError::io);
  CHECK(bench.wire.peer_connect());
  CHECK_FALSE(bench.wire.peer_connect());  // already connecting
  bench.scheduler.run_until(device::Instant{} + seconds(64));
  CHECK(phone.ups == 2);
  CHECK(bench.events.back().kind == device::LinkEventKind::up);
  // The board ends the window: the phone is told, and cannot connect again.
  bench.link.disconnect();
  CHECK_FALSE(bench.wire.advertising());
  bench.scheduler.run_until(device::Instant{} + seconds(64) + milliseconds(500));
  CHECK(phone.downs >= 2);
  CHECK_FALSE(bench.wire.peer_connect());
  // A connect with the phone already near connects at once; a reset ends the advertising.
  REQUIRE(bench.link.connect(device::LinkTarget{}) == HalError::none);
  bench.scheduler.run_until(device::Instant{} + seconds(65));
  CHECK(phone.ups == 3);
  bench.wire.device_reset();
  CHECK_FALSE(bench.wire.advertising());
  // The timeline names the link.
  const auto ups = bench.timeline.select().kind(RecordKind::link_up).records();
  REQUIRE_FALSE(ups.empty());
  CHECK(ups[0].value == static_cast<std::uint32_t>(device::LinkKind::bluetooth));
  CHECK(bench.timeline.describe(ups[0]).find("bluetooth") != std::string::npos);
}

TEST_CASE("each board has three links, each on its own wire") {
  Simulation sim;
  host::DeviceSpec spec;
  spec.name = "board";
  SimDevice& board = sim.add_device(spec);
  CHECK(&board.wire(device::LinkKind::usb).link() == &board.board().usb);
  CHECK(&board.wire(device::LinkKind::network).link() == &board.board().network);
  CHECK(&board.wire(device::LinkKind::bluetooth).link() == &board.board().bluetooth);
  CHECK(board.board().hal().bluetooth == &board.board().bluetooth);
  CHECK(board.board().bluetooth.kind() == device::LinkKind::bluetooth);
}

}  // namespace
}  // namespace hsn::test
