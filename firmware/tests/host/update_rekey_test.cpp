// The key change after a restore on the test hub (m3-updates-design.md section 7), and the Medium's
// replay of a recorded packet: after restore() the hub acts on no packet under a device's old key,
// answers each with a Key change bound as its answers are, at most one per device every 10 s, and
// switches a device at its first packet under the new key.

#include <doctest/doctest.h>

#include <optional>
#include <string>

#include "hsn/device/services/record.hpp"
#include "hsn/device/services/setup.hpp"
#include "hsn/host/replay_radio.hpp"
#include "sim_support.hpp"
#include "support.hpp"
#include "update_hub_support.hpp"

namespace hsn::test {
namespace {

using host::HubAction;
using host::HubVerdict;
using host::RecordKind;

std::uint32_t address_of(host::SimDevice& device) {
  device::Record<device::PairingRecord> pairing(device.board().storage, device::StoreKey::pairing,
                                                device::kPairingRecordVersion, {});
  REQUIRE(pairing.load() == device::HalError::none);
  return pairing.get().address;
}

std::size_t verdicts(const host::TestHub& hub, const std::string& name, HubVerdict verdict) {
  std::size_t count = 0;
  for (const host::HubPacket& packet : hub.received()) {
    count += packet.from == name && packet.verdict == verdict ? 1 : 0;
  }
  return count;
}

/** The ids of a device's door reports on the air. */
std::vector<std::uint64_t> door_reports(const host::SimDevice& device) {
  std::vector<std::uint64_t> ids;
  for (const host::Record& record : device.records()
                                        .kind(RecordKind::transmission)
                                        .type(protocol::message_type::door_changed)
                                        .records()) {
    ids.push_back(record.transmission);
  }
  return ids;
}

/** An armed hub, a scripted door, and a recorder on the air. */
struct Home {
  Home() : radio(site.sim) {
    site.sim.medium().keep_transmissions(true);
    host::SensorConfig settings;
    settings.countdown_seconds = 30;
    door = &site.sensor("door", ScriptSensorConfig{}, log, settings);
    site.hub.arm();
  }
  Site site;
  ScriptSensorLog log;
  host::SimDevice* door = nullptr;
  host::ReplayRadio radio;
};

TEST_CASE("the Medium keeps and replays a transmission: a new one, heard like the first") {
  Home home;
  home.door->set_input(device::Input::door, true, at(seconds(1)));
  home.site.sim.run_until(at(seconds(5)));
  const auto ids = door_reports(*home.door);
  REQUIRE(ids.size() == 1);
  CHECK(home.site.sim.medium().kept(ids[0]));
  const Bytes original = home.site.sim.medium().kept_packet(ids[0]);
  std::uint64_t replayed = 0;
  home.site.sim.schedule(at(seconds(10)), [&]() { replayed = home.radio.replay(ids[0]); });
  home.site.sim.run_until(at(seconds(12)));
  INFO(home.site.sim.timeline().select().dump() << home.site.hub.dump());
  CHECK(replayed > ids[0]);
  // On the air from the recorder, the same bytes and channel; the hub's window refuses it.
  const auto sent =
      home.site.sim.timeline().of(home.radio.actor()).kind(RecordKind::transmission).records();
  REQUIRE(sent.size() == 1);
  CHECK(sent[0].transmission == replayed);
  CHECK(sent[0].length == original.size());
  CHECK(home.site.sim.medium().kept_packet(replayed) == original);
  CHECK(home.radio.sent() == 1);
  CHECK(verdicts(home.site.hub, "door", HubVerdict::duplicate) == 1);
  CHECK(home.site.hub.decisions(HubAction::countdown_started, "door").size() == 1);
  // Not kept: refused by name.
  host::Simulation plain;
  host::ReplayRadio nobody(plain);
  CHECK_THROWS_AS(nobody.replay(1), host::SimulationError);
  home.site.sim.medium().keep_transmissions(false);
  home.door->set_input(device::Input::door, false, at(seconds(13)));
  home.site.sim.run_until(at(seconds(16)));
  const auto later = door_reports(*home.door);
  REQUIRE(later.size() == 2);
  CHECK_FALSE(home.site.sim.medium().kept(later[1]));
}

TEST_CASE("after a restore an armed door report recorded since the backup starts no countdown") {
  Home home;
  host::HubSnapshot backup = home.site.hub.snapshot();
  // After the backup: the door opens (countdown), then closes; the hub is disarmed and armed.
  home.door->set_input(device::Input::door, true, at(seconds(1)));
  home.site.sim.run_until(at(seconds(5)));
  const auto reports = door_reports(*home.door);
  REQUIRE(reports.size() == 1);
  REQUIRE(home.site.hub.decisions(HubAction::countdown_started, "door").size() == 1);
  home.site.hub.disarm();
  home.door->set_input(device::Input::door, false, at(seconds(6)));
  home.site.sim.run_until(at(seconds(10)));
  home.site.hub.arm();
  // The hub is restored from the backup, and someone replays the recorded opening.
  home.site.hub.restore(backup);
  CHECK(home.site.hub.rekey_pending("door"));
  home.site.sim.schedule(at(seconds(20)), [&]() { home.radio.replay(reports[0]); });
  home.site.sim.run_until(at(seconds(25)));
  INFO(home.site.hub.dump());
  // The backup's window would accept it; the old key is never acted on.
  CHECK(home.site.hub.decisions(HubAction::countdown_started, "door").size() == 1);
  CHECK(verdicts(home.site.hub, "door", HubVerdict::old_key) == 1);
  CHECK(home.site.hub.decisions(HubAction::old_key_packet, "door").size() == 1);
  // It draws a Key change, bound to the packet it answers, sealed under the old key.
  const auto changes = home.site.hub.sent_to("door", protocol::message_type::key_change);
  REQUIRE(changes.size() == 1);
  const std::uint32_t counter = home.site.hub.received().back().counter;
  const auto change = open_from_hub<protocol::KeyChange>(
      home.site.hub.key_of("door"), changes[0].packet, protocol::Binding::sensor_packet(counter),
      protocol::PacketLimit::radio);
  REQUIRE(change.has_value());
  REQUIRE(home.site.hub.next_key_of("door").has_value());
  CHECK(change->new_key == *home.site.hub.next_key_of("door"));
  CHECK(change->new_key != home.site.hub.key_of("door"));
  const auto sent = home.site.hub.decisions(HubAction::key_change_sent, "door");
  REQUIRE(sent.size() == 1);
  CHECK(sent[0].value == 0);  // no value, as the hub records it
  // Its window is the backup's still: untouched by the old-key packet.
  CHECK(home.site.hub.window("door").highest() == backup.devices[0].window.highest());
  // The hub's counters moved past everything it sent since the backup.
  CHECK(changes[0].counter > (1u << 24));
}

TEST_CASE("the real sensor's next packet under the old key draws the Key change, which it hears") {
  Home home;
  host::HubSnapshot backup = home.site.hub.snapshot();
  home.site.hub.restore(backup);
  home.door->set_input(device::Input::door, true, at(seconds(2)));
  home.site.sim.run_until(at(seconds(6)));
  INFO(home.site.hub.dump());
  CHECK(home.site.hub.decisions(HubAction::countdown_started, "door").empty());
  // The scripted sensor opens it bound to its own report (its key change is K2's and U4's).
  CHECK(home.log.count(protocol::message_type::key_change) == 1);
  CHECK(home.log.count(protocol::message_type::reply) == 0);
}

TEST_CASE("a flood of replays draws one Key change every 10 s, always the same new key") {
  Home home;
  host::HubSnapshot backup = home.site.hub.snapshot();
  home.door->set_input(device::Input::door, true, at(seconds(1)));
  home.site.sim.run_until(at(seconds(5)));
  const auto reports = door_reports(*home.door);
  REQUIRE(reports.size() == 1);
  home.site.hub.restore(backup);
  for (int i = 0; i < 12; ++i) {
    home.site.sim.schedule(at(seconds(10) + seconds(i)),
                           [&home, &reports]() { home.radio.replay(reports[0]); });
  }
  home.site.sim.run_until(at(seconds(25)));
  INFO(home.site.hub.dump());
  CHECK(verdicts(home.site.hub, "door", HubVerdict::old_key) == 12);
  const auto changes = home.site.hub.sent_to("door", protocol::message_type::key_change);
  REQUIRE(changes.size() == 2);
  CHECK(changes[1].at - changes[0].at >= seconds(10));
  CHECK(changes[1].at - changes[0].at < seconds(11));
  const std::uint32_t counter = home.site.hub.received().back().counter;
  const auto first = open_from_hub<protocol::KeyChange>(
      home.site.hub.key_of("door"), changes[0].packet, protocol::Binding::sensor_packet(counter),
      protocol::PacketLimit::radio);
  const auto second = open_from_hub<protocol::KeyChange>(
      home.site.hub.key_of("door"), changes[1].packet, protocol::Binding::sensor_packet(counter),
      protocol::PacketLimit::radio);
  REQUIRE(first.has_value());
  REQUIRE(second.has_value());
  CHECK(first->new_key == second->new_key);
  CHECK(home.site.hub.decisions(HubAction::countdown_started, "door").size() == 1);
}

TEST_CASE("the first packet under the new key switches the sensor and is acted on") {
  Home home;
  host::HubSnapshot backup = home.site.hub.snapshot();
  home.site.hub.restore(backup);
  const std::uint32_t address = address_of(*home.door);
  const protocol::DeviceKey old_key = home.site.hub.key_of("door");
  // A packet under the old key makes the new key; the device then speaks under it from counter 64.
  protocol::Heartbeat heartbeat;
  const Bytes old_packet = seal_as_device(old_key, address, 500, heartbeat);
  home.site.sim.schedule(at(seconds(1)), [&]() { home.radio.send(old_packet, site_dr5()); });
  home.site.sim.run_until(at(seconds(3)));
  REQUIRE(home.site.hub.next_key_of("door").has_value());
  const protocol::DeviceKey new_key = *home.site.hub.next_key_of("door");
  protocol::DoorChanged opened;
  opened.flags.door_open = true;
  opened.flags.reply_wanted = true;
  opened.settings_version = home.site.hub.settings_version("door");
  const Bytes new_packet = seal_as_device(new_key, address, 64, opened);
  home.site.sim.schedule(at(seconds(3)), [&]() { home.radio.send(new_packet, site_dr5()); });
  home.site.sim.run_until(at(seconds(6)));
  INFO(home.site.hub.dump());
  CHECK_FALSE(home.site.hub.rekey_pending("door"));
  CHECK(home.site.hub.decisions(HubAction::key_changed, "door").size() == 1);
  CHECK(home.site.hub.key_of("door") == new_key);
  CHECK_FALSE(home.site.hub.next_key_of("door").has_value());
  // Acted on: the countdown runs, and its reply is sealed under the new key, counting from 1.
  CHECK(home.site.hub.decisions(HubAction::countdown_started, "door").size() == 1);
  const auto replies = home.site.hub.sent_to("door", protocol::message_type::reply);
  REQUIRE_FALSE(replies.empty());
  CHECK(replies.back().counter == 1);
  CHECK(open_from_hub<protocol::Reply>(new_key, replies.back().packet,
                                       protocol::Binding::sensor_packet(64),
                                       protocol::PacketLimit::radio)
            .has_value());
  // After the switch, a packet under the old key is a stranger's: a bad tag, never answered.
  const std::size_t changes =
      home.site.hub.sent_to("door", protocol::message_type::key_change).size();
  home.site.sim.schedule(at(seconds(20)), [&]() { home.radio.send(old_packet, site_dr5()); });
  home.site.sim.run_until(at(seconds(22)));
  CHECK(verdicts(home.site.hub, "door", HubVerdict::bad_tag) == 1);
  CHECK(home.site.hub.sent_to("door", protocol::message_type::key_change).size() == changes);
}

TEST_CASE("a backup taken mid-change keeps the new key: restored again, the same key is sent") {
  Home home;
  home.site.hub.restore(home.site.hub.snapshot());
  const std::uint32_t address = address_of(*home.door);
  const protocol::DeviceKey old_key = home.site.hub.key_of("door");
  protocol::Heartbeat heartbeat;
  const Bytes old_packet = seal_as_device(old_key, address, 500, heartbeat);
  home.site.sim.schedule(at(seconds(1)), [&]() { home.radio.send(old_packet, site_dr5()); });
  home.site.sim.run_until(at(seconds(3)));
  const protocol::DeviceKey made = *home.site.hub.next_key_of("door");
  const host::HubSnapshot mid = home.site.hub.snapshot();
  REQUIRE(mid.devices[0].rekey);
  REQUIRE(mid.devices[0].next_key.has_value());
  home.site.hub.restore(mid);
  const Bytes again = seal_as_device(old_key, address, 501, heartbeat);
  home.site.sim.schedule(at(seconds(5)), [&]() { home.radio.send(again, site_dr5()); });
  home.site.sim.run_until(at(seconds(7)));
  const auto changes = home.site.hub.sent_to("door", protocol::message_type::key_change);
  REQUIRE(changes.size() == 2);
  const auto change = open_from_hub<protocol::KeyChange>(old_key, changes[1].packet,
                                                         protocol::Binding::sensor_packet(501),
                                                         protocol::PacketLimit::radio);
  REQUIRE(change.has_value());
  CHECK(change->new_key == made);
}

TEST_CASE(
    "every siren gets its Key change at the restore on both paths; its old-key report is "
    "not acted on") {
  Site site;
  ScriptSirenLog log;
  host::SimDevice& siren = site.siren("siren", ScriptSirenConfig{}, log);
  site.sim.run_until(at(seconds(5)));
  const host::HubSnapshot backup = site.hub.snapshot();
  site.hub.restore(backup);
  site.sim.run_until(at(seconds(6)));
  INFO(site.hub.dump());
  const auto changes = site.hub.sent_to("siren", protocol::message_type::key_change);
  REQUIRE(changes.size() >= 2);
  bool by_link = false;
  bool by_radio = false;
  for (const host::HubSent& sent : changes) {
    by_link = by_link || sent.path == host::HubPath::link;
    by_radio = by_radio || sent.path == host::HubPath::radio;
    const auto change =
        open_from_hub<protocol::KeyChange>(site.hub.key_of("siren"), sent.packet,
                                           protocol::Binding::none(), protocol::PacketLimit::radio);
    REQUIRE(change.has_value());
    CHECK(change->new_key == *site.hub.next_key_of("siren"));
  }
  CHECK(by_link);
  CHECK(by_radio);
  // The siren (whose own change is K2's and U5's) goes on under its old key: its reports are
  // never acted on, and no command it confirms counts.
  const std::size_t confirmed = site.hub.decisions(HubAction::siren_confirmed, "siren").size();
  site.hub.command_siren("siren", protocol::SirenAction::test, 5);
  site.sim.run_until(at(seconds(70)));
  CHECK(verdicts(site.hub, "siren", HubVerdict::old_key) >= 1);
  CHECK(site.hub.decisions(HubAction::siren_confirmed, "siren").size() == confirmed);
  static_cast<void>(siren);
}

TEST_CASE("a gateway's hello under its old key is answered with a Key change, not a welcome") {
  Site site(gateway_mode());
  site.add_mode_gateway();
  site.sim.run_until(at(seconds(3)));
  REQUIRE(site.hub.decisions(HubAction::gateway_welcomed, "gateway").size() == 1);
  site.hub.restore(site.hub.snapshot());
  // The restored hub dropped the connection. The scripted gateway connects only when it starts
  // (the gateway role reconnects by itself): it is restarted, and says hello under its old key.
  CHECK_FALSE(site.sim.device("gateway").wire(device::LinkKind::network).connected());
  site.sim.device("gateway").restart(at(seconds(4)));
  site.sim.run_until(at(seconds(30)));
  INFO(site.hub.dump());
  CHECK(site.hub.decisions(HubAction::gateway_welcomed, "gateway").size() == 1);
  CHECK(verdicts(site.hub, "gateway", HubVerdict::old_key) >= 1);
  const auto changes = site.hub.sent_to("gateway", protocol::message_type::key_change);
  REQUIRE_FALSE(changes.empty());
  const auto hellos = site.hub.received();
  std::optional<protocol::Hello> hello;
  for (auto it = hellos.rbegin(); it != hellos.rend(); ++it) {
    if (it->from == "gateway" && it->verdict == HubVerdict::old_key &&
        it->type == protocol::message_type::hello) {
      hello = it->as<protocol::Hello>();
      break;
    }
  }
  REQUIRE(hello.has_value());
  // Bound to the hello's random, in place of the welcome.
  const auto change =
      open_from_hub<protocol::KeyChange>(site.hub.key_of("gateway"), changes.back().packet,
                                         protocol::Binding::hello(hello->gateway_random));
  REQUIRE(change.has_value());
  CHECK(change->new_key == *site.hub.next_key_of("gateway"));
  CHECK(site.hub.sent_to("gateway", protocol::message_type::welcome).size() == 1);
}

}  // namespace
}  // namespace hsn::test
