// The real-time bench's script (hub-design.md section 11, item 5): each command's effect, its
// refusals, and quit.

#include <doctest/doctest.h>

#include <memory>

#include "hsn/host/bench_script.hpp"
#include "hsn/host/provisioning.hpp"
#include "hsn/host/sim_time.hpp"

namespace hsn::test {
namespace {

using device::Input;
using device::LinkKind;
using device::milliseconds;
using device::seconds;
using host::at;
using host::RecordKind;

struct Bench {
  Bench() {
    for (const char* name : {"door", "siren"}) {
      host::DeviceSpec spec;
      spec.name = name;
      host::SimDevice& device = sim.add_device(spec);
      host::make_board(device.board(), protocol::Role::sensor);
      device.board().power.external = true;
    }
    usb = std::make_unique<host::PtyLink>(sim.device("door"), LinkKind::usb);
    sim.run_until(at(seconds(1)));
  }

  host::ScriptResult run(const std::string& line) {
    const host::ScriptResult result = script.run(line);
    sim.run_until(sim.now());
    return result;
  }

  host::Simulation sim;
  std::unique_ptr<host::PtyLink> usb;
  host::BenchScript script{sim, [this](const std::string& name, LinkKind kind) {
                             return name == "door" && kind == LinkKind::usb ? usb.get() : nullptr;
                           }};
};

std::vector<host::Record> inputs(Bench& bench, const char* name) {
  return bench.sim.device(name).records().kind(RecordKind::input).records();
}

TEST_CASE("door, cover, button and USB power change the input at the current instant") {
  Bench bench;
  CHECK(bench.run("door door open").ok);
  CHECK(bench.run("cover door open").ok);
  CHECK(bench.run("button door press").ok);
  CHECK(bench.run("usb-power door off").ok);
  CHECK(bench.run("door door close").ok);
  const auto changed = inputs(bench, "door");
  REQUIRE(changed.size() == 5);
  CHECK(changed[0].value == static_cast<std::uint32_t>(Input::door));
  CHECK(changed[0].flag);
  CHECK(changed[1].value == static_cast<std::uint32_t>(Input::cover));
  CHECK(changed[2].value == static_cast<std::uint32_t>(Input::button));
  CHECK(changed[3].value == static_cast<std::uint32_t>(Input::external_power));
  CHECK_FALSE(changed[3].flag);
  CHECK_FALSE(changed[4].flag);
  for (const host::Record& record : changed) {
    CHECK(record.at == at(seconds(1)));
  }
  CHECK_FALSE(bench.sim.device("door").board().power.external);
}

TEST_CASE("hold presses the button now and releases it later") {
  Bench bench;
  CHECK(bench.run("hold door 5.5").ok);
  bench.sim.run_until(at(seconds(10)));
  const auto changed = inputs(bench, "door");
  REQUIRE(changed.size() == 2);
  CHECK(changed[0].flag);
  CHECK(changed[1].at == at(seconds(6) + milliseconds(500)));
  CHECK_FALSE(changed[1].flag);
}

TEST_CASE("power loss, restart, noise, path loss, cut and restore") {
  Bench bench;
  host::SimDevice& door = bench.sim.device("door");
  CHECK(bench.run("power-loss door 2").ok);
  bench.sim.run_until(at(seconds(4)));
  CHECK(door.records().kind(RecordKind::power_loss).count() == 1);
  CHECK(door.boots() == 2);
  CHECK(bench.run("restart door").ok);
  bench.sim.run_until(at(seconds(5)));
  CHECK(door.records().kind(RecordKind::restart).count() == 1);
  CHECK(door.boots() == 3);
  CHECK(bench.run("noise 1 -90 10").ok);
  CHECK(bench.sim.medium().noise_dbm(868300000, at(seconds(6))) == doctest::Approx(-90));
  CHECK(bench.sim.medium().noise_dbm(868300000, at(seconds(16))) < -100);
  CHECK(bench.run("path-loss door siren 140").ok);
  CHECK(bench.sim.medium().received_dbm(door.station(), bench.sim.device("siren").station(), 14) ==
        doctest::Approx(-126));
  CHECK(bench.run("cut door usb").ok);
  CHECK(bench.usb->is_cut());
  CHECK(bench.run("restore door usb").ok);
  CHECK_FALSE(bench.usb->is_cut());
}

TEST_CASE("comments and blank lines do nothing; bad lines are refused and change nothing") {
  Bench bench;
  CHECK(bench.run("").ok);
  CHECK(bench.run("# a comment").ok);
  for (const char* bad :
       {"door", "door nobody open", "door door ajar", "hold door -1", "power-loss door 0",
        "cut door network", "cut door wifi", "noise 7 -90 10", "noise -1 -90 10",
        "noise 1.5 -90 10", "noise 300 -90 10", "noise 1 loud 10", "path-loss door nobody 100",
        "jump door", "restart door now"}) {
    INFO(bad);
    const host::ScriptResult result = bench.run(bad);
    CHECK_FALSE(result.ok);
    CHECK_FALSE(result.error.empty());
  }
  CHECK(inputs(bench, "door").empty());
  CHECK(bench.sim.device("door").boots() == 1);
}

TEST_CASE("quit says so") {
  Bench bench;
  const host::ScriptResult result = bench.run("quit");
  CHECK(result.ok);
  CHECK(result.quit);
}

}  // namespace
}  // namespace hsn::test
