// The key change after a restore on the real roles (m3-updates-design.md section 7): a real sensor
// (its door report draws the Key change and is said again under the new key), a real siren (changed
// at the restored hub's start, on both paths) and a real gateway (a Key change in place of the
// welcome, then a hello under the new key), against the test hub's restore. Each runs once, then
// under the power-cut harness at every flash operation of the whole scenario: after every cut the
// device is heard under its new key, no counter carries two packets under one key, nothing goes
// under the old key once the new one is in flash, and the device still does its job.
//
// A sensor's heartbeat does not draw the Key change here: the test hub answers an old-key packet as
// soon as possible, when a sensor that sent a heartbeat listens only at the reply moment (protocol
// section 7). tests/roles/sensor/rekey_test.cpp covers that case with a Key change at the reply
// moment; the small roles of rekey_device_test.cpp test the service on its own.

#include <doctest/doctest.h>

#include <map>
#include <memory>
#include <optional>
#include <string>

#include "hsn/host/power_cut_harness.hpp"
#include "hsn/host/role_box.hpp"
#include "hsn/host/test_hub.hpp"
#include "hsn/roles/gateway/gateway_role.hpp"
#include "hsn/roles/sensor/sensor_role.hpp"
#include "hsn/roles/siren/siren_role.hpp"
#include "sim_support.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using host::HubAction;
using host::HubVerdict;
using host::RecordKind;
namespace type = protocol::message_type;

/** The true instant the new key reached flash: the first whole pairing write after `after`. */
std::optional<device::Instant> key_written_at(host::SimDevice& device, device::Instant after) {
  for (const host::Record& record : device.records().kind(RecordKind::flash_write).records()) {
    if (record.value == static_cast<std::uint32_t>(device::StoreKey::pairing) && !record.flag &&
        record.at > after) {
      return record.at;
    }
  }
  return std::nullopt;
}

/**
 * The device was switched to its new key once; under each key no counter carries two different
 * packets; under the new key every counter is at least one step; nothing fails its tag; and once
 * the new key was in flash, nothing came under the old one.
 */
void check_keys(const host::TestHub& hub, host::SimDevice& device, std::uint32_t step) {
  const std::string& name = device.name();
  CHECK_FALSE(hub.rekey_pending(name));
  const auto switches = hub.decisions(HubAction::key_changed, name);
  REQUIRE(switches.size() == 1);
  const device::Instant switched = switches[0].at;
  const auto sent = hub.decisions(HubAction::key_change_sent, name);
  REQUIRE_FALSE(sent.empty());
  const std::optional<device::Instant> written = key_written_at(device, sent.front().at);
  REQUIRE(written.has_value());
  std::map<std::uint32_t, Bytes> old_key;
  std::map<std::uint32_t, Bytes> new_key;
  for (const host::HubPacket& packet : hub.received()) {
    if (packet.from != name || packet.body.empty()) {
      continue;
    }
    CAPTURE(packet.counter);
    CHECK(packet.verdict != HubVerdict::bad_tag);
    const bool old = packet.verdict == HubVerdict::old_key || packet.at < switched;
    if (old && packet.at > sent.front().at) {
      CHECK(packet.at <= *written);
    }
    if (!old) {
      CHECK(packet.counter >= step);
    }
    auto& seen = old ? old_key : new_key;
    const auto found = seen.find(packet.counter);
    if (found == seen.end()) {
      seen.emplace(packet.counter, packet.body);
    } else {
      CHECK(found->second == packet.body);
    }
  }
  CHECK_FALSE(new_key.empty());
}

bool decided_after(const host::TestHub& hub, HubAction action, const std::string& name,
                   device::Instant from) {
  for (const host::HubDecision& decision : hub.decisions(action, name)) {
    if (decision.at > from) {
      return true;
    }
  }
  return false;
}

// ---- The sensor ----

/**
 * A real sensor, armed; the hub is restored at 22 s; the door opens at 60 s and its report draws
 * the Key change. Disarmed at 100 s, the door closes at 110 s, armed at 130 s, opens at 150 s.
 */
struct SensorWorld {
  SensorWorld() : hub(sim) {
    host::DeviceSpec spec;
    spec.name = "door";
    spec.role = host::make_role<roles::sensor::SensorRole>(&host::HostBoard::sensor_io);
    door = &sim.add_device(spec);
    hub.add_sensor(*door);
    hub.arm();
    sim.schedule(at(seconds(20)), [this]() { backup = hub.snapshot(); });
    sim.schedule(at(seconds(22)), [this]() { hub.restore(backup); });
    door->set_input(device::Input::door, true, at(seconds(60)));
    sim.schedule(at(seconds(100)), [this]() { hub.disarm(); });
    door->set_input(device::Input::door, false, at(seconds(110)));
    sim.schedule(at(seconds(130)), [this]() { hub.arm(); });
    door->set_input(device::Input::door, true, at(seconds(150)));
  }

