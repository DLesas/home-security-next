// The test hub's rules, each run in both modes: with its own ideal radio, and through a scripted
// gateway. Heartbeat replies and settings versions, event replies, countdowns, late reports,
// disarmed notices, siren commands and settings on both paths. Protocol sections 4, 6, 7 and 8.
// The gateway's own handshake and requests are in test_hub_gateway_test.cpp.

#include <limits>

#include "sim_support.hpp"

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
    // by its counter, as a repeat of the latest (its settings came after its Started, at boot).
    const auto commands = site.hub.sent_to("siren", type::siren_command);
    REQUIRE(commands.size() == 2);
    CHECK(commands[0].path == HubPath::link);
    CHECK(commands[1].path == radio_path(mode));
    CHECK(commands[0].counter == commands[1].counter);
    REQUIRE(first_siren_command(siren_log) != nullptr);
    const ScriptSirenLog::Command first = *first_siren_command(siren_log);
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
    // The changed settings (those after its Started, at boot, aside), on both paths.
    std::vector<host::HubSent> sent;
    for (const host::HubSent& packet : site.hub.sent_to("siren", type::siren_settings)) {
      if (packet.at >= at(seconds(5))) {
        sent.push_back(packet);
      }
    }
    REQUIRE(sent.size() == 2);
    // On LoRa at DR5, the rate the siren held, not the DR4 the settings bring.
    CHECK(sent[1].path == radio_path(mode));
    CHECK(sent[1].data_rate == 5);
    // Confirmed once, as the settings after its Started were.
    std::size_t confirmed = 0;
    for (const host::HubDecision& decision :
         site.hub.decisions(HubAction::siren_confirmed, "siren")) {
      confirmed += decision.at >= at(seconds(5)) ? 1u : 0u;
    }
    CHECK(confirmed == 1);
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
    // New settings while the first command is unconfirmed: they wait for the commands (§7).
    site.sim.schedule(at(seconds(5)) + milliseconds(5), [&]() {
      host::SirenConfig changed = settings;
      changed.max_sound_seconds = 200;
      site.hub.change_siren("siren", changed);
    });
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
    // The report answering the replaced command came while the newer one waited: the changed
    // settings waited too, until the newer command was confirmed.
    const auto confirmations = site.hub.decisions(HubAction::siren_confirmed, "siren");
    std::vector<host::HubSent> settings_sent;
    for (const host::HubSent& packet : site.hub.sent_to("siren", type::siren_settings)) {
      if (packet.at >= at(seconds(5))) {
        settings_sent.push_back(packet);
      }
    }
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
        REQUIRE(first_siren_command(siren_log) != nullptr);
        CHECK(first_siren_command(siren_log)->seconds == 110);
      } else {
        CHECK(commands.empty());
      }
    }
  }
}

/** The sound commands the hub decided on, to any siren. */
std::size_t sound_commands(const Site& site) {
  std::size_t count = 0;
  for (const host::HubDecision& decision : site.hub.decisions(HubAction::siren_command)) {
    if (decision.value / 65536 == protocol::SirenAction::sound_alarm) {
      count += 1;
    }
  }
  return count;
}

TEST_CASE("within one alarm each siren is commanded once, however many countdowns end") {
  constexpr std::size_t kDoors = 30;
  constexpr std::size_t kSirens = 4;
  Site site;
  std::vector<ScriptSensorLog> door_logs(kDoors);
  std::vector<ScriptSirenLog> siren_logs(kSirens);
  host::SensorConfig settings;
  settings.countdown_seconds = 20;
  std::vector<host::SimDevice*> doors;
  for (std::size_t i = 0; i < kDoors; ++i) {
    doors.push_back(
        &site.sensor("door" + std::to_string(i), ScriptSensorConfig{}, door_logs[i], settings));
  }
  std::vector<host::SimDevice*> sirens;
  for (std::size_t i = 0; i < kSirens; ++i) {
    sirens.push_back(&site.siren("siren" + std::to_string(i), ScriptSirenConfig{}, siren_logs[i]));
  }
  site.hub.arm();
  // Thirty doors within six seconds, spaced so their reports and the replies do not collide.
  for (std::size_t i = 0; i < kDoors; ++i) {
    doors[i]->set_input(device::Input::door, true,
                        at(seconds(10) + milliseconds(200 * static_cast<std::int64_t>(i))));
  }
  site.sim.run_until(at(seconds(60)));
  INFO(site.hub.dump());
  CHECK(site.hub.decisions(HubAction::alarm).size() == kDoors);
  CHECK(sound_commands(site) == kSirens);
  for (host::SimDevice* siren : sirens) {
    CHECK(siren->board().siren_io.output_state);
    CHECK(site.hub.sent_to(siren->name(), type::siren_command).size() == 2);  // Wi-Fi and LoRa
  }

  // A disarm ends the alarm; the next one commands every siren afresh.
  site.hub.disarm();
  site.sim.run_until(at(seconds(70)));
  for (host::SimDevice* siren : sirens) {
    CHECK_FALSE(siren->board().siren_io.output_state);
  }
  // Every door is still open: armed whatever the doors, each when it closes (D114).
  site.hub.arm(host::OpenDoors::arm_when_closed);
  doors[0]->set_input(device::Input::door, false, at(seconds(72)));
  doors[0]->set_input(device::Input::door, true, at(seconds(75)));
  site.sim.run_until(at(seconds(110)));
  CHECK(site.hub.decisions(HubAction::alarm).size() == kDoors + 1);
  CHECK(sound_commands(site) == 2 * kSirens);
  for (host::SimDevice* siren : sirens) {
    CHECK(siren->board().siren_io.output_state);
  }
}

