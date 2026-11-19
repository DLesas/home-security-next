// UpdateService, step 2 (m3-updates-design.md section 2): installing only on the hub's go-ahead,
// the trial and its deadline per role, confirming on healthy(), rollback and what Started reports
// afterwards, and the rules that hold while on trial.

#include <algorithm>

#include "update_bench.hpp"

namespace hsn::test::update {
namespace {

using device::SleepDepth;
using device::UpdatePacketKind;
using device::UpdatePath;
using protocol::UpdateAction;
using protocol::UpdateReason;
using protocol::UpdateStage;

const protocol::FirmwareVersion kOld{1, 0, 0};
const protocol::FirmwareVersion kNew{1, 1, 0};

bool same(const protocol::FirmwareVersion& a, const protocol::FirmwareVersion& b) {
  return a.major == b.major && a.minor == b.minor && a.patch == b.patch;
}

/** A board that has installed a new image and booted it on trial. */
struct OnTrial {
  explicit OnTrial(std::uint8_t role = protocol::Role::sensor)
      : bench(options(role)),
        file(make_file(make_image(kNew, 70000))),
        hub(bench, LinkKind::network, file.file()) {
    bench.boot();
    fetch_to_verified(bench, hub, file, packets);
    REQUIRE(bench.update().next_packet(bench.now).kind == UpdatePacketKind::none);
    // Nothing is installed until the hub says so.
    bench.advance(device::seconds(3600));
    REQUIRE_FALSE(bench.instance->device.next_wake().restart);
    REQUIRE(bench.slots.select_calls == 0);
    install_and_restart(bench, hub, file, packets);
    booted_at = bench.now;
    packets.clear();
  }

  static BenchOptions options(std::uint8_t role) {
    BenchOptions o;
    o.role = role;
    return o;
  }

