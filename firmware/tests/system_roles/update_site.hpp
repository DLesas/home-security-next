#pragma once

// Firmware updates and the key change through the real hub in lockstep (m3-updates-design.md
// section 8, "Through the real hub in lockstep"): the questions the update tests ask of the hub's
// records and of the boards. Only with HSN_LOCKSTEP: the rollout, its holds and the restore are
// the real hub's (the test hub has a simple model of each, tested in tests/host/).

#ifdef HSN_LOCKSTEP

#include <algorithm>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "hsn/host/script_phone.hpp"
#include "hsn/host/test_image.hpp"
#include "system_site.hpp"

namespace hsn::test::system {

/** The image every update test rolls out: an own build, as `hsn firmware add --own` adds it. */
const protocol::FirmwareVersion kNewVersion{1, 4, 0};
/** The version boards are made with (`hal().build.version`'s default, the development build). */
const protocol::FirmwareVersion kOldVersion{0, 1, 0};
/** A test image of 64 KB, the size the design's lockstep tests use (section 8). */
constexpr std::size_t kImageBytes = 64 * 1024;
/** A version as the hub's decisions carry it: major × 65,536 + minor × 256 + patch. */
inline std::int64_t version_value(const protocol::FirmwareVersion& version) {
  return version.major * 65536 + version.minor * 256 + version.patch;
}
/** The pilots' soak (D139: an hour ‡). */
constexpr Duration kSoak = seconds(3600);
/** A rollout's states, as `rollout.status` names them. */
constexpr const char* kConfirmed = "confirmed";

/** `rollout_paused`'s reason for a rollback (the hub's `paused_reason`, core/model/rows.ts). */
constexpr std::uint8_t kPausedRolledBack = host::kRolledBackReason;

inline bool same_version(const protocol::FirmwareVersion& a, const protocol::FirmwareVersion& b) {
  return a.major == b.major && a.minor == b.minor && a.patch == b.patch;
}

/** True when the board boots the new image, confirmed (off trial). */
inline bool runs_new_confirmed(host::SimDevice& device) {
  return same_version(device.boot_choice().image.version, kNewVersion) &&
         !device.board().slots.running().on_trial;
}

/** The first instant of a decision of `action` for `device`, or never. */
inline Instant first(const host::RemoteHub& hub, HubAction action, const std::string& device) {
  const auto found = hub.decisions(action, device);
  return found.empty() ? Instant::never() : found.front().at;
}

/** The last instant of a decision of `action` for `device`, or never. */
inline Instant last(const host::RemoteHub& hub, HubAction action, const std::string& device) {
  const auto found = hub.decisions(action, device);
  return found.empty() ? Instant::never() : found.back().at;
}

/** A device's span in one stage: [from, to), `to` never when it has not ended. */
struct Span {
  std::string device;
  Instant from = Instant::never();
  Instant to = Instant::never();
};

/**
 * Each device's install, from its go-ahead (`firmware_installing`) to its end on the new image
 * (`firmware_confirmed`) or its rollback (`firmware_rolled_back`), one span per go-ahead.
 */
inline std::vector<Span> install_spans(const host::RemoteHub& hub,
                                       const std::vector<std::string>& devices) {
  std::vector<Span> spans;
  for (const std::string& name : devices) {
    std::optional<Span> open;
    for (const host::HubDecision& d : hub.decisions()) {
      if (d.device != name) {
        continue;
      }
      if (d.action == HubAction::firmware_installing && !open.has_value()) {
        open = Span{name, d.at, Instant::never()};
      } else if ((d.action == HubAction::firmware_confirmed ||
                  d.action == HubAction::firmware_rolled_back) &&
                 open.has_value()) {
        open->to = d.at;
        spans.push_back(*open);
        open.reset();
      }
    }
    if (open.has_value()) {
      spans.push_back(*open);
    }
  }
  return spans;
}

/**
 * Each device's fetch: from the first offer that tells it to fetch (actions 1 to 3) to its
 * `verified` status (stage 2), one span per device; a device still fetching has `to` never.
 */
inline std::vector<Span> fetch_spans(const host::RemoteHub& hub,
                                     const std::vector<std::string>& devices) {
  std::vector<Span> spans;
  for (const std::string& name : devices) {
    std::optional<Span> open;
    for (const host::HubDecision& d : hub.decisions()) {
      if (d.device != name) {
        continue;
      }
      const bool fetch = d.action == HubAction::firmware_offer && d.value >= 1 && d.value <= 3;
      const bool verified = d.action == HubAction::firmware_status && (d.value >> 8) == 2;
      if (fetch && !open.has_value()) {
        open = Span{name, d.at, Instant::never()};
      } else if (verified && open.has_value()) {
        open->to = d.at;
        spans.push_back(*open);
        open.reset();
      }
    }
    if (open.has_value()) {
      spans.push_back(*open);
    }
  }
  return spans;
}

/** The most spans open at one instant (a span is open on [from, to)). */
inline std::size_t most_at_once(const std::vector<Span>& spans) {
  std::vector<std::pair<Instant, int>> edges;
  for (const Span& span : spans) {
    edges.emplace_back(span.from, 1);
    if (!span.to.is_never()) {
      edges.emplace_back(span.to, -1);
    }
  }
  // Ends before starts at one instant: a span that ends as another begins is not two at once.
  std::sort(edges.begin(), edges.end(), [](const auto& a, const auto& b) {
    return a.first < b.first || (a.first == b.first && a.second < b.second);
  });
  int open = 0;
  int most = 0;
  for (const auto& edge : edges) {
    open += edge.second;
    most = std::max(most, open);
  }
  return static_cast<std::size_t>(most);
}

/** The hub's critical hub events, a deadline guard's record among them (none in a good run). */
inline std::vector<std::string> critical_events(const host::RemoteHub& hub) {
  std::vector<std::string> out;
  for (const auto& record : hub.records()) {
    if (record.second.at("kind").as_string() != "hubEvent") {
      continue;
    }
    const json::Value& row = record.second.at("row");
    if (row.at("level").as_string() == "critical") {
      out.push_back(row.at("code").as_string() + ": " + row.at("message").as_string());
    }
  }
  return out;
}

/** Log entries a device sent the hub at warning level or above, as "code text value". */
inline std::vector<std::string> device_warnings(const host::RemoteHub& hub,
                                                const std::string& name) {
  std::vector<std::string> out;
  for (const host::HubLogEntry& entry : hub.log_entries_from(name)) {
    if (entry.level >= 2) {
      out.push_back(std::to_string(entry.code) + " " + entry.text);
    }
  }
  return out;
}

/** Data frames the hub served a device, and the Gone frames, by reason. */
struct Served {
  std::size_t data = 0;
  std::map<std::uint8_t, std::size_t> gone;
  /** The highest end of a Data served. */
  std::uint32_t to = 0;
};

inline Served served(const host::RemoteHub& hub, const std::string& name, Instant from = Instant{},
                     Instant until = Instant::never()) {
  Served out;
  for (const host::HubTransfer& t : hub.transfers()) {
    if (t.device != name || t.at < from || (!until.is_never() && t.at >= until)) {
      continue;
    }
    if (t.answer == protocol::transfer_kind::data) {
      out.data += 1;
      out.to = std::max(out.to, t.offset + t.length);
    } else if (t.answer == protocol::transfer_kind::gone) {
      out.gone[t.gone_reason] += 1;
    }
  }
  return out;
}

/**
 * The links a device had transfer frames on from `from` (frames that are not packets, larger than
 * a Get; after provisioning, whose setup messages are not packets either): a set of "usb",
 * "network", "bluetooth".
 */
inline std::set<std::string> data_links(const host::SimDevice& device, Instant from) {
  std::set<std::string> kinds;
  for (const Record& record :
       device.records().kind(RecordKind::link_received).between(from, Instant::never()).records()) {
    if (record.length > protocol::kTransferDataHeaderSize && !record.label.has_header) {
      kinds.insert(record.value == static_cast<std::uint32_t>(device::LinkKind::usb) ? "usb"
                   : record.value == static_cast<std::uint32_t>(device::LinkKind::network)
                       ? "network"
                       : "bluetooth");
    }
  }
  return kinds;
}

/** The board holds part of an image: its update record (store key 0x05). */
inline bool holds_update_record(host::SimDevice& device) {
  return device.board().storage.has(device::StoreKey::update);
}

/** What the new image does once booted: works, or hangs (the task watchdog resets the chip). */
enum class NewImage : std::uint8_t { good, hangs };

/** The role a board of `role` runs, for every image (the roles do not change between images). */
inline host::RoleFactory role_factory(std::uint8_t role) {
  switch (role) {
    case protocol::Role::sensor:
      return host::make_role<roles::sensor::SensorRole>(&host::HostBoard::sensor_io);
    case protocol::Role::siren:
      return host::make_role<roles::siren::SirenRole>(&host::HostBoard::siren_io);
    default:
      return host::make_role<roles::gateway::GatewayRole>(&host::HostBoard::gateway_io);
  }
}

/**
 * A board of `role` added to the site as SystemSite's helpers add it (a sensor on a cell, a siren
 * and a gateway on mains), whose new image runs the same role and, for `NewImage::hangs`, hangs
 * at its first event, before it can confirm itself (a rollback by the watchdog, section 2).
 */
inline host::SimDevice& add_board(SystemSite& site, std::uint8_t role, const std::string& name,
                                  NewImage image, const host::SensorConfig& sensor = {},
                                  const host::GatewayConfig& gateway = {}) {
  host::DeviceSpec spec;
  spec.name = name;
  spec.role = role_factory(role);
  if (image == NewImage::hangs) {
    spec.images.push_back(host::ImageRole{kNewVersion, role_factory(role), Duration{}});
  }
  host::SimDevice& device = site.sim.add_device(spec);
  if (role == protocol::Role::sensor) {
    site.hub.add_sensor(device, sensor);
  } else if (role == protocol::Role::siren) {
    device.board().power.external = true;
    site.hub.add_siren(device, host::SirenConfig{});
  } else {
    device.board().power.external = true;
    site.hub.add_gateway(device, gateway);
    site.gateways.push_back(name);
  }
  return device;
}

/** Runs the site in steps of `step` until `done` holds or `limit` is reached; true when it held. */
template <typename Done>
bool run_until_true(SystemSite& site, Instant limit, Done done, Duration step = seconds(1)) {
  while (site.sim.now() < limit) {
    site.run_until(std::min(limit, site.sim.now() + step));
    if (done()) {
      return true;
    }
  }
  return false;
}

/** The hub's decisions of `action` from `from` on. */
inline std::vector<host::HubDecision> decisions_since(const host::RemoteHub& hub, HubAction action,
                                                      Instant from,
                                                      const std::string& device = "") {
  std::vector<host::HubDecision> out;
  for (const host::HubDecision& d : hub.decisions(action, device)) {
    if (d.at >= from) {
      out.push_back(d);
    }
  }
  return out;
}

/** Offers telling a device to fetch (actions 1 to 3) from `from` on, to any device. */
inline std::size_t fetch_offers_since(const host::RemoteHub& hub, Instant from) {
  std::size_t count = 0;
  for (const host::HubDecision& d : decisions_since(hub, HubAction::firmware_offer, from)) {
    count += d.value >= 1 && d.value <= 3 ? 1 : 0;
  }
  return count;
}

}  // namespace hsn::test::system

#endif
