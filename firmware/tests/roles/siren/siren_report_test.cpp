// Reports and the Wi-Fi path (protocol sections 6, 7 and 10; SR6, D52, D73, D109, FW5, FW8,
// HN(a)46, HN(a)47): every 30 s on Wi-Fi, on LoRa at once when a Wi-Fi report fails, a LoRa check
// every 5 minutes, Started once per start-up, reconnects on the back-off schedule.

#include "siren_bench.hpp"
#include "siren_support.hpp"

namespace hsn::test::siren {
namespace {

using device::Input;
using device::LinkKind;
using device::StoreKey;
using roles::siren::SirenTimer;

/** The largest gap between reports the hub accepted, on any path, in [from, to). */
device::Duration longest_silence(SirenSite& site, device::Instant from, device::Instant to) {
  device::Instant last = from;
  device::Duration longest;
  for (const HubReport& report : site.reports()) {
    if (report.at < from || report.at >= to) {
      continue;
    }
    longest = report.at - last > longest ? report.at - last : longest;
    last = report.at;
  }
  return to - last > longest ? to - last : longest;
}

TEST_CASE("SR6 D73: a report every 30 s on Wi-Fi and a LoRa check every 5 minutes") {
  SirenSite site;
  site.run_until(seconds(1));
  const device::Instant first_report = site.due(SirenTimer::wifi_report);
  const device::Instant first_check = site.due(SirenTimer::lora_check);
  site.run_until(seconds(11 * 60));
  INFO(site.dump());
  const auto regular = site.reports(reason::regular, HubPath::link);
  // One at link up (0.1 s), then every 30 s from the random first one (§7), 25 ms on the link.
  REQUIRE(regular.size() >= 22);
  CHECK(regular[1].at == first_report + milliseconds(25));
  for (std::size_t i = 2; i < regular.size(); ++i) {
    CHECK(regular[i].at - regular[i - 1].at == seconds(30));
  }
  CHECK(site.reports(reason::regular, HubPath::radio).empty());
  // The checks go on LoRa only, with Wi-Fi up, every 5 minutes from their own random start.
  const auto checks = site.reports(reason::lora_check);
  const std::size_t expected =
      static_cast<std::size_t>((at(seconds(660)) - first_check).us / seconds(300).us) + 1;
  REQUIRE(checks.size() == expected);
  CHECK(checks[0].path == HubPath::radio);
  CHECK(checks[0].report.flags.wifi_connected);
  for (std::size_t i = 1; i < checks.size(); ++i) {
    CHECK(checks[i].at - checks[i - 1].at == seconds(300));
  }
  const auto sent = site.on_air(type::siren_report).records();
  bool on_time = false;
  for (const host::Record& record : sent) {
    on_time =
        on_time || (record.from >= first_check && record.from < first_check + milliseconds(10));
  }
  CHECK(on_time);
  CHECK(site.reports(reason::wifi_report_failed).empty());
}

TEST_CASE("§6: the settings set the report and check intervals") {
  host::SirenConfig config;
  config.wifi_report_interval_seconds = 10;
  config.lora_check_interval_units = 4;  // 60 s
  SirenSite site({}, config);
  site.run_until(seconds(130));
  INFO(site.dump());
  const auto regular = site.reports(reason::regular, HubPath::link);
  REQUIRE(regular.size() >= 12);
  CHECK(regular.back().at - regular[regular.size() - 2].at == seconds(10));
  // The settings came at 0.15 s: checks at 60.15 and 120.15 s.
  CHECK(site.reports(reason::lora_check).size() == 2);
}

TEST_CASE(
    "SR6 D52: with the link down, reports go on LoRa at once and every interval, then "
    "back on Wi-Fi") {
  SirenSite site;
  site.sim.schedule(at(seconds(40)), [&]() {
    site.siren.board().network.fail_connect = true;
    site.hub.drop_link("siren", LinkKind::network);
  });
  site.sim.schedule(at(seconds(99)), [&]() { site.siren.board().network.fail_connect = false; });
  site.run_until(seconds(1));
  const device::Instant first = site.due(SirenTimer::wifi_report);
  site.run_until(seconds(200));
  INFO(site.dump());
  const auto failed = site.reports(reason::wifi_report_failed);
  // At once when the link went down, then at each regular report until the link is back: the
  // two that fall between 40 and 100 s.
  REQUIRE(failed.size() == 3);
  CHECK(failed[0].at < at(seconds(40) + milliseconds(200)));
  const device::Instant tick = next_in_rhythm(first, seconds(30), at(seconds(40)));
  for (std::size_t i = 1; i < failed.size(); ++i) {
    const device::Instant due = tick + seconds(30 * static_cast<std::int64_t>(i - 1));
    CHECK(failed[i].at > due);
    CHECK(failed[i].at < due + milliseconds(200));
  }
  for (const HubReport& report : failed) {
    CHECK(report.path == HubPath::radio);
    CHECK_FALSE(report.report.flags.wifi_connected);
  }
  // Reconnected at 100 s (attempts at 41, 43, 47, 55, 70, 100 s): Wi-Fi again, at once.
  const auto regular = site.reports(reason::regular, HubPath::link);
  REQUIRE_FALSE(regular.empty());
  bool back = false;
  for (const HubReport& report : regular) {
    back = back || (report.at > at(seconds(100)) && report.at < at(seconds(100) + seconds(1)));
    if (report.at > at(seconds(100))) {
      CHECK(report.report.flags.wifi_connected);
    }
  }
  CHECK(back);
  // D52: from its first report on, the hub was never more than a report interval without one.
  CHECK(longest_silence(site, at(seconds(1)), at(seconds(200))) <= seconds(31));
}

TEST_CASE("SR6: a report the link will not take goes on LoRa at once") {
  SirenSite site;
  site.sim.schedule(at(seconds(40)), [&]() { site.siren.board().network.refuse_sends = true; });
  site.sim.schedule(at(seconds(100)), [&]() { site.siren.board().network.refuse_sends = false; });
  site.run_until(seconds(1));
  const device::Instant first = site.due(SirenTimer::wifi_report);
  site.run_until(seconds(130));
  INFO(site.dump());
  const auto failed = site.reports(reason::wifi_report_failed);
  // The two regular reports between 40 and 100 s: refused, and on the air at once after a 3 ms
  // channel check.
  REQUIRE(failed.size() == 2);
  const device::Instant tick = next_in_rhythm(first, seconds(30), at(seconds(40)));
  CHECK(failed[0].at > tick);
  CHECK(failed[0].at < tick + milliseconds(150));
  CHECK(failed[1].at > tick + seconds(30));
  CHECK(failed[1].at < tick + seconds(30) + milliseconds(150));
  // The next one goes on Wi-Fi again.
  const auto regular = site.reports(reason::regular, HubPath::link);
  REQUIRE_FALSE(regular.empty());
  CHECK(regular.back().at == tick + seconds(60) + milliseconds(25));
  CHECK(site.logged(siren_log::wifi_report_failed).size() >= 1);
}

TEST_CASE("§7: the hub goes quiet; when the link reports down, a report goes on LoRa at once") {
  SirenSite site;
  // The hub stops answering at 10 s; the platform's ping notices 30 s later (a longer
  // silence than the platform's 15 s, so that exactly one report falls inside it).
  site.sim.schedule(at(seconds(10)),
                    [&]() { site.hub.drop_link("siren", LinkKind::network, seconds(30)); });
  site.run_until(seconds(70));
  INFO(site.dump());
  // The report in the silent half-minute went into the link and was lost.
  CHECK(site.on_wifi(type::siren_report).between(at(seconds(10)), at(seconds(40))).count() == 1);
  const auto failed = site.reports(reason::wifi_report_failed);
  REQUIRE(failed.size() == 1);
  CHECK(failed[0].at > at(seconds(40)));
  CHECK(failed[0].at < at(seconds(40) + milliseconds(200)));
  // Reconnected 1 s later, and reporting on Wi-Fi again at once.
  const auto regular = site.reports(reason::regular, HubPath::link);
  REQUIRE_FALSE(regular.empty());
  CHECK(regular.back().at > at(seconds(41)));
  CHECK(site.logged(siren_log::wifi_down).size() == 1);
  // A second outage starts the back-off again from 1 s.
  site.hub.drop_link("siren", LinkKind::network);
  const std::size_t connects = site.siren.board().network.connects;
  site.run_until(seconds(70) + milliseconds(990));
  CHECK(site.siren.board().network.connects == connects);
  site.run_until(seconds(71) + milliseconds(10));
  CHECK(site.siren.board().network.connects == connects + 1);
}

TEST_CASE("§7 HN(a)46: reconnects after 1, 2, 4, 8, 15, then every 30 s, to the paired hub") {
  SirenSite site;
  site.siren.board().network.fail_connect = true;
  struct Probe {
    device::Duration when;
    std::size_t connects;
  };
  // Boot at 0.05 s: tries at 0.05, 1.05, 3.05, 7.05, 15.05, 30.05, 60.05, 90.05 s.
  const Probe probes[] = {
      {milliseconds(60), 1},    {milliseconds(1040), 1},  {milliseconds(1060), 2},
      {milliseconds(3040), 2},  {milliseconds(3060), 3},  {milliseconds(7060), 4},
      {seconds(15), 4},         {milliseconds(15060), 5}, {milliseconds(30060), 6},
      {milliseconds(60040), 6}, {milliseconds(60060), 7}, {milliseconds(90060), 8}};
  std::vector<std::size_t> seen;
  for (const Probe& probe : probes) {
    site.sim.schedule(at(probe.when),
                      [&]() { seen.push_back(site.siren.board().network.connects); });
  }
  site.run_until(seconds(100));
  REQUIRE(seen.size() == std::size(probes));
  for (std::size_t i = 0; i < seen.size(); ++i) {
    INFO("probe at " << at(probes[i].when));
    CHECK(seen[i] == probes[i].connects);
  }
  // HN(a)47: the target is the paired hub and network.
  const device::LinkTarget& target = site.siren.board().network.last_target;
  const protocol::HubIdentity paired{9, 8, 7, 6, 5, 4, 3, 2};
  CHECK(target.hub == paired);
  CHECK(std::string(target.wifi_name.begin(), target.wifi_name.end()) == "home");
  CHECK(std::string(target.wifi_password.begin(), target.wifi_password.end()) == "secret");
  CHECK(site.logged(siren_log::wifi_connect_failed).empty());  // never up, so not yet sent
}

TEST_CASE(
    "§7: a connect that the hub never answers fails when the link reports down, then "
    "backs off") {
  host::SirenConfig no_hub;
  no_hub.wifi = false;
  SirenSite site({}, no_hub);
  site.run_until(seconds(60));
  const auto downs = site.siren.records().kind(RecordKind::link_down).records();
  // Connects at 0.05, 16.05 and 33.05 s; each reported down 15 s later.
  REQUIRE(downs.size() == 3);
  CHECK(downs[0].at == at(seconds(15) + milliseconds(50)));
  CHECK(downs[1].at == at(seconds(31) + milliseconds(50)));
  CHECK(downs[2].at == at(seconds(48) + milliseconds(50)));
  CHECK(site.siren.board().network.connects == 4);
}

TEST_CASE("§6 FW8: Started goes once per start-up, on Wi-Fi when the link comes up") {
  SirenSite site;
  site.siren.board().hal().build.version = protocol::FirmwareVersion{1, 2, 3};
  site.siren.restart(at(seconds(50)));
  site.run_until(seconds(120));
  INFO(site.dump());
  const auto started = site.hub.received_from("siren", type::started);
  REQUIRE(started.size() == 2);
  const auto first = started[0].as<protocol::Started>();
  CHECK(started[0].path == HubPath::link);
  CHECK(started[0].at == at(seconds(0) + milliseconds(125)));
  CHECK(first.role == protocol::Role::siren);
  CHECK(first.firmware_version.major == 1);
  CHECK(first.firmware_version.minor == 2);
  CHECK(first.firmware_version.patch == 3);
  CHECK(first.reset_cause == 1);       // power-on
  CHECK(first.settings_version == 0);  // none held yet
  const auto second = started[1].as<protocol::Started>();
  CHECK(started[1].path == HubPath::link);
  CHECK(second.reset_cause == 3);       // software restart
  CHECK(second.settings_version == 1);  // from flash
  CHECK(site.on_air(type::started).empty());
}

TEST_CASE("§6: Started goes on LoRa when Wi-Fi has not come up 30 s after the start-up") {
  SirenSite site;
  site.siren.board().network.fail_connect = true;
  site.sim.schedule(at(seconds(50)), [&]() { site.siren.board().network.fail_connect = false; });
  site.run_until(seconds(120));
  INFO(site.dump());
  const auto started = site.hub.received_from("siren", type::started);
  REQUIRE(started.size() == 1);
  CHECK(started[0].path == HubPath::radio);
  const auto on_air = site.on_air(type::started).records();
  REQUIRE(on_air.size() == 1);
  CHECK(on_air[0].from >= at(seconds(30) + milliseconds(50)));
  CHECK(on_air[0].from < at(seconds(30) + milliseconds(60)));
  // Wi-Fi came up at 60.05 s: no second Started.
  CHECK(site.on_wifi(type::started).empty());
  CHECK_FALSE(site.reports(reason::regular, HubPath::link).empty());
}

TEST_CASE("FW5: a stored fatal error is reported in Started and then cleared") {
  SirenSite site;
  const std::array<std::uint8_t, 2> code{0x04, 0x00};
  REQUIRE(site.siren.board().storage.write(StoreKey::fatal_error, protocol::ByteView(code)) ==
          device::HalError::none);
  site.siren.restart(at(seconds(20)));
  site.run_until(seconds(40));
  const auto started = site.hub.received_from("siren", type::started);
  REQUIRE(started.size() == 2);
  CHECK(started[0].as<protocol::Started>().last_fatal_error == 4);
  CHECK(started[1].as<protocol::Started>().last_fatal_error == 0);
  CHECK_FALSE(site.siren.board().storage.has(StoreKey::fatal_error));
}

TEST_CASE("§6 D109: flags, cell voltage and temperature as the board reads them") {
  SirenSite site;
  host::FakeSirenIo& io = site.siren.board().siren_io;
  io.cell = true;
  io.cell_mv = 3700;
  io.charge = true;
  io.temperature_c = -5;
  site.siren.board().power.external = true;
  site.run_until(seconds(31));
  const auto regular = site.reports(reason::regular, HubPath::link);
  REQUIRE_FALSE(regular.empty());
  const protocol::SirenReport& report = regular.back().report;
  CHECK(report.flags.on_mains);
  CHECK(report.flags.cell_fitted);
  CHECK(report.flags.charging);
  CHECK_FALSE(report.flags.cover_open);
  CHECK(report.flags.wifi_connected);
  CHECK(report.cell_battery_code == 120);  // (3,700 − 2,500) ÷ 10
  CHECK(report.temperature_celsius == -5);
  CHECK(report.settings_version == 1);
  // Mains goes: reported at once, on the backup cell, and logged.
  site.siren.set_input(Input::external_power, false, at(seconds(40)));
  site.run_until(seconds(41));
  const auto after = site.reports(reason::regular, HubPath::link);
  REQUIRE(after.size() == regular.size() + 1);
  CHECK(after.back().at == at(seconds(40) + milliseconds(25)));
  CHECK_FALSE(after.back().report.flags.on_mains);
  CHECK(after.back().report.flags.cell_fitted);
  CHECK(site.logged(siren_log::mains_lost).size() == 1);
}

TEST_CASE("§6: with no cell fitted the cell byte is 0") {
  SirenSite site;
  site.siren.board().siren_io.cell_mv = 4000;
  site.run_until(seconds(31));
  const auto regular = site.reports(reason::regular, HubPath::link);
  REQUIRE_FALSE(regular.empty());
  CHECK_FALSE(regular.back().report.flags.cell_fitted);
  CHECK(regular.back().report.cell_battery_code == 0);
}

TEST_CASE("task item 5: opening the cover is reported at once, on LoRa when Wi-Fi is down") {
  SirenSite site;
  site.siren.set_input(Input::cover, true, at(seconds(40)));
  site.sim.schedule(at(seconds(50)), [&]() {
    site.siren.board().network.fail_connect = true;
    site.hub.drop_link("siren", LinkKind::network);
  });
  site.siren.set_input(Input::cover, false, at(seconds(70)));
  site.run_until(seconds(72));
  INFO(site.dump());
  const auto regular = site.reports(reason::regular, HubPath::link);
  REQUIRE_FALSE(regular.empty());
  bool opened = false;
  for (const HubReport& report : regular) {
    opened = opened ||
             (report.at == at(seconds(40) + milliseconds(25)) && report.report.flags.cover_open);
  }
  CHECK(opened);
  CHECK(site.logged(siren_log::cover_opened).size() == 1);
  // Closed while Wi-Fi is down: on LoRa at once.
  const auto failed = site.reports(reason::wifi_report_failed);
  REQUIRE_FALSE(failed.empty());
  CHECK(failed.back().at > at(seconds(70)));
  CHECK(failed.back().at < at(seconds(70) + milliseconds(200)));
  CHECK_FALSE(failed.back().report.flags.cover_open);
}

/** Where a timer first falls after `from`, as a fraction of `interval` in tenths, 0 to 9. */
std::size_t decile(Instant due, Instant from, device::Duration interval) {
  const device::Duration offset = due - from;
  REQUIRE(offset > device::Duration{});
  REQUIRE(offset <= interval);
  return static_cast<std::size_t>((offset.us - 1) * 10 / interval.us);
}

TEST_CASE(
    "§7: the first report and the first check fall anywhere in their interval, never "
    "beyond it, and differ from board to board") {
  constexpr std::uint64_t kBoards = 200;
  std::array<std::size_t, 10> reports{};
  std::array<std::size_t, 10> checks{};
  std::array<std::size_t, 10> changed{};
  Instant previous;
  std::size_t repeats = 0;
  for (std::uint64_t seed = 1; seed <= kBoards; ++seed) {
    Bench bench(seed);
    bench.boot(BootKind::power_on, at_seconds(1));
    const Instant report = bench.state().timers.at(SirenTimer::wifi_report);
    reports[decile(report, at_seconds(1), seconds(30))] += 1;
    checks[decile(bench.state().timers.at(SirenTimer::lora_check), at_seconds(1), seconds(300))] +=
        1;
    repeats += report == previous ? 1u : 0u;
    previous = report;
    // New settings with a new interval start it at a random point too.
    bench.link_up(at_seconds(2));
    protocol::SirenSettings settings;
    settings.settings_version = 2;
    settings.wifi_report_interval_seconds = 20;
    settings.lora_check_interval_units = 20;
    settings.max_sound_seconds = 300;
    settings.send_data_rate = 5;
    settings.command_data_rate = 5;
    bench.wifi_packet(
        hub_packet(settings, 10, protocol::Binding::none(), kAddress, protocol::PacketLimit::link),
        at_seconds(5));
    changed[decile(bench.state().timers.at(SirenTimer::wifi_report), at_seconds(5), seconds(20))] +=
        1;
  }
  // Every tenth of each interval is used, so boards started together spread out.
  for (std::size_t i = 0; i < 10; ++i) {
    INFO("tenth " << i);
    CHECK(reports[i] > 0);
    CHECK(checks[i] > 0);
    CHECK(changed[i] > 0);
  }
  CHECK(repeats == 0);
}

TEST_CASE("§7: after the random first one, the rhythm is the interval") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  const Instant first = bench.state().timers.at(SirenTimer::wifi_report);
  const Instant first_check = bench.state().timers.at(SirenTimer::lora_check);
  // The link coming up reports at once but keeps the phase: sirens whose links come up together
  // must not line up again.
  bench.link_up(at_seconds(2));
  CHECK(bench.state().timers.at(SirenTimer::wifi_report) == first);
  // Each runs when due, earlier one first, and is next due one interval later.
  const auto report_rhythm = [&]() {
    bench.timer(first);
    CHECK(bench.state().timers.at(SirenTimer::wifi_report) == first + seconds(30));
  };
  const auto check_rhythm = [&]() {
    bench.timer(first_check);
    CHECK(bench.state().timers.at(SirenTimer::lora_check) == first_check + seconds(300));
  };
  if (first <= first_check) {
    report_rhythm();
    check_rhythm();
  } else {
    check_rhythm();
    report_rhythm();
  }
}

}  // namespace
}  // namespace hsn::test::siren
