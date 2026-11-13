// The gateway's radio (§2, §6 forwarded packet, §7 "Reply timing and a busy gateway"; GW1, GW2,
// GW3, GW5, D71, D101, D108, O14): what it hears and forwards, what it counts and drops, that it
// is deaf while it sends, that it never cuts a reception off, and that it hears one data rate.

#include <algorithm>

#include "gateway_bench.hpp"
#include "hsn/roles/gateway/gateway_clock.hpp"

namespace hsn::test {
namespace {

using roles::gateway::clock_value;
using roles::gateway::RadioMode;
namespace gateway_log = roles::gateway::gateway_log;

/** The one transmission of a device, or the first. */
host::Record first_transmission(host::SimDevice& device) {
  const auto sent = device.records().kind(RecordKind::transmission).records();
  REQUIRE_FALSE(sent.empty());
  return sent[0];
}

/** The gateway's reception of a packet from `from`. */
host::Record reception_from(host::SimDevice& gateway, host::SimDevice& from) {
  const auto heard =
      gateway.records()
          .kind(RecordKind::reception)
          .where([&](const host::Record& record) { return record.peer == from.actor(); })
          .records();
  REQUIRE(heard.size() == 1);
  return heard[0];
}

TEST_CASE("GW1 GW2 GW5 D101 a heard packet is forwarded unchanged, with when and how it came") {
  Site site(gateway_mode());
  // A gateway clock 150 ppm fast: the arrival time is on its own clock (§6).
  host::SimDevice& gateway = add_gateway(site, "gateway", {}, 150);
  ScriptSensorLog near_log;
  ScriptSensorLog far_log;
  host::SimDevice& near = site.sensor("near", ScriptSensorConfig{}, near_log);
  host::SimDevice& far = site.sensor("far", ScriptSensorConfig{}, far_log);
  site.sim.medium().set_path_loss(near.station(), gateway.station(), 90);
  site.sim.medium().set_path_loss(far.station(), gateway.station(), 125);
  near.set_input(device::Input::door, true, at(seconds(5)));
  far.set_input(device::Input::door, true, at(seconds(8)));
  site.sim.run_until(at(seconds(12)));
  INFO(site.sim.timeline().select().dump());

  // Listening continuously on the site channel at the settings' rate (GW1).
  const device::RxParams& rx = gateway.board().radio.rx_params();
  CHECK(rx.timeout == device::Duration{});
  CHECK(rx.channel.frequency_hz == 868300000u);
  CHECK(rx.channel.data_rate == 5);

  const auto forwarded = forwarded_by(site.hub, "gateway");
  REQUIRE(forwarded.size() == 2);
  host::SimDevice* senders[] = {&near, &far};
  for (std::size_t i = 0; i < 2; ++i) {
    host::SimDevice& sensor = *senders[i];
    INFO(sensor.name());
    const host::Record sent = first_transmission(sensor);
    const host::Record heard = reception_from(gateway, sensor);
    // The device packet as it was sent: the gateway cannot read or change it (D71, D101).
    CHECK(forwarded[i].packet == transmitted(sensor)[0]);
    CHECK(forwarded[i].meta.received_at_micros == clock_value(gateway.clock().local(sent.until)));
    CHECK(forwarded[i].meta.rssi_dbm == heard.rssi_dbm);
    CHECK(forwarded[i].meta.snr_quarter_db == heard.snr_quarter_db);
    CHECK(forwarded[i].meta.data_rate == 5);
    CHECK(forwarded[i].meta.site_channel == 1);
  }
  // Signal strength per device, for placement (GW5).
  CHECK(forwarded[0].meta.rssi_dbm == 14 - 90);
  CHECK(forwarded[1].meta.rssi_dbm == 14 - 125);
  // Both reports were answered through the gateway (GW2).
  CHECK(near_log.count(type::reply) == 1);
  CHECK(far_log.count(type::reply) == 1);
}

TEST_CASE("GW3 D71 the gateway forwards what it cannot read and never answers by itself") {
  LinkSite site;
  ScriptSensorLog sensor_log;
  host::SimDevice& door =
      add_lone_sensor(site.sim, "door", ScriptSensorConfig{}, sensor_log, 0x0D00F001);
  door.set_input(device::Input::door, true, at(seconds(5)));
  door.set_input(device::Input::door, false, at(seconds(9)));
  // Twenty bytes that are no packet of anyone's: forwarded all the same.
  Bytes noise(20, 0x5A);
  add_talker(site.sim, "stranger", {Burst{at(seconds(12)), noise}});
  site.sim.run_until(at(seconds(60)));

  const auto forwarded = site.hub.forwarded();
  REQUIRE(forwarded.size() == 3);
  CHECK(forwarded[0].packet == transmitted(door)[0]);
  CHECK(forwarded[1].packet == transmitted(door)[1]);
  CHECK(forwarded[2].packet == noise);
  // The sensor asked for replies, but only the hub answers, and it did not ask.
  CHECK(transmitted(site.gateway).empty());
  CHECK(sensor_log.heard.empty());
}

TEST_CASE("GW1 short and CRC-failed packets are counted, and not forwarded (§6)") {
  LinkSite site;
  const Bytes short_packet(10, 0x11);
  const Bytes almost(17, 0x22);
  const Bytes smallest(18, 0x33);
  const Bytes clash(30, 0x44);
  add_talker(site.sim, "one",
             {Burst{at(seconds(5)), short_packet}, Burst{at(seconds(10)), clash},
              Burst{at(seconds(15)), almost}, Burst{at(seconds(20)), smallest}});
  // Sends at the same instant as "one": both are lost at the gateway, which saw a header.
  add_talker(site.sim, "two", {Burst{at(seconds(10)), clash}});
  site.sim.run_until(at(seconds(35)));
  INFO(site.sim.timeline().select().dump());

  const auto forwarded = site.hub.forwarded();
  REQUIRE(forwarded.size() == 1);
  CHECK(forwarded[0].packet == smallest);
  const auto statuses = site.hub.statuses();
  REQUIRE(statuses.size() == 1);
  CHECK(statuses[0].packets_received == 3);
  CHECK(statuses[0].packets_crc_failed == 1);
  // Short packets are counted as received, but are not heard packets to forward.
  CHECK(gateway_of(site.gateway).counts().heard == 1);
  CHECK(gateway_of(site.gateway).counts().forwards_lost == 0);
}

TEST_CASE("GW2 the gateway is deaf while it sends: shown from the sensor's side (§7)") {
  LinkSite site;
  ScriptSensorLog sensor_log;
  host::SimDevice& door =
      add_lone_sensor(site.sim, "door", ScriptSensorConfig{}, sensor_log, 0x0D00F002);
  // A siren command at SF12 holds the radio for about 1.5 s from 5 s.
  site.sim.schedule(at(seconds(5)), [&]() {
    site.hub.send_request(site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0,
                                           opaque_packet(0x5151, 3), 0,
                                           protocol::TransmitPriority::siren_command));
  });
  // The door opens while it sends, and closes after.
  door.set_input(device::Input::door, true, at(seconds(5) + milliseconds(500)));
  door.set_input(device::Input::door, false, at(seconds(9)));
  site.sim.run_until(at(seconds(12)));
  INFO(site.sim.timeline().select().dump());

