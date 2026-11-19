// Whole-device updates with the real roles (m3-updates-design.md sections 2, 5, 6 and 8): a real
// sensor over Wi-Fi and over Bluetooth through ScriptPhone, a real siren on its Wi-Fi link, a real
// gateway on USB and on Wi-Fi, each against the test hub, with the fake slots and bootloader. Each
// scenario also runs under the power-cut harness, cut at every flash operation of the whole update
// (during it and after it): after every cut the device boots an image that works, finishes the
// update or rolls back, still does its job (the armed door still raises its report, the siren
// still sounds on command, the gateway still forwards), and never puts one counter on two packets.
// The small test roles of update_scenarios_test.cpp test the update service on its own.

#include <doctest/doctest.h>

#include <map>
#include <memory>
#include <optional>
#include <string>

#include "hsn/host/power_cut_harness.hpp"
#include "hsn/host/role_box.hpp"
#include "hsn/host/script_phone.hpp"
#include "hsn/host/test_hub.hpp"
#include "hsn/host/test_image.hpp"
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
using host::UpdateMethod;
using host::UpdateState;
namespace type = protocol::message_type;

const protocol::FirmwareVersion kNew{1, 4, 0};

bool same(const protocol::FirmwareVersion& a, const protocol::FirmwareVersion& b) {
  return a.major == b.major && a.minor == b.minor && a.patch == b.patch;
}

/** Under the device's key, no counter carries two different packets. */
void check_counters(const host::TestHub& hub, const std::string& name) {
  std::map<std::uint32_t, Bytes> seen;
  for (const host::HubPacket& packet : hub.received()) {
    if (packet.from != name || packet.body.empty()) {
      continue;
    }
    CAPTURE(packet.counter);
    CHECK(packet.verdict != HubVerdict::bad_tag);
    const auto found = seen.find(packet.counter);
    if (found == seen.end()) {
      seen.emplace(packet.counter, packet.body);
    } else {
      CHECK(found->second == packet.body);
    }
  }
}

/**
 * The update's end, whatever the cut: the board runs a bootable image off trial, wrote nothing on
 * trial, and either runs the new image confirmed, or (a cut on trial) rolled back to the old.
 */
void check_update(const host::TestHub& hub, host::SimDevice& device, const host::CutRun& run) {
  CHECK(device.state() != host::PowerState::off);
  CHECK(device.boot_choice().bootable);
  CHECK_FALSE(device.board().slots.running().on_trial);
  CHECK(device.board().slots.writes_on_trial() == 0);
  const UpdateState state = hub.update_of(device.name()).state;
  if (state == UpdateState::offered) {
    // A cut that took the offer with it, before the first piece (the counter write of a siren's or
    // gateway's offer): the device holds nothing and runs its image; the test hub offers again
    // only a download under way (a gap of the test hub, reported), so nothing more happens.
    CHECK(device.records().kind(RecordKind::slot_write).count() == 0);
    CHECK_FALSE(same(device.boot_choice().image.version, kNew));
    CHECK_FALSE(run.uncut());
    return;
  }
  if (state == UpdateState::rolled_back) {
    // Only a cut on trial rolls back: one after the restart into the new image (section 6).
    CHECK_FALSE(run.uncut());
    const auto cuts = device.records()
                          .kind(RecordKind::power_loss)
                          .where([](const host::Record& r) { return r.flag; })
                          .records();
    const auto restarts = device.records().kind(RecordKind::restart).records();
    REQUIRE(cuts.size() == 1);
    REQUIRE_FALSE(restarts.empty());
    CHECK(cuts[0].at >= restarts[0].at);
    CHECK_FALSE(same(device.boot_choice().image.version, kNew));
    CHECK(device.boot_choice().image.rolled_back);
    return;
  }
  CHECK(state == UpdateState::confirmed);
  CHECK(same(device.boot_choice().image.version, kNew));
}

/** True when the hub took `name`'s packet of `type` after `from`. */
bool heard_after(const host::TestHub& hub, const std::string& name, std::uint8_t of_type,
                 device::Instant from) {
  for (const host::HubPacket& packet : hub.received_from(name, of_type)) {
    if (packet.at > from && packet.verdict == HubVerdict::accepted) {
      return true;
    }
  }
  return false;
}

// ---- The sensor ----

