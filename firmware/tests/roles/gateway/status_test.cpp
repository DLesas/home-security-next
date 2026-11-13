// What the gateway reports about itself (§6 gateway status and Started; GW6, FW5, FW6, FW8, D110):
// a status at the settings' interval with every field, the reset cause and last fatal error in
// Started, and log entries reaching the hub as they arise.

#include <algorithm>

#include "gateway_bench.hpp"
#include "hsn/device/services/record.hpp"

namespace hsn::test {
namespace {

using host::HubAction;
namespace gateway_log = roles::gateway::gateway_log;

TEST_CASE("GW6 a status at the settings' interval, with uptime, airtime, noise, counts and flags") {
  Site site(gateway_mode());
  host::GatewayConfig config;
  config.status_interval_seconds = 10;
  host::SimDevice& gateway = add_gateway(site, "gateway", config);
  gateway.board().gateway_io.cell = true;
  ScriptSensorLog sensor_log;
  host::SimDevice& door = site.sensor("door", ScriptSensorConfig{}, sensor_log);
  door.set_input(device::Input::door, true, at(seconds(12)));
  door.set_input(device::Input::door, false, at(seconds(14)));
  site.sim.run_until(at(seconds(45)));
  INFO(site.hub.dump());

  const auto statuses = site.hub.received_from("gateway", type::gateway_status);
  REQUIRE(statuses.size() == 4);
  for (std::size_t i = 0; i < statuses.size(); ++i) {
    INFO("status " << i);
    if (i > 0) {
      CHECK(statuses[i].at - statuses[i - 1].at == seconds(10));
    }
    const auto status = statuses[i].as<protocol::GatewayStatus>();
    CHECK(status.settings_version == 1);
    CHECK(status.wifi_rssi_dbm == 0);
    CHECK_FALSE(status.flags.usb_connected);
    CHECK(status.flags.cell_fitted);
    CHECK(status.flags.on_mains);
    CHECK(status.normal_noise_dbm == -117);
    CHECK(status.noise_median_dbm == -117);
  }
  const auto first = statuses[0].as<protocol::GatewayStatus>();
  const auto second = statuses[1].as<protocol::GatewayStatus>();
  const auto third = statuses[2].as<protocol::GatewayStatus>();
  // Seconds since start-up, which was 50 ms in.
  CHECK(first.uptime_seconds == 10);
  CHECK(second.uptime_seconds == 20);
  // The two door reports fell in the second period, and the counts start again after it.
  CHECK(first.packets_received == 0);
  CHECK(second.packets_received == 2);
  CHECK(second.packets_crc_failed == 0);
  CHECK(third.packets_received == 0);
  // Two short replies on 869.525 MHz are well under a hundredth of a percent of the hour; the
  // airtime field is checked near its limit in the D104 case.
  CHECK(gateway.records().kind(RecordKind::transmission).count() == 2);
  CHECK(third.airtime_hundredths_percent == 0);
}

TEST_CASE("GW6 a new status interval in the settings takes effect at once") {
  Site site(gateway_mode());
  add_gateway(site, "gateway");
  site.sim.run_until(at(seconds(5)));
  host::GatewayConfig changed;
  changed.status_interval_seconds = 7;
  site.hub.change_gateway("gateway", changed);
  site.sim.run_until(at(seconds(30)));
  const auto statuses = site.hub.received_from("gateway", type::gateway_status);
  REQUIRE(statuses.size() == 3);
  CHECK(statuses[1].at - statuses[0].at == seconds(7));
  CHECK(statuses[0].as<protocol::GatewayStatus>().settings_version == 2);
}

TEST_CASE("FW5 Started reports the reset cause and the stored fatal error, which is then cleared") {
  Site site(gateway_mode());
  host::SimDevice& gateway = add_gateway(site, "gateway");
  const std::uint8_t busy_loop[2] = {static_cast<std::uint8_t>(device::fatal_code::busy_loop), 0};
  REQUIRE(gateway.board().storage.write(device::StoreKey::fatal_error,
                                        protocol::ByteView(busy_loop)) == device::HalError::none);
  site.sim.run_until(at(seconds(3)));
  gateway.restart(at(seconds(3)));
  site.sim.run_until(at(seconds(6)));
  const auto started = hub_got<protocol::Started>(site.hub, "gateway");
  REQUIRE(started.size() == 2);
  CHECK(started[0].last_fatal_error == device::fatal_code::busy_loop);
  CHECK(started[0].reset_cause == 1);  // power on, as the bench's ESP-IDF value
  CHECK(started[1].last_fatal_error == 0);
  CHECK(started[1].reset_cause == 3);  // software restart
  CHECK_FALSE(gateway.board().storage.has(device::StoreKey::fatal_error));
}

TEST_CASE("FW6 D110 every failure is logged with a gateway code and reaches the hub as it arises") {
  Site site(gateway_mode());
  host::SimDevice& gateway = add_gateway(site, "gateway");
  // The settings write fails: logged, and the value is still used.
  // After the hello (sealed at 0.10 s, which writes a resume point), before the settings.
  site.sim.schedule(at(milliseconds(110)), [&]() { gateway.board().storage.fail_next_writes = 1; });
  site.sim.run_until(at(seconds(3)));
  const auto entries = site.hub.log_entries_from("gateway");
  REQUIRE(entries.size() == 1);
  CHECK(entries[0].code == gateway_log::settings_store_failed);
  CHECK(entries[0].level == static_cast<std::uint8_t>(device::LogLevel::error));
  CHECK(entries[0].code >= device::log_code::gateway_first);
  CHECK(entries[0].code < device::log_code::platform_first);
  // It went over the link the moment it arose, in the same instant as the settings.
  CHECK(entries[0].at - site.hub.decisions(HubAction::gateway_settings, "gateway")[0].at ==
        milliseconds(50));
  CHECK_FALSE(gateway.board().storage.has(roles::gateway::kSettingsKey));
  CHECK(gateway_of(gateway).state().settings.version == 1);
  CHECK(gateway.services()->log.size() == 0);
  // The next connection stores them.
  gateway.restart(at(seconds(3)));
  site.sim.run_until(at(seconds(6)));
  CHECK(gateway.board().storage.has(roles::gateway::kSettingsKey));
}

TEST_CASE("FW6 a hello that cannot be sealed is logged; the next try connects") {
  Site site(gateway_mode());
  host::SimDevice& gateway = add_gateway(site, "gateway");
  // The hello needs a resume point written first (§4): that write fails once.
  gateway.board().storage.fail_next_writes = 1;
  site.sim.run_until(at(seconds(20)));
  CHECK(gateway_of(gateway).state().connection.phase == roles::gateway::ConnectionPhase::connected);
  const auto hellos = hub_got<protocol::Hello>(site.hub, "gateway");
  REQUIRE(hellos.size() == 1);
  std::vector<std::uint16_t> codes;
  for (const host::HubLogEntry& entry : site.hub.log_entries_from("gateway")) {
    codes.push_back(entry.code);
  }
  CHECK(std::count(codes.begin(), codes.end(), gateway_log::seal_failed) == 1);
  CHECK(std::count(codes.begin(), codes.end(), gateway_log::welcome_timeout) == 1);
}

/** The text of the gateway's zero-setting warning, as the hub got it. */
std::string zero_setting_text(const LinkHub& hub) {
  for (const LinkHub::Got& got : hub.got(type::log_entries)) {
    protocol::LogEntries entries;
    REQUIRE(protocol::decode_body(view_of(got.body), entries) == protocol::Error::none);
    protocol::LogEntryReader reader(entries.entries);
    protocol::LogEntry entry;
    while (reader.next(entry)) {
      if (entry.code == gateway_log::zero_setting) {
        CHECK(entry.level == static_cast<std::uint8_t>(device::LogLevel::warning));
        return std::string(entry.text.bytes.begin(), entry.text.bytes.end());
      }
    }
  }
  return "";
}

TEST_CASE("§6 a zero interval, alert level or duration is not valid: the value held stays") {
  LinkSite site;
  site.hub.settings.status_interval_seconds = 10;
  site.hub.settings.interference_threshold_db = 12;
  site.hub.settings.interference_seconds = 20;
  site.sim.run_until(at(seconds(2)));
  site.sim.schedule(at(seconds(2)), [&]() {
    protocol::GatewaySettings zeros = site.hub.settings;
    zeros.settings_version = 2;
    zeros.status_interval_seconds = 0;
    zeros.interference_threshold_db = 0;
    zeros.interference_seconds = 0;
    site.hub.send(zeros);
  });
  site.sim.run_until(at(seconds(35)));
  const roles::gateway::HeldSettings& held = gateway_of(site.gateway).state().settings;
  CHECK(held.version == 2);
  CHECK(held.status_interval_seconds == 10);
  CHECK(held.interference_threshold_db == 12);
  CHECK(held.interference_seconds == 20);
  // Stored as held, never as 0.
  device::Record<roles::gateway::HeldSettings> stored(
      site.gateway.board().storage, roles::gateway::kSettingsKey,
      roles::gateway::kSettingsRecordVersion, roles::gateway::HeldSettings{});
  REQUIRE(stored.load() == device::HalError::none);
  CHECK(stored.get().status_interval_seconds == 10);
  CHECK(stored.get().interference_threshold_db == 12);
  CHECK(stored.get().interference_seconds == 20);
  // Still a status every 10 s, and one warning naming the three fields (bits 0 to 2).
  const auto statuses = site.hub.got(type::gateway_status);
  REQUIRE(statuses.size() == 3);
  CHECK(statuses[1].at - statuses[0].at == seconds(10));
  const auto codes = site.hub.log_codes();
  CHECK(std::count(codes.begin(), codes.end(), gateway_log::zero_setting) == 1);
  CHECK(zero_setting_text(site.hub) == "zero setting 7");
}

TEST_CASE("§6 zeros in the first settings leave the protocol's defaults (§8)") {
  LinkSite site;
  site.hub.settings.status_interval_seconds = 0;
  site.hub.settings.interference_threshold_db = 0;
  site.hub.settings.interference_seconds = 0;
  site.sim.run_until(at(seconds(65)));
  const roles::gateway::HeldSettings& held = gateway_of(site.gateway).state().settings;
  CHECK(held.status_interval_seconds == 30);
  CHECK(held.interference_threshold_db == 10);
  CHECK(held.interference_seconds == 30);
  CHECK(site.hub.got(type::gateway_status).size() == 2);
  const auto codes = site.hub.log_codes();
  CHECK(std::count(codes.begin(), codes.end(), gateway_log::zero_setting) == 1);
}

TEST_CASE("GW6 the status carries the Wi-Fi signal strength on Wi-Fi, and 0 on USB") {
  for (const bool usb : {false, true}) {
    INFO((usb ? "USB" : "Wi-Fi"));
    Site site(gateway_mode());
    host::GatewayConfig config;
    config.usb = usb;
    host::SimDevice& gateway = add_gateway(site, "gateway", config);
    gateway.board().network.wifi_signal_dbm = -61;
    site.sim.run_until(at(seconds(35)));
    const auto statuses = hub_got<protocol::GatewayStatus>(site.hub, "gateway");
    REQUIRE(statuses.size() == 1);
    CHECK(statuses[0].wifi_rssi_dbm == (usb ? 0 : -61));
  }
}

}  // namespace
}  // namespace hsn::test
