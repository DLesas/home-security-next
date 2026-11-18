// The power-cut harness (m3-updates-design.md section 8, "a power cut at every flash operation") on
// scenarios that write storage only: one device on the test hub's radio, and a sensor, a siren and
// a gateway together on the simulated radio. Every run, cut or not, must keep each device working,
// and no counter may ever be used for two different packets.

#include <doctest/doctest.h>

#include <map>
#include <memory>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "hsn/host/power_cut_harness.hpp"
#include "hsn/host/test_hub.hpp"
#include "sim_support.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using host::CutPoint;
using host::CutRun;
using host::FlashOp;
using host::PowerState;

/** No counter of one device carried two different packets to the hub (a nonce reused). */
void check_no_counter_reused(const host::TestHub& hub, const std::string& name) {
  std::map<std::uint32_t, Bytes> seen;
  for (const host::HubPacket& packet : hub.received()) {
    if (packet.from != name || packet.body.empty()) {
      continue;
    }
    const auto found = seen.find(packet.counter);
    if (found == seen.end()) {
      seen.emplace(packet.counter, packet.body);
      continue;
    }
    CAPTURE(packet.counter);
    CHECK(found->second == packet.body);
  }
}

bool alive(const host::SimDevice& device) {
  return device.state() == PowerState::running || device.state() == PowerState::deep_sleep;
}

/** One probe that writes its wake count, then sends a heartbeat the hub opens, every 5 s. */
struct ProbeWorld {
  ProbeWorld() : hub(sim) {
    ProbeConfig config;
    config.deep = true;
    config.period = seconds(5);
    config.transmit = true;
    config.flash_every = 1;
    host::DeviceSpec spec;
    spec.name = "probe";
    spec.role = probe(config, log);
    device = &sim.add_device(spec);
    hub.add_sensor(*device);
  }
  host::Simulation sim;
  host::TestHub hub;
  ProbeLog log;
  host::SimDevice* device = nullptr;
};

host::CutScenario<ProbeWorld> probe_scenario(std::vector<CutRun>& runs) {
  host::CutScenario<ProbeWorld> scenario;
  scenario.make = []() { return std::make_unique<ProbeWorld>(); };
  scenario.simulation = [](ProbeWorld& world) -> host::Simulation& { return world.sim; };
  scenario.run = [](ProbeWorld& world) { world.sim.run_until(at(seconds(40))); };
  scenario.check = [&runs](ProbeWorld& world, const CutRun& run) {
    INFO(run.describe());
    runs.push_back(run);
    CHECK(alive(*world.device));
    CHECK(world.device->power_cuts() == (run.uncut() ? 0u : 1u));
    check_no_counter_reused(world.hub, "probe");
    // The count record is whole: version byte and four bytes, never torn.
    const auto stored = world.device->board().storage.records.find(device::StoreKey::sensor_first);
    REQUIRE(stored != world.device->board().storage.records.end());
    CHECK(stored->second.size() == 5);
    // The probe goes on: it is heard in the last ten seconds.
    CHECK(world.hub.received_from("probe").size() > 0);
    CHECK(world.device->records()
              .kind(host::RecordKind::transmission)
              .between(at(seconds(30)), at(seconds(40)))
              .count() >= 1);
  };
  return scenario;
}

TEST_CASE("the harness cuts once at every operation, during and after, and checks every run") {
  std::vector<CutRun> runs;
  const host::CutReport report = host::run_power_cuts(probe_scenario(runs));
  const std::uint64_t operations = report.operations.at("probe");
  // Eight wakes, each a count write, and a resume point now and then.
  CHECK(operations >= 8);
  CHECK(report.runs == 1 + 2 * operations);
  REQUIRE(runs.size() == report.runs);
  CHECK(runs[0].uncut());
  // Every operation once at each point, in order; the operation cut is the one the run without a
  // cut made at that place.
  ProbeWorld reference;
  reference.device->board().power_cut.arm(0, CutPoint::during);
  reference.sim.run_until(at(seconds(40)));
  const auto& counted = reference.device->board().power_cut.counted();
  REQUIRE(counted.size() == operations);
  std::size_t at_index = 1;
  for (const CutPoint point : {CutPoint::during, CutPoint::after}) {
    for (std::uint64_t nth = 1; nth <= operations; ++nth, ++at_index) {
      const CutRun& run = runs[at_index];
      CHECK(run.device == "probe");
      CHECK(run.nth == nth);
      CHECK(run.point == point);
      CHECK(run.op == counted[nth - 1].op);
    }
  }
  std::set<FlashOp> kinds;
  for (const auto& op : counted) {
    kinds.insert(op.op);
  }
  CHECK(kinds.count(FlashOp::record_write) == 1);
}

