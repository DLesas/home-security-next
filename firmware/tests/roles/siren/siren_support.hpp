#pragma once

// Helpers for the siren role's scenario tests: a simulation with a test hub and the real
// SirenRole (make_role<SirenRole>), and short ways to ask what the siren sent and what the hub
// made of it. Every file that includes this builds the role, so it is compiled without RTTI.

#include <doctest/doctest.h>

#include <cstdint>
#include <string>
#include <vector>

#include "hsn/device/hal/storage.hpp"
#include "hsn/host/role_box.hpp"
#include "hsn/host/sim_time.hpp"
#include "hsn/host/simulation.hpp"
#include "hsn/host/test_hub.hpp"
#include "hsn/host/timeline.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/roles/siren/siren_constants.hpp"
#include "hsn/roles/siren/siren_log_codes.hpp"
#include "hsn/roles/siren/siren_role.hpp"

namespace hsn::test::siren {

using device::milliseconds;
using device::seconds;
using host::at;
using host::HubAction;
using host::HubPath;
using host::RecordKind;
using roles::siren::SirenRole;
namespace type = protocol::message_type;
using action = protocol::SirenAction;
using reason = protocol::SirenReportReason;
namespace siren_log = roles::siren::siren_log;

/** The real siren role on the board's siren I/O. */
inline host::RoleFactory siren_role() {
  return host::make_role<SirenRole>(&host::HostBoard::siren_io);
}

/** A report the hub accepted, with how it came. */
struct HubReport {
  device::Instant at;
  HubPath path = HubPath::link;
  std::uint32_t counter = 0;
  protocol::SirenReport report;
};

/**
 * A simulation, a test hub and one siren paired with it, named "siren". Members are public: a
 * test reaches into the simulation, the hub and the board directly.
 */
struct SirenSite {
  explicit SirenSite(host::HubOptions options = {}, host::SirenConfig config = {},
                     host::SimulationOptions simulation = {})
      : sim(simulation), hub(sim, options), siren(add(config)) {}

  /** Adds the siren and pairs it before its first boot. */
  host::SimDevice& add(const host::SirenConfig& config) {
    host::DeviceSpec spec;
    spec.name = "siren";
    spec.role = siren_role();
    host::SimDevice& device = sim.add_device(spec);
    hub.add_siren(device, config);
    return device;
  }

  /** Runs to a true instant. */
  void run_until(device::Duration since_start) {
    sim.run_until(at(since_start));
  }

  /** Schedules a hub command at a true instant. */
  void command_at(device::Duration when, std::uint8_t act, std::uint16_t secs) {
    sim.schedule(at(when), [this, act, secs]() { hub.command_siren("siren", act, secs); });
  }

  /** Every siren report the hub accepted, in order. */
  std::vector<HubReport> reports() const {
    std::vector<HubReport> found;
    for (const host::HubPacket& packet : hub.received_from("siren", type::siren_report)) {
      found.push_back(
          HubReport{packet.at, packet.path, packet.counter, packet.as<protocol::SirenReport>()});
    }
    return found;
  }

  /** Accepted reports with one reason, on one path. */
  std::vector<HubReport> reports(std::uint8_t why, HubPath path) const {
    std::vector<HubReport> found;
    for (const HubReport& report : reports()) {
      if (report.report.reason == why && report.path == path) {
        found.push_back(report);
      }
    }
    return found;
  }

  /** Accepted reports with one reason, on any path. */
  std::vector<HubReport> reports(std::uint8_t why) const {
    std::vector<HubReport> found;
    for (const HubReport& report : reports()) {
      if (report.report.reason == why) {
        found.push_back(report);
      }
    }
    return found;
  }

  /** Flash writes of one record, failed ones included. */
  std::size_t flash_writes(device::StoreKey key) const {
    return siren.records()
        .kind(RecordKind::flash_write)
        .where([key](const host::Record& r) { return r.value == static_cast<std::uint32_t>(key); })
        .count();
  }

  /** The siren's LoRa transmissions of one message type. */
  host::Selection on_air(std::uint8_t message_type) const {
    return siren.records().kind(RecordKind::transmission).type(message_type);
  }

  /** The siren's Wi-Fi packets of one message type. */
  host::Selection on_wifi(std::uint8_t message_type) const {
    return siren.records().kind(RecordKind::link_sent).type(message_type);
  }

  /** Log entries from the siren with one code. */
  std::vector<host::HubLogEntry> logged(std::uint16_t code) const {
    std::vector<host::HubLogEntry> found;
    for (const host::HubLogEntry& entry : hub.log_entries_from("siren")) {
      if (entry.code == code) {
        found.push_back(entry);
      }
    }
    return found;
  }

  /**
   * When one of the role's timers is due now, as a true instant (the bench's boards run without
   * drift, so their clocks read true time).
   */
  device::Instant due(roles::siren::SirenTimer timer) {
    return role().state().timers.at(timer);
  }

  /** The running role. */
  SirenRole& role() {
    return siren.role<SirenRole>();
  }

  /** The sounder output now. */
  bool sounding() {
    return siren.board().siren_io.output_state;
  }

  /** The true instants the sounder changed, with the level it changed to. */
  std::vector<std::pair<device::Instant, bool>> outputs() const {
    std::vector<std::pair<device::Instant, bool>> found;
    for (const host::Record& record : siren.records().kind(RecordKind::output).records()) {
      found.emplace_back(record.at, record.flag);
    }
    return found;
  }

  /** Everything, for a failed check. */
  std::string dump() const {
    return siren.records().dump() + hub.dump();
  }

  host::Simulation sim;
  host::TestHub hub;
  host::SimDevice& siren;
};

/**
 * The first instant at or after `from` in the rhythm that starts at `first` and repeats every
 * `interval`: when a periodic report or check falls, given the random phase it started with.
 */
inline device::Instant next_in_rhythm(device::Instant first, device::Duration interval,
                                      device::Instant from) {
  if (from <= first) {
    return first;
  }
  const std::int64_t periods = ((from - first).us + interval.us - 1) / interval.us;
  return first + device::Duration{periods * interval.us};
}

/** Siren settings with a different version's worth of change. */
inline host::SirenConfig settings_with(std::uint16_t max_sound_seconds) {
  host::SirenConfig config;
  config.max_sound_seconds = max_sound_seconds;
  return config;
}

}  // namespace hsn::test::siren
