// M1a's "done when" with scripted devices standing in for the roles, in gateway link mode: an
// armed door report, the countdown, the siren sounding at its end, and a disarm that stops it
// (design section 8, system tests).

#include "sim_support.hpp"

namespace hsn::test {
namespace {

using host::HubAction;
using host::HubPath;
namespace type = protocol::message_type;

TEST_CASE("an armed door opening sounds the siren at the countdown's end; disarming stops it") {
  Site site(gateway_mode());
  ScriptGatewayLog gateway_log;
  ScriptSensorLog sensor_log;
  ScriptSirenLog siren_log;
  host::SensorConfig sensor_settings;
  sensor_settings.countdown_seconds = 20;
  host::SimDevice& gateway = site.gateway("gateway", ScriptGatewayConfig{}, gateway_log);
  host::SimDevice& door = site.sensor("door", ScriptSensorConfig{}, sensor_log, sensor_settings);
  host::SimDevice& siren = site.siren("siren", ScriptSirenConfig{}, siren_log);
  site.hub.arm();

  door.set_input(device::Input::door, true, at(seconds(10)));
  site.sim.run_until(at(seconds(12)));
  INFO(site.hub.dump());
  // The report went through the gateway, and its reply came back through it: countdown started.
  REQUIRE(sensor_log.heard.size() == 1);
  CHECK(sensor_log.heard[0].reply.flags.armed);
  CHECK(sensor_log.heard[0].reply.flags.countdown_started);
  CHECK(sensor_log.heard[0].reply.countdown_remaining_seconds == 20);
  CHECK_FALSE(siren.board().siren_io.output_state);

  site.sim.run_until(at(seconds(35)));
  // The countdown ended about 30.1 s in: the siren sounds, told on Wi-Fi and through the gateway.
  const auto alarm = site.hub.decisions(HubAction::alarm, "door");
  REQUIRE(alarm.size() == 1);
  CHECK(alarm[0].at > at(seconds(30)));
  CHECK(alarm[0].at < at(seconds(31)));
  CHECK(siren.board().siren_io.output_state);
  const auto sounding = siren.records().kind(RecordKind::output).records();
  REQUIRE(sounding.size() == 1);
  CHECK(sounding[0].at - alarm[0].at < milliseconds(100));
  const auto commands = site.hub.sent_to("siren", type::siren_command);
  REQUIRE(commands.size() == 2);
  CHECK(commands[0].path == HubPath::link);
  CHECK(commands[1].path == HubPath::gateway);
  CHECK(commands[1].via == "gateway");
  CHECK(gateway_log.siren_requests >= 1);
  CHECK(site.hub.decisions(HubAction::siren_confirmed, "siren").size() >= 1);
  // On the air through the gateway: the reply, the siren command, then the siren's settings,
  // because its first report showed it holding none.
  CHECK(gateway.records()
            .kind(RecordKind::transmission)
            .between(at(seconds(0)), at(seconds(31)))
            .type_names() == "reply, siren_command, siren_settings");

  site.hub.disarm();
  site.sim.run_until(at(seconds(45)));
  CHECK_FALSE(siren.board().siren_io.output_state);
  const auto outputs = siren.records().kind(RecordKind::output).records();
  REQUIRE(outputs.size() == 2);
  CHECK_FALSE(outputs[1].flag);
  CHECK(outputs[1].at - at(seconds(35)) < milliseconds(100));
  // The siren wrote its command counter once per new command or settings, never for a repeat.
  const auto command_counter = [](const host::Record& record) {
    return record.value == static_cast<std::uint32_t>(device::StoreKey::command_counter);
  };
  CHECK(siren.records().kind(RecordKind::flash_write).where(command_counter).count() ==
        siren_log.count(device::CommandVerdict::new_command));
  // The sensor's packets stayed far inside its airtime.
  CHECK(door.records().busiest_hour() < seconds(1));
}

}  // namespace
}  // namespace hsn::test
