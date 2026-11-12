#include "hsn/host/simulation.hpp"

#include <utility>

#include "hsn/host/simulation_error.hpp"

namespace hsn::host {
namespace {

/** SplitMix64: spreads the simulation seed into one independent seed per board. */
std::uint64_t board_seed(std::uint64_t seed, std::size_t index) {
  std::uint64_t z = seed + 0x9E3779B97F4A7C15ULL * (static_cast<std::uint64_t>(index) + 1);
  z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
  z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
  return z ^ (z >> 31);
}

}  // namespace

Simulation::Simulation(SimulationOptions options)
    : options_(options), medium_(scheduler_, timeline_, labels_, options.medium) {}

Simulation::~Simulation() = default;

SimDevice& Simulation::add_device(DeviceSpec spec) {
  for (const auto& existing : devices_) {
    if (existing->name() == spec.name) {
      throw SimulationError("a device named " + spec.name + " exists already");
    }
  }
  const SimContext context{
      scheduler_, timeline_, labels_, medium_, options_.call_budget, options_.keep_fake_records};
  devices_.push_back(std::make_unique<SimDevice>(context, std::move(spec),
                                                 board_seed(options_.seed, devices_.size())));
  return *devices_.back();
}

SimDevice& Simulation::device(const std::string& name) {
  for (const auto& existing : devices_) {
    if (existing->name() == name) {
      return *existing;
    }
  }
  throw SimulationError("no device named " + name);
}

void Simulation::run_until(device::Instant limit) {
  scheduler_.run_until(limit);
}

void Simulation::run_for(device::Duration span) {
  scheduler_.run_until(scheduler_.now() + span);
}

void Simulation::schedule(device::Instant when, std::function<void()> action) {
  scheduler_.schedule(when, std::move(action));
}

ActorId Simulation::add_actor(const std::string& name) {
  return timeline_.add_actor(name);
}

}  // namespace hsn::host