  Bench bench;
  ImageFile file;
  Source hub;
  Packets packets;
  Instant booted_at;
};

TEST_CASE("the new image boots on trial: Started says so, and the chip never sleeps deep") {
  OnTrial t;
  device::UpdateService& update = t.bench.update();
  CHECK(update.on_trial());
  CHECK(same(update.running().version, kNew));
  CHECK_FALSE(update.running().rolled_back);
  const protocol::Started started = t.bench.services().health.started(protocol::Role::sensor, 0);
  REQUIRE(started.image.present);
  CHECK(started.image.fields.flags.on_trial);
  CHECK_FALSE(started.image.fields.flags.rolled_back);
  CHECK(same(started.firmware_version, kNew));
  // The trial's deadline is the service's only need: light sleep at most until then.
  const device::Wake wake = update.next_wake();
  CHECK(wake.deepest == SleepDepth::light);
  CHECK(wake.at == t.booted_at + device::seconds(600));
  CHECK(t.bench.instance->device.next_wake().deepest == SleepDepth::light);
  // Nothing to ask the hub: the verified record is this image's own.
  CHECK_FALSE(t.bench.take_packet().has_value());
  CHECK(t.bench.storage.has(device::StoreKey::update));
}

TEST_CASE("on trial, no transfer starts: every offer to fetch or install is refused onTrial") {
  OnTrial t;
  const ImageFile other = make_file(make_image({2, 0, 0}, 40000, 5));
  for (const std::uint8_t action : {UpdateAction::fetch, UpdateAction::join_wifi_and_fetch,
                                    UpdateAction::open_bluetooth, UpdateAction::install_now}) {
    CAPTURE(static_cast<int>(action));
    t.bench.update().offer(make_offer(action, other), UpdatePath::network, t.bench.now);
    const auto packet = t.bench.take_packet();
    REQUIRE(packet.has_value());
    CHECK(packet->status.stage == UpdateStage::refused);
    CHECK(packet->status.reason == UpdateReason::on_trial);
    CHECK(packet->status.image_id == other.id);
    CHECK(t.bench.log_value(device::log_code::update_refused) == UpdateReason::on_trial);
  }
  CHECK(t.bench.network.sent.size() == t.bench.network.handled);
  CHECK(t.bench.network.connects == 0);
  CHECK(t.bench.bluetooth.connects == 0);
  CHECK_FALSE(t.bench.bluetooth.connecting);
  CHECK(t.bench.slots.select_calls == 1);
  // "Nothing" and "wait" change nothing either; the reply's flag asks no query.
  t.bench.update().offer(make_offer(UpdateAction::nothing, other), UpdatePath::network,
                         t.bench.now);
  t.bench.update().offer(make_offer(UpdateAction::wait, other), UpdatePath::network, t.bench.now);
  protocol::Reply reply;
  reply.flags.update_available = true;
  t.bench.update().update_flag(reply, t.bench.now);
  CHECK_FALSE(t.bench.take_packet().has_value());
  CHECK(t.bench.storage.has(device::StoreKey::update));
}

TEST_CASE("healthy confirms the trial: confirm, a confirmed status, the record erased") {
  OnTrial t;
  t.bench.advance(device::seconds(2));
  t.bench.update().healthy(t.bench.now);
  CHECK(t.bench.slots.confirm_calls == 1);
  CHECK_FALSE(t.bench.update().on_trial());
  CHECK_FALSE(t.bench.storage.has(device::StoreKey::update));
  const auto packet = t.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->status.stage == UpdateStage::confirmed);
  CHECK(packet->status.reason == UpdateReason::none);
  CHECK(packet->status.image_id == t.file.id);
  CHECK(packet->status.bytes_written == 128 + 70000);
  CHECK(t.bench.log_value(device::log_code::update_confirmed) == 65536 + 256);
  // No deadline any more; deep sleep allowed again.
  CHECK(t.bench.update().next_wake().at.is_never());
  CHECK(t.bench.instance->device.next_wake().deepest == SleepDepth::deep);
  CHECK_FALSE(t.bench.update().active());
  // Healthy again: nothing more.
  t.bench.update().healthy(t.bench.now);
  CHECK(t.bench.slots.confirm_calls == 1);
  CHECK_FALSE(t.bench.take_packet().has_value());
  // Long after the deadline, still running: and every later boot runs it confirmed.
  t.bench.advance(device::seconds(3600));
  CHECK_FALSE(t.bench.instance->device.next_wake().restart);
  CHECK(t.bench.slots.reject_calls == 0);
  t.bench.boot(device::BootKind::other_reset);
  CHECK_FALSE(t.bench.update().on_trial());
  CHECK_FALSE(t.bench.update().running().rolled_back);
  CHECK(same(t.bench.update().running().version, kNew));
  CHECK_FALSE(t.bench.take_packet().has_value());
}

TEST_CASE("healthy off trial does nothing") {
  Bench bench;
  bench.boot();
  bench.update().healthy(bench.now);
  CHECK(bench.slots.confirm_calls == 0);
  CHECK_FALSE(bench.take_packet().has_value());
}

TEST_CASE("confirmation succeeds even when erasing its staging record fails") {
  OnTrial t;
  t.bench.storage.fail_update_erase = true;
  t.bench.update().healthy(t.bench.now);
  CHECK_FALSE(t.bench.update().on_trial());
  REQUIRE(t.bench.storage.has(device::StoreKey::update));
  const auto confirmed = t.bench.take_packet();
  REQUIRE(confirmed.has_value());
  CHECK(confirmed->status.stage == UpdateStage::confirmed);
  CHECK(confirmed->status.image_id == t.file.id);
  CHECK(t.bench.log_value(device::log_code::storage_failed) ==
        static_cast<std::int32_t>(HalError::io));

  t.bench.update().offer(make_offer(UpdateAction::install_now, t.file), UpdatePath::network,
                         t.bench.now);
  const auto query = t.bench.take_packet();
  REQUIRE(query.has_value());
  CHECK(query->kind == UpdatePacketKind::query);
  CHECK(query->query.held == protocol::UpdateHeld::nothing);
  CHECK(t.bench.slots.select_calls == 1);

  t.bench.storage.fail_update_erase = false;
  t.bench.boot(device::BootKind::other_reset);
  CHECK_FALSE(t.bench.update().on_trial());
  CHECK_FALSE(t.bench.storage.has(device::StoreKey::update));
  CHECK_FALSE(t.bench.take_packet().has_value());
}

TEST_CASE("a confirm that fails leaves the image on trial; the next healthy confirms") {
  OnTrial t;
  t.bench.slots.fail_confirm = true;
  t.bench.update().healthy(t.bench.now);
  CHECK(t.bench.update().on_trial());
  CHECK_FALSE(t.bench.take_packet().has_value());
  CHECK(t.bench.storage.has(device::StoreKey::update));
  const auto codes = t.bench.log_codes();
  CHECK(std::count(codes.begin(), codes.end(), device::log_code::update_trial_failed) == 1);
  CHECK(t.bench.update().next_wake().at == t.booted_at + device::seconds(600));
  t.bench.slots.fail_confirm = false;
  t.bench.update().healthy(t.bench.now);
  CHECK_FALSE(t.bench.update().on_trial());
  REQUIRE(t.bench.take_packet().has_value());
}

/** After a rollback: the old image runs, and says what failed. */
void check_rolled_back(Bench& bench) {
  device::UpdateService& update = bench.update();
  CHECK_FALSE(update.on_trial());
  CHECK(same(update.running().version, kOld));
  CHECK(update.running().rolled_back);
  CHECK(same(update.running().failed, kNew));
  const protocol::Started started = bench.services().health.started(protocol::Role::sensor, 0);
  REQUIRE(started.image.present);
  CHECK_FALSE(started.image.fields.flags.on_trial);
  CHECK(started.image.fields.flags.rolled_back);
  CHECK(same(started.image.fields.failed_version, kNew));
  CHECK(same(started.firmware_version, kOld));
  CHECK(bench.log_value(device::log_code::update_rolled_back) == 65536 + 256);
  // The image that failed is not offered to the hub again as verified.
  CHECK_FALSE(bench.storage.has(device::StoreKey::update));
  CHECK_FALSE(bench.take_packet().has_value());
  CHECK(bench.slots.running_works());
  // A rollback costs no fatal error: it is not a stuck state machine.
  CHECK_FALSE(bench.storage.has(device::StoreKey::fatal_error));
}

TEST_CASE("the trial deadline: 10 minutes for a sensor, then reject and restart into the old") {
  OnTrial t;
  t.bench.advance_to(t.booted_at + device::seconds(600) + device::microseconds(-1));
  CHECK_FALSE(t.bench.instance->device.next_wake().restart);
  CHECK(t.bench.slots.reject_calls == 0);
  t.bench.advance_to(t.booted_at + device::seconds(600));
  CHECK(t.bench.slots.reject_calls == 1);
  CHECK(t.bench.instance->device.next_wake().restart);
  CHECK(t.bench.log_codes().back() == device::log_code::update_trial_failed);
  // Healthy too late changes nothing: the restart is asked for.
  t.bench.update().healthy(t.bench.now);
  CHECK(t.bench.slots.confirm_calls == 0);
  t.bench.boot(device::BootKind::other_reset);
  check_rolled_back(t.bench);
}

TEST_CASE("the trial deadline is 5 minutes for a siren and a gateway") {
  for (const std::uint8_t role : {protocol::Role::siren, protocol::Role::gateway}) {
    CAPTURE(static_cast<int>(role));
    OnTrial t(role);
    CHECK(t.bench.update().next_wake().at == t.booted_at + device::seconds(300));
    t.bench.advance_to(t.booted_at + device::seconds(300) + device::microseconds(-1));
    CHECK(t.bench.slots.reject_calls == 0);
    t.bench.advance_to(t.booted_at + device::seconds(300));
    CHECK(t.bench.slots.reject_calls == 1);
    CHECK(t.bench.instance->device.next_wake().restart);
  }
}

TEST_CASE("any reset on trial rolls back, and the old image reports it") {
  OnTrial t;
  t.bench.advance(device::seconds(30));
  // A watchdog reset, a panic, a power cut: the bootloader finds the image still on trial.
  t.bench.boot(device::BootKind::other_reset);
  check_rolled_back(t.bench);
  // And it stays reported until a later image is confirmed.
  t.bench.boot(device::BootKind::power_on);
  CHECK(t.bench.update().running().rolled_back);
}

TEST_CASE("a rollback hides its failed image even if its staging record cannot be erased") {
  OnTrial t;
  t.bench.storage.fail_update_erase = true;
  t.bench.boot(device::BootKind::other_reset);
  CHECK(t.bench.update().running().rolled_back);
  REQUIRE(t.bench.storage.has(device::StoreKey::update));
  CHECK_FALSE(t.bench.take_packet().has_value());
  CHECK(t.bench.log_value(device::log_code::storage_failed) ==
        static_cast<std::int32_t>(HalError::io));

  t.bench.update().offer(make_offer(UpdateAction::install_now, t.file), UpdatePath::network,
                         t.bench.now);
  const auto query = t.bench.take_packet();
  REQUIRE(query.has_value());
  CHECK(query->kind == UpdatePacketKind::query);
  CHECK(query->query.held == protocol::UpdateHeld::nothing);
  CHECK(t.bench.slots.select_calls == 1);

  t.bench.storage.fail_update_erase = false;
  t.bench.boot(device::BootKind::other_reset);
  check_rolled_back(t.bench);
}

TEST_CASE("a reject that fails still restarts: a restart on trial rolls back anyway") {
  OnTrial t;
  t.bench.power.budget = t.bench.power.ops.size();  // the reject's otadata write is cut
  t.bench.advance_to(t.booted_at + device::seconds(600));
  CHECK(t.bench.instance->device.next_wake().restart);
  t.bench.power.restore();
  t.bench.boot(device::BootKind::power_on);
  check_rolled_back(t.bench);
}

TEST_CASE("a selected image the bootloader cannot run is skipped: the old one boots") {
  Bench bench;
  bench.boot();
  ImageFile file = make_file(make_image(kNew, 70000));
  Source hub(bench, LinkKind::network, file.file());
  Packets packets;
  fetch_to_verified(bench, hub, file, packets);
  bench.update().offer(make_offer(UpdateAction::install_now, file), UpdatePath::network, bench.now);
  REQUIRE_FALSE(run(bench, hub, [] { return false; }));
  // Damaged after select() checked it.
  bench.slots.bytes[static_cast<std::size_t>(bench.slots.other_slot())][20] ^= 0xFF;
  bench.boot(device::BootKind::other_reset);
  CHECK(same(bench.update().running().version, kOld));
  CHECK(bench.update().running().rolled_back);
  CHECK(bench.slots.running_works());
}

TEST_CASE("with an update active, the stuck-awake bound is 40 minutes; without one, the role's") {
  Bench bench;
  bench.boot();
  ImageFile file = make_file(make_image(kNew, 70000));
  Source hub(bench, LinkKind::network, file.file());
  Packets packets;
  fetch_to_verified(bench, hub, file, packets);
  bench.boot(device::BootKind::other_reset);
  REQUIRE(bench.update().active());  // a verified image waiting for the go-ahead
  TestRole& role = bench.instance->role;
  role.longest = device::seconds(20 * 60);
  role.wake.at = bench.now + device::seconds(5 * 3600);
  role.wake.deepest = SleepDepth::light;
  const Instant start = bench.now;
  bench.instance->runner.deliver(device::Event::timer_at(bench.now));
  bench.now = start + device::seconds(40 * 60);
  bench.instance->runner.deliver(device::Event::timer_at(bench.now));
  CHECK_FALSE(bench.instance->device.next_wake().restart);
  bench.now = start + device::seconds(40 * 60 + 1);
  bench.instance->runner.deliver(device::Event::timer_at(bench.now));
  CHECK(bench.instance->device.next_wake().restart);
  CHECK(bench.storage.has(device::StoreKey::fatal_error));

  // Nothing active (the image discarded): the role's 20 minutes.
  bench.storage.records.erase(device::StoreKey::fatal_error);
  bench.boot(device::BootKind::other_reset);
  bench.update().offer(make_offer(UpdateAction::nothing, file), UpdatePath::network, bench.now);
  REQUIRE_FALSE(bench.update().active());
  TestRole& again = bench.instance->role;
  again.longest = device::seconds(20 * 60);
  again.wake.at = bench.now + device::seconds(5 * 3600);
  again.wake.deepest = SleepDepth::light;
  const Instant second = bench.now;
  bench.instance->runner.deliver(device::Event::timer_at(bench.now));
  bench.now = second + device::seconds(20 * 60 + 1);
  bench.instance->runner.deliver(device::Event::timer_at(bench.now));
  CHECK(bench.instance->device.next_wake().restart);
}

}  // namespace
}  // namespace hsn::test::update
