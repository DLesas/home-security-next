// Two gateways hearing the same packets (§7 "One gateway replies"; GW9, D28): the hub keeps the
// first copy and answers through the gateway that delivered it, at a moment on that gateway's own
// clock; the other gateway sends nothing.

#include "gateway_bench.hpp"

namespace hsn::test {
namespace {

using host::HubAction;
using host::HubVerdict;

TEST_CASE("GW9 D28 a packet heard by two gateways counts once and is answered through one") {
  Site site(gateway_mode());
  // Clocks that disagree: each moment is counted on the clock of the gateway that sends it.
  host::SimDevice& east = add_gateway(site, "east", {}, 300);
  host::SimDevice& west = add_gateway(site, "west", {}, -300);
  ScriptSensorLog sensor_log;
  ScriptSensorConfig config;
  config.heartbeat_every = seconds(60);
  config.link_check_every = 1;
  host::SimDevice& door = site.sensor("door", config, sensor_log);
  site.sim.medium().set_path_loss(door.station(), east.station(), 95);
  site.sim.medium().set_path_loss(door.station(), west.station(), 115);
  door.set_input(device::Input::door, true, at(seconds(10)));
  site.sim.run_until(at(seconds(65)));
  INFO(site.sim.timeline().select().dump() << site.hub.dump());

  // Both forwarded both packets, each with its own signal strength (GW5).
  const auto from_east = forwarded_by(site.hub, "east");
  const auto from_west = forwarded_by(site.hub, "west");
  REQUIRE(from_east.size() == 2);
  REQUIRE(from_west.size() == 2);
  CHECK(from_east[0].packet == from_west[0].packet);
  CHECK(from_east[0].meta.rssi_dbm == 14 - 95);
  CHECK(from_west[0].meta.rssi_dbm == 14 - 115);

  // The hub accepted one copy of each and dropped the other by its counter.
  std::vector<host::HubPacket> copies;
  for (const host::HubPacket& packet : site.hub.received()) {
    if (packet.from == "door") {
      copies.push_back(packet);
    }
  }
  REQUIRE(copies.size() == 4);
  std::size_t accepted = 0;
  std::size_t duplicates = 0;
  for (const host::HubPacket& copy : copies) {
    accepted += copy.verdict == HubVerdict::accepted ? 1u : 0u;
    duplicates += copy.verdict == HubVerdict::duplicate ? 1u : 0u;
  }
  CHECK(accepted == 2);
  CHECK(duplicates == 2);

  // Each reply went through the gateway whose copy was accepted, and only that one sent it.
  const auto replies = site.hub.sent_to("door", type::reply);
  REQUIRE(replies.size() == 2);
  const std::string first_via = site.hub.received_from("door", type::door_changed)[0].via;
  CHECK(replies[0].via == first_via);
  for (const host::HubSent& reply : site.hub.sent_to("door", type::reply)) {
    CHECK(reply.via == site.hub.received_from("door")[&reply == &replies[0] ? 0 : 1].via);
  }
  std::size_t via_east = 0;
  for (const host::HubSent& reply : replies) {
    via_east += reply.via == "east" ? 1u : 0u;
  }
  CHECK(east.records().kind(RecordKind::transmission).count() == via_east);
  CHECK(west.records().kind(RecordKind::transmission).count() == 2 - via_east);
  CHECK(sensor_log.count(type::reply) == 2);

  // The heartbeat's reply left at the reply moment on its own gateway's clock.
  const std::string beat_via = site.hub.received_from("door", type::heartbeat)[0].via;
  host::SimDevice& sender = beat_via == "east" ? east : west;
  const auto beats = door.records().kind(RecordKind::transmission).type(type::heartbeat).records();
  REQUIRE(beats.size() == 1);
  const auto timed = sender.records().kind(RecordKind::transmission).type(type::reply).records();
  REQUIRE_FALSE(timed.empty());
  CHECK(sender.clock().local(timed.back().from) ==
        sender.clock().local(beats[0].until) + seconds(1));
  CHECK(
      decision_values(site.hub, HubAction::transmit_result, "door") ==
      std::vector<std::int64_t>{protocol::TransmitOutcome::sent, protocol::TransmitOutcome::sent});
}

}  // namespace
}  // namespace hsn::test
