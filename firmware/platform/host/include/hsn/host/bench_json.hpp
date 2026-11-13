#pragma once

#include <string>
#include <vector>

#include "hsn/host/timeline.hpp"

namespace hsn::host {

/** One link in the bench's manifest. */
struct ManifestLink {
  /** "usb" or "network". */
  std::string kind;
  /** The pseudo-terminal's path. */
  std::string path;
};

/** One device in the bench's manifest. */
struct ManifestDevice {
  /** 1 to 64 characters, no spaces (the hub's control protocol). */
  std::string name;
  /** "sensor", "siren" or "gateway". */
  std::string role;
  std::vector<ManifestLink> links;
};

/** The manifest's version, as the hub's schema fixes it (hub/src/control-protocol/manifest.ts). */
constexpr int kManifestVersion = 1;

/**
 * The bench's manifest as JSON (hub-design.md section 11, item 3), in the schema the hub froze:
 * {"version":1,"devices":[{"name","role","links":[{"kind","path"}]}]}. Throws SimulationError for
 * a name or role the schema refuses.
 */
std::string manifest_json(const std::vector<ManifestDevice>& devices);

/** A JSON string literal, escaped. */
std::string json_string(const std::string& text);

/** A true instant as JSON seconds with microseconds: 12.345678. */
std::string json_seconds(device::Instant at);

/**
 * One timeline record as one line of JSON (no newline): {"t", "actor", "kind", "text"} and the
 * record's fields that are set ("from", "until", "frequency_hz", "data_rate", "rssi_dbm",
 * "snr_quarter_db", "flag", "value", "length", "peer", "counter", "address", "type").
 */
std::string record_json(const Timeline& timeline, const Record& record);

}  // namespace hsn::host
