#pragma once

// Helpers for the simulation, test hub and system tests: role factories for the test-only roles
// and scripted devices, and the usual names. Every file that builds one of these roles is
// compiled without RTTI, like the core that emits Role's vtable.

#include <doctest/doctest.h>

#include <cstdint>
#include <string>
#include <vector>

#include "host/probe_role.hpp"
#include "host/script_gateway.hpp"
#include "host/script_sensor.hpp"
#include "host/script_siren.hpp"
#include "hsn/host/provisioning.hpp"
#include "hsn/host/role_box.hpp"
#include "hsn/host/simulation.hpp"
#include "hsn/host/test_hub.hpp"
#include "hsn/host/timeline.hpp"

namespace hsn::test {

using device::milliseconds;
using device::seconds;
using host::at;
using host::RecordKind;

/** A ProbeRole on the board's sensor I/O. */
inline host::RoleFactory probe(const ProbeConfig& config, ProbeLog& log) {
  return [config, &log](device::Services& services, host::HostBoard& board) {
    return host::box_role<ProbeRole>(services, board.sensor_io, config, log);
  };
}

/** A ScriptSensor on the board's sensor I/O. */
inline host::RoleFactory script_sensor(const ScriptSensorConfig& config, ScriptSensorLog& log) {
  return [config, &log](device::Services& services, host::HostBoard& board) {
    return host::box_role<ScriptSensor>(services, board.sensor_io, config, log);
  };
}

/** A ScriptSiren on the board's siren I/O. */
inline host::RoleFactory script_siren(const ScriptSirenConfig& config, ScriptSirenLog& log) {
  return [config, &log](device::Services& services, host::HostBoard& board) {
    return host::box_role<ScriptSiren>(services, board.siren_io, config, log);
  };
}

/** A ScriptGateway on the board's gateway I/O. */
inline host::RoleFactory script_gateway(const ScriptGatewayConfig& config, ScriptGatewayLog& log) {
  return [config, &log](device::Services& services, host::HostBoard& board) {
    return host::box_role<ScriptGateway>(services, board.gateway_io, config, log);
  };
}

/** A sensor pairing for boards without a hub. */
inline host::Provisioning sensor_pairing(std::uint32_t address = 0x1A2B3C4D) {
  host::Provisioning provisioning;
  provisioning.role = protocol::Role::sensor;
  provisioning.address = address;
  provisioning.key = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15};
  return provisioning;
}

/**
 * A simulation with a test hub, and one-line ways to add scripted devices paired with it.
 * Members are public: a test reaches into the simulation, the hub and the devices directly.
 */
struct Site {
  explicit Site(host::HubOptions options = {}, host::SimulationOptions simulation = {})
      : mode(options.mode), sim(simulation), hub(sim, options) {}

  host::SimDevice& sensor(const std::string& name, const ScriptSensorConfig& config,
                          ScriptSensorLog& log, const host::SensorConfig& settings = {}) {
    host::DeviceSpec spec;
    spec.name = name;
    spec.role = script_sensor(config, log);
    host::SimDevice& device = sim.add_device(spec);
    hub.add_sensor(device, settings);
    return device;
  }

  host::SimDevice& siren(const std::string& name, const ScriptSirenConfig& config,
                         ScriptSirenLog& log, const host::SirenConfig& settings = {}) {
    host::DeviceSpec spec;
    spec.name = name;
    spec.role = script_siren(config, log);
    host::SimDevice& device = sim.add_device(spec);
    hub.add_siren(device, settings);
    return device;
  }

  host::SimDevice& gateway(const std::string& name, const ScriptGatewayConfig& config,
                           ScriptGatewayLog& log, const host::GatewayConfig& settings = {},
                           std::int32_t drift_ppm = 0) {
    host::DeviceSpec spec;
    spec.name = name;
    spec.role = script_gateway(config, log);
    spec.drift_ppm = drift_ppm;
    host::SimDevice& device = sim.add_device(spec);
    hub.add_gateway(device, settings);
    return device;
  }

  /**
   * In gateway link mode, adds the scripted gateway "gateway" on the network link, so a test
   * written for the hub runs unchanged in both modes. Call before adding other devices.
   */
  void add_mode_gateway(std::uint8_t listen_data_rate = 5) {
    if (hub_mode() == host::HubMode::gateway_link) {
      ScriptGatewayConfig config;
      config.listen_data_rate = listen_data_rate;
      gateway("gateway", config, gateway_log);
    }
  }

  /** The station that hears devices for the hub: its own radio, or the gateway's. */
  host::StationId hub_ear() {
    return hub_mode() == host::HubMode::direct_radio ? hub.station()
                                                     : sim.device("gateway").station();
  }

  host::HubMode hub_mode() const {
    return mode;
  }

  host::HubMode mode = host::HubMode::direct_radio;
  host::Simulation sim;
  host::TestHub hub;
  ScriptGatewayLog gateway_log;
};

/** A gateway link mode hub. */
inline host::HubOptions gateway_mode() {
  host::HubOptions options;
  options.mode = host::HubMode::gateway_link;
  return options;
}

/** Hub options in one mode. */
inline host::HubOptions hub_options(host::HubMode mode) {
  host::HubOptions options;
  options.mode = mode;
  return options;
}

/** Both hub modes, for tests of behaviour that must not depend on the path. */
constexpr host::HubMode kBothModes[] = {host::HubMode::direct_radio, host::HubMode::gateway_link};

/** A mode's name, for INFO. */
inline std::string mode_name(host::HubMode mode) {
  return mode == host::HubMode::direct_radio ? "direct radio" : "gateway link";
}

}  // namespace hsn::test
