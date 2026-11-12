#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "hsn/device/time.hpp"
#include "hsn/host/medium.hpp"
#include "hsn/host/packet_labels.hpp"
#include "hsn/host/scheduler.hpp"
#include "hsn/host/sim_device.hpp"
#include "hsn/host/sim_time.hpp"
#include "hsn/host/timeline.hpp"

namespace hsn::host {

/** Settings of a whole simulation. */
struct SimulationOptions {
  /** Seeds every board's random source; the same seed gives the same timeline. */
  std::uint64_t seed = 1;
  /** Hardware calls allowed per handle() (design section 6). */
  std::uint32_t call_budget = 32;
  /** Keep the fakes' own call records as well as the timeline; turn off for year-long runs. */
  bool keep_fake_records = true;
  /** The Medium's physics. */
  MediumOptions medium;
};

/**
 * The discrete-event simulation of design section 8: any number of devices, each with its own
 * board, drifting clock, boots and role, on one shared Medium, over one true time. Nothing runs
 * until run_until() or run_for() is called, and nothing reads a wall clock, so a run is a pure
 * function of the seed and the script. Scenarios read top to bottom:
 *
 *   Simulation sim;
 *   SimDevice& door = sim.add_device({"door", make_role<SensorRole>(&HostBoard::sensor_io)});
 *   door.set_input(device::Input::door, true, at(seconds(10)));
 *   sim.run_until(at(seconds(60)));
 *   CHECK(door.records().kind(RecordKind::transmission).count() == 1);
 *
 * A broken bench rule (the hardware-call budget, a zero-time loop) throws SimulationError out of
 * run_until, which fails the test case with its message.
 */
class Simulation {
public:
  /** An empty simulation at true time zero. */
  explicit Simulation(SimulationOptions options = {});
  Simulation(const Simulation&) = delete;
  Simulation& operator=(const Simulation&) = delete;
  ~Simulation();

  /** Adds a device; it powers on at spec.power_on. Names must be unique. */
  SimDevice& add_device(DeviceSpec spec);

  /** Returns a device by name; throws SimulationError if there is none. */
  SimDevice& device(const std::string& name);

  /** Every device, in the order added. */
  const std::vector<std::unique_ptr<SimDevice>>& devices() const {
    return devices_;
  }

  /** The true time. */
  device::Instant now() const {
    return scheduler_.now();
  }

  /** Runs everything due up to and including `limit`, then sets the time to it. */
  void run_until(device::Instant limit);

  /** Runs for `span` of true time. */
  void run_for(device::Duration span);

  /** Runs `action` at a true instant, for hub commands and checks in the middle of a run. */
  void schedule(device::Instant when, std::function<void()> action);

  /** Names a new actor on the timeline that is not a device (the test hub). */
  ActorId add_actor(const std::string& name);

  /** The queue of true time. */
  Scheduler& scheduler() {
    return scheduler_;
  }

  /** Everything that happened. */
  Timeline& timeline() {
    return timeline_;
  }

  /** Everything that happened. */
  const Timeline& timeline() const {
    return timeline_;
  }

  /** The labellers that name packets on the timeline. */
  PacketLabels& labels() {
    return labels_;
  }

  /** The shared radio channel: path losses, noise, capture margin. */
  Medium& medium() {
    return medium_;
  }

  /** The settings it was made with. */
  const SimulationOptions& options() const {
    return options_;
  }

private:
  SimulationOptions options_;
  Scheduler scheduler_;
  Timeline timeline_;
  PacketLabels labels_;
  Medium medium_;
  std::vector<std::unique_ptr<SimDevice>> devices_;
};

}  // namespace hsn::host
