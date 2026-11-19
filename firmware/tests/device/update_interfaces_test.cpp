// The update interfaces as step 0 froze them (m3-updates-design.md sections 2, 5 and 7): the
// host board's update fakes in its Hal, UpdateService with nothing offered, Device's routing of
// transfer frames and Bluetooth events, the trial rules, Started's image fields in Health, the
// update record, and the key change's stub.

#include <array>
#include <optional>
#include <vector>

#include "device_support.hpp"
#include "hsn/device/device.hpp"
#include "hsn/device/runner.hpp"
#include "hsn/device/services/record.hpp"
#include "hsn/device/services/update.hpp"
#include "hsn/host/host_board.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/transfer.hpp"

namespace hsn::test {
namespace {

using device::BootKind;
using device::HalError;
using device::SleepDepth;
using device::Wake;
using Instance = host::HostInstance<TestRole>;

Instance& boot(std::optional<Instance>& instance, host::HostBoard& board,
               BootKind kind = BootKind::power_on) {
  instance.reset();
  instance.emplace(board);
  instance->runner.start(board.boot_event(kind));
  return *instance;
}

bool same_version(const protocol::FirmwareVersion& a, const protocol::FirmwareVersion& b) {
  return a.major == b.major && a.minor == b.minor && a.patch == b.patch;
}

device::Event bluetooth_event(Instant now, device::LinkEventKind kind, const Bytes& packet) {
  device::LinkEvent link;
  link.link = device::LinkKind::bluetooth;
  link.kind = kind;
  link.packet = view_of(packet);
  return device::Event::from_link(now, link);
}

/** The codes of every kept log entry, oldest first. */
std::vector<std::uint16_t> log_codes(device::Services& services, Instant now) {
  protocol::LogEntries entries;
  std::vector<std::uint16_t> codes;
  if (services.log.prepare(now, entries) == 0) {
    return codes;
  }
  protocol::LogEntryReader reader(entries.entries);
  protocol::LogEntry entry;
  while (reader.next(entry)) {
    codes.push_back(entry.code);
  }
  return codes;
}

/** A Get frame, as a phone or the hub would never send one: only its first byte matters here. */
Bytes transfer_frame() {
  protocol::transfer::Get get;
  get.length = 128;
  Bytes bytes(32);
  const auto size =
      protocol::encode_transfer(get, protocol::MutableByteView(bytes.data(), bytes.size()));
  REQUIRE(size.ok());
  bytes.resize(size.value());
  return bytes;
}

TEST_CASE("a host board holds the update fakes and reports its confirmed factory image") {
  // The step 0 stand-ins are replaced by the real fakes (engineer U2): their own tests are
  // tests/host/update_*_test.cpp. Here only that a board wires them into its Hal.
  host::HostBoard board;
  device::Hal& hal = board.hal();
  CHECK(&hal.slots == &board.slots);
  CHECK(&hal.update_crypto == &board.update_crypto);
  CHECK(&hal.key_import == &board.key_import);
  CHECK(hal.bluetooth == &board.bluetooth);
  CHECK(hal.network == &board.network);

  const device::BootImage image = hal.slots.running();
  CHECK(same_version(image.version, hal.build.version));
  CHECK_FALSE(image.on_trial);
  CHECK_FALSE(image.rolled_back);
  CHECK(hal.slots.capacity() == host::kDefaultSlotSize);
  std::array<std::uint8_t, 4> bytes{1, 2, 3, 4};
  CHECK(hal.slots.erase(0) == HalError::none);
  CHECK(hal.slots.write(0, protocol::ByteView(bytes)) == HalError::none);
  bytes.fill(0);
  CHECK(hal.slots.read(0, protocol::MutableByteView(bytes)) == HalError::none);
  CHECK(bytes == std::array<std::uint8_t, 4>{1, 2, 3, 4});
  // Four bytes are no image: nothing to select, and nothing to go back to.
  CHECK(hal.slots.select() == HalError::invalid);
  CHECK(hal.slots.confirm() == HalError::none);
  CHECK(hal.slots.reject() == HalError::invalid);

  std::array<std::uint8_t, device::kSha256Size> digest{};
  CHECK(hal.update_crypto.sha256_start() == HalError::none);
  CHECK(hal.update_crypto.sha256_add(protocol::ByteView(bytes)) == HalError::none);
  CHECK(hal.update_crypto.sha256_finish(protocol::MutableByteView(digest)) == HalError::none);
  CHECK(digest != std::array<std::uint8_t, device::kSha256Size>{});
  CHECK_FALSE(hal.update_crypto.verify_p256(protocol::ByteView(), protocol::ByteView(),
                                            protocol::ByteView()));
  // No key yet: no session key; an empty HMAC key is refused.
  CHECK(hal.update_crypto.session_key(protocol::ByteView(), kAddress,
                                      protocol::MutableByteView(digest)) == HalError::invalid);
  CHECK(hal.update_crypto.hmac_sha256(protocol::ByteView(), protocol::ByteView(),
                                      protocol::MutableByteView(digest)) == HalError::invalid);
  CHECK(hal.key_import.import_key(kKey) == HalError::none);
  // Every one is a hardware call for the budget of design section 6.
  CHECK(board.calls.calls() == 15);
}

TEST_CASE("the fake bootloader reports payload IDs only for OTA selections that reached flash") {
  for (const auto cut : {host::CutPoint::during, host::CutPoint::after}) {
    host::HostBoard board;
    CHECK_FALSE(board.slots.running().id.has_value());
    const Bytes image = host::make_test_image(board.slots.running().version, 4096, 42);
    protocol::ImageHeader header;
    header.image_sha256 = host::sha256_of(view_of(image));
    const auto id = protocol::image_id_of(header);
    board.slots.install(1, view_of(image));
    board.power_cut.arm(1, cut);
    static_cast<void>(board.slots.select());
    REQUIRE(board.power_cut.cut());
    board.power_cut.restore();
    const auto first = board.slots.boot();
    REQUIRE(first.bootable);
    if (cut == host::CutPoint::during) {
      CHECK_FALSE(first.image.id.has_value());
      CHECK_FALSE(first.image.failed_id.has_value());
    } else {
      CHECK(first.image.id == id);
      CHECK(first.image.on_trial);
      const auto rollback = board.slots.boot();
      CHECK_FALSE(rollback.image.id.has_value());
      CHECK(rollback.image.failed_id == id);
      CHECK(rollback.image.rolled_back);
    }
    REQUIRE(board.slots.select() == HalError::none);
    REQUIRE(board.slots.boot().image.id == id);
    REQUIRE(board.slots.confirm() == HalError::none);
    CHECK(board.slots.boot().image.id == id);
    CHECK_FALSE(board.slots.running().failed_id.has_value());
  }
}

TEST_CASE("UpdateService with nothing offered: reads the running image, gives it to Started") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  Instance& run = boot(instance, board);
  device::UpdateService& update = run.services.update;
  const Instant now = board.clock.now();
  CHECK(same_version(update.running().version, board.hal().build.version));
  CHECK_FALSE(update.on_trial());
  CHECK_FALSE(update.active());
  const Wake idle = update.next_wake();
  CHECK(idle.at.is_never());
  CHECK(idle.deepest == SleepDepth::deep);
  CHECK(idle.deep_wake_inputs.empty());
  CHECK_FALSE(idle.restart);
  CHECK(update.next_packet(now).kind == device::UpdatePacketKind::none);

