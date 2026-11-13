// Device (retained block, breadcrumb, setup interception, setup-only mode, stuck awake) and
// Runner (watchdog feeding, slices, busy loops, one deep sleep per wake). Design sections 2, 5
// and 6.

#include <optional>

#include "device_support.hpp"
#include "hsn/device/device.hpp"
#include "hsn/device/runner.hpp"
#include "hsn/host/host_board.hpp"

namespace hsn::test {
namespace {

using device::BootKind;
using device::EventKind;
using device::RetainedStatus;
using device::SleepDepth;
using device::Wake;
using Instance = host::HostInstance<TestRole>;

/** Builds a fresh instance on the board and boots it, as a reset does. */
Instance& boot(std::optional<Instance>& instance, host::HostBoard& board, BootKind kind,
               device::WakeMask woke_by = device::WakeMask()) {
  instance.reset();
  instance.emplace(board);
  instance->runner.start(board.boot_event(kind, woke_by));
  return *instance;
}

std::uint32_t breadcrumb(host::HostBoard& board) {
  const auto crumb = board.retained.breadcrumb();
  return static_cast<std::uint32_t>(crumb[0] | (crumb[1] << 8) | (crumb[2] << 16)) |
         (static_cast<std::uint32_t>(crumb[3]) << 24);
}

TEST_CASE("an unpaired board, or one with another role, stays in setup-only mode") {
  host::HostBoard board;
  std::optional<Instance> instance;
  boot(instance, board, BootKind::power_on);
  CHECK(instance->device.setup_only());
  CHECK(instance->role.seen.empty());
  const Wake wake = instance->device.next_wake();
  CHECK(wake.at.is_never());
  CHECK(wake.deepest == SleepDepth::deep);

  pair_board(board, protocol::Role::siren);
  boot(instance, board, BootKind::power_on);  // TestRole is a sensor
  CHECK(instance->device.setup_only());
  CHECK(instance->role.seen.empty());
}

/** Stores a role without a pairing, or a pairing without a role. */
void half_set_up(host::HostBoard& board, bool with_role) {
  pair_board(board, protocol::Role::sensor);
  board.storage.records.erase(with_role ? device::StoreKey::pairing : device::StoreKey::role);
}

TEST_CASE("setup-only on a cell sleeps deep until power or the button; on power it stays up") {
  for (const bool with_role : {true, false}) {
    INFO("with role: " << with_role);
    host::HostBoard board;
    half_set_up(board, with_role);
    std::optional<Instance> instance;
    Instance& run = boot(instance, board, BootKind::power_on);
    REQUIRE(run.device.setup_only());
    const device::WaitRequest asleep = run.runner.plan(board.clock.now());
    CHECK(asleep.depth == SleepDepth::deep);
    CHECK(asleep.until.is_never());
    CHECK(asleep.deep_wake_inputs.has(device::Input::external_power));
    CHECK(asleep.deep_wake_inputs.has(device::Input::button));
    CHECK_FALSE(asleep.deep_wake_inputs.has(device::Input::door));
    CHECK_FALSE(asleep.deep_wake_inputs.has_timer());

    // Plugged in: the platform wakes it, and it stays reachable for setup messages.
    board.power.external = true;
    Instance& woken = boot(instance, board, BootKind::deep_sleep_wake,
                           device::WakeMask::of(device::Input::external_power));
    const device::WaitRequest awake = woken.runner.plan(board.clock.now());
    CHECK(awake.depth == SleepDepth::light);
    CHECK(awake.until <= board.clock.now() + device::kFeedSlice);
    woken.runner.deliver(
        device::Event::from_link(board.clock.now(), board.usb.packet_event(Bytes{0xF1, 0x01})));
    CHECK(board.usb.sent.size() == 1);
    CHECK(woken.runner.plan(board.clock.now()).depth == SleepDepth::light);

    // Unplugged again: back to deep sleep at the next plan.
    board.power.external = false;
    device::InputEvent unplugged;
    unplugged.input = device::Input::external_power;
    unplugged.active = false;
    woken.runner.deliver(device::Event::from_input(board.clock.now(), unplugged));
    CHECK(woken.runner.plan(board.clock.now()).depth == SleepDepth::deep);
    CHECK(woken.role.seen.empty());
  }
}

TEST_CASE("a paired board starts its role and channel, and the boot is a start-up") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  board.clock.set(at_seconds(5));
  Instance& run = boot(instance, board, BootKind::power_on);
  CHECK_FALSE(run.device.setup_only());
  REQUIRE(run.role.seen.size() == 1);
  CHECK(run.role.seen[0].kind == EventKind::boot);
  CHECK(run.role.seen[0].boot.retained == RetainedStatus::none);
  CHECK(device::is_start_up(run.role.seen[0].boot));
  CHECK(run.services.channel.started());
  CHECK(run.services.channel.address() == kAddress);
  CHECK(run.services.uptime_seconds(at_seconds(65)) == 60);
}

TEST_CASE("the airtime record and its last transmission survive a deep-sleep wake") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  Instance& first = boot(instance, board, BootKind::power_on);
  // A full legal hour on the site channel, the last packet ending at 50 s.
  first.services.airtime.record(device::Band::g1, at_seconds(10), device::seconds(36));
  first.services.airtime.record(device::Band::g1, at_seconds(49), device::seconds(1));
  board.clock.set(at_seconds(50));
  first.runner.deliver(device::Event::timer_at(board.clock.now()));  // seals the block

