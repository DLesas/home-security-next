// The test hub and log entries (protocol section 6, D110): every device's entries are recorded
// with the time each was made; a sensor's, sent over LoRa one at a time, are answered with a
// reply bound to the packet, at the rate the sensor listens at, and an entry whose reply was lost
// comes again and is recorded again, marked as a repeat; a siren's and a gateway's are not
// answered.

#include <limits>
#include <string>

#include "sim_support.hpp"

namespace hsn::test {
namespace {

using device::LogLevel;
using host::HubLogEntry;
using host::HubMode;
using host::HubPath;
namespace type = protocol::message_type;

constexpr double kCut = std::numeric_limits<double>::infinity();
constexpr double kNormal = 100.0;
constexpr std::uint16_t kSwitch = 0x1001;

/** The path radio packets take in a mode. */
HubPath radio_path(HubMode mode) {
  return mode == HubMode::direct_radio ? HubPath::radio : HubPath::gateway;
}

/**
 * A sensor with heartbeats at 60, 120, 180 s and on, only the first answered (its settings
 * version), that sends one log entry after each heartbeat; it logs an info entry at 65 s and a
 * warning at 70 s.
 */
ScriptSensorConfig logging_sensor() {
  ScriptSensorConfig config;
  config.heartbeat_every = seconds(60);
  config.link_check_every = 100;
  config.send_logs = true;
  config.log_entries = {{at(seconds(65)), LogLevel::info, 0x1002, "info only"},
                        {at(seconds(70)), LogLevel::warning, kSwitch, "door switch"}};
  return config;
}

/** A device's log entries packets on the air. */
std::vector<host::Record> log_packets_on_air(host::SimDevice& device) {
  return device.records().kind(RecordKind::transmission).type(type::log_entries).records();
}

/** True when `made` lies within a second after `logged`: the age is right to the packet. */
bool made_soon_after(device::Instant made, device::Instant logged) {
  return made >= logged && made < logged + seconds(1);
}

TEST_CASE("a sensor's LoRa log entry is recorded, dated, and answered with a reply bound to it") {
  for (const HubMode mode : kBothModes) {
    INFO("mode: " << mode_name(mode));
    Site site(hub_options(mode));
    site.add_mode_gateway();
    ScriptSensorLog log;
    host::SimDevice& door = site.sensor("door", logging_sensor(), log);
    site.sim.run_until(at(seconds(130)));
    INFO(site.sim.timeline().select().dump() << site.hub.dump());

    // One packet, after the second heartbeat, with the warning only: the info entry is not sent.
    const auto on_air = log_packets_on_air(door);
    REQUIRE(on_air.size() == 1);
    REQUIRE(log.log_sends.size() == 1);
    CHECK(log.log_sends[0].code == kSwitch);
    const auto entries = site.hub.log_entries_from("door");
    REQUIRE(entries.size() == 1);
    const HubLogEntry& entry = entries[0];
    CHECK(entry.counter == log.log_sends[0].counter);
    CHECK(entry.level == static_cast<std::uint8_t>(LogLevel::warning));
    CHECK(entry.code == kSwitch);
    CHECK(entry.text == "door switch");
    CHECK(entry.path == radio_path(mode));
    CHECK(entry.via == (mode == HubMode::gateway_link ? "gateway" : ""));
    CHECK(entry.repeat_of == 0);
    // Made at 70 s, though it arrived 51 s later: the arrival less the entry's age.
    CHECK(entry.age_tenths >= 510);
    CHECK(made_soon_after(entry.made_at, at(seconds(70))));
    if (mode == HubMode::direct_radio) {
      CHECK(entry.made_at + milliseconds(100 * entry.age_tenths) == on_air[0].until);
    }

    // Answered as soon as possible, like a door report, with a reply bound to the log packet.
    const auto replies = site.hub.sent_to("door", type::reply);
    REQUIRE(replies.size() == 2);
    const auto replies_on_air =
        site.sim.timeline().select().kind(RecordKind::transmission).type(type::reply).records();
    REQUIRE(replies_on_air.size() == 2);
    CHECK(replies_on_air[1].from == on_air[0].until + milliseconds(50));
    REQUIRE(log.heard.size() == 2);
    CHECK(log.heard[1].type == type::reply);
    CHECK(log.heard[1].answered == log.log_sends[0].counter);
    CHECK(log.log_sends[0].answered);
    CHECK(log.rejected == 0);
    CHECK(site.hub.dump().find("logged door level 2 code 0x1001 \"door switch\"") !=
          std::string::npos);
  }
}

TEST_CASE("an entry whose reply was lost comes again; the hub records every copy it saw") {
  for (const HubMode mode : kBothModes) {
    INFO("mode: " << mode_name(mode));
    Site site(hub_options(mode));
    site.add_mode_gateway();
    ScriptSensorLog log;
    host::SimDevice& door = site.sensor("door", logging_sensor(), log);
    const host::StationId sensor = door.station();
    const host::StationId hub = site.hub_ear();

    SUBCASE("the hub never had the first packet: one record") {
      site.sim.schedule(at(seconds(100)),
                        [&]() { site.sim.medium().set_path_loss_one_way(sensor, hub, kCut); });
      site.sim.schedule(at(seconds(150)),
                        [&]() { site.sim.medium().set_path_loss_one_way(sensor, hub, kNormal); });
      site.sim.run_until(at(seconds(250)));
      INFO(site.hub.dump());
      REQUIRE(log.log_sends.size() == 2);
      CHECK(log.log_sends[0].code == kSwitch);
      CHECK_FALSE(log.log_sends[0].answered);
      CHECK(log.log_sends[1].code == kSwitch);
      CHECK(log.log_sends[1].answered);
      const auto entries = site.hub.log_entries_from("door");
      REQUIRE(entries.size() == 1);
      CHECK(entries[0].counter == log.log_sends[1].counter);
      CHECK(entries[0].repeat_of == 0);
      CHECK(made_soon_after(entries[0].made_at, at(seconds(70))));
    }
    SUBCASE("the hub had both: two records, the second marked with the first's counter") {
      site.sim.schedule(at(seconds(100)),
                        [&]() { site.sim.medium().set_path_loss_one_way(hub, sensor, kCut); });
      site.sim.schedule(at(seconds(150)),
                        [&]() { site.sim.medium().set_path_loss_one_way(hub, sensor, kNormal); });
      site.sim.run_until(at(seconds(250)));
      INFO(site.hub.dump());
      // Offered again after the lost reply, then released by the reply: nothing after 240 s.
      REQUIRE(log.log_sends.size() == 2);
      CHECK_FALSE(log.log_sends[0].answered);
      CHECK(log.log_sends[1].answered);
      CHECK(log_packets_on_air(door).size() == 2);
      const auto entries = site.hub.log_entries_from("door");
      REQUIRE(entries.size() == 2);
      CHECK(entries[0].counter == log.log_sends[0].counter);
      CHECK(entries[0].repeat_of == 0);
      CHECK(entries[1].counter == log.log_sends[1].counter);
      CHECK(entries[1].repeat_of == entries[0].counter);
      CHECK(entries[1].code == kSwitch);
      // Both copies date the entry to when it was made, though they arrived a minute apart.
      CHECK(made_soon_after(entries[0].made_at, at(seconds(70))));
      CHECK(made_soon_after(entries[1].made_at, at(seconds(70))));
      CHECK(site.hub.dump().find("repeat of #" + std::to_string(entries[0].counter)) !=
            std::string::npos);
      // Each copy was answered.
      CHECK(site.hub.sent_to("door", type::reply).size() == 3);
    }
    SUBCASE("two replies lost: every later copy is marked with the first packet's counter") {
      site.sim.schedule(at(seconds(100)),
                        [&]() { site.sim.medium().set_path_loss_one_way(hub, sensor, kCut); });
      site.sim.schedule(at(seconds(210)),
                        [&]() { site.sim.medium().set_path_loss_one_way(hub, sensor, kNormal); });
      site.sim.run_until(at(seconds(310)));
      INFO(site.hub.dump());
      REQUIRE(log.log_sends.size() == 3);
      CHECK(log.log_sends[2].answered);
      const auto entries = site.hub.log_entries_from("door");
      REQUIRE(entries.size() == 3);
      CHECK(entries[0].repeat_of == 0);
      CHECK(entries[1].repeat_of == entries[0].counter);
      CHECK(entries[2].repeat_of == entries[0].counter);
      CHECK(entries[2].counter == log.log_sends[2].counter);
    }
  }
}

TEST_CASE("only the same entry from the same sensor counts as a repeat") {
  Site site;
  SUBCASE("entries that differ in code, text or level, or come from another sensor") {
    ScriptSensorLog door_log;
    ScriptSensorConfig door = logging_sensor();
    door.log_entries = {{at(seconds(70)), LogLevel::warning, kSwitch, "same"},
                        {at(seconds(71)), LogLevel::warning, 0x1002, "same"},
                        {at(seconds(72)), LogLevel::warning, kSwitch, "other"},
                        {at(seconds(73)), LogLevel::error, kSwitch, "other"}};
    site.sensor("door", door, door_log);
    // The window sensor starts 10 s later, so its heartbeats do not collide with the door's.
    ScriptSensorLog window_log;
    ScriptSensorConfig window = logging_sensor();
    window.log_entries = {{at(seconds(70)), LogLevel::warning, kSwitch, "same"}};
    host::DeviceSpec spec;
    spec.name = "window";
    spec.role = script_sensor(window, window_log);
    spec.power_on = at(seconds(10));
    site.hub.add_sensor(site.sim.add_device(spec));
    site.sim.run_until(at(seconds(320)));
    INFO(site.hub.dump());
    REQUIRE(door_log.log_sends.size() == 4);
    REQUIRE(window_log.log_sends.size() == 1);
    REQUIRE(site.hub.log_entries().size() == 5);
    for (const HubLogEntry& entry : site.hub.log_entries()) {
      INFO(entry.from << " #" << entry.counter);
      CHECK(entry.repeat_of == 0);
    }
  }
  SUBCASE("the same entry made again a minute later") {
    ScriptSensorLog log;
    ScriptSensorConfig config = logging_sensor();
    config.log_entries = {{at(seconds(70)), LogLevel::warning, kSwitch, "same"},
                          {at(seconds(130)), LogLevel::warning, kSwitch, "same"}};
    site.sensor("door", config, log);
    site.sim.run_until(at(seconds(190)));
    INFO(site.hub.dump());
    REQUIRE(log.log_sends.size() == 2);
    const auto entries = site.hub.log_entries_from("door");
    REQUIRE(entries.size() == 2);
    CHECK(entries[1].repeat_of == 0);
  }
}

TEST_CASE("a sensor's log entries are answered at the rate it listens at") {
  for (const HubMode mode : kBothModes) {
    INFO("mode: " << mode_name(mode));
    Site site(hub_options(mode));
    site.add_mode_gateway(3);
    ScriptSensorLog log;
    ScriptSensorConfig config = logging_sensor();
    config.send_data_rate = 3;
    host::SensorConfig settings;
    settings.send_data_rate = 3;
    settings.reply_data_rate = 5;
    std::vector<int> expected;
    SUBCASE("the reply rate of the settings in the hub's latest reply") {
      // The first heartbeat's reply goes at its own rate (it held no settings) and gives it DR5.
      expected = {3, 5};
    }
    SUBCASE("its sending rate after an unanswered heartbeat with flag bit 7") {
      config.fall_back_at_heartbeat = 2;
      expected = {3, 3};
    }
    SUBCASE("the reply rate again once a reply answered the heartbeat with flag bit 7") {
      config.fall_back_at_heartbeat = 2;
      config.link_check_every = 2;
      expected = {3, 3, 5};
    }
    site.sensor("door", config, log, settings);
    site.sim.run_until(at(seconds(130)));
    INFO(site.hub.dump());
    std::vector<int> rates;
    for (const host::HubSent& sent : site.hub.sent_to("door", type::reply)) {
      rates.push_back(sent.data_rate);
    }
    CHECK(rates == expected);
    REQUIRE(log.log_sends.size() == 1);
    CHECK(log.log_sends[0].answered);
  }
}

TEST_CASE("a siren's and a gateway's log entries over their links are recorded, not answered") {
  SUBCASE("a siren over Wi-Fi, every level") {
    Site site;
    ScriptSirenLog log;
    ScriptSirenConfig config;
    // The same entry twice, each sent and released before the next: two entries, not a repeat.
    config.log_entries = {{at(seconds(5)), LogLevel::warning, 0x2001, "amp hot"},
                          {at(seconds(6)), LogLevel::info, 0x2002, "wifi slow"},
                          {at(seconds(7)), LogLevel::info, 0x2002, "wifi slow"}};
    site.siren("siren", config, log);
    site.sim.run_until(at(seconds(10)));
    INFO(site.hub.dump());
    CHECK(log.log_packets == 3);
    const auto entries = site.hub.log_entries_from("siren");
    REQUIRE(entries.size() == 3);
    CHECK(entries[0].code == 0x2001);
    CHECK(entries[0].text == "amp hot");
    CHECK(entries[0].level == static_cast<std::uint8_t>(LogLevel::warning));
    CHECK(entries[1].code == 0x2002);
    CHECK(entries[1].level == static_cast<std::uint8_t>(LogLevel::info));
    for (const HubLogEntry& entry : entries) {
      CHECK(entry.path == HubPath::link);
      CHECK(entry.repeat_of == 0);
    }
    CHECK(made_soon_after(entries[0].made_at, at(seconds(5))));
    CHECK(made_soon_after(entries[1].made_at, at(seconds(6))));
    CHECK(site.hub.sent_to("siren").empty());
  }
  SUBCASE("a gateway over its link, once welcomed") {
    Site site(gateway_mode());
    ScriptGatewayConfig config;
    config.log_entries = {{at(seconds(5)), LogLevel::error, 0x3001, "radio stuck"}};
    site.gateway("gateway", config, site.gateway_log);
    site.sim.run_until(at(seconds(10)));
    INFO(site.hub.dump());
    CHECK(site.gateway_log.log_packets == 1);
    const auto entries = site.hub.log_entries_from("gateway");
    REQUIRE(entries.size() == 1);
    CHECK(entries[0].code == 0x3001);
    CHECK(entries[0].text == "radio stuck");
    CHECK(entries[0].path == HubPath::link);
    CHECK(entries[0].via.empty());
    CHECK(made_soon_after(entries[0].made_at, at(seconds(5))));
    // Its welcome and settings went at the start; nothing answers the entry.
    for (const host::HubSent& sent : site.hub.sent_to("gateway")) {
      CHECK(sent.at < entries[0].at);
    }
    CHECK(site.hub.sent_to("gateway").size() == 2);
  }
}

}  // namespace
}  // namespace hsn::test