TEST_CASE("an alarm that ended by itself is commanded afresh by the next countdown") {
  host::HubOptions options;
  options.alarm_seconds = 20;
  Site site(options);
  ScriptSensorLog first_log;
  ScriptSensorLog second_log;
  ScriptSirenLog siren_log;
  host::SensorConfig settings;
  settings.countdown_seconds = 5;
  host::SimDevice& first = site.sensor("first", ScriptSensorConfig{}, first_log, settings);
  host::SimDevice& second = site.sensor("second", ScriptSensorConfig{}, second_log, settings);
  site.siren("siren", ScriptSirenConfig{}, siren_log);
  site.hub.arm();
  first.set_input(device::Input::door, true, at(seconds(10)));
  // Its countdown ends at about 15 s and the sirens stop by themselves at about 35 s.
  second.set_input(device::Input::door, true, at(seconds(40)));
  site.sim.run_until(at(seconds(60)));
  CHECK(site.hub.decisions(HubAction::alarm).size() == 2);
  CHECK(sound_commands(site) == 2);
}

TEST_CASE("a reset or a power loss drives the siren's sounder low, on the timeline") {
  for (const bool power_loss : {false, true}) {
    INFO("power loss: " << power_loss);
    Site site;
    ScriptSensorLog door_log;
    ScriptSirenLog siren_log;
    host::SensorConfig settings;
    settings.countdown_seconds = 5;
    host::SimDevice& door = site.sensor("door", ScriptSensorConfig{}, door_log, settings);
    host::SimDevice& siren = site.siren("siren", ScriptSirenConfig{}, siren_log);
    site.hub.arm();
    door.set_input(device::Input::door, true, at(seconds(10)));
    site.sim.run_until(at(seconds(25)));
    REQUIRE(siren.board().siren_io.output_state);
    const device::Instant down = at(seconds(30));
    if (power_loss) {
      siren.power_loss(down, seconds(5));
    } else {
      siren.restart(down);
    }
    site.sim.run_until(at(seconds(50)));
    CHECK_FALSE(siren.board().siren_io.output_state);
    const auto outputs = siren.records().kind(RecordKind::output).records();
    REQUIRE(outputs.size() == 2);
    CHECK(outputs[0].flag);
    CHECK_FALSE(outputs[1].flag);
    CHECK(outputs[1].at == down);
  }
}

/** A station that keeps a frequency busy: one packet after another, back to back. */
class Jammer final : public host::StationListener {
public:
  Jammer(host::Simulation& sim, const device::RadioChannel& channel)
      : sim_(sim), channel_(channel) {}

  void start(host::StationId station, device::Instant when) {
    station_ = station;
    sim_.schedule(when, [this]() { send(); });
  }

  void tx_done(device::Instant at) override {
    sim_.schedule(at, [this]() { send(); });
  }
  void rx_done(device::Instant, const host::Bytes&, std::int16_t, std::int8_t,
               std::uint8_t) override {}
  void rx_crc_error(device::Instant) override {}
  void rx_timeout(device::Instant) override {}
  void header_seen(device::Instant) override {}
  void cad_done(device::Instant, bool) override {}

private:
  void send() {
    // A foreign system's packet: an address no one here holds.
    host::Bytes packet(30, 0x55);
    packet[0] = 0x10;
    sim_.medium().transmit(station_, channel_, 14, packet);
  }

  host::Simulation& sim_;
  device::RadioChannel channel_;
  host::StationId station_{};
};

TEST_CASE("a siren waiting on a busy channel to answer still hears a command sent meanwhile") {
  Site site;
  ScriptSirenLog siren_log;
  ScriptSirenConfig config;
  config.wifi = false;
  host::SirenConfig settings;
  settings.wifi = false;
  host::SimDevice& siren = site.siren("siren", config, siren_log, settings);
  // The site channel is busy from 1 s on, so the siren's answer to the first command waits.
  Jammer jammer(site.sim, device::RadioChannel{868300000, 5});
  jammer.start(site.sim.medium().add_station(site.sim.timeline().add_actor("jammer"), jammer),
               at(seconds(1)));
  site.sim.schedule(at(seconds(5)), [&]() {
    site.hub.command_siren("siren", protocol::SirenAction::sound_alarm, 60);
  });
  site.sim.schedule(at(seconds(5) + milliseconds(500)),
                    [&]() { site.hub.command_siren("siren", protocol::SirenAction::off, 0); });
  site.sim.run_until(at(seconds(20)));
  INFO(siren.records().dump());

  const auto busy =
      siren.records().kind(RecordKind::channel_check).where([](const host::Record& record) {
        return record.flag;
      });
  REQUIRE(busy.count() >= 1);
  // Its answers, after the commands (its Started went at boot).
  const auto sent = siren.records()
                        .kind(RecordKind::transmission)
                        .between(at(seconds(5)), device::Instant::never())
                        .records();
  REQUIRE_FALSE(sent.empty());
  // The off command was heard by LoRa during the busy wait: after the first busy check, before
  // the answer went on the air.
  const ScriptSirenLog::Command* off = nullptr;
  for (const ScriptSirenLog::Command& command : siren_log.commands) {
    if (command.action == protocol::SirenAction::off &&
        command.verdict == device::CommandVerdict::new_command) {
      off = &command;
    }
  }
  REQUIRE(off != nullptr);
  CHECK_FALSE(off->by_wifi);
  const device::Instant heard = siren.clock().true_time(off->at);
  CHECK(heard > busy.records()[0].at);
  CHECK(heard < sent[0].from);
  CHECK_FALSE(siren.board().siren_io.output_state);
}

}  // namespace
}  // namespace hsn::test