  board.clock.set(at_seconds(52));
  Instance& woken = boot(instance, board, BootKind::deep_sleep_wake, device::WakeMask::timer());
  REQUIRE(woken.role.seen[0].boot.retained == RetainedStatus::intact);
  CHECK(woken.services.airtime.used_last_hour(device::Band::g1, at_seconds(52)) ==
        device::seconds(37));
  // Past the hour, an essential 1 s packet waits 9 s from the last packet's end.
  const auto admission = woken.services.airtime.admit(device::Band::g1, device::seconds(1),
                                                      device::TxClass::essential, at_seconds(52));
  CHECK_FALSE(admission.allowed);
  CHECK(admission.past_limit);
  CHECK(admission.earliest == at_seconds(59));
}

TEST_CASE("the role's state and the core's survive deep sleep in the retained block") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  Instance& first = boot(instance, board, BootKind::power_on);
  first.role.state.state_id = 7;
  first.runner.deliver(device::Event::timer_at(board.clock.now()));
  CHECK(first.role.state.events == 2);
  const std::uint32_t uptime_base = first.services.uptime_seconds(at_seconds(100));

  board.clock.advance(device::seconds(180));
  Instance& woken = boot(instance, board, BootKind::deep_sleep_wake, device::WakeMask::timer());
  CHECK(woken.role.state.events == 3);
  CHECK(woken.role.state.state_id == 7);
  CHECK(woken.role.seen[0].boot.retained == RetainedStatus::intact);
  CHECK_FALSE(device::is_start_up(woken.role.seen[0].boot));
  // A deep-sleep wake is not a start-up: uptime keeps counting from the first boot.
  CHECK(woken.services.uptime_seconds(at_seconds(100)) == uptime_base);
}

TEST_CASE("a corrupted block, a changed role layout or a power loss is a cold start") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  boot(instance, board, BootKind::power_on);
  board.retained.corrupt(200);
  CHECK(boot(instance, board, BootKind::deep_sleep_wake).role.seen[0].boot.retained ==
        RetainedStatus::none);

  boot(instance, board, BootKind::deep_sleep_wake);
  instance.reset();
  instance.emplace(board);
  instance->role.layout = 2;
  instance->runner.start(board.boot_event(BootKind::deep_sleep_wake));
  CHECK(instance->role.seen[0].boot.retained == RetainedStatus::none);
  CHECK(device::is_start_up(instance->role.seen[0].boot));

  board.power_loss();
  CHECK(boot(instance, board, BootKind::power_on).role.seen[0].boot.retained ==
        RetainedStatus::none);
}

TEST_CASE("a clock that went backwards keeps the state but says its deadlines mean nothing") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  board.clock.set(at_seconds(5000));
  boot(instance, board, BootKind::power_on);
  board.clock.set(at_seconds(3));
  Instance& run = boot(instance, board, BootKind::other_reset);
  CHECK(run.role.seen[0].boot.retained == RetainedStatus::clock_reset);
  CHECK(run.role.state.events == 2);
}

TEST_CASE("a role state too large for the block is not retained, and the role still runs") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  instance.emplace(board);
  instance->role.big_state = true;
  instance->runner.start(board.boot_event(BootKind::power_on));
  CHECK(instance->role.seen.size() == 1);
  CHECK(instance->services.log.size() == 1);
}

