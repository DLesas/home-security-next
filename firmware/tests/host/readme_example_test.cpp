// The worked example of platform/host/README.md, verbatim. A scripted sensor stands in for the
// sensor role; the sensor's engineer swaps in make_role<roles::sensor::SensorRole>(...).

#include "sim_support.hpp"

namespace hsn::test {
namespace {

TEST_CASE("README: an armed door opening is answered with a countdown, then disarmed") {
  // One simulation, one hub with its own radio standing in for a gateway.
  host::Simulation sim;
  host::TestHub hub(sim);

  // A board running the role, 40 ppm fast, paired with the hub before its first boot.
  ScriptSensorLog log;
  host::DeviceSpec spec;
  spec.name = "door";
  spec.role = script_sensor(ScriptSensorConfig{}, log);
  spec.drift_ppm = 40;
  host::SimDevice& door = sim.add_device(spec);
  host::SensorConfig settings;
  settings.countdown_seconds = 30;
  hub.add_sensor(door, settings);

  // The script: armed from the start, the door opens at 10 s, the user disarms at 20 s.
  hub.arm();
  door.set_input(device::Input::door, true, at(seconds(10)));
  sim.schedule(at(seconds(20)), [&]() { hub.disarm(); });
  sim.run_until(at(seconds(30)));
  INFO(sim.timeline().select().dump() << hub.dump());

  // What went on the air, in order, by whom.
  CHECK(door.records().kind(RecordKind::transmission).type_names() == "door_changed");
  CHECK(sim.timeline().of(hub.actor()).kind(RecordKind::transmission).type_names() ==
        "reply, disarmed_notice, disarmed_notice");
  // What the hub decided, and when.
  const auto countdown = hub.decisions(host::HubAction::countdown_started, "door");
  REQUIRE(countdown.size() == 1);
  CHECK(countdown[0].value == 30);
  CHECK(hub.decisions(host::HubAction::disarmed_notice, "door").size() == 2);
  // What the device made of it.
  REQUIRE(log.heard.size() == 2);
  CHECK(log.heard[0].reply.flags.countdown_started);
  CHECK(log.heard[1].type == protocol::message_type::disarmed_notice);
  // Budgets over the run.
  CHECK(door.records().kind(RecordKind::flash_write).count() <= 1);
  CHECK(door.records().busiest_hour() < seconds(36));
}

}  // namespace
}  // namespace hsn::test
