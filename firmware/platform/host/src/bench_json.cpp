#include "hsn/host/bench_json.hpp"

#include <cstdio>
#include <regex>
#include <sstream>

#include "hsn/host/packet_labels.hpp"
#include "hsn/host/simulation_error.hpp"

namespace hsn::host {

std::string json_string(const std::string& text) {
  std::string out = "\"";
  for (const char c : text) {
    const auto byte = static_cast<unsigned char>(c);
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (byte < 0x20) {
      char escaped[8];
      std::snprintf(escaped, sizeof(escaped), "\\u%04x", byte);
      out += escaped;
    } else {
      out += c;
    }
  }
  return out + "\"";
}

std::string json_seconds(device::Instant at) {
  char text[32];
  std::snprintf(text, sizeof(text), "%llu.%06llu", static_cast<unsigned long long>(at.us / 1000000),
                static_cast<unsigned long long>(at.us % 1000000));
  return text;
}

std::string manifest_json(const std::vector<ManifestDevice>& devices) {
  static const std::regex name_rule(R"(^\S{1,64}$)");
  std::ostringstream out;
  out << "{\"version\":" << kManifestVersion << ",\"devices\":[";
  for (std::size_t i = 0; i < devices.size(); ++i) {
    const ManifestDevice& device = devices[i];
    if (!std::regex_match(device.name, name_rule)) {
      throw SimulationError("a manifest name must be 1 to 64 characters, no spaces: " +
                            device.name);
    }
    if (device.role != "sensor" && device.role != "siren" && device.role != "gateway") {
      throw SimulationError("a manifest role must be sensor, siren or gateway: " + device.role);
    }
    out << (i == 0 ? "" : ",") << "{\"name\":" << json_string(device.name)
        << ",\"role\":" << json_string(device.role) << ",\"links\":[";
    for (std::size_t j = 0; j < device.links.size(); ++j) {
      const ManifestLink& link = device.links[j];
      if ((link.kind != "usb" && link.kind != "network") || link.path.empty()) {
        throw SimulationError("a manifest link needs kind usb or network and a path");
      }
      out << (j == 0 ? "" : ",") << "{\"kind\":" << json_string(link.kind)
          << ",\"path\":" << json_string(link.path) << "}";
    }
    out << "]}";
  }
  out << "]}";
  return out.str();
}

std::string record_json(const Timeline& timeline, const Record& record) {
  std::ostringstream out;
  out << "{\"t\":" << json_seconds(record.at)
      << ",\"actor\":" << json_string(timeline.actor_name(record.actor))
      << ",\"kind\":" << json_string(record_kind_name(record.kind));
  if (record.from != device::Instant{}) {
    out << ",\"from\":" << json_seconds(record.from);
  }
  if (record.until != device::Instant{}) {
    out << ",\"until\":" << (record.until.is_never() ? "null" : json_seconds(record.until));
  }
  if (record.frequency_hz != 0) {
    out << ",\"frequency_hz\":" << record.frequency_hz
        << ",\"data_rate\":" << static_cast<int>(record.data_rate);
  }
  if (record.kind == RecordKind::boot) {
    // A boot record keeps its reset cause in the rssi field.
    out << ",\"reset_cause\":" << record.rssi_dbm;
  } else if (record.rssi_dbm != 0) {
    out << ",\"rssi_dbm\":" << record.rssi_dbm;
  }
  if (record.snr_quarter_db != 0) {
    out << ",\"snr_quarter_db\":" << static_cast<int>(record.snr_quarter_db);
  }
  out << ",\"flag\":" << (record.flag ? "true" : "false") << ",\"value\":" << record.value;
  if (record.length != 0) {
    out << ",\"length\":" << record.length;
  }
  if (record.peer != kNoActor) {
    out << ",\"peer\":" << json_string(timeline.actor_name(record.peer));
  }
  if (record.label.has_header) {
    out << ",\"address\":" << record.label.address << ",\"counter\":" << record.label.counter;
    if (record.label.type != 0) {
      out << ",\"type\":" << json_string(message_type_name(record.label.type));
    }
  }
  // The same record as the bench prints it, for a reader.
  std::string text = timeline.describe(record);
  const std::size_t first = text.find_first_not_of(' ');
  out << ",\"text\":" << json_string(first == std::string::npos ? text : text.substr(first)) << "}";
  return out.str();
}

}  // namespace hsn::host
