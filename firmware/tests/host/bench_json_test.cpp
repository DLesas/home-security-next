// The bench's manifest, in the schema the hub froze (hub/src/control-protocol/manifest.ts), and
// its timeline as JSON lines (hub-design.md section 11, items 3 and 5).

#include <doctest/doctest.h>

#include <nlohmann/json.hpp>

#include "hsn/host/bench_json.hpp"
#include "hsn/host/sim_time.hpp"
#include "hsn/host/simulation_error.hpp"
#include "hsn/protocol/messages.hpp"

namespace hsn::test {
namespace {

using json = nlohmann::json;

TEST_CASE("the manifest names each device, its role and its terminals, as the schema says") {
  const std::vector<host::ManifestDevice> devices = {
      {"sensor1", "sensor", {{"usb", "/dev/ttys004"}}},
      {"siren1", "siren", {{"usb", "/dev/ttys005"}, {"network", "/dev/ttys006"}}},
      {"gateway1", "gateway", {{"usb", "/dev/pts/7"}}},
  };
  const std::string text = host::manifest_json(devices);
  CHECK(text ==
        R"({"version":1,"devices":[)"
        R"({"name":"sensor1","role":"sensor","links":[{"kind":"usb","path":"/dev/ttys004"}]},)"
        R"({"name":"siren1","role":"siren","links":[{"kind":"usb","path":"/dev/ttys005"},)"
        R"({"kind":"network","path":"/dev/ttys006"}]},)"
        R"({"name":"gateway1","role":"gateway","links":[{"kind":"usb","path":"/dev/pts/7"}]}]})");
  // The schema's rules, checked field by field on the parsed document.
  const json manifest = json::parse(text);
  CHECK(manifest.at("version") == 1);
  for (const json& device : manifest.at("devices")) {
    const std::string name = device.at("name");
    CHECK(!name.empty());
    CHECK(name.size() <= 64);
    CHECK(name.find(' ') == std::string::npos);
    const std::string role = device.at("role");
    CHECK((role == "sensor" || role == "siren" || role == "gateway"));
    for (const json& link : device.at("links")) {
      const std::string kind = link.at("kind");
      CHECK((kind == "usb" || kind == "network"));
      CHECK(!link.at("path").get<std::string>().empty());
    }
  }
  CHECK(host::manifest_json({}) == R"({"version":1,"devices":[]})");
}

TEST_CASE("the manifest refuses what the schema refuses") {
  CHECK_THROWS_AS(host::manifest_json({{"two words", "sensor", {}}}), host::SimulationError);
  CHECK_THROWS_AS(host::manifest_json({{"", "sensor", {}}}), host::SimulationError);
  CHECK_THROWS_AS(host::manifest_json({{std::string(65, 'x'), "sensor", {}}}),
                  host::SimulationError);
  CHECK_THROWS_AS(host::manifest_json({{"door", "camera", {}}}), host::SimulationError);
  CHECK_THROWS_AS(host::manifest_json({{"door", "sensor", {{"bluetooth", "/dev/x"}}}}),
                  host::SimulationError);
  CHECK_THROWS_AS(host::manifest_json({{"door", "sensor", {{"usb", ""}}}}), host::SimulationError);
}

TEST_CASE("a timeline record is one line of JSON with its set fields and its text") {
  host::Timeline timeline;
  const host::ActorId door = timeline.add_actor("door");
  const host::ActorId hub = timeline.add_actor("hub");
  host::Record sent;
  sent.at = host::at(device::milliseconds(1500));
  sent.actor = door;
  sent.kind = host::RecordKind::transmission;
  sent.from = sent.at;
  sent.until = sent.at + device::milliseconds(62);
  sent.frequency_hz = 868300000;
  sent.data_rate = 5;
  sent.rssi_dbm = 14;
  sent.length = 25;
  sent.label.has_header = true;
  sent.label.address = 0x1A2B3C4D;
  sent.label.counter = 64;
  sent.label.type = protocol::message_type::door_changed;
  timeline.add(sent);
  const json line = json::parse(host::record_json(timeline, sent));
  CHECK(line.at("t") == 1.5);
  CHECK(line.at("actor") == "door");
  CHECK(line.at("kind") == "transmission");
  CHECK(line.at("from") == 1.5);
  CHECK(line.at("until") == 1.562);
  CHECK(line.at("frequency_hz") == 868300000);
  CHECK(line.at("data_rate") == 5);
  CHECK(line.at("length") == 25);
  CHECK(line.at("address") == 0x1A2B3C4D);
  CHECK(line.at("counter") == 64);
  CHECK(line.at("type") == "door_changed");
  CHECK(line.at("text").get<std::string>().find("transmission") != std::string::npos);
  CHECK(host::record_json(timeline, sent).find('\n') == std::string::npos);

  host::Record heard;
  heard.at = host::at(device::seconds(2));
  heard.actor = hub;
  heard.kind = host::RecordKind::deep_sleep;
  heard.until = device::Instant::never();
  heard.peer = door;
  const json other = json::parse(host::record_json(timeline, heard));
  CHECK(other.at("until").is_null());
  CHECK(other.at("peer") == "door");
  CHECK_FALSE(other.contains("frequency_hz"));

  host::Record boot;
  boot.actor = door;
  boot.kind = host::RecordKind::boot;
  boot.rssi_dbm = 1;
  const json booted = json::parse(host::record_json(timeline, boot));
  CHECK(booted.at("reset_cause") == 1);
  CHECK_FALSE(booted.contains("rssi_dbm"));
  CHECK(host::json_string("a \"b\"\n") == R"("a \"b\"\u000a")");
}

}  // namespace
}  // namespace hsn::test