  host::Simulation sim;
  host::TestHub hub;
  host::SimDevice* door = nullptr;
  host::HubSnapshot backup;
};

constexpr device::Instant kSensorEnd = at(seconds(200));

void check_sensor(SensorWorld& world, const host::CutRun& run) {
  INFO(run.describe() << "\n" << world.hub.dump());
  check_keys(world.hub, *world.door, 64);
  // Its job, after: the armed door at 150 s raised its report, and the countdown started.
  CHECK(decided_after(world.hub, HubAction::countdown_started, "door", at(seconds(150))));
  if (run.uncut()) {
    // The report drew the Key change, and went again under the new key: its countdown counts
    // from the opening at 60 s.
    const auto first = world.hub.decisions(HubAction::countdown_started, "door");
    REQUIRE_FALSE(first.empty());
    CHECK(first[0].at < at(seconds(62)));
    CHECK(first[0].value <= 30);
  }
}

TEST_CASE("a real sensor changes its key at its door report's Key change, and reports again") {
  SensorWorld world;
  world.sim.run_until(kSensorEnd);
  check_sensor(world, host::CutRun{});
}

TEST_CASE("a real sensor's key change with the power cut at every flash operation") {
  host::CutScenario<SensorWorld> scenario;
  scenario.make = []() { return std::make_unique<SensorWorld>(); };
  scenario.simulation = [](SensorWorld& world) -> host::Simulation& { return world.sim; };
  scenario.run = [](SensorWorld& world) { world.sim.run_until(kSensorEnd); };
  scenario.check = check_sensor;
  const host::CutReport report = host::run_power_cuts(scenario);
  MESSAGE("sensor: flash operations " << report.operations.at("door") << ", runs " << report.runs);
  CHECK(report.operations.at("door") >= 3);
}

// ---- The siren ----

/** A real siren; the hub is restored at 12 s; tests at 40 s and 55 s. */
struct SirenWorld {
  SirenWorld() : hub(sim) {
    host::DeviceSpec spec;
    spec.name = "siren";
    spec.role = host::make_role<roles::siren::SirenRole>(&host::HostBoard::siren_io);
    siren = &sim.add_device(spec);
    hub.add_siren(*siren);
    sim.schedule(at(seconds(10)), [this]() { backup = hub.snapshot(); });
    sim.schedule(at(seconds(12)), [this]() { hub.restore(backup); });
    // Two tests: a cut can fall on the first one's counter write, and take that one with it.
    sim.schedule(at(seconds(40)),
                 [this]() { hub.command_siren("siren", protocol::SirenAction::test, 3); });
    sim.schedule(at(seconds(55)),
                 [this]() { hub.command_siren("siren", protocol::SirenAction::test, 3); });
  }

  host::Simulation sim;
  host::TestHub hub;
  host::SimDevice* siren = nullptr;
  host::HubSnapshot backup;
};

constexpr device::Instant kSirenEnd = at(seconds(70));

void check_siren(SirenWorld& world, const host::CutRun& run) {
  INFO(run.describe() << "\n" << world.hub.dump());
  check_keys(world.hub, *world.siren, 1024);
  // Its job, after: a test from 40 s on sounded it and was confirmed.
  bool sounded = false;
  for (const host::Record& output : world.siren->records().kind(RecordKind::output).records()) {
    sounded = sounded || (output.flag && output.at >= at(seconds(40)));
  }
  CHECK(sounded);
  CHECK(decided_after(world.hub, HubAction::siren_confirmed, "siren", at(seconds(40))));
  if (run.uncut()) {
    // The first packet under the new key answered the Key change: a report, reason 1.
    const auto switched = world.hub.decisions(HubAction::key_changed, "siren");
    REQUIRE(switched.size() == 1);
    std::optional<host::HubPacket> first;
    for (const host::HubPacket& packet : world.hub.received_from("siren")) {
      if (packet.at >= switched[0].at && packet.verdict == HubVerdict::accepted && !first) {
        first = packet;
      }
    }
    REQUIRE(first.has_value());
    REQUIRE(first->type == type::siren_report);
    CHECK(first->as<protocol::SirenReport>().reason == protocol::SirenReportReason::command_answer);
    CHECK(first->counter == 1024);
  }
}

TEST_CASE("a real siren changes its key at the restored hub's start, and sounds after") {
  SirenWorld world;
  world.sim.run_until(kSirenEnd);
  check_siren(world, host::CutRun{});
}