  // Health off trial, "wait" with nothing held, and a reply without the flag change nothing and
  // write nothing (the service's own tests, update_*_test.cpp, cover what an offer does).
  const std::size_t changes = board.storage.change_count();
  protocol::UpdateOffer offer;
  offer.action = protocol::UpdateAction::wait;
  update.offer(offer, device::UpdatePath::network, now);
  protocol::Reply reply;
  update.update_flag(reply, now);
  update.healthy(now);
  update.packet_sent(now);
  CHECK(update.next_packet(now).kind == device::UpdatePacketKind::none);
  CHECK_FALSE(update.active());
  CHECK(board.storage.change_count() == changes);

  // Started carries the image fields from the first boot on: a confirmed image, no rollback.
  const protocol::Started started = run.services.health.started(protocol::Role::sensor, 1);
  REQUIRE(started.image.present);
  CHECK_FALSE(started.image.fields.flags.on_trial);
  CHECK_FALSE(started.image.fields.flags.rolled_back);
  CHECK(same_version(started.image.fields.failed_version, protocol::FirmwareVersion{}));

  // The role's wake passes through Device unchanged.
  run.role.wake.at = now + device::seconds(30);
  run.role.wake.deepest = SleepDepth::deep;
  run.role.wake.deep_wake_inputs = device::WakeMask::of(device::Input::door);
  const Wake wake = run.device.next_wake();
  CHECK(wake.at == run.role.wake.at);
  CHECK(wake.deepest == SleepDepth::deep);
  CHECK(wake.deep_wake_inputs == run.role.wake.deep_wake_inputs);
  CHECK_FALSE(wake.restart);
}

TEST_CASE("transfer frames on any link go to UpdateService, never to the role") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  Instance& run = boot(instance, board);
  REQUIRE(run.role.seen.size() == 1);
  const Bytes frame = transfer_frame();
  REQUIRE(frame[0] == protocol::kTransferMarker);
  run.runner.deliver(device::Event::from_link(board.clock.now(), board.usb.packet_event(frame)));
  run.runner.deliver(
      device::Event::from_link(board.clock.now(), board.network.packet_event(frame)));
  CHECK(run.role.seen.size() == 1);
  // A packet, and a link's own up and down, still reach the role.
  run.runner.deliver(
      device::Event::from_link(board.clock.now(), board.network.packet_event(Bytes{0x18, 0x00})));
  run.runner.deliver(device::Event::from_link(board.clock.now(), board.network.up_event()));
  CHECK(run.role.seen.size() == 3);
  CHECK(log_codes(run.services, board.clock.now()).empty());
}