/** A real sensor updated over Wi-Fi or by a phone; then armed, and its door opens at 200 s. */
struct SensorWorld {
  explicit SensorWorld(UpdateMethod method) : hub(sim) {
    host::DeviceSpec spec;
    spec.name = "door";
    spec.role = host::make_role<roles::sensor::SensorRole>(&host::HostBoard::sensor_io);
    door = &sim.add_device(spec);
    hub.add_sensor(*door);
    image = &hub.add_image(host::make_test_image(kNew, 20000));
    if (method == UpdateMethod::bluetooth) {
      phone =
          std::make_unique<host::ScriptPhone>(sim, *door, hub.open_bluetooth("door", image->id));
      // Opening its cover sends a report the hub always answers: the sensor learns of it at once.
      door->set_input(device::Input::cover, true, at(seconds(2)));
      door->set_input(device::Input::cover, false, at(seconds(170)));
    } else {
      hub.offer_update("door", image->id, method);
    }
    door->set_input(device::Input::door, true, at(seconds(200)));
  }

  void run() {
    sim.run_until(at(seconds(180)));
    state_at_arm = hub.update_of("door").state;
    hub.arm();
    sim.run_until(at(seconds(240)));
  }

  host::Simulation sim;
  host::TestHub hub;
  host::SimDevice* door = nullptr;
  const host::HubImage* image = nullptr;
  std::unique_ptr<host::ScriptPhone> phone;
  UpdateState state_at_arm = UpdateState::none;
};

void check_sensor(SensorWorld& world, const host::CutRun& run) {
  INFO(run.describe() << "\n" << world.hub.dump());
  host::SimDevice& door = *world.door;
  // Done (or rolled back) before it was armed: a sensor updates only while disarmed.
  CHECK((world.state_at_arm == UpdateState::confirmed ||
         world.state_at_arm == UpdateState::rolled_back));
  check_update(world.hub, door, run);
  // Its job: the armed door raised its report, and the hub started the countdown.
  CHECK(heard_after(world.hub, "door", type::door_changed, at(seconds(200))));
  bool countdown = false;
  for (const host::HubDecision& decision :
       world.hub.decisions(HubAction::countdown_started, "door")) {
    countdown = countdown || decision.at > at(seconds(200));
  }
  CHECK(countdown);
  check_counters(world.hub, "door");
}

TEST_CASE("a real sensor updates over Wi-Fi, and its armed door is reported after") {
  SensorWorld world(UpdateMethod::join_wifi);
  world.run();
  check_sensor(world, host::CutRun{});
  // The download went on the network link, its update packets over LoRa before and after.
  CHECK(world.door->records().kind(RecordKind::link_sent).type(type::update_query).count() >= 1);
  CHECK(world.door->records().kind(RecordKind::transmission).type(type::update_status).count() ==
        3);
}

TEST_CASE("a real sensor updates from a phone over Bluetooth") {
  SensorWorld world(UpdateMethod::bluetooth);
  world.run();
  check_sensor(world, host::CutRun{});
  REQUIRE(world.phone->done.has_value());
  CHECK(world.phone->done->result == protocol::DoneResult::verified);
  CHECK(world.phone->served_to == world.image->file.size());
  // Nothing on Wi-Fi: Bluetooth and LoRa only.
  CHECK(world.door->board().network.connects == 0);
}

TEST_CASE("a real sensor's Wi-Fi update with the power cut at every flash operation") {
  host::CutScenario<SensorWorld> scenario;
  scenario.make = []() { return std::make_unique<SensorWorld>(UpdateMethod::join_wifi); };
  scenario.simulation = [](SensorWorld& world) -> host::Simulation& { return world.sim; };
  scenario.run = [](SensorWorld& world) { world.run(); };
  scenario.check = check_sensor;
  const host::CutReport report = host::run_power_cuts(scenario);
  MESSAGE("sensor over Wi-Fi: flash operations " << report.operations.at("door") << ", runs "
                                                 << report.runs);
  CHECK(report.operations.at("door") >= 10);
}

TEST_CASE("a real sensor's Bluetooth update with the power cut at every flash operation") {
  host::CutScenario<SensorWorld> scenario;
  scenario.make = []() { return std::make_unique<SensorWorld>(UpdateMethod::bluetooth); };
  scenario.simulation = [](SensorWorld& world) -> host::Simulation& { return world.sim; };
  scenario.run = [](SensorWorld& world) { world.run(); };
  scenario.devices = {"door"};
  scenario.check = check_sensor;
  const host::CutReport report = host::run_power_cuts(scenario);
  MESSAGE("sensor over Bluetooth: flash operations " << report.operations.at("door") << ", runs "
                                                     << report.runs);
  CHECK(report.operations.at("door") >= 10);
}

// ---- The siren ----