  const auto gateway_sent = site.gateway.records().kind(RecordKind::transmission).records();
  REQUIRE(gateway_sent.size() == 1);
  const auto door_sent = door.records().kind(RecordKind::transmission).records();
  REQUIRE(door_sent.size() == 2);
  // The sensor sent while the gateway was on the air, on the other frequency...
  CHECK(door_sent[0].from > gateway_sent[0].from);
  CHECK(door_sent[0].until < gateway_sent[0].until);
  // ...and that packet never reached the hub; the one after did.
  const auto forwarded = site.hub.forwarded();
  REQUIRE(forwarded.size() == 1);
  CHECK(counter_in(forwarded[0].packet) == sensor_log.sent[1]);
  CHECK(site.gateway.records().kind(RecordKind::reception).count() == 1);
  // No noise was sampled while it sent: a deaf radio has no noise reading (GW11).
  const auto codes = site.hub.log_codes();
  CHECK(std::count(codes.begin(), codes.end(), gateway_log::radio_call_failed) == 0);
  for (const host::RadioCall& call :
       site.gateway.board().radio.calls_of(host::RadioCall::Kind::noise)) {
    CHECK(call.result == device::HalError::none);
  }
}

TEST_CASE("§7 receiving comes first: a fixed moment inside a reception is skipped, ASAP waits") {
  LinkSite site(0x01);
  ScriptSensorLog sensor_log;
  ScriptSensorConfig slow;
  slow.send_data_rate = 0;
  host::SimDevice& door = add_lone_sensor(site.sim, "door", slow, sensor_log, 0x0D00F003);
  door.set_input(device::Input::door, true, at(seconds(5)));
  site.sim.run_until(at(seconds(5) + milliseconds(300)));
  const host::Record sent = first_transmission(door);
  std::uint32_t timed = 0;
  std::uint32_t asap = 0;
  // Once its header is in, the hub asks for a send in the middle of it, and one as soon as can be.
  const device::Instant ask = sent.from + milliseconds(700);
  site.sim.schedule(ask, [&]() {
    REQUIRE(gateway_of(site.gateway).state().radio.mode == RadioMode::receiving);
    const std::uint32_t moment =
        clock_value(site.gateway.clock().local(sent.until) + milliseconds(-300));
    timed = site.hub.send_request(
        site.hub.request(protocol::TransmitWhen::at_time, moment, opaque_packet(0x99, 1)));
    asap = site.hub.send_request(
        site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0, opaque_packet(0x99, 2)));
  });
  site.sim.run_until(at(seconds(10)));
  INFO(site.sim.timeline().select().dump());

