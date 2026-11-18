#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "hsn/host/power_cut.hpp"
#include "hsn/host/sim_device.hpp"
#include "hsn/host/simulation.hpp"
#include "hsn/host/simulation_error.hpp"

namespace hsn::host {

/** One run of a scenario under the power-cut harness. */
struct CutRun {
  /** The device whose power was cut; empty for the run without a cut. */
  std::string device;
  /** The flash operation the cut fell on, counted from 1 on that device; 0 for no cut. */
  std::uint64_t nth = 0;
  CutPoint point = CutPoint::during;
  /** What that operation was. */
  FlashOp op = FlashOp::record_write;

  /** True for the run without a cut. */
  bool uncut() const {
    return nth == 0;
  }

  /** "door: during operation 7 (slot_write) of 31", for a test's INFO. */
  std::string describe(std::uint64_t of = 0) const {
    if (uncut()) {
      return "no cut";
    }
    return device + ": " + (point == CutPoint::during ? "during" : "after") + " operation " +
           std::to_string(nth) + " (" + flash_op_name(op) + ")" +
           (of > 0 ? " of " + std::to_string(of) : std::string());
  }
};

/** What the harness did. */
struct CutReport {
  /** Flash operations each device made in the run without a cut. */
  std::map<std::string, std::uint64_t> operations;
  /** Runs made, the one without a cut included. */
  std::size_t runs = 0;
};

/**
 * A scenario for run_power_cuts: how to build a fresh world, run it, and check it. `World` is the
 * test's own: a Simulation and whatever else the scenario needs (a TestHub, logs, a phone), built
 * and scripted by `make` (devices added and paired, inputs and hub actions scheduled) and run to
 * its end by `run`. Nothing may be shared between worlds: each run starts from nothing.
 */
template <typename World>
struct CutScenario {
  /** Builds and scripts a fresh world. Flash written here (pairing) is not counted. */
  std::function<std::unique_ptr<World>()> make;
  /** The world's simulation. */
  std::function<Simulation&(World&)> simulation;
  /** Runs the world to its end. */
  std::function<void(World&)> run;
  /**
   * The scenario's own assertions, after every run: the run without a cut (CutRun::uncut()) and
   * each run with one. Use doctest's CHECK with INFO(run.describe()).
   */
  std::function<void(World&, const CutRun&)> check;
  /** The devices whose power is cut, by name; every device in the simulation when empty. */
  std::vector<std::string> devices;
  /** Where on each operation to cut: during it and after it, by default. */
  std::vector<CutPoint> points{CutPoint::during, CutPoint::after};
  /** Cut at every `stride`th operation only (1: every one), for very long scenarios. */
  std::uint64_t stride = 1;
};

/**
 * The power-cut harness (m3-updates-design.md section 8, "a power cut at every flash operation").
 * It runs the scenario once without a cut, counting each device's flash operations from the end of
 * `make` (record writes and erases, slot erases and writes, and every otadata write, the fake
 * bootloader's included). Then, for each device and each point, and for every N from 1 to that
 * count, it builds a fresh world, arms the device's PowerCut at its Nth operation, runs it and
 * checks it. The cut turns the board off at that operation (during it: the operation's mess; after
 * it: the operation whole), for DeviceSpec::off_after_cut, then powers it on, and the scenario
 * carries on: the checks say what must hold anyway. Runs are deterministic, so the Nth operation
 * of a cut run is the Nth of the run without one; a run whose cut never fell throws
 * SimulationError, naming it.
 */
template <typename World>
CutReport run_power_cuts(const CutScenario<World>& scenario) {
  CutReport report;
  std::vector<std::string> devices = scenario.devices;
  {
    std::unique_ptr<World> world = scenario.make();
    Simulation& sim = scenario.simulation(*world);
    if (devices.empty()) {
      for (const auto& device : sim.devices()) {
        devices.push_back(device->name());
      }
    }
    for (const std::string& name : devices) {
      sim.device(name).board().power_cut.arm(0, CutPoint::during);
    }
    scenario.run(*world);
    for (const std::string& name : devices) {
      report.operations[name] = sim.device(name).board().power_cut.count();
    }
    report.runs += 1;
    scenario.check(*world, CutRun{});
  }
  const std::uint64_t stride = scenario.stride == 0 ? 1 : scenario.stride;
  for (const std::string& name : devices) {
    const std::uint64_t total = report.operations[name];
    for (const CutPoint point : scenario.points) {
      for (std::uint64_t nth = 1; nth <= total; nth += stride) {
        std::unique_ptr<World> world = scenario.make();
        Simulation& sim = scenario.simulation(*world);
        PowerCut& power = sim.device(name).board().power_cut;
        power.arm(nth, point);
        scenario.run(*world);
        CutRun run;
        run.device = name;
        run.nth = nth;
        run.point = point;
        if (!power.has_cut()) {
          throw SimulationError("the power cut " + run.describe(total) +
                                " never fell: the run is not the run without a cut");
        }
        run.op = power.cut_at().op;
        report.runs += 1;
        scenario.check(*world, run);
      }
    }
  }
  return report;
}

}  // namespace hsn::host