TEST_CASE("setup messages are answered on USB, never reach the role, and are ignored elsewhere") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  Instance& run = boot(instance, board, BootKind::power_on);
  run.runner.deliver(
      device::Event::from_link(board.clock.now(), board.usb.packet_event(Bytes{0xF1, 0x01})));
  REQUIRE(board.usb.sent.size() == 1);
  CHECK(board.usb.sent[0].packet[0] == 0xF1);
  CHECK(board.usb.sent[0].packet[1] == protocol::setup_type::identity);
  run.runner.deliver(
      device::Event::from_link(board.clock.now(), board.network.packet_event(Bytes{0xF1, 0x01})));
  CHECK(board.usb.sent.size() == 1);
  CHECK(board.network.sent.empty());
  CHECK(run.role.seen.size() == 1);
  // An ordinary packet does reach the role.
  run.runner.deliver(
      device::Event::from_link(board.clock.now(), board.network.packet_event(Bytes{0x18, 0x00})));
  CHECK(run.role.seen.size() == 2);
}

TEST_CASE("an accepted provision restarts the device with nothing retained") {
  host::HostBoard board;
  std::optional<Instance> instance;
  pair_board(board, protocol::Role::sensor);
  Instance& run = boot(instance, board, BootKind::power_on);
  protocol::Provision provision;
  provision.pairing.address = kAddress + 5;
  provision.pairing.key = kKey;
  Bytes bytes(300);
  const auto size =
      protocol::encode_setup(provision, protocol::MutableByteView(bytes.data(), bytes.size()));
  REQUIRE(size.ok());
  bytes.resize(size.value());
  run.runner.deliver(device::Event::from_link(board.clock.now(), board.usb.packet_event(bytes)));
  CHECK(run.device.next_wake().restart);
  CHECK(run.runner.plan(board.clock.now()).restart);
  Instance& again = boot(instance, board, BootKind::other_reset);
  CHECK(again.role.seen[0].boot.retained == RetainedStatus::none);
  CHECK(again.services.channel.address() == kAddress + 5);
}

TEST_CASE("the breadcrumb names the event and state; after a watchdog reset Started reports it") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  Instance& run = boot(instance, board, BootKind::power_on);
  run.role.state.state_id = 0x42;
  run.role.on_event = [&](const device::Event&) {
    CHECK(breadcrumb(board) == device::breadcrumb_of(EventKind::radio, 0x42));
  };
  device::RadioEvent radio;
  radio.kind = device::RadioEventKind::rx_timeout;
  run.runner.deliver(device::Event::from_radio(board.clock.now(), radio));
  // The handler hung there; the watchdog reset the chip.
  instance.reset();
  instance.emplace(board);
  device::Event reset = board.boot_event(BootKind::other_reset);
  reset.boot.watchdog_reset = true;
  instance->runner.start(reset);
  CHECK(instance->services.health.started(protocol::Role::sensor, 0).last_fatal_error ==
        (device::fatal_code::watchdog | device::breadcrumb_of(EventKind::radio, 0x42)));
}

TEST_CASE("a role awake past its longest awake time is restarted with a stored fatal error") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  Instance& run = boot(instance, board, BootKind::power_on);
  run.role.longest = device::seconds(10);
  run.role.wake.at = board.clock.now() + device::seconds(60);
  run.role.wake.deepest = SleepDepth::light;
  board.clock.advance(device::seconds(9));
  run.runner.deliver(device::Event::timer_at(board.clock.now()));
  CHECK_FALSE(run.device.next_wake().restart);
  board.clock.advance(device::seconds(2));
  run.runner.deliver(device::Event::timer_at(board.clock.now()));
  CHECK(run.device.next_wake().restart);
  CHECK(board.storage.has(device::StoreKey::fatal_error));
  // Allowing deep sleep resets the count.
  Instance& again = boot(instance, board, BootKind::other_reset);
  again.role.longest = device::seconds(10);
  again.role.wake.deepest = SleepDepth::deep;
  board.clock.advance(device::seconds(30));
  again.runner.deliver(device::Event::timer_at(board.clock.now()));
  CHECK_FALSE(again.device.next_wake().restart);
}

/** Runs the platform loop shape with the fake waiter until it sleeps deep, restarts, or stops. */
void run_loop(Instance& run, host::HostBoard& board, int max_waits) {
  for (int i = 0; i < max_waits; ++i) {
    const device::WaitResult result = board.waiter.wait(run.runner.plan(board.clock.now()));
    if (board.waiter.slept || board.waiter.restarted) {
      return;
    }
    if (result.has_event) {
      run.runner.deliver(result.event);
    } else {
      run.runner.timed_out(board.clock.now());
    }
  }
}