TEST_CASE("the harness can cut every Nth operation only, and names the devices it cuts") {
  std::vector<CutRun> runs;
  host::CutScenario<ProbeWorld> scenario = probe_scenario(runs);
  scenario.stride = 3;
  scenario.points = {CutPoint::after};
  scenario.devices = {"probe"};
  const host::CutReport report = host::run_power_cuts(scenario);
  const std::uint64_t operations = report.operations.at("probe");
  CHECK(report.runs == 1 + (operations + 2) / 3);
  for (std::size_t i = 1; i < runs.size(); ++i) {
    CHECK(runs[i].nth % 3 == 1);
    CHECK(runs[i].point == CutPoint::after);
  }
}

/** A sensor, a siren and a gateway on the radio: an armed door, an alarm, a disarm. */
struct SystemWorld {
  SystemWorld() : site(gateway_mode()) {
    site.add_mode_gateway();
    host::SensorConfig settings;
    settings.countdown_seconds = 10;
    site.sensor("door", ScriptSensorConfig{}, sensor_log, settings);
    site.siren("siren", ScriptSirenConfig{}, siren_log);
    site.hub.arm();
    site.sim.device("door").set_input(device::Input::door, true, at(seconds(5)));
    site.sim.schedule(at(seconds(40)), [this]() { site.hub.disarm(); });
  }
  Site site;
  ScriptSensorLog sensor_log;
  ScriptSirenLog siren_log;
};

TEST_CASE(
    "whole devices: a cut at any operation of a sensor, siren or gateway leaves them working") {
  host::CutScenario<SystemWorld> scenario;
  scenario.make = []() { return std::make_unique<SystemWorld>(); };
  scenario.simulation = [](SystemWorld& world) -> host::Simulation& { return world.site.sim; };
  scenario.run = [](SystemWorld& world) { world.site.sim.run_until(at(seconds(80))); };
  std::size_t checked = 0;
  scenario.check = [&checked](SystemWorld& world, const CutRun& run) {
    INFO(run.describe());
    checked += 1;
    for (const char* name : {"door", "siren", "gateway"}) {
      CAPTURE(name);
      const host::SimDevice& device = world.site.sim.device(name);
      CHECK(alive(device));
      check_no_counter_reused(world.site.hub, name);
      CHECK(device.power_cuts() == (!run.uncut() && run.device == name ? 1u : 0u));
    }
    // Disarmed at 40 s: whatever happened, the siren is silent at the end.
    CHECK_FALSE(world.site.sim.device("siren").board().siren_io.output_on());
    if (run.uncut()) {
      CHECK(world.site.hub.decisions(host::HubAction::alarm, "door").size() == 1);
      CHECK(world.site.hub.decisions(host::HubAction::siren_confirmed, "siren").size() >= 2);
    }
  };
  const host::CutReport report = host::run_power_cuts(scenario);
  MESSAGE("flash operations: door " << report.operations.at("door") << ", siren "
                                    << report.operations.at("siren") << ", gateway "
                                    << report.operations.at("gateway") << "; runs " << report.runs);
  // The siren stores each new command's counter: at least the alarm and the off.
  CHECK(report.operations.at("siren") >= 2);
  CHECK(checked == report.runs);
  std::uint64_t total = 0;
  for (const auto& entry : report.operations) {
    total += entry.second;
  }
  CHECK(report.runs == 1 + 2 * total);
}

}  // namespace
}  // namespace hsn::test