/** A real siren on mains, updated on its Wi-Fi link; commanded to test at 120 s. */
struct SirenWorld {
  SirenWorld() : hub(sim) {
    host::DeviceSpec spec;
    spec.name = "siren";
    spec.role = host::make_role<roles::siren::SirenRole>(&host::HostBoard::siren_io);
    siren = &sim.add_device(spec);
    siren->board().power.external = true;
    hub.add_siren(*siren);
    image = &hub.add_image(host::make_test_image(kNew, 20000));
    sim.schedule(at(seconds(1)), [this]() { hub.offer_update("siren", image->id); });
    // Two tests: a cut can fall on the first one's counter write, and take that one with it.
    sim.schedule(at(seconds(120)),
                 [this]() { hub.command_siren("siren", protocol::SirenAction::test, 5); });
    sim.schedule(at(seconds(135)),
                 [this]() { hub.command_siren("siren", protocol::SirenAction::test, 5); });
  }

  host::Simulation sim;
  host::TestHub hub;
  host::SimDevice* siren = nullptr;
  const host::HubImage* image = nullptr;
};

void check_siren(SirenWorld& world, const host::CutRun& run) {
  INFO(run.describe() << "\n" << world.hub.dump());
  check_update(world.hub, *world.siren, run);
  // Its job: it sounded on a command at 120 s or after, and confirmed it.
  bool sounded = false;
  for (const host::Record& output : world.siren->records().kind(RecordKind::output).records()) {
    sounded = sounded || (output.flag && output.at >= at(seconds(120)));
  }
  CHECK(sounded);
  bool confirmed = false;
  for (const host::HubDecision& decision :
       world.hub.decisions(HubAction::siren_confirmed, "siren")) {
    confirmed = confirmed || decision.at >= at(seconds(120));
  }
  CHECK(confirmed);
  check_counters(world.hub, "siren");
}

TEST_CASE("a real siren updates on its Wi-Fi link, and sounds on command after") {
  SirenWorld world;
  world.sim.run_until(at(seconds(150)));
  check_siren(world, host::CutRun{});
}

TEST_CASE("a real siren's update with the power cut at every flash operation") {
  host::CutScenario<SirenWorld> scenario;
  scenario.make = []() { return std::make_unique<SirenWorld>(); };
  scenario.simulation = [](SirenWorld& world) -> host::Simulation& { return world.sim; };
  scenario.run = [](SirenWorld& world) { world.sim.run_until(at(seconds(150))); };
  scenario.check = check_siren;
  const host::CutReport report = host::run_power_cuts(scenario);
  MESSAGE("siren: flash operations " << report.operations.at("siren") << ", runs " << report.runs);
  CHECK(report.operations.at("siren") >= 10);
}

// ---- The gateway ----

/** A real gateway on USB or Wi-Fi, updated on it; a scripted sensor heartbeats through it. */
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
    door_spec.power_on = at(seconds(5));
    hub.add_sensor(sim.add_device(door_spec));
    image = &hub.add_image(host::make_test_image(kNew, 20000));
    sim.schedule(at(seconds(1)), [this]() { hub.offer_update("gateway", image->id); });
  }

  host::Simulation sim;
  host::TestHub hub;
  ScriptSensorLog log;
  host::SimDevice* gateway = nullptr;
  const host::HubImage* image = nullptr;
};

void check_gateway(GatewayWorld& world, const host::CutRun& run) {
  INFO(run.describe() << "\n" << world.hub.dump());
  check_update(world.hub, *world.gateway, run);
  // Its job: the sensor's heartbeats reach the hub through it, to the end.
  CHECK(heard_after(world.hub, "door", type::heartbeat, at(seconds(120))));
  CHECK(heard_after(world.hub, "gateway", type::forwarded_packet, at(seconds(120))));
  check_counters(world.hub, "gateway");
}

TEST_CASE("a real gateway updates on Wi-Fi and on USB, and forwards after") {
  for (const bool usb : {false, true}) {
    CAPTURE(usb);
    GatewayWorld world(usb);
    world.sim.run_until(at(seconds(150)));
    check_gateway(world, host::CutRun{});
  }
}

TEST_CASE("a real gateway's update on USB with the power cut at every flash operation") {
  host::CutScenario<GatewayWorld> scenario;
  scenario.make = []() { return std::make_unique<GatewayWorld>(true); };
  scenario.simulation = [](GatewayWorld& world) -> host::Simulation& { return world.sim; };
  scenario.run = [](GatewayWorld& world) { world.sim.run_until(at(seconds(150))); };
  scenario.devices = {"gateway"};
  scenario.check = check_gateway;
  const host::CutReport report = host::run_power_cuts(scenario);
  MESSAGE("gateway: flash operations " << report.operations.at("gateway") << ", runs "
                                       << report.runs);
  CHECK(report.operations.at("gateway") >= 10);
}

}  // namespace
}  // namespace hsn::test