TEST_CASE("Bluetooth link events never reach the role; a packet that is no frame is logged") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  Instance& run = boot(instance, board);
  const Instant now = board.clock.now();
  run.runner.deliver(bluetooth_event(now, device::LinkEventKind::up, Bytes{}));
  run.runner.deliver(bluetooth_event(now, device::LinkEventKind::packet, transfer_frame()));
  run.runner.deliver(bluetooth_event(now, device::LinkEventKind::down, Bytes{}));
  CHECK(log_codes(run.services, now).empty());
  run.runner.deliver(bluetooth_event(now, device::LinkEventKind::packet, Bytes{0x18, 0x00}));
  CHECK(run.role.seen.size() == 1);
  CHECK(log_codes(run.services, now) ==
        std::vector<std::uint16_t>{device::log_code::bluetooth_ignored});
}

TEST_CASE("an unpaired board passes no transfer frame on") {
  host::HostBoard board;
  std::optional<Instance> instance;
  Instance& run = boot(instance, board);
  REQUIRE(run.device.setup_only());
  run.runner.deliver(
      device::Event::from_link(board.clock.now(), board.usb.packet_event(transfer_frame())));
  CHECK(run.role.seen.empty());
  CHECK(board.usb.sent.empty());
}

TEST_CASE("an image on trial never sleeps deep: the role's deep wake becomes light") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  board.slots.image.on_trial = true;
  std::optional<Instance> instance;
  Instance& run = boot(instance, board);
  CHECK(run.services.update.on_trial());
  run.role.wake.at = board.clock.now() + device::seconds(60);
  run.role.wake.deepest = SleepDepth::deep;
  run.role.wake.deep_wake_inputs = device::WakeMask::of(device::Input::door);
  const Wake wake = run.device.next_wake();
  CHECK(wake.deepest == SleepDepth::light);
  CHECK(wake.at == run.role.wake.at);
  CHECK(run.runner.plan(board.clock.now()).depth == SleepDepth::light);
  // A shallower wake is left as it is.
  run.role.wake.deepest = SleepDepth::awake;
  CHECK(run.device.next_wake().deepest == SleepDepth::awake);
  // Once confirmed (the next boot reads a confirmed image), deep is allowed again.
  board.slots.image.on_trial = false;
  Instance& again = boot(instance, board, BootKind::other_reset);
  again.role.wake.deepest = SleepDepth::deep;
  CHECK(again.device.next_wake().deepest == SleepDepth::deep);
}