TEST_CASE("a real siren's key change with the power cut at every flash operation") {
  host::CutScenario<SirenWorld> scenario;
  scenario.make = []() { return std::make_unique<SirenWorld>(); };
  scenario.simulation = [](SirenWorld& world) -> host::Simulation& { return world.sim; };
  scenario.run = [](SirenWorld& world) { world.sim.run_until(kSirenEnd); };
  scenario.check = check_siren;
  const host::CutReport report = host::run_power_cuts(scenario);
  MESSAGE("siren: flash operations " << report.operations.at("siren") << ", runs " << report.runs);
  CHECK(report.operations.at("siren") >= 3);
}

// ---- The gateway ----

/**
 * A real gateway with a scripted sensor heartbeating through it; the hub is restored at 12 s and
 * the gateway's connection dropped, so its next hello is under the old key.
 */
struct GatewayWorld {
  explicit GatewayWorld(bool usb) : hub(sim, gateway_mode()) {
    host::DeviceSpec spec;
    spec.name = "gateway";
    spec.role = host::make_role<roles::gateway::GatewayRole>(&host::HostBoard::gateway_io);
    gateway = &sim.add_device(spec);
    gateway->board().power.external = true;
    host::GatewayConfig config;
    config.usb = usb;
    config.network = !usb;
    hub.add_gateway(*gateway, config);
    ScriptSensorConfig sensor;
    sensor.heartbeat_every = seconds(20);
    sensor.link_check_every = 1;
    host::DeviceSpec door_spec;
    door_spec.name = "door";
    door_spec.role = script_sensor(sensor, log);
    door_spec.power_on = at(seconds(3));
    hub.add_sensor(sim.add_device(door_spec));
    const device::LinkKind link = usb ? device::LinkKind::usb : device::LinkKind::network;
    sim.schedule(at(seconds(10)), [this]() { backup = hub.snapshot(); });
    sim.schedule(at(seconds(12)), [this, link]() {
      hub.restore(backup);
      hub.drop_link("gateway", link);
    });
    if (usb) {
      // A USB port the hub closed: plugged in again a second later.
      sim.schedule(at(seconds(13)), [this]() {
        hub.drop_link("gateway", device::LinkKind::usb, device::Duration{});
      });
    }
  }

  host::Simulation sim;
  host::TestHub hub;
  ScriptSensorLog log;
  host::SimDevice* gateway = nullptr;
  host::HubSnapshot backup;
};

constexpr device::Instant kGatewayEnd = at(seconds(90));

void check_gateway(GatewayWorld& world, const host::CutRun& run) {
  INFO(run.describe() << "\n" << world.hub.dump());
  check_keys(world.hub, *world.gateway, 1024);
  // Welcomed under the new key, and forwarding to the end (the scripted sensor, which cannot
  // change its key, is only heard through it).
  const auto switched = world.hub.decisions(HubAction::key_changed, "gateway");
  REQUIRE(switched.size() == 1);
  CHECK(decided_after(world.hub, HubAction::gateway_welcomed, "gateway",
                      switched[0].at + device::Duration{-1000}));
  bool forwarded = false;
  for (const host::HubPacket& packet : world.hub.received_from("gateway", type::forwarded_packet)) {
    forwarded =
        forwarded || (packet.at > at(seconds(60)) && packet.verdict == HubVerdict::accepted);
  }
  CHECK(forwarded);
  if (run.uncut()) {
    const auto hellos = world.hub.received_from("gateway", type::hello);
    REQUIRE_FALSE(hellos.empty());
    CHECK(hellos.back().counter == 1024);
  }
}

TEST_CASE("a real gateway changes its key in place of the welcome, on Wi-Fi and on USB") {
  for (const bool usb : {false, true}) {
    CAPTURE(usb);
    GatewayWorld world(usb);
    world.sim.run_until(kGatewayEnd);
    check_gateway(world, host::CutRun{});
  }
}

TEST_CASE("a real gateway's key change with the power cut at every flash operation") {
  host::CutScenario<GatewayWorld> scenario;
  scenario.make = []() { return std::make_unique<GatewayWorld>(false); };
  scenario.simulation = [](GatewayWorld& world) -> host::Simulation& { return world.sim; };
  scenario.run = [](GatewayWorld& world) { world.sim.run_until(kGatewayEnd); };
  scenario.devices = {"gateway"};
  scenario.check = check_gateway;
  const host::CutReport report = host::run_power_cuts(scenario);
  MESSAGE("gateway: flash operations " << report.operations.at("gateway") << ", runs "
                                       << report.runs);
  CHECK(report.operations.at("gateway") >= 3);
}

}  // namespace
}  // namespace hsn::test