  REQUIRE(site.hub.result_for(timed).has_value());
  CHECK(site.hub.result_for(timed)->result == protocol::TransmitOutcome::radio_busy);
  REQUIRE(site.hub.result_for(asap).has_value());
  CHECK(site.hub.result_for(asap)->result == protocol::TransmitOutcome::sent);
  // The reception was not cut off: the packet was forwarded, and the send came after its end.
  REQUIRE(site.hub.forwarded().size() == 1);
  const auto gateway_sent = site.gateway.records().kind(RecordKind::transmission).records();
  REQUIRE(gateway_sent.size() == 1);
  CHECK(gateway_sent[0].from == sent.until);
  CHECK(transmitted(site.gateway)[0] == opaque_packet(0x99, 2));
}

TEST_CASE("§7 new settings during a reception take effect once it has ended") {
  LinkSite site(0x01);
  ScriptSensorLog sensor_log;
  ScriptSensorConfig slow;
  slow.send_data_rate = 0;
  host::SimDevice& door = add_lone_sensor(site.sim, "door", slow, sensor_log, 0x0D00F004);
  door.set_input(device::Input::door, true, at(seconds(5)));
  site.sim.run_until(at(seconds(5) + milliseconds(300)));
  const host::Record sent = first_transmission(door);
  site.sim.schedule(sent.from + milliseconds(700), [&]() {
    protocol::GatewaySettings faster = site.hub.settings;
    faster.settings_version = 2;
    faster.listen_data_rate_mask = 0x20;
    site.hub.send(faster);
  });
  site.sim.run_until(at(seconds(10)));
  const auto receives = site.gateway.board().radio.calls_of(host::RadioCall::Kind::receive);
  REQUIRE(receives.size() >= 2);
  // No receive was started during the packet; the next one is at its end, at the new rate.
  CHECK(receives.back().at == site.gateway.clock().local(sent.until));
  CHECK(receives.back().channel.data_rate == 5);
  CHECK(receives[receives.size() - 2].at < sent.from);
  CHECK(site.hub.forwarded().size() == 1);
}

