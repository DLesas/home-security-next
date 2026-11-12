// The Simulation (design section 8): repeatable runs, drifting clocks, deep sleep as a reset,
// power loss, scripted inputs, the hardware-call budget and speed. Driven by ProbeRole.

#include <chrono>
#include <functional>
#include <string>

#include "host/sim_support.hpp"
#include "hsn/host/simulation_error.hpp"

namespace hsn::test {
namespace {

using device::BootKind;
using device::EventKind;
using device::Input;
using device::RetainedStatus;
using host::DeviceSpec;
using host::SimDevice;
using host::Simulation;

/** Adds a paired probe board. */
SimDevice& add_probe(Simulation& sim, const std::string& name, const ProbeConfig& config,
                     ProbeLog& log, std::int32_t drift_ppm = 0,
                     device::Instant power_on = device::Instant{},
                     std::uint32_t address = 0x1A2B3C4D) {
  DeviceSpec spec;
  spec.name = name;
  spec.role = probe(config, log);
  spec.drift_ppm = drift_ppm;
  spec.power_on = power_on;
  SimDevice& device = sim.add_device(spec);
  host::provision(device.board(), sensor_pairing(address));
  return device;
}

/** Three transmitting probes whose channel checks find each other busy: random back-offs. */
std::string busy_channel_timeline(std::uint64_t seed) {
  host::SimulationOptions options;
  options.seed = seed;
  Simulation sim(options);
  ProbeConfig config;
  config.deep = false;
  config.transmit = true;
  config.period = seconds(10);
  ProbeLog logs[3];
  for (int i = 0; i < 3; ++i) {
    add_probe(sim, "probe" + std::to_string(i), config, logs[i], 20 * i,
              device::Instant{} + milliseconds(2 * i), 0x1A2B3C40u + static_cast<std::uint32_t>(i));
  }
  sim.run_until(at(seconds(600)));
  return sim.timeline().select().dump();
}

TEST_CASE("two runs with the same seed give the identical timeline; another seed does not") {
  const std::string first = busy_channel_timeline(1);
  CHECK(first.find("busy") != std::string::npos);
  CHECK(first == busy_channel_timeline(1));
  CHECK(first != busy_channel_timeline(2));
}

TEST_CASE("each board's clock runs at its own drift") {
  Simulation sim;
  ProbeConfig config;
  config.deep = false;
  config.transmit = true;
  config.period = seconds(60);
  ProbeLog fast_log;
  ProbeLog slow_log;
  SimDevice& fast = add_probe(sim, "fast", config, fast_log, 100, device::Instant{}, 0x11111111);
  SimDevice& slow = add_probe(sim, "slow", config, slow_log, -100, device::Instant{}, 0x22222222);
  // Far apart, so their packets never meet.
  sim.medium().cut(fast.station(), slow.station());
  sim.run_until(at(seconds(86400)));

  // A true day reads 86,400 s × (1 ± 10^-4) on each board.
  CHECK(fast.local_now() == device::Instant{} + device::microseconds(86408640000));
  CHECK(slow.local_now() == device::Instant{} + device::microseconds(86391360000));
  // So in one true day the fast board wakes once more.
  CHECK(fast_log.wakes.size() == 1441);
  CHECK(slow_log.wakes.size() == 1440);

  // Its 1,440th wake is at 86,340.05 s on its own clock: 86,331.42 s and 86,348.68 s true. The
  // packet goes out a channel check (3 ms) later.
  const auto fast_sent = fast.records().kind(RecordKind::transmission).records();
  const auto slow_sent = slow.records().kind(RecordKind::transmission).records();
  REQUIRE(fast_sent.size() >= 1440);
  REQUIRE(slow_sent.size() >= 1440);
  const double fast_at = static_cast<double>(fast_sent[1439].from.us) / 1e6;
  const double slow_at = static_cast<double>(slow_sent[1439].from.us) / 1e6;
  CHECK(fast_at == doctest::Approx(86340.053 / 1.0001).epsilon(1e-8));
  CHECK(slow_at == doctest::Approx(86340.053 / 0.9999).epsilon(1e-8));
  CHECK(slow_at - fast_at == doctest::Approx(17.27).epsilon(1e-3));
}

TEST_CASE("deep sleep rebuilds the role: RAM is lost, retained memory and flash are kept") {
  Simulation sim;
  ProbeConfig config;
  config.flash_every = 1;
  ProbeLog log;
  SimDevice& probe_board = add_probe(sim, "probe", config, log);
  sim.run_until(at(seconds(400)));

  // Timers at 180.05 and 360.05 s; each boot follows its wake by the 50 ms boot time.
  CHECK(probe_board.boots() == 3);
  std::vector<ProbeLog::Entry> boots;
  for (const ProbeLog::Entry& entry : log.entries) {
    if (entry.kind == EventKind::boot) {
      boots.push_back(entry);
    }
  }
  REQUIRE(boots.size() == 3);
  CHECK(boots[0].boot.kind == BootKind::power_on);
  CHECK(boots[0].boot.retained == RetainedStatus::none);
  for (std::size_t i = 1; i < boots.size(); ++i) {
    CHECK(boots[i].boot.kind == BootKind::deep_sleep_wake);
    CHECK(boots[i].boot.woke_by.has_timer());
    CHECK(boots[i].boot.retained == RetainedStatus::intact);
  }
  for (std::size_t i = 0; i < boots.size(); ++i) {
    // The count in retained memory goes on; the count in RAM starts again every boot.
    CHECK(boots[i].wakes == i + 1);
    CHECK(boots[i].ram_events == 1);
  }
  CHECK(boots[2].local == at(seconds(360)) + milliseconds(100));
  CHECK(probe_board.state() == host::PowerState::deep_sleep);
  CHECK(probe_board.records().kind(RecordKind::deep_sleep).count() == 3);
  CHECK(probe_board.records().kind(RecordKind::flash_write).count() == 3);
  REQUIRE(probe_board.board().storage.has(device::StoreKey::sensor_first));
  CHECK(probe_board.board().storage.records.at(device::StoreKey::sensor_first)[1] == 3);
}

TEST_CASE("a power loss wipes retained memory and restarts the clock; flash survives") {
  Simulation sim;
  ProbeConfig config;
  config.flash_every = 2;
  ProbeLog log;
  SimDevice& probe_board = add_probe(sim, "probe", config, log);
  probe_board.power_loss(at(seconds(200)), seconds(5));
  sim.run_until(at(seconds(210)));

  const ProbeLog::Entry& last = log.entries.back();
  CHECK(last.kind == EventKind::boot);
  CHECK(last.boot.kind == BootKind::power_on);
  CHECK(last.boot.retained == RetainedStatus::none);
  CHECK(last.wakes == 1);
  // The RTC started again when power came back at 205 s.
  CHECK(last.local == device::Instant{} + milliseconds(50));
  CHECK(probe_board.local_now() == at(seconds(5)));
  // Flash still holds the count written at the second wake, before the power went.
  CHECK(probe_board.board().storage.records.at(device::StoreKey::sensor_first)[1] == 2);
  CHECK(probe_board.records().kind(RecordKind::power_loss).count() == 1);
}

TEST_CASE("a restart rebuilds RAM and keeps retained memory") {
  Simulation sim;
  ProbeConfig config;
  config.deep = false;
  ProbeLog log;
  SimDevice& probe_board = add_probe(sim, "probe", config, log);
  probe_board.restart(at(seconds(30)));
  sim.run_until(at(seconds(31)));
  const ProbeLog::Entry& last = log.entries.back();
  CHECK(last.boot.kind == BootKind::other_reset);
  CHECK(last.boot.reset_cause == 3);
  CHECK(last.boot.retained == RetainedStatus::intact);
  CHECK(last.ram_events == 1);
  CHECK(probe_board.boots() == 2);
}

TEST_CASE("scripted inputs arrive as events, or wake a deep sleep when they are wake inputs") {
  SUBCASE("a door opening wakes a deep-sleeping board") {
    Simulation sim;
    ProbeLog log;
    SimDevice& probe_board = add_probe(sim, "probe", ProbeConfig{}, log);
    probe_board.set_input(Input::door, true, at(seconds(10)));
    sim.run_until(at(seconds(11)));
    const ProbeLog::Entry& last = log.entries.back();
    CHECK(last.kind == EventKind::boot);
    CHECK(last.boot.kind == BootKind::deep_sleep_wake);
    CHECK(last.boot.woke_by == device::WakeMask::of(Input::door));
    CHECK(last.local == at(seconds(10)) + milliseconds(50));
    CHECK(probe_board.board().sensor_io.door);
  }
  SUBCASE("an input that is not a wake input only changes the level") {
    Simulation sim;
    ProbeLog log;
    SimDevice& probe_board = add_probe(sim, "probe", ProbeConfig{}, log);
    probe_board.set_input(Input::cover, true, at(seconds(10)));
    sim.run_until(at(seconds(11)));
    CHECK(probe_board.boots() == 1);
    CHECK(probe_board.board().sensor_io.cover);
  }
  SUBCASE("a held button and arriving power reach an awake board at their times") {
    Simulation sim;
    ProbeConfig config;
    config.deep = false;
    ProbeLog log;
    SimDevice& probe_board = add_probe(sim, "probe", config, log, 1000);
    probe_board.hold_button(at(seconds(5)), at(seconds(11)));
    probe_board.set_input(Input::external_power, true, at(seconds(20)));
    sim.run_until(at(seconds(30)));
    std::vector<ProbeLog::Entry> inputs;
    for (const ProbeLog::Entry& entry : log.entries) {
      if (entry.kind == EventKind::input) {
        inputs.push_back(entry);
      }
    }
    REQUIRE(inputs.size() == 3);
    CHECK(inputs[0].input.input == Input::button);
    CHECK(inputs[0].input.active);
    CHECK(inputs[1].input.input == Input::button);
    CHECK_FALSE(inputs[1].input.active);
    CHECK(inputs[2].input.input == Input::external_power);
    // Stamped on the board's own clock, 1,000 ppm fast.
    CHECK(inputs[0].input.at == device::Instant{} + milliseconds(5005));
    CHECK(inputs[1].input.at == device::Instant{} + milliseconds(11011));
    CHECK(probe_board.board().power.external);
    CHECK(probe_board.records().kind(RecordKind::input).count() == 3);
  }
}

TEST_CASE("deep sleep puts the radio to sleep: a board in deep sleep hears nothing") {
  Simulation sim;
  ProbeConfig sleeper_config;
  sleeper_config.listen_before_sleep = true;
  ProbeLog sleeper_log;
  SimDevice& sleeper = add_probe(sim, "sleeper", sleeper_config, sleeper_log);
  ProbeConfig talker_config;
  talker_config.deep = false;
  talker_config.transmit = true;
  talker_config.period = seconds(10);
  ProbeLog talker_log;
  add_probe(sim, "talker", talker_config, talker_log, 0, at(seconds(1)), 0x22222222);
  sim.run_until(at(seconds(30)));
  CHECK(sleeper.state() == host::PowerState::deep_sleep);
  CHECK(sleeper.board().radio.mode() == host::RadioMode::sleeping);
  CHECK(sleeper.records().kind(RecordKind::rx_window).count() == 1);
  CHECK(sleeper.records().kind(RecordKind::reception).empty());
}

TEST_CASE("the scheduler runs ties in order and stops a zero-time loop") {
  host::Scheduler scheduler;
  std::string order;
  scheduler.schedule(at(seconds(2)), [&]() { order += "b"; });
  scheduler.schedule(at(seconds(1)), [&]() { order += "a"; });
  scheduler.schedule(at(seconds(2)), [&]() { order += "c"; });
  scheduler.run_until(at(seconds(3)));
  CHECK(order == "abc");
  CHECK(scheduler.now() == at(seconds(3)));
  std::function<void()> again = [&]() { scheduler.schedule(scheduler.now(), again); };
  scheduler.schedule(at(seconds(4)), again);
  CHECK_THROWS_WITH_AS(scheduler.run_until(at(seconds(5))), doctest::Contains("time stands still"),
                       host::SimulationError);
}

TEST_CASE("a handle() over the hardware-call budget fails the run with a message") {
  SUBCASE("over 32 calls") {
    Simulation sim;
    ProbeConfig config;
    config.extra_calls = 40;
    ProbeLog log;
    add_probe(sim, "greedy", config, log);
    CHECK_THROWS_WITH_AS(sim.run_until(at(seconds(1))),
                         doctest::Contains("hardware calls in one handle() of a boot event"),
                         host::SimulationError);
  }
  SUBCASE("within the budget") {
    Simulation sim;
    ProbeConfig config;
    config.extra_calls = 10;
    ProbeLog log;
    add_probe(sim, "frugal", config, log);
    CHECK_NOTHROW(sim.run_until(at(seconds(400))));
  }
}

TEST_CASE("thirty days of a periodic sensor-like role take well under a second") {
  host::SimulationOptions options;
  options.keep_fake_records = false;
  Simulation sim(options);
  ProbeConfig config;
  config.transmit = true;
  ProbeLog log;
  SimDevice& probe_board = add_probe(sim, "probe", config, log);
  // The one wall-clock reading in the bench's tests.
  const auto started = std::chrono::steady_clock::now();
  sim.run_until(at(seconds(30 * 86400)));
  const auto elapsed = std::chrono::steady_clock::now() - started;
  MESSAGE("30 simulated days in " << std::chrono::duration<double>(elapsed).count() << " s");
  CHECK(log.wakes.size() == 14400);
  CHECK(probe_board.records().kind(RecordKind::transmission).count() == 14400);
  // Twenty or twenty-one 62 ms heartbeats in any rolling hour: far below 1% (36 s).
  CHECK(probe_board.records().busiest_hour() <= milliseconds(21 * 62));
  CHECK(probe_board.records().busiest_hour() >= milliseconds(20 * 61));
  // Generous: sanitizer builds and slow machines included.
  CHECK(elapsed < std::chrono::seconds(10));
}

}  // namespace
}  // namespace hsn::test
