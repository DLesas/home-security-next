// The gateway's connection to the hub (§4, §7 "Gateway connection", §10; GW4, GW8, GW10, FW7,
// FW8, FW9, D81, D97, D101): hello, welcome, settings and Started; refused welcomes and packets
// of other sessions; reconnecting on the back-off schedule; USB or Wi-Fi.

#include "gateway_bench.hpp"
#include "hsn/protocol/setup.hpp"

namespace hsn::test {
namespace {

using host::HubAction;
using host::HubVerdict;
using roles::gateway::ConnectionPhase;

/** Link records of one direction and one link (0 USB, 1 network). */
std::vector<host::Record> link_records(host::SimDevice& device, RecordKind kind,
                                       device::LinkKind link) {
  const std::uint32_t value = link == device::LinkKind::usb ? 0u : 1u;
  return device.records()
      .kind(kind)
      .where([value](const host::Record& record) { return record.value == value; })
      .records();
}

TEST_CASE("GW4 hello with a fresh random value, welcome, settings, then Started (§7)") {
  Site site(gateway_mode());
  host::SimDevice& gateway = add_gateway(site, "gateway");
  gateway.board().hal().build.version = protocol::FirmwareVersion{1, 4, 2};
  site.sim.run_until(at(seconds(3)));
  INFO(site.sim.timeline().select().dump() << site.hub.dump());

  CHECK(gateway.records().kind(RecordKind::link_sent).type_names() == "hello, started");
  CHECK(gateway.records().kind(RecordKind::link_received).type_names() ==
        "welcome, gateway_settings");
  CHECK(site.hub.decisions(HubAction::gateway_welcomed, "gateway").size() == 1);
  // Every packet authenticated with the gateway's own key and, after the hello, the session.
  for (const host::HubPacket& packet : site.hub.received()) {
    CHECK(packet.verdict == HubVerdict::accepted);
  }
  const auto hellos = hub_got<protocol::Hello>(site.hub, "gateway");
  REQUIRE(hellos.size() == 1);
  CHECK(hellos[0].settings_version == 0);        // none held before the first settings
  CHECK(hellos[0].firmware_version.major == 1);  // FW8
  CHECK(hellos[0].firmware_version.minor == 4);
  CHECK(hellos[0].firmware_version.patch == 2);
  const auto started = hub_got<protocol::Started>(site.hub, "gateway");
  REQUIRE(started.size() == 1);
  CHECK(started[0].role == protocol::Role::gateway);
  CHECK(started[0].firmware_version.minor == 4);
  CHECK(started[0].settings_version == 1);
  CHECK(gateway_of(gateway).state().connection.phase == ConnectionPhase::connected);
  // The settings are stored once.
  CHECK(gateway.board().storage.write_count(roles::gateway::kSettingsKey) == 1);
}

TEST_CASE("FW8 GW4 every connection has a new random value and the settings version held") {
  Site site(gateway_mode());
  host::SimDevice& gateway = add_gateway(site, "gateway");
  site.sim.run_until(at(seconds(3)));
  gateway.restart(at(seconds(4)));
  site.sim.run_until(at(seconds(8)));
  const auto hellos = hub_got<protocol::Hello>(site.hub, "gateway");
  REQUIRE(hellos.size() == 2);
  CHECK(hellos[0].gateway_random != hellos[1].gateway_random);
  // The second start holds the settings stored on the first, and stores nothing new.
  CHECK(hellos[1].settings_version == 1);
  CHECK(gateway.board().storage.write_count(roles::gateway::kSettingsKey) == 1);
  // Started once per start-up (§6).
  CHECK(hub_got<protocol::Started>(site.hub, "gateway").size() == 2);
}

TEST_CASE("USB Identify restarts an established USB session with a fresh hello") {
  host::Simulation sim;
  host::DeviceSpec spec;
  spec.name = "gateway";
  spec.role = gateway_role();
  host::SimDevice& gateway = sim.add_device(spec);
  host::provision(gateway.board(), gateway_pairing());
  LinkHub hub(sim, gateway, gateway_pairing());
  hub.auto_welcome = false;
  hub.attach(device::LinkKind::usb);
  sim.run_until(at(milliseconds(500)));
  REQUIRE(hub.hellos == 1);
  const auto first = hub.gateway_random;
  const Bytes identify{protocol::kSetupMarker, protocol::Identify::type};
  sim.schedule(at(milliseconds(500)), [&] { hub.send_raw(identify); });
  sim.run_until(at(milliseconds(750)));
  CHECK(hub.hellos == 1);
  CHECK(hub.gateway_random == first);

  sim.schedule(at(milliseconds(750)), [&] { hub.welcome(); });
  sim.run_until(at(seconds(1)));
  REQUIRE(gateway_of(gateway).state().connection.phase == ConnectionPhase::connected);
  const Bytes old_welcome = hub.last_welcome;
  sim.schedule(at(seconds(1)), [&] { hub.send_raw(identify); });
  sim.run_until(at(milliseconds(1250)));
  REQUIRE(hub.hellos == 2);
  CHECK(hub.gateway_random != first);
  CHECK(gateway_of(gateway).state().connection.phase == ConnectionPhase::awaiting_welcome);
  sim.schedule(at(milliseconds(1250)), [&] { hub.send_raw(old_welcome); });
  sim.run_until(at(milliseconds(1500)));
  CHECK(gateway_of(gateway).state().connection.phase == ConnectionPhase::awaiting_welcome);
  sim.schedule(at(milliseconds(1500)), [&] { hub.welcome(); });
  sim.run_until(at(milliseconds(1750)));
  CHECK(gateway_of(gateway).state().connection.phase == ConnectionPhase::connected);
}

TEST_CASE("USB Identify leaves an established Wi-Fi session alone") {
  host::Simulation sim;
  host::DeviceSpec spec;
  spec.name = "gateway";
  spec.role = gateway_role();
  host::SimDevice& gateway = sim.add_device(spec);
  host::provision(gateway.board(), gateway_pairing());
  LinkHub network(sim, gateway, gateway_pairing());
  network.attach(device::LinkKind::network);
  sim.run_until(at(seconds(3)));
  const auto& connection = gateway_of(gateway).state().connection;
  REQUIRE(connection.phase == ConnectionPhase::connected);
  REQUIRE(connection.link == device::LinkKind::network);
  const auto generation = connection.generation;

  LinkHub usb(sim, gateway, gateway_pairing());
  usb.attach(device::LinkKind::usb);
  sim.schedule(at(seconds(3)),
               [&] { usb.send_raw(Bytes{protocol::kSetupMarker, protocol::Identify::type}); });
  sim.run_until(at(milliseconds(3250)));
  CHECK(usb.hellos == 0);
  CHECK(connection.phase == ConnectionPhase::connected);
  CHECK(connection.link == device::LinkKind::network);
  CHECK(connection.generation == generation);
}

TEST_CASE("GW8 the network link is asked for the paired hub, network and password") {
  Site site(gateway_mode());
  host::SimDevice& gateway = add_gateway(site, "gateway");
  site.sim.run_until(at(seconds(1)));
  const device::LinkTarget& target = gateway.board().network.last_target;
  CHECK(target.hub == protocol::HubIdentity{9, 8, 7, 6, 5, 4, 3, 2});
  CHECK(std::string(target.wifi_name.begin(), target.wifi_name.end()) == "home");
  CHECK(std::string(target.wifi_password.begin(), target.wifi_password.end()) == "secret");
}

TEST_CASE("§4 a welcome bound to anything but the hello is refused, and the right one taken") {
  host::Simulation sim;
  host::DeviceSpec spec;
  spec.name = "gateway";
  spec.role = gateway_role();
  host::SimDevice& gateway = sim.add_device(spec);
  host::provision(gateway.board(), gateway_pairing());
  LinkHub hub(sim, gateway, gateway_pairing());
  hub.auto_welcome = false;
  hub.attach(device::LinkKind::network);
  sim.run_until(at(seconds(1)));
  REQUIRE(hub.hellos == 1);

  // Bound to another random value: refused.
  protocol::RandomValue other = hub.gateway_random;
  other[0] ^= 0x01;
  sim.schedule(at(seconds(1)), [&]() { hub.welcome(protocol::Binding::hello(other)); });
  sim.run_until(at(seconds(2)));
  CHECK(gateway_of(gateway).state().connection.phase == ConnectionPhase::awaiting_welcome);
  CHECK(gateway.services()->log.size() >= 1);

  // A packet of another type, even one bound to the hello, is not a welcome.
  sim.schedule(at(seconds(2)), [&]() {
    hub.send_raw(hub.seal(hub.settings, protocol::Binding::hello(hub.gateway_random)));
  });
  sim.run_until(at(seconds(3)));
  CHECK(gateway_of(gateway).state().connection.phase == ConnectionPhase::awaiting_welcome);

  // The right welcome, then the settings, then Started.
  sim.schedule(at(seconds(3)), [&]() {
    hub.welcome();
    hub.send(hub.settings);
  });
  sim.run_until(at(seconds(4)));
  CHECK(gateway_of(gateway).state().connection.phase == ConnectionPhase::connected);
  CHECK(hub.got(type::started).size() == 1);
  // The refusals were logged and reached the hub once connected (D110).
  bool refused_logged = false;
  for (const LinkHub::Got& got : hub.got(type::log_entries)) {
    protocol::LogEntries entries;
    REQUIRE(protocol::decode_body(protocol::ByteView(got.body.data(), got.body.size()), entries) ==
            protocol::Error::none);
    protocol::LogEntryReader reader(entries.entries);
    protocol::LogEntry entry;
    while (reader.next(entry)) {
      refused_logged =
          refused_logged || entry.code == roles::gateway::gateway_log::hub_packet_refused;
    }
  }
  CHECK(refused_logged);
}

TEST_CASE("§4 a welcome replayed from an earlier connection is refused") {
  host::Simulation sim;
  host::DeviceSpec spec;
  spec.name = "gateway";
  spec.role = gateway_role();
  host::SimDevice& gateway = sim.add_device(spec);
  host::provision(gateway.board(), gateway_pairing());
  LinkHub hub(sim, gateway, gateway_pairing());
  hub.attach(device::LinkKind::network);
  sim.run_until(at(seconds(2)));
  REQUIRE(gateway_of(gateway).state().connection.phase == ConnectionPhase::connected);
  const Bytes old_welcome = hub.last_welcome;
  const Bytes old_settings = hub.seal(hub.settings, hub.session_binding());

  // The link drops; the gateway reconnects with a new hello, and the recording is replayed.
  hub.auto_welcome = false;
  sim.schedule(at(seconds(2)), [&]() { gateway.wire(device::LinkKind::network).drop(); });
  sim.run_until(at(seconds(4)));
  REQUIRE(hub.hellos == 2);
  sim.schedule(at(seconds(4)), [&]() { hub.send_raw(old_welcome); });
  sim.run_until(at(seconds(5)));
  CHECK(gateway_of(gateway).state().connection.phase == ConnectionPhase::awaiting_welcome);

  // Welcomed properly, a packet bound to the earlier session is refused too.
  sim.schedule(at(seconds(5)), [&]() {
    hub.welcome();
    hub.send(hub.settings);
  });
  sim.run_until(at(seconds(6)));
  REQUIRE(gateway_of(gateway).state().connection.phase == ConnectionPhase::connected);
  const auto before = gateway_of(gateway).state().connection.session.last_accepted;
  sim.schedule(at(seconds(6)), [&]() { hub.send_raw(old_settings); });
  sim.run_until(at(seconds(7)));
  CHECK(gateway_of(gateway).state().connection.session.last_accepted == before);

  // And so is a packet of this session sent again: its counter is not higher.
  const Bytes request =
      hub.seal(hub.request(protocol::TransmitWhen::as_soon_as_possible, 0, opaque_packet(7, 9)),
               hub.session_binding());
  sim.schedule(at(seconds(7)), [&]() {
    hub.send_raw(request);
    hub.send_raw(request);
  });
  sim.run_until(at(seconds(8)));
  CHECK(transmitted(gateway).size() == 1);
  CHECK(hub.results().size() == 1);
}

TEST_CASE("FW7 a lost link is retried after 1, 2, 4, 8, 15, then every 30 s (§7)") {
  Site site(gateway_mode());
  host::SimDevice& gateway = add_gateway(site, "gateway");
  site.sim.run_until(at(seconds(3)));
  // The hub goes away: each try then fails after the link's 15 s without an answer.
  site.sim.schedule(at(seconds(3)), [&]() { gateway.wire(device::LinkKind::network).detach(); });
  site.sim.run_until(at(seconds(300)));
  const auto downs = link_records(gateway, RecordKind::link_down, device::LinkKind::network);
  REQUIRE(downs.size() >= 8);
  CHECK(downs[0].at == at(seconds(3)));
  const std::int64_t gaps[] = {1, 2, 4, 8, 15, 30, 30};
  for (std::size_t i = 0; i < 7; ++i) {
    INFO("failure " << i + 1);
    CHECK(downs[i + 1].at - downs[i].at == seconds(gaps[i] + 15));
  }
  // The hub returns: the next try is welcomed, and the schedule starts again from 1 s.
  const device::Instant back = downs.back().at + seconds(1);
  site.sim.schedule(
      back, [&]() { gateway.wire(device::LinkKind::network).attach(site.hub, milliseconds(25)); });
  site.sim.run_until(back + seconds(60));
  CHECK(gateway_of(gateway).state().connection.phase == ConnectionPhase::connected);
  CHECK(gateway_of(gateway).state().connection.failures == 0);
  const device::Instant dropped = site.sim.now();
  site.hub.drop_link("gateway", device::LinkKind::network);
  site.sim.run_until(dropped + seconds(3));
  const auto ups = link_records(gateway, RecordKind::link_up, device::LinkKind::network);
  REQUIRE_FALSE(ups.empty());
  CHECK(ups.back().at == dropped + seconds(1) + milliseconds(50));
}

TEST_CASE("§7 a hello that gets no welcome in 10 s is given up and retried with a new hello") {
  host::Simulation sim;
  host::DeviceSpec spec;
  spec.name = "gateway";
  spec.role = gateway_role();
  host::SimDevice& gateway = sim.add_device(spec);
  host::provision(gateway.board(), gateway_pairing());
  LinkHub hub(sim, gateway, gateway_pairing());
  hub.auto_welcome = false;
  hub.attach(device::LinkKind::network);
  sim.run_until(at(seconds(40)));
  const auto hellos = hub.got(type::hello);
  REQUIRE(hellos.size() >= 3);
  // Each wait is 10 s, then the back-off, then connecting again (50 ms there and back).
  CHECK(hellos[1].at - hellos[0].at == seconds(10 + 1) + milliseconds(50));
  CHECK(hellos[2].at - hellos[1].at == seconds(10 + 2) + milliseconds(50));
  CHECK(hellos[0].body != hellos[1].body);
  CHECK(gateway.board().network.disconnects >= 2);
}

TEST_CASE("GW10 D81 a computer that answers on USB is used, and Wi-Fi is not") {
  Site site(gateway_mode());
  host::GatewayConfig config;
  config.usb = true;
  config.network = true;
  host::SimDevice& gateway = add_gateway(site, "gateway", config);
  ScriptSensorLog sensor_log;
  host::SimDevice& door = site.sensor("door", ScriptSensorConfig{}, sensor_log);
  door.set_input(device::Input::door, true, at(seconds(5)));
  site.sim.run_until(at(seconds(70)));
  INFO(site.sim.timeline().select().dump());
  CHECK(gateway.board().network.connects == 0);
  CHECK(link_records(gateway, RecordKind::link_sent, device::LinkKind::network).empty());
  CHECK(gateway_of(gateway).state().connection.link == device::LinkKind::usb);
  // The door report went to the hub over USB and its reply came back.
  CHECK(site.hub.received_from("door", type::door_changed).size() == 1);
  CHECK(sensor_log.count(type::reply) == 1);
  const auto statuses = hub_got<protocol::GatewayStatus>(site.hub, "gateway");
  REQUIRE(statuses.size() == 2);
  CHECK(statuses[0].flags.usb_connected);
  CHECK(statuses[0].wifi_rssi_dbm == 0);
  // One hello: welcomed at once, no more hellos every 2 s.
  CHECK(hub_got<protocol::Hello>(site.hub, "gateway").size() == 1);
}

TEST_CASE("GW10 D81 with no computer attached the gateway uses Wi-Fi and never tries USB") {
  Site site(gateway_mode());
  host::SimDevice& gateway = add_gateway(site, "gateway");
  site.sim.run_until(at(seconds(125)));
  CHECK(gateway.board().usb.sent.empty());
  CHECK(gateway.board().usb.connects == 0);
  CHECK(gateway_of(gateway).state().connection.link == device::LinkKind::network);
  CHECK(hub_got<protocol::GatewayStatus>(site.hub, "gateway").size() == 4);
}

TEST_CASE("GW10 D81 hellos on USB every 2 s, Wi-Fi after 10 s without a welcome (§10)") {
  Site site(gateway_mode());
  host::SimDevice& gateway = add_gateway(site, "gateway");
  // A computer is attached, but nothing answers on it.
  gateway.board().gateway_io.host = true;
  site.sim.run_until(at(seconds(15)));
  const auto usb_hellos = link_records(gateway, RecordKind::link_sent, device::LinkKind::usb);
  REQUIRE(usb_hellos.size() == 5);
  for (std::size_t i = 0; i < usb_hellos.size(); ++i) {
    CHECK(usb_hellos[i].at == at(milliseconds(50)) + seconds(2 * static_cast<std::int64_t>(i)));
  }
  // At 10 s it turns to Wi-Fi, and is welcomed there.
  const auto network_sent = link_records(gateway, RecordKind::link_sent, device::LinkKind::network);
  REQUIRE_FALSE(network_sent.empty());
  CHECK(network_sent[0].label.type == type::hello);
  CHECK(network_sent[0].at == at(seconds(10) + milliseconds(100)));
  CHECK(gateway_of(gateway).state().connection.phase == ConnectionPhase::connected);
  CHECK(gateway_of(gateway).state().connection.link == device::LinkKind::network);
}

TEST_CASE("GW10 D81 on Wi-Fi, USB is tried every 30 s and used once it answers (§10)") {
  Site site(gateway_mode());
  host::SimDevice& gateway = add_gateway(site, "gateway");
  gateway.board().gateway_io.host = true;
  site.sim.run_until(at(seconds(20)));
  REQUIRE(gateway_of(gateway).state().connection.link == device::LinkKind::network);
  // Nobody answers at 30 s either; the hub is on the cable from 40 s.
  site.sim.schedule(at(seconds(40)), [&]() {
    gateway.wire(device::LinkKind::usb).attach(site.hub, milliseconds(25));
  });
  site.sim.run_until(at(seconds(80)));
  INFO(site.sim.timeline().select().dump());
  const auto usb_sent = link_records(gateway, RecordKind::link_sent, device::LinkKind::usb);
  // Five hellos from 0 s, five from 30 s, then one at 60 s that is welcomed.
  REQUIRE(usb_sent.size() >= 11);
  CHECK(usb_sent[5].at == at(seconds(30) + milliseconds(50)));
  CHECK(usb_sent[10].at == at(seconds(60) + milliseconds(50)));
  CHECK(usb_sent[10].label.type == type::hello);
  CHECK(gateway_of(gateway).state().connection.link == device::LinkKind::usb);
  CHECK(gateway_of(gateway).state().connection.phase == ConnectionPhase::connected);
  // USB only from then on: Wi-Fi is closed and carries nothing more.
  CHECK(gateway.board().network.disconnects >= 1);
  site.sim.run_until(at(seconds(200)));
  CHECK(link_records(gateway, RecordKind::link_sent, device::LinkKind::network).back().at <
        at(seconds(61)));
  const auto later = link_records(gateway, RecordKind::link_sent, device::LinkKind::usb);
  CHECK(later.size() == 11 + 4);
  CHECK(later.back().label.type == type::gateway_status);
  CHECK(gateway.board().network.connects == 1);
  // The hub heard the hello on Wi-Fi and the one on USB that it answered; Started went once.
  CHECK(hub_got<protocol::Hello>(site.hub, "gateway").size() == 2);
  CHECK(hub_got<protocol::Started>(site.hub, "gateway").size() == 1);
}

TEST_CASE("GW10 a USB connection that drops is tried again on USB first") {
  Site site(gateway_mode());
  host::GatewayConfig config;
  config.usb = true;
  config.network = true;
  host::SimDevice& gateway = add_gateway(site, "gateway", config);
  site.sim.run_until(at(seconds(5)));
  site.hub.drop_link("gateway", device::LinkKind::usb);
  site.sim.run_until(at(seconds(10)));
  CHECK(gateway.board().network.connects == 0);
  CHECK(gateway_of(gateway).state().connection.link == device::LinkKind::usb);
  CHECK(gateway_of(gateway).state().connection.phase == ConnectionPhase::connected);
  CHECK(site.hub.decisions(HubAction::gateway_welcomed, "gateway").size() == 2);
}

TEST_CASE("FW9 D101 the same packets go over USB and Wi-Fi") {
  for (const bool usb : {false, true}) {
    INFO((usb ? "USB" : "Wi-Fi"));
    Site site(gateway_mode());
    host::GatewayConfig config;
    config.usb = usb;
    config.network = !usb;
    host::SimDevice& gateway = add_gateway(site, "gateway", config);
    ScriptSensorLog sensor_log;
    host::SimDevice& door = site.sensor("door", ScriptSensorConfig{}, sensor_log);
    door.set_input(device::Input::door, true, at(seconds(5)));
    site.sim.run_until(at(seconds(10)));
    const auto forwarded = hub_got<protocol::ForwardedPacket>(site.hub, "gateway");
    REQUIRE(forwarded.size() == 1);
    CHECK(gateway.records().kind(RecordKind::link_sent).type_names() ==
          "hello, started, forwarded_packet, transmit_result");
    CHECK(sensor_log.count(type::reply) == 1);
  }
}

TEST_CASE("D97 the gateway is never silent 60 s while connected: a status every 30 s") {
  Site site(gateway_mode());
  host::SimDevice& gateway = add_gateway(site, "gateway");
  site.sim.run_until(at(seconds(600)));
  const auto sent = gateway.records().kind(RecordKind::link_sent).records();
  REQUIRE(sent.size() >= 20);
  for (std::size_t i = 1; i < sent.size(); ++i) {
    CHECK(sent[i].at - sent[i - 1].at <= seconds(30));
  }
  CHECK(sent.back().at > at(seconds(570)));
}

}  // namespace
}  // namespace hsn::test
