// The test hub's rules, each run in both modes: with its own ideal radio, and through a scripted
// gateway. Heartbeat replies and settings versions, event replies, countdowns, late reports,
// disarmed notices, siren commands and settings on both paths. Protocol sections 4, 6, 7 and 8.
// The gateway's own handshake and requests are in test_hub_gateway_test.cpp.

#include <limits>

#include "host/sim_support.hpp"

namespace hsn::test {
namespace {

using host::HubAction;
using host::HubMode;
using host::HubPath;
namespace type = protocol::message_type;

/** The path radio packets take in a mode. */
HubPath radio_path(HubMode mode) {
  return mode == HubMode::direct_radio ? HubPath::radio : HubPath::gateway;
}

/** A sensor that sends heartbeats every minute and asks for a reply on every third. */
ScriptSensorConfig heartbeats_every_minute() {
  ScriptSensorConfig config;
  config.heartbeat_every = seconds(60);
  config.link_check_every = 3;
  return config;
}

/** Every reply that went on the air, by the hub's radio or a gateway. */
std::vector<host::Record> replies_on_air(Site& site) {
  return site.sim.timeline().select().kind(RecordKind::transmission).type(type::reply).records();
}

TEST_CASE("heartbeats are answered only on a version mismatch or when asked, at the reply moment") {
  for (const HubMode mode : kBothModes) {
    INFO("mode: " << mode_name(mode));
    Site site(hub_options(mode));
    site.add_mode_gateway();
    ScriptSensorLog log;
    host::SimDevice& door = site.sensor("door", heartbeats_every_minute(), log);
    CHECK(site.hub.settings_version("door") == 1);
    // Heartbeats at 60, 120, 180 s and on; arming at 200 s and new settings at 250 s change the
    // version, which the 4th and 5th heartbeats then do not hold.
    site.sim.schedule(at(seconds(200)), [&]() { site.hub.arm(); });
    site.sim.schedule(at(seconds(250)), [&]() {
      host::SensorConfig settings;
      settings.countdown_seconds = 45;
      site.hub.change_sensor("door", settings);
    });
    site.sim.run_until(at(seconds(370)));
    CHECK(site.hub.settings_version("door") == 3);

    const auto heartbeats = door.records().kind(RecordKind::transmission).records();
    REQUIRE(heartbeats.size() == 6);
    CHECK(door.records().kind(RecordKind::transmission).type_names() ==
          "heartbeat, heartbeat, heartbeat, heartbeat, heartbeat, heartbeat");
    // 1st: version 0 against 1. 2nd: nothing to say. 3rd: asked. 4th, 5th: the version changed.
    // 6th: asked.
    const std::size_t answered[] = {0, 2, 3, 4, 5};
    const auto on_air = replies_on_air(site);
    REQUIRE(on_air.size() == 5);
    const auto sent = site.hub.sent_to("door", type::reply);
    REQUIRE(sent.size() == 5);
    for (std::size_t i = 0; i < on_air.size(); ++i) {
      INFO("reply " << i);
      // Exactly the reply moment after the heartbeat ended (protocol section 8).
      CHECK(on_air[i].from == heartbeats[answered[i]].until + seconds(1));
      CHECK(sent[i].path == radio_path(mode));
    }
    REQUIRE(log.heard.size() == 5);
    for (std::size_t i = 0; i < log.heard.size(); ++i) {
      CHECK(log.heard[i].answered == log.sent[answered[i]]);
    }
    CHECK(log.heard[0].reply.settings_version == 1);
    CHECK_FALSE(log.heard[0].reply.flags.armed);
    CHECK(log.heard[2].reply.settings_version == 2);
    CHECK(log.heard[2].reply.flags.armed);
    CHECK(log.heard[3].reply.settings_version == 3);
    CHECK(log.heard[3].reply.countdown_seconds == 45);
  }
}

TEST_CASE("a heartbeat reply is skipped when the radio is busy at the reply moment") {
  for (const HubMode mode : kBothModes) {
    INFO("mode: " << mode_name(mode));
    Site site(hub_options(mode));
    site.add_mode_gateway();
    ScriptSensorLog sensor_log;
    ScriptSirenLog siren_log;
    ScriptSirenConfig slow;
    slow.command_data_rate = 0;
    host::SirenConfig settings;
    settings.command_data_rate = 0;
    site.sensor("door", heartbeats_every_minute(), sensor_log);
    site.siren("siren", slow, siren_log, settings);
    // The first heartbeat ends at 60.115 s; a siren command at SF12 holds the radio from 60.6 s
    // to past 62 s, over the reply moment at 61.115 s.
    site.sim.schedule(at(seconds(60)) + milliseconds(600),
                      [&]() { site.hub.command_siren("siren", protocol::SirenAction::test, 5); });
    site.sim.run_until(at(seconds(63)));
    if (mode == HubMode::direct_radio) {
      CHECK(site.hub.decisions(HubAction::reply_skipped, "door").size() == 1);
    } else {
      // The gateway decides, and says so in its transmit result.
      const auto results = site.hub.decisions(HubAction::transmit_result, "door");
      REQUIRE(results.size() == 1);
      CHECK(results[0].value == protocol::TransmitOutcome::radio_busy);
    }
    CHECK(sensor_log.heard.empty());
  }
}

TEST_CASE("event reports are answered as soon as possible, bound to the report") {
  for (const HubMode mode : kBothModes) {
    INFO("mode: " << mode_name(mode));
    SUBCASE("a door report, disarmed") {
      Site site(hub_options(mode));
      site.add_mode_gateway();
      ScriptSensorLog log;
      host::SimDevice& door = site.sensor("door", ScriptSensorConfig{}, log);
      door.set_input(device::Input::door, true, at(seconds(10)));
      site.sim.run_until(at(seconds(15)));
      const auto report = door.records().kind(RecordKind::transmission).records();
      REQUIRE(report.size() == 1);
      CHECK(report[0].label.type == type::door_changed);
      // 50 ms after the report ended: the hub's processing, or the two link hops.
      const auto on_air = replies_on_air(site);
      REQUIRE(on_air.size() == 1);
      CHECK(on_air[0].from == report[0].until + milliseconds(50));
      REQUIRE(log.heard.size() == 1);
      CHECK(log.heard[0].answered == log.sent[0]);
      CHECK_FALSE(log.heard[0].reply.flags.armed);
      CHECK_FALSE(log.heard[0].reply.flags.countdown_started);
      CHECK(site.hub.decisions(HubAction::report_while_disarmed, "door").size() == 1);
      CHECK(site.hub.received_from("door", type::door_changed).size() == 1);
    }
    SUBCASE("Started is always answered") {
      Site site(hub_options(mode));
      site.add_mode_gateway();
      ScriptSensorLog log;
      ScriptSensorConfig config;
      config.send_started = true;
      // After the gateway is connected.
      host::DeviceSpec spec;
      spec.name = "door";
      spec.role = script_sensor(config, log);
      spec.power_on = at(seconds(1));
      site.hub.add_sensor(site.sim.add_device(spec));
      site.sim.run_until(at(seconds(5)));
      REQUIRE(log.heard.size() == 1);
      CHECK(log.heard[0].type == type::reply);
      CHECK(log.heard[0].answered == log.sent[0]);
    }
    SUBCASE("a reply that cannot start while the sensor still listens is not sent") {
      host::HubOptions options = hub_options(mode);
      options.processing = seconds(2);
      options.link_latency = seconds(1);
      Site site(options);
      site.add_mode_gateway();
      ScriptSensorLog log;
      host::SimDevice& door = site.sensor("door", ScriptSensorConfig{}, log);
      door.set_input(device::Input::door, true, at(seconds(10)));
      site.sim.run_until(at(seconds(15)));
      if (mode == HubMode::direct_radio) {
        CHECK(site.hub.decisions(HubAction::too_late, "door").size() == 1);
      } else {
        const auto results = site.hub.decisions(HubAction::transmit_result, "door");
        REQUIRE(results.size() == 1);
        CHECK(results[0].value == protocol::TransmitOutcome::too_late);
      }
      CHECK(replies_on_air(site).empty());
      CHECK(log.heard.empty());
    }
  }
}

TEST_CASE("each sensor has its own countdown, and disarming sends the notice twice") {
  for (const HubMode mode : kBothModes) {
    INFO("mode: " << mode_name(mode));
    Site site(hub_options(mode));
    site.add_mode_gateway();
    ScriptSensorLog front_log;
    ScriptSensorLog back_log;
    host::SensorConfig front_settings;
    front_settings.countdown_seconds = 30;
    host::SensorConfig back_settings;
    back_settings.countdown_seconds = 20;
    host::SimDevice& front = site.sensor("front", ScriptSensorConfig{}, front_log, front_settings);
    host::SimDevice& back = site.sensor("back", ScriptSensorConfig{}, back_log, back_settings);
    site.hub.arm();
    front.set_input(device::Input::door, true, at(seconds(10)));
    back.set_input(device::Input::door, true, at(seconds(12)));
    site.sim.run_until(at(seconds(25)));

    const auto started = site.hub.decisions(HubAction::countdown_started);
    REQUIRE(started.size() == 2);
    CHECK(started[0].device == "front");
    CHECK(started[0].value == 30);
    CHECK(started[1].device == "back");
    CHECK(started[1].value == 20);
    REQUIRE(front_log.heard.size() == 1);
    CHECK(front_log.heard[0].reply.flags.countdown_started);
    CHECK(front_log.heard[0].reply.countdown_remaining_seconds == 30);
    REQUIRE(back_log.heard.size() == 1);
    CHECK(back_log.heard[0].reply.countdown_remaining_seconds == 20);
    CHECK(site.hub.countdown_running("front"));

    site.hub.disarm();
    site.sim.run_until(at(seconds(60)));
    for (const auto* name : {"front", "back"}) {
      INFO(name);
      const auto notices = site.hub.decisions(HubAction::disarmed_notice, name);
      REQUIRE(notices.size() == 2);
      CHECK(notices[0].at == at(seconds(25)));
      CHECK(notices[1].at == at(seconds(27)));
      CHECK(site.hub.sent_to(name, type::disarmed_notice).size() == 2);
      CHECK_FALSE(site.hub.countdown_running(name));
    }
    // Each notice is bound to that sensor's report; the sensor stops listening after the first.
    CHECK(site.hub.decisions(HubAction::disarmed_notice, "front")[0].value == front_log.sent[0]);
    CHECK(front_log.count(type::disarmed_notice) == 1);
    CHECK(back_log.count(type::disarmed_notice) == 1);
    CHECK(back_log.heard.back().answered == back_log.sent[0]);
    CHECK(site.hub.decisions(HubAction::alarm).empty());
  }
}

TEST_CASE("a countdown that ends sounds the sirens on both paths until a report confirms it") {
  for (const HubMode mode : kBothModes) {
    INFO("mode: " << mode_name(mode));
    host::HubOptions options = hub_options(mode);
    Site site(options);
    site.add_mode_gateway();
    ScriptSensorLog sensor_log;
    ScriptSirenLog siren_log;
    host::SensorConfig settings;
    settings.countdown_seconds = 20;
    host::SimDevice& door = site.sensor("door", ScriptSensorConfig{}, sensor_log, settings);
    host::SimDevice& siren = site.siren("siren", ScriptSirenConfig{}, siren_log);
    site.hub.arm();
    door.set_input(device::Input::door, true, at(seconds(10)));
    site.sim.run_until(at(seconds(45)));

    // The countdown ends 20 s after the report ended (its age was 0), as the hub knows that end:
    // exactly from its own radio, on arrival through a gateway.
    const auto report = door.records().kind(RecordKind::transmission).records();
    REQUIRE(report.size() == 1);
    const device::Duration known_late =
        mode == HubMode::direct_radio ? device::Duration{} : options.link_latency;
    const auto alarm = site.hub.decisions(HubAction::alarm, "door");
    REQUIRE(alarm.size() == 1);
    CHECK(alarm[0].at == report[0].until + seconds(20) + known_late);
    // The same command on Wi-Fi and LoRa: the siren acts on the first copy and drops the second
    // by its counter. The second is a repeat of the latest, or too old when the settings the hub
    // sends after the siren's first report (it held none) arrived by Wi-Fi before it.
    const auto commands = site.hub.sent_to("siren", type::siren_command);
    REQUIRE(commands.size() == 2);
    CHECK(commands[0].path == HubPath::link);
    CHECK(commands[1].path == radio_path(mode));
    CHECK(commands[0].counter == commands[1].counter);
    REQUIRE_FALSE(siren_log.commands.empty());
    const ScriptSirenLog::Command first = siren_log.commands[0];
    CHECK(first.by_wifi);
    CHECK(first.verdict == device::CommandVerdict::new_command);
    CHECK(first.action == protocol::SirenAction::sound_alarm);
    CHECK(first.seconds == 180);
    std::size_t lora_copies = 0;
    for (const ScriptSirenLog::Command& command : siren_log.commands) {
      if (!command.by_wifi && command.counter == first.counter) {
        lora_copies += 1;
        CHECK(command.verdict != device::CommandVerdict::new_command);
      }
    }
    CHECK(lora_copies == 1);
    CHECK(site.hub.decisions(HubAction::siren_confirmed, "siren").size() >= 1);
    CHECK(siren.board().siren_io.output_state);
    CHECK(siren.records().kind(RecordKind::output).count() == 1);

    // Disarming stops the sirens.
    site.hub.disarm();
    site.sim.run_until(at(seconds(60)));
    CHECK_FALSE(siren.board().siren_io.output_state);
    const auto outputs = siren.records().kind(RecordKind::output).records();
    REQUIRE(outputs.size() == 2);
    CHECK_FALSE(outputs[1].flag);
  }
}

TEST_CASE("an unconfirmed siren command repeats every 2 s on Wi-Fi and 5 s on LoRa for a minute") {
  for (const HubMode mode : kBothModes) {
    INFO("mode: " << mode_name(mode));
    Site site(hub_options(mode));
    site.add_mode_gateway();
    ScriptSirenLog log;
    host::SimDevice& siren = site.siren("siren", ScriptSirenConfig{}, log);
    // The siren hears everything, but none of its reports get through.
    siren.board().network.refuse_sends = true;
    site.sim.medium().set_path_loss_one_way(siren.station(), site.hub_ear(),
                                            std::numeric_limits<double>::infinity());
    site.sim.schedule(at(seconds(5)),
                      [&]() { site.hub.command_siren("siren", protocol::SirenAction::test, 10); });
    site.sim.run_until(at(seconds(90)));

    std::size_t by_wifi = 0;
    std::size_t by_lora = 0;
    for (const host::HubSent& sent : site.hub.sent_to("siren", type::siren_command)) {
      by_wifi += sent.path == HubPath::link ? 1u : 0u;
      by_lora += sent.path == radio_path(mode) ? 1u : 0u;
    }
    // Wi-Fi at 5, 7, …, 63 s; LoRa at 5, 10, …, 60 s; then the warning at 65 s.
    CHECK(by_wifi == 30);
    CHECK(by_lora == 12);
    const auto unreachable = site.hub.decisions(HubAction::siren_unreachable, "siren");
    REQUIRE(unreachable.size() == 1);
    CHECK(unreachable[0].at == at(seconds(65)));
    // The siren acted once and answered every repeat, which never arrived.
    CHECK(log.count(device::CommandVerdict::new_command) == 1);
    CHECK(log.count(device::CommandVerdict::repeat_of_latest) == 41);
  }
}

TEST_CASE("siren settings go on both paths at the rate the siren holds, until confirmed") {
  for (const HubMode mode : kBothModes) {
    INFO("mode: " << mode_name(mode));
    Site site(hub_options(mode));
    site.add_mode_gateway();
    ScriptSirenLog log;
    site.siren("siren", ScriptSirenConfig{}, log);
    site.sim.schedule(at(seconds(5)), [&]() {
      host::SirenConfig settings;
      settings.command_data_rate = 4;
      settings.max_sound_seconds = 120;
      site.hub.change_siren("siren", settings);
    });
    site.sim.run_until(at(seconds(20)));
    CHECK(site.hub.settings_version("siren") == 2);
    CHECK(log.settings_version == 2);
    const auto sent = site.hub.sent_to("siren", type::siren_settings);
    REQUIRE(sent.size() == 2);
    // On LoRa at DR5, the rate the siren held, not the DR4 the settings bring.
    CHECK(sent[1].path == radio_path(mode));
    CHECK(sent[1].data_rate == 5);
    CHECK(site.hub.decisions(HubAction::siren_confirmed, "siren").size() == 1);
  }
}

TEST_CASE("replies go at the rate the sensor listens at: its held version's, or bit 7's") {
  for (const HubMode mode : kBothModes) {
    INFO("mode: " << mode_name(mode));
    Site site(hub_options(mode));
    site.add_mode_gateway(3);
    ScriptSensorLog log;
    ScriptSensorConfig config;
    config.send_data_rate = 3;
    config.heartbeat_every = seconds(60);
    config.link_check_every = 1;
    config.fall_back_at_heartbeat = 2;
    host::SensorConfig settings;
    settings.send_data_rate = 3;
    settings.reply_data_rate = 5;
    host::SimDevice& door = site.sensor("door", config, log, settings);
    // New settings at 200 s bring reply rate DR4, which the sensor holds only after a reply.
    site.sim.schedule(at(seconds(200)), [&]() {
      host::SensorConfig faster = settings;
      faster.reply_data_rate = 4;
      site.hub.change_sensor("door", faster);
    });
    site.sim.run_until(at(seconds(310)));
    static_cast<void>(door);

    // 1st: no settings held, its own rate. 2nd: fallen back, bit 7, the rate it arrived at. 3rd:
    // back on version 1's reply rate. 4th: still holding version 1. 5th: holding version 2.
    std::vector<int> rates;
    for (const host::HubSent& sent : site.hub.sent_to("door", type::reply)) {
      rates.push_back(sent.data_rate);
    }
    CHECK(rates == std::vector<int>{3, 3, 5, 5, 4});
    const auto heartbeats = site.hub.received_from("door", type::heartbeat);
    REQUIRE(heartbeats.size() == 5);
    CHECK_FALSE(heartbeats[0].as<protocol::Heartbeat>().flags.listening_at_send_rate);
    CHECK(heartbeats[1].as<protocol::Heartbeat>().flags.listening_at_send_rate);
    CHECK_FALSE(heartbeats[2].as<protocol::Heartbeat>().flags.listening_at_send_rate);
    // Every reply was heard, so every one went at the rate the sensor was listening at.
    CHECK(log.heard.size() == 5);
  }
}

/** A siren whose reports cannot reach the hub until `unblock` is called. */
struct BlockedSiren {
  BlockedSiren(Site& site_in, const ScriptSirenConfig& config = {},
               const host::SirenConfig& settings = {})
      : site(site_in), device(site.siren("siren", config, log, settings)) {
    device.board().network.refuse_sends = true;
    site.sim.medium().set_path_loss_one_way(device.station(), site.hub_ear(),
                                            std::numeric_limits<double>::infinity());
  }