TEST_CASE("a 60-second light-sleep wait is fed every 2 s and ends in one timer event") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  Instance& run = boot(instance, board, BootKind::power_on);
  CHECK(board.watchdog.timeout_ms == device::kWatchdogTimeoutMs);
  const Instant due = board.clock.now() + device::seconds(60);
  run.role.wake.at = due;
  run.role.wake.deepest = SleepDepth::light;
  run.role.on_event = [&](const device::Event&) { run.role.wake.at = Instant::never(); };
  run_loop(run, board, 40);
  REQUIRE(run.role.seen.size() == 2);
  CHECK(run.role.seen[1].kind == EventKind::timer);
  CHECK(run.role.seen[1].now == due);
  for (const device::WaitRequest& request : board.waiter.requests) {
    CHECK(request.depth == SleepDepth::light);
  }
  CHECK(board.watchdog.longest_gap(board.clock.now()) <= device::kFeedSlice);
  CHECK_FALSE(board.watchdog.would_have_fired(board.clock.now()));
}

TEST_CASE("a hardware event during a wait is delivered at once and fed") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  Instance& run = boot(instance, board, BootKind::power_on);
  run.role.wake.at = board.clock.now() + device::seconds(30);
  run.role.wake.deepest = SleepDepth::light;
  device::InputEvent door;
  door.input = device::Input::door;
  door.active = true;
  board.waiter.script(
      device::Event::from_input(board.clock.now() + device::milliseconds(4500), door));
  run.role.on_event = [&](const device::Event& event) {
    if (event.kind == EventKind::input) {
      run.role.wake.at = Instant::never();
    }
  };
  run_loop(run, board, 10);
  REQUIRE(run.role.seen.size() == 2);
  CHECK(run.role.seen[1].kind == EventKind::input);
  CHECK(run.role.seen[1].now == at_seconds(0) + device::milliseconds(4500));
}

TEST_CASE("a deep sleep is one unsliced wait, and each wake sleeps exactly once") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  for (int cycle = 0; cycle < 3; ++cycle) {
    Instance& run =
        boot(instance, board, cycle == 0 ? BootKind::power_on : BootKind::deep_sleep_wake,
             device::WakeMask::timer());
    REQUIRE(run.role.seen.size() == 1);
    run.role.wake.at = board.clock.now() + device::seconds(180);
    run.role.wake.deepest = SleepDepth::deep;
    run.role.wake.deep_wake_inputs = device::WakeMask::of(device::Input::door);
    board.waiter.requests.clear();
    board.waiter.slept = false;
    run_loop(run, board, 10);
    REQUIRE(board.waiter.slept);
    REQUIRE(board.waiter.requests.size() == 1);
    CHECK(board.waiter.requests[0].depth == SleepDepth::deep);
    CHECK(board.waiter.requests[0].until == run.role.wake.at);
    CHECK(board.waiter.requests[0].deep_wake_inputs.has(device::Input::door));
    // The chip sleeps, then the timer wakes it.
    board.clock.set(run.role.wake.at);
  }
  CHECK(instance->role.state.events == 3);
}

TEST_CASE("a role that keeps asking to run at once is a busy loop, restarted with a fatal error") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  Instance& run = boot(instance, board, BootKind::power_on);
  run.role.wake.at = board.clock.now();
  run.role.on_event = [&](const device::Event& event) { run.role.wake.at = event.now; };
  run_loop(run, board, 200);
  CHECK(board.waiter.restarted);
  CHECK(run.role.seen.size() == device::kBusyLoopLimit + 1);
  CHECK(board.storage.has(device::StoreKey::fatal_error));
  board.waiter.restarted = false;
  Instance& again = boot(instance, board, BootKind::other_reset);
  CHECK(again.services.health.last_fatal() == device::fatal_code::busy_loop);
}

TEST_CASE("a slice that ends before the wake time does not call the role") {
  host::HostBoard board;
  pair_board(board, protocol::Role::sensor);
  std::optional<Instance> instance;
  Instance& run = boot(instance, board, BootKind::power_on);
  run.role.wake.at = board.clock.now() + device::seconds(10);
  run.role.wake.deepest = SleepDepth::awake;
  const device::WaitRequest request = run.runner.plan(board.clock.now());
  CHECK(request.until == board.clock.now() + device::kFeedSlice);
  const std::size_t feeds = board.watchdog.feeds.size();
  board.clock.set(request.until);
  run.runner.timed_out(board.clock.now());
  CHECK(run.role.seen.size() == 1);
  CHECK(board.watchdog.feeds.size() == feeds + 1);
}

}  // namespace
}  // namespace hsn::test