TEST_CASE("on trial, the stuck-awake bound is the larger of the role's and 40 minutes") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  board.slots.image.on_trial = true;
  std::optional<Instance> instance;
  Instance& run = boot(instance, board);
  // A trial ends at its deadline (10 minutes for a sensor), so a role bound shorter than that
  // shows the raised bound; the full 40 minutes, with an update active, is in
  // update_trial_test.cpp.
  run.role.longest = device::seconds(5 * 60);
  run.role.wake.at = board.clock.now() + device::seconds(3600);
  run.role.wake.deepest = SleepDepth::deep;  // capped at light while on trial
  board.clock.advance(device::seconds(9 * 60));
  run.runner.deliver(device::Event::timer_at(board.clock.now()));
  CHECK_FALSE(run.device.next_wake().restart);
  CHECK_FALSE(board.storage.has(device::StoreKey::fatal_error));
  // The trial's deadline restarts it, as a rollback and not as a stuck state machine.
  board.clock.advance(device::seconds(60));
  run.runner.deliver(device::Event::timer_at(board.clock.now()));
  CHECK(run.device.next_wake().restart);
  CHECK_FALSE(board.storage.has(device::StoreKey::fatal_error));

  // A role bound longer than 40 minutes stays its own; no bound stays no bound.
  Instance& longer = boot(instance, board, BootKind::other_reset);
  longer.role.longest = device::seconds(50 * 60);
  longer.role.wake.deepest = SleepDepth::light;
  board.clock.advance(device::seconds(9 * 60));
  longer.runner.deliver(device::Event::timer_at(board.clock.now()));
  CHECK_FALSE(longer.device.next_wake().restart);
  Instance& unbounded = boot(instance, board, BootKind::other_reset);
  unbounded.role.wake.deepest = SleepDepth::light;
  board.clock.advance(device::seconds(9 * 60));
  unbounded.runner.deliver(device::Event::timer_at(board.clock.now()));
  CHECK_FALSE(unbounded.device.next_wake().restart);
}

TEST_CASE("off trial, the stuck-awake bound is the role's, as before") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  Instance& run = boot(instance, board);
  run.role.longest = device::seconds(20 * 60);
  run.role.wake.at = board.clock.now() + device::seconds(3600);
  run.role.wake.deepest = SleepDepth::light;
  board.clock.advance(device::seconds(20 * 60 + 1));
  run.runner.deliver(device::Event::timer_at(board.clock.now()));
  CHECK(run.device.next_wake().restart);
}

