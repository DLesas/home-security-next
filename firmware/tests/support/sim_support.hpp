#pragma once

// Helpers for the simulation, test hub and system tests: role factories for the test-only roles
// and scripted devices, and the usual names. Every file that builds one of these roles is
// compiled without RTTI, like the core that emits Role's vtable.

#include <doctest/doctest.h>

#include <cstdint>
#include <string>
#include <vector>

#include "hsn/host/provisioning.hpp"
#include "hsn/host/role_box.hpp"
#include "hsn/host/simulation.hpp"
#include "hsn/host/test_hub.hpp"
#include "hsn/host/timeline.hpp"
#include "probe_role.hpp"
#include "script_gateway.hpp"
#include "script_sensor.hpp"
#include "script_siren.hpp"
#ifdef HSN_LOCKSTEP
#include "hsn/host/remote_hub.hpp"
#include "lockstep_support.hpp"
#endif

namespace hsn::test {

/**
 * The hub the scenarios run against: the test hub, or, built with HSN_LOCKSTEP (the lockstep
 * group, hub-design.md section 11), the real hub in lockstep. The scenarios are the same text.
 */
#ifdef HSN_LOCKSTEP
using SiteHub = host::RemoteHub;
#else
using SiteHub = host::TestHub;
#endif

/**
 * Restarts every board makes before the scenario starts: on the real hub, the one that follows
 * accepting its Provision over USB (section 11, "Expected differences": one more boot each).
 */
#ifdef HSN_LOCKSTEP
constexpr std::size_t kProvisioningResets = 1;
#else
constexpr std::size_t kProvisioningResets = 0;
#endif

/**
 * The flash writes a board made while the hub provisioned it over USB (section 11, "Expected
 * differences"): those up to the restart that follows its Provision. None on the test hub.
 */
inline std::size_t provisioning_flash_writes(const host::SimDevice& device) {
  if (kProvisioningResets == 0) {
    return 0;
  }
  const auto restarts = device.records().kind(host::RecordKind::restart).records();
  if (restarts.empty()) {
    return 0;
  }
  return device.records()
      .kind(host::RecordKind::flash_write)
      .between(device::Instant{}, restarts.front().at + device::microseconds(1))
      .count();
}

/**
 * The first siren command (not settings) a scripted siren got, or null: its Started after every
 * start-up brings it settings first (protocol section 6).
 */
inline const ScriptSirenLog::Command* first_siren_command(const ScriptSirenLog& log) {
  for (const ScriptSirenLog::Command& command : log.commands) {
    if (command.type == protocol::message_type::siren_command) {
      return &command;
    }
  }
  return nullptr;
}

/** True for a packet, false for a setup message (§10), which the real hub's boards also send. */
inline bool is_packet(const host::Record& record) {
  return record.label.has_header;
}

/**
 * Marks a case the real hub is known to fail, with why: on the real hub it must fail (doctest's
 * should_fail), so a fix shows; on the test hub it is an ordinary case.
 */
#ifdef HSN_LOCKSTEP
#define HSN_FAILS_ON_REAL_HUB(why) *doctest::should_fail() * doctest::description(why)
#else
#define HSN_FAILS_ON_REAL_HUB(why)
#endif

/**
 * Marks a case that does not apply to the real hub, with why (a setting the protocol does not give
 * a site yet): skipped there, an ordinary case on the test hub.
 */
#ifdef HSN_LOCKSTEP
#define HSN_NOT_ON_REAL_HUB(why) *doctest::skip() * doctest::description(why)
#else
#define HSN_NOT_ON_REAL_HUB(why)
#endif

/** Marks a case blocked on the real hub by a fault there: skipped there, with the evidence. */
#ifdef HSN_LOCKSTEP
#define HSN_BLOCKED_ON_REAL_HUB(why) *doctest::skip() * doctest::description("BLOCKED: " why)
#else
#define HSN_BLOCKED_ON_REAL_HUB(why)
#endif

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
#ifdef HSN_LOCKSTEP
      : mode(options.mode),
        sim(simulation),
        hub(sim, options, hub_program()){}
#else
      : mode(options.mode), sim(simulation), hub(sim, options) {
  }
#endif

            host::SimDevice
            & sensor(const std::string& name, const ScriptSensorConfig& config,
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
      // The hub's settings name the same one rate, which the gateway then keeps listening at.
      host::GatewayConfig settings;
      settings.listen_data_rate_mask = static_cast<std::uint8_t>(1u << listen_data_rate);
      gateway("gateway", config, gateway_log, settings);
    }
  }

  /** The station that hears devices for the hub: its own radio, or the gateway's. */
  host::StationId hub_ear() {
#ifdef HSN_LOCKSTEP
    return sim.device("gateway").station();
#else
    return hub_mode() == host::HubMode::direct_radio ? hub.station()
                                                     : sim.device("gateway").station();
#endif
  }

  host::HubMode hub_mode() const {
    return mode;
  }

  host::HubMode mode = host::HubMode::direct_radio;
  host::Simulation sim;
  SiteHub hub;
  ScriptGatewayLog gateway_log;
};

/** A gateway link mode hub. */
inline host::HubOptions gateway_mode() {
  host::HubOptions options;
  options.mode = host::HubMode::gateway_link;
  return options;
}

/**
 * A gateway link mode hub on a site of one sending rate, DR5, as the protocol gives every site
 * until O14 is settled (§2); the test hub's default site also allows DR2, for the sensor's
 * fall-back tests. The real hub can only run sites like this.
 */
inline host::HubOptions one_rate_gateway_mode() {
  host::HubOptions options = gateway_mode();
  options.allowed_data_rate_mask = 1u << protocol::DataRate::dr5;
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