  void unblock() {
    device.board().network.refuse_sends = false;
    site.sim.medium().set_path_loss_one_way(device.station(), site.hub_ear(), 100.0);
  }

  Site& site;
  ScriptSirenLog log;
  host::SimDevice& device;
};

TEST_CASE("one at a time: settings wait while a command is unconfirmed, then go") {
  for (const HubMode mode : kBothModes) {
    INFO("mode: " << mode_name(mode));
    Site site(hub_options(mode));
    site.add_mode_gateway();
    BlockedSiren siren(site);
    site.sim.schedule(at(seconds(5)),
                      [&]() { site.hub.command_siren("siren", protocol::SirenAction::test, 60); });
    site.sim.schedule(at(seconds(6)), [&]() {
      host::SirenConfig settings;
      settings.max_sound_seconds = 120;
      site.hub.change_siren("siren", settings);
    });
    site.sim.run_until(at(seconds(20)));
    // Nothing but the command went to the siren, and it kept its counter.
    CHECK(site.hub.sent_to("siren", type::siren_settings).empty());
    const auto commands = site.hub.sent_to("siren");
    REQUIRE(commands.size() > 2);
    for (const host::HubSent& sent : commands) {
      CHECK(sent.type == type::siren_command);
      CHECK(sent.counter == commands[0].counter);
    }

    siren.unblock();
    site.sim.run_until(at(seconds(40)));
    const auto confirmed = site.hub.decisions(HubAction::siren_confirmed, "siren");
    REQUIRE(confirmed.size() == 2);
    const auto settings = site.hub.sent_to("siren", type::siren_settings);
    REQUIRE_FALSE(settings.empty());
    CHECK(settings[0].at >= confirmed[0].at);
    CHECK(siren.log.settings_version == 2);
    CHECK(siren.device.board().siren_io.output_state);
  }
}

TEST_CASE("one at a time: a newer command replaces a waiting one") {
  for (const HubMode mode : kBothModes) {
    INFO("mode: " << mode_name(mode));
    Site site(hub_options(mode));
    site.add_mode_gateway();
    BlockedSiren siren(site);
    site.sim.schedule(at(seconds(5)),
                      [&]() { site.hub.command_siren("siren", protocol::SirenAction::test, 30); });
    site.sim.schedule(at(seconds(8)),
                      [&]() { site.hub.command_siren("siren", protocol::SirenAction::off, 0); });
    site.sim.run_until(at(seconds(70)));
    const auto commands = site.hub.sent_to("siren", type::siren_command);
    REQUIRE_FALSE(commands.empty());
    const std::uint32_t first = commands.front().counter;
    const std::uint32_t newer = commands.back().counter;
    CHECK(newer > first);
    std::size_t first_after = 0;
    std::size_t first_before = 0;
    for (const host::HubSent& sent : commands) {
      if (sent.counter == first) {
        (sent.at < at(seconds(8)) ? first_before : first_after) += 1;
      }
    }
    // Wi-Fi at 5 and 7 s, LoRa at 5 s; none after the newer command.
    CHECK(first_before == 3);
    CHECK(first_after == 0);
    // Only the newer one is given up on, a minute after it was issued.
    const auto unreachable = site.hub.decisions(HubAction::siren_unreachable, "siren");
    REQUIRE(unreachable.size() == 1);
    CHECK(unreachable[0].at == at(seconds(68)));
    CHECK_FALSE(siren.device.board().siren_io.output_state);
  }
}

TEST_CASE("a replaced or confirmed command arriving late by LoRa is dropped as too old") {
  for (const HubMode mode : kBothModes) {
    INFO("mode: " << mode_name(mode));
    Site site(hub_options(mode));
    site.add_mode_gateway();
    // Commands at SF12 take 1.5 s on the air, so both Wi-Fi copies win by far.
    ScriptSirenConfig slow;
    slow.command_data_rate = 0;
    host::SirenConfig settings;
    settings.command_data_rate = 0;
    ScriptSirenLog log;
    host::SimDevice& siren = site.siren("siren", slow, log, settings);
    site.sim.schedule(at(seconds(5)),
                      [&]() { site.hub.command_siren("siren", protocol::SirenAction::test, 30); });
    site.sim.schedule(at(seconds(5)) + milliseconds(10),
                      [&]() { site.hub.command_siren("siren", protocol::SirenAction::off, 0); });
    site.sim.run_until(at(seconds(15)));
    const auto commands = site.hub.sent_to("siren", type::siren_command);
    REQUIRE(commands.size() >= 2);
    const std::uint32_t replaced = commands.front().counter;
    const std::uint32_t confirmed = commands.back().counter;
    std::size_t late = 0;
    for (const ScriptSirenLog::Command& command : log.commands) {
      if (!command.by_wifi && (command.counter == replaced || command.counter == confirmed)) {
        late += 1;
        CHECK(command.verdict == device::CommandVerdict::too_old);
      }
    }
    CHECK(late == 2);
    // No other effect: the output went on and off once, no flash write, and the only LoRa
    // answers are to LoRa copies of the latest packet (the settings sent after confirmation).
    const auto outputs = siren.records().kind(RecordKind::output).records();
    REQUIRE(outputs.size() == 2);
    CHECK(outputs[0].flag);
    CHECK_FALSE(outputs[1].flag);
    std::size_t lora_repeats = 0;
    for (const ScriptSirenLog::Command& command : log.commands) {
      lora_repeats +=
          !command.by_wifi && command.verdict == device::CommandVerdict::repeat_of_latest ? 1u : 0u;
    }
    CHECK(log.reports_by_lora == lora_repeats);
    const auto command_counter = [](const host::Record& record) {
      return record.value == static_cast<std::uint32_t>(device::StoreKey::command_counter);
    };
    CHECK(siren.records().kind(RecordKind::flash_write).where(command_counter).count() ==
          log.count(device::CommandVerdict::new_command));
    CHECK(site.hub.decisions(HubAction::siren_unreachable).empty());
    // The report answering the replaced command came while the newer one waited: the settings
    // the siren lacked waited too, until the newer command was confirmed.
    const auto confirmations = site.hub.decisions(HubAction::siren_confirmed, "siren");
    const auto settings_sent = site.hub.sent_to("siren", type::siren_settings);
    REQUIRE_FALSE(confirmations.empty());
    REQUIRE_FALSE(settings_sent.empty());
    CHECK(settings_sent[0].at >= confirmations[0].at);
  }
}

TEST_CASE("a reset takes a device's link down at both ends without an event; it reconnects") {
  for (const HubMode mode : kBothModes) {
    INFO("mode: " << mode_name(mode));
    Site site(hub_options(mode));
    site.add_mode_gateway();
    ScriptSirenLog log;
    host::SimDevice& siren = site.siren("siren", ScriptSirenConfig{}, log);
    site.sim.run_until(at(seconds(4)));
    host::LinkWire& wire = siren.wire(device::LinkKind::network);
    CHECK(wire.connected());
    siren.restart(at(seconds(5)));
    site.sim.run_until(at(seconds(5)) + milliseconds(10));
    CHECK_FALSE(wire.connected());
    CHECK_FALSE(siren.board().network.up());
    CHECK(siren.records().kind(RecordKind::link_down).empty());
    site.sim.run_until(at(seconds(6)));
    CHECK(wire.connected());
    CHECK(siren.records().kind(RecordKind::link_up).count() == 2);
  }
}

TEST_CASE("late door reports in each of the three ranges of protocol section 7") {
  struct Case {
    std::uint16_t age;
    HubAction action;
    std::int64_t value;
  };
  // Countdown 30 s, sirens 180 s. The door report ends at about 1,000.065 s; the opening was
  // `age` seconds before. Within the countdown: 20 s left. After it, within the sirens' time:
  // they sound for the 110 s left of it. After even that: a notification of the opening, 700 s.
  const Case cases[] = {
      {10, HubAction::countdown_started, 20},
      {100, HubAction::late_report_sirens, 110},
      {300, HubAction::late_report_notification, 700},
  };
  for (const HubMode mode : kBothModes) {
    for (const Case& item : cases) {
      INFO(mode_name(mode) << ", age " << item.age);
      Site site(hub_options(mode));
      site.add_mode_gateway();
      ScriptSensorLog sensor_log;
      ScriptSirenLog siren_log;
      ScriptSensorConfig config;
      config.extra_age_seconds = item.age;
      host::SimDevice& door = site.sensor("door", config, sensor_log);
      site.siren("siren", ScriptSirenConfig{}, siren_log);
      site.hub.arm();
      door.set_input(device::Input::door, true, at(seconds(1000)));
      site.sim.run_until(at(seconds(1010)));
      const auto decided = site.hub.decisions(item.action, "door");
      REQUIRE(decided.size() == 1);
      CHECK(decided[0].value == item.value);
      REQUIRE(sensor_log.heard.size() == 1);
      const bool counting = item.action == HubAction::countdown_started;
      CHECK(sensor_log.heard[0].reply.flags.countdown_started == counting);
      const auto commands = site.hub.decisions(HubAction::siren_command, "siren");
      if (item.action == HubAction::late_report_sirens) {
        // The sirens sound for what is left of their time, counted from the countdown's end.
        REQUIRE(commands.size() == 1);
        CHECK(commands[0].value == protocol::SirenAction::sound_alarm * 65536 + 110);
        REQUIRE_FALSE(siren_log.commands.empty());
        CHECK(siren_log.commands[0].seconds == 110);
      } else {
        CHECK(commands.empty());
      }
    }
  }
}

}  // namespace
}  // namespace hsn::test
