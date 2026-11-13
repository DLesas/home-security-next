// The test hub in gateway link mode, with scripted gateways carrying the radio: hello and
// welcome, settings, forwarded packets, transmit requests at a time on the gateway's clock or as
// soon as possible, transmit results, and a packet heard by two gateways. Protocol sections 4, 6
// and 7.

#include "sim_support.hpp"

namespace hsn::test {
namespace {

using host::HubAction;
using host::HubPath;
using host::HubVerdict;
namespace type = protocol::message_type;

TEST_CASE("a gateway's hello is welcomed, then it is given its settings, on either link") {
  for (const bool usb : {false, true}) {
    INFO((usb ? "USB" : "network"));
    Site site(gateway_mode());
    ScriptGatewayLog log;
    ScriptGatewayConfig config;
    config.use_usb = usb;
    host::GatewayConfig attachment;
    attachment.usb = usb;
    attachment.network = !usb;
    host::SimDevice& gateway = site.gateway("gateway", config, log, attachment);
    site.sim.run_until(at(seconds(2)));
    CHECK(log.hellos == 1);
    CHECK(log.welcomes == 1);
    CHECK(log.settings == 1);
    CHECK(log.rejected == 0);
    CHECK(site.hub.decisions(HubAction::gateway_welcomed, "gateway").size() == 1);
    CHECK(gateway.records().kind(RecordKind::link_sent).type_names() == "hello");
    CHECK(gateway.records().kind(RecordKind::link_received).type_names() ==
          "welcome, gateway_settings");
    CHECK(gateway.board().gateway_io.host == usb);

    // New settings reach it on the same connection, with a new version.
    host::GatewayConfig changed = attachment;
    changed.status_interval_seconds = 60;
    site.hub.change_gateway("gateway", changed);
    site.sim.run_until(at(seconds(3)));
    CHECK(log.settings == 2);
    CHECK(log.settings_version == 2);
  }
}

TEST_CASE("a forwarded door report is answered by a transmit request as soon as possible") {
  Site site(gateway_mode());
  ScriptGatewayLog gateway_log;
  ScriptSensorLog sensor_log;
  host::SimDevice& gateway = site.gateway("gateway", ScriptGatewayConfig{}, gateway_log);
  host::SimDevice& door = site.sensor("door", ScriptSensorConfig{}, sensor_log);
  door.set_input(device::Input::door, true, at(seconds(10)));
  site.sim.run_until(at(seconds(15)));

  const auto reports = site.hub.received_from("door", type::door_changed);
  REQUIRE(reports.size() == 1);
  CHECK(reports[0].path == HubPath::gateway);
  CHECK(reports[0].via == "gateway");
  CHECK(gateway_log.forwarded == 1);
  const auto replies = site.hub.sent_to("door", type::reply);
  REQUIRE(replies.size() == 1);
  CHECK(replies[0].path == HubPath::gateway);
  CHECK(replies[0].via == "gateway");
  CHECK(gateway_log.requests == 1);
  CHECK(gateway_log.timed_requests == 0);
  // The gateway sent it and said so.
  const auto results = site.hub.decisions(HubAction::transmit_result, "door");
  REQUIRE(results.size() == 1);
  CHECK(results[0].value == protocol::TransmitOutcome::sent);
  CHECK(gateway.records().kind(RecordKind::transmission).type_names() == "reply");
  REQUIRE(sensor_log.heard.size() == 1);
  CHECK(sensor_log.heard[0].answered == sensor_log.sent[0]);
  // Both link directions are on the timeline, named.
  CHECK(gateway.records().kind(RecordKind::link_sent).type_names() ==
        "hello, forwarded_packet, transmit_result");
}

TEST_CASE("a heartbeat reply goes at the fixed moment on the gateway's own clock") {
  Site site(gateway_mode());
  ScriptGatewayLog gateway_log;
  ScriptSensorLog sensor_log;
  ScriptSensorConfig config;
  config.heartbeat_every = seconds(60);
  // A gateway clock 200 ppm fast: its second is 0.2 ms short in true time.
  host::SimDevice& gateway =
      site.gateway("gateway", ScriptGatewayConfig{}, gateway_log, host::GatewayConfig{}, 200);
  host::SimDevice& door = site.sensor("door", config, sensor_log);
  site.sim.run_until(at(seconds(65)));

  CHECK(gateway_log.timed_requests == 1);
  const auto heartbeat = door.records().kind(RecordKind::transmission).records();
  const auto reply = gateway.records().kind(RecordKind::transmission).records();
  REQUIRE(heartbeat.size() == 1);
  REQUIRE(reply.size() == 1);
  CHECK(reply[0].label.type == type::reply);
  const device::Duration moment = reply[0].from - heartbeat[0].until;
  CHECK(moment > seconds(1) - milliseconds(1));
  CHECK(moment < seconds(1));
  REQUIRE(sensor_log.heard.size() == 1);
  CHECK(sensor_log.heard[0].answered == sensor_log.sent[0]);
}

TEST_CASE("a packet heard by two gateways is accepted once and answered through the first") {
  Site site(gateway_mode());
  ScriptGatewayLog first_log;
  ScriptGatewayLog second_log;
  ScriptSensorLog sensor_log;
  site.gateway("first", ScriptGatewayConfig{}, first_log);
  site.gateway("second", ScriptGatewayConfig{}, second_log);
  host::SimDevice& door = site.sensor("door", ScriptSensorConfig{}, sensor_log);
  door.set_input(device::Input::door, true, at(seconds(10)));
  site.sim.run_until(at(seconds(15)));

  CHECK(first_log.forwarded == 1);
  CHECK(second_log.forwarded == 1);
  std::vector<host::HubPacket> copies;
  for (const host::HubPacket& packet : site.hub.received()) {
    if (packet.from == "door") {
      copies.push_back(packet);
    }
  }
  REQUIRE(copies.size() == 2);
  CHECK(copies[0].verdict == HubVerdict::accepted);
  CHECK(copies[0].via == "first");
  CHECK(copies[1].verdict == HubVerdict::duplicate);
  CHECK(copies[1].via == "second");
  const auto replies = site.hub.sent_to("door", type::reply);
  REQUIRE(replies.size() == 1);
  CHECK(replies[0].via == "first");
  CHECK(second_log.requests == 0);
  CHECK(sensor_log.heard.size() == 1);
}

TEST_CASE("siren commands go through a gateway with siren priority, and on Wi-Fi") {
  Site site(gateway_mode());
  ScriptGatewayLog gateway_log;
  ScriptSirenLog siren_log;
  site.gateway("gateway", ScriptGatewayConfig{}, gateway_log);
  host::SimDevice& siren = site.siren("siren", ScriptSirenConfig{}, siren_log);
  site.sim.schedule(at(seconds(5)),
                    [&]() { site.hub.command_siren("siren", protocol::SirenAction::test, 30); });
  site.sim.run_until(at(seconds(10)));
  CHECK(gateway_log.siren_requests >= 1);
  CHECK(siren.board().siren_io.output_state);
  // Acted on once: the Wi-Fi copy came first, the LoRa one was a repeat.
  CHECK(siren_log.count(device::CommandVerdict::new_command) >= 1);
  REQUIRE_FALSE(siren_log.commands.empty());
  CHECK(siren_log.commands[0].by_wifi);
  CHECK(siren_log.commands[0].action == protocol::SirenAction::test);
  CHECK(site.hub.decisions(HubAction::siren_confirmed, "siren").size() >= 1);
}

}  // namespace
}  // namespace hsn::test