TEST_CASE("O14 settings naming several data rates: the slowest is heard, and a warning logged") {
  host::HubOptions options = gateway_mode();
  options.site_channel = 2;  // 868.5 MHz
  Site site(options);
  host::GatewayConfig config;
  config.listen_data_rate_mask = 0x24;  // DR2 and DR5
  host::SimDevice& gateway = add_gateway(site, "gateway", config);
  ScriptSensorLog fast_log;
  ScriptSensorLog slow_log;
  ScriptSensorConfig slow;
  slow.send_data_rate = 2;
  host::SimDevice& fast = site.sensor("fast", ScriptSensorConfig{}, fast_log);
  host::SensorConfig slow_settings;
  slow_settings.send_data_rate = 2;
  slow_settings.reply_data_rate = 2;
  host::SimDevice& slow_door = site.sensor("slow", slow, slow_log, slow_settings);
  fast.set_input(device::Input::door, true, at(seconds(5)));
  slow_door.set_input(device::Input::door, true, at(seconds(10)));
  site.sim.run_until(at(seconds(20)));

  CHECK(gateway.board().radio.rx_params().channel.data_rate == 2);
  CHECK(gateway.board().radio.rx_params().channel.frequency_hz == 868500000u);
  CHECK(site.hub.received_from("fast").empty());
  CHECK(site.hub.received_from("slow", type::door_changed).size() == 1);
  // The forwarded packet names the rate and channel it was heard on.
  const auto forwarded = forwarded_by(site.hub, "gateway");
  REQUIRE(forwarded.size() == 1);
  CHECK(forwarded[0].meta.data_rate == 2);
  CHECK(forwarded[0].meta.site_channel == 2);
  bool warned = false;
  for (const host::HubLogEntry& entry : site.hub.log_entries_from("gateway")) {
    warned = warned || (entry.code == gateway_log::several_data_rates &&
                        entry.level == static_cast<std::uint8_t>(device::LogLevel::warning));
  }
  CHECK(warned);
}

TEST_CASE("§3 settings with an unlisted channel or data rate keep the current ones") {
  LinkSite site;
  site.sim.run_until(at(seconds(2)));
  site.sim.schedule(at(seconds(2)), [&]() {
    protocol::GatewaySettings odd = site.hub.settings;
    odd.settings_version = 2;
    odd.site_channel = 7;
    odd.listen_data_rate_mask = 0xC0;
    site.hub.send(odd);
  });
  site.sim.run_until(at(seconds(3)));
  const device::RxParams& rx = site.gateway.board().radio.rx_params();
  CHECK(rx.channel.frequency_hz == 868300000u);
  CHECK(rx.channel.data_rate == 5);
  CHECK(gateway_of(site.gateway).state().settings.version == 2);
  // The settings held keep the channel and rates in use, and are stored so.
  CHECK(gateway_of(site.gateway).state().settings.site_channel == 1);
  CHECK(gateway_of(site.gateway).state().settings.listen_data_rate_mask == 0x20);
  const auto codes = site.hub.log_codes();
  CHECK(std::count(codes.begin(), codes.end(), gateway_log::unknown_channel) == 1);
  CHECK(std::count(codes.begin(), codes.end(), gateway_log::unknown_data_rate) == 1);
}

TEST_CASE("D108 a request is sent at its data rate and power, then the gateway listens again") {
  LinkSite site;
  std::uint32_t loud = 0;
  site.sim.schedule(at(seconds(3)), [&]() {
    site.hub.send_request(site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0,
                                           opaque_packet(1, 1), 3,
                                           protocol::TransmitPriority::normal, 20));
  });
  site.sim.schedule(at(seconds(5)), [&]() {
    loud = site.hub.send_request(site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0,
                                                  opaque_packet(1, 2), 5,
                                                  protocol::TransmitPriority::normal, 30));
  });
  site.sim.run_until(at(seconds(7)));
  const auto sends = site.gateway.board().radio.calls_of(host::RadioCall::Kind::transmit);
  REQUIRE(sends.size() == 2);
  CHECK(sends[0].channel.frequency_hz == 869525000u);
  CHECK(sends[0].channel.data_rate == 3);
  CHECK(sends[0].power_dbm == 20);
  // Never above the radio's +22 dBm (§2).
  CHECK(sends[1].power_dbm == 22);
  CHECK(site.hub.result_for(loud)->result == protocol::TransmitOutcome::sent);
  // Straight back to listening on the site channel when each send ends.
  const auto sent = site.gateway.records().kind(RecordKind::transmission).records();
  const auto windows = site.gateway.records().kind(RecordKind::rx_window).records();
  for (const host::Record& transmission : sent) {
    bool resumed = false;
    for (const host::Record& window : windows) {
      resumed = resumed || window.at == transmission.until;
    }
    CHECK(resumed);
  }
  CHECK(site.gateway.board().radio.rx_params().channel.frequency_hz == 868300000u);
}

}  // namespace
}  // namespace hsn::test