TEST_CASE("Health carries the running image into Started once it is given") {
  host::HostBoard board;
  device::Health health(board.storage, board.hal().build);
  health.boot(device::BootInfo{}, 0);
  CHECK_FALSE(health.started(protocol::Role::siren, 2).image.present);

  device::BootImage trial;
  trial.on_trial = true;
  trial.failed = protocol::FirmwareVersion{9, 9, 9};  // not rolled back: not reported
  health.running_image(trial);
  protocol::Started started = health.started(protocol::Role::siren, 2);
  REQUIRE(started.image.present);
  CHECK(started.image.fields.flags.on_trial);
  CHECK_FALSE(started.image.fields.flags.rolled_back);
  CHECK(same_version(started.image.fields.failed_version, protocol::FirmwareVersion{}));
  std::array<std::uint8_t, 13> plaintext{};
  const auto size = protocol::encode_plaintext(started, protocol::MutableByteView(plaintext));
  REQUIRE(size.ok());
  CHECK(size.value() == 13);
  CHECK(plaintext[9] == 0x01);

  device::BootImage after_rollback;
  after_rollback.rolled_back = true;
  after_rollback.failed = protocol::FirmwareVersion{1, 4, 0};
  health.running_image(after_rollback);
  started = health.started(protocol::Role::siren, 2);
  CHECK(started.image.fields.flags.rolled_back);
  CHECK(same_version(started.image.fields.failed_version, after_rollback.failed));

  // Each boot starts again without it.
  health.boot(device::BootInfo{}, 0);
  CHECK_FALSE(health.started(protocol::Role::siren, 2).image.present);
}

TEST_CASE("the update record is 134 bytes under key 0x05, and a factory reset removes it") {
  host::HostBoard board;
  CHECK(static_cast<std::uint8_t>(device::StoreKey::update) == 0x05);
  device::UpdateRecord value;
  value.stage = static_cast<std::uint8_t>(device::UpdateRecordStage::verified);
  value.bytes_written = {0x00, 0x00, 0x01, 0x00};
  device::Record<device::UpdateRecord> record(board.storage, device::StoreKey::update,
                                              device::kUpdateRecordVersion, {});
  REQUIRE(record.update(value) == HalError::none);
  REQUIRE(board.storage.has(device::StoreKey::update));
  CHECK(board.storage.records[device::StoreKey::update].size() == 134);
  CHECK(board.storage.records[device::StoreKey::update][0] == device::kUpdateRecordVersion);
  REQUIRE(board.storage.erase_all_but_role() == HalError::none);
  CHECK_FALSE(board.storage.has(device::StoreKey::update));
}

TEST_CASE(
    "change_key refuses the key held, writing nothing; a new key is taken and reported again") {
  // Built by K2 (m3-updates-design.md section 7); its own tests are secure_channel_rekey_test.cpp.
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  Instance& run = boot(instance, board);
  const std::size_t changes = board.storage.change_count();
  REQUIRE(board.key_import.key().has_value());
  const protocol::DeviceKey held = *board.key_import.key();
  CHECK(run.services.channel.change_key(held, board.clock.now()) == device::Status::refused);
  CHECK_FALSE(run.services.channel.take_key_change());
  CHECK(board.storage.change_count() == changes);
  protocol::DeviceKey new_key = held;
  new_key[0] ^= 0xFF;
  CHECK(run.services.channel.change_key(new_key, board.clock.now()) == device::Status::ok);
  CHECK(run.services.channel.take_key_change());
  CHECK_FALSE(run.services.channel.take_key_change());
  CHECK(board.storage.change_count() == changes + 2);
  // A channel without a key import cannot change its key at all.
  device::CounterState state;
  device::SecureChannel bare(board.cipher, board.storage, state);
  CHECK(bare.change_key(new_key, board.clock.now()) == device::Status::not_ready);
  CHECK_FALSE(bare.take_key_change());
}

TEST_CASE("wake masks join") {
  const device::WakeMask door = device::WakeMask::of(device::Input::door);
  const device::WakeMask both = door | device::WakeMask::of(device::Input::button);
  CHECK(both.has(device::Input::door));
  CHECK(both.has(device::Input::button));
  CHECK_FALSE(both.has(device::Input::cover));
  CHECK((door | device::WakeMask()) == door);
}

}  // namespace
}  // namespace hsn::test
