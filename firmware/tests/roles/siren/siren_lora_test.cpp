// LoRa (protocol sections 2 and 7; SR1, D36, D101, D108, FW7, FW9): continuous receive on
// 869.525 MHz at the command rate held, sending on the site channel at the sending rate after a
// channel check, answers first when airtime runs low, the gateway path, and radio faults.

#include "sim_support.hpp"
#include "siren_bench.hpp"
#include "siren_support.hpp"

namespace hsn::test::siren {
namespace {

using device::LinkKind;
using host::RadioCall;
using roles::siren::SirenTimer;

constexpr std::uint32_t kSiteFrequencyHz = 868300000;  // site channel 1, the hub's default
constexpr std::uint32_t kReplyFrequencyHz = 869525000;

/** The siren's receive windows. */
std::vector<host::Record> windows(const SirenSite& site) {
  return site.siren.records().kind(RecordKind::rx_window).records();
}

TEST_CASE("SR1 D108: it listens continuously on 869.525 MHz at the command rate it holds") {
  host::SirenConfig config;
  config.command_data_rate = protocol::DataRate::dr3;
  SirenSite site({}, config);
  site.sim.schedule(at(seconds(60)), [&]() {
    host::SirenConfig faster = config;
    faster.command_data_rate = protocol::DataRate::dr4;
    site.hub.change_siren("siren", faster);
  });
  site.run_until(seconds(90));
  INFO(site.dump());
  const auto opened = windows(site);
  REQUIRE(opened.size() >= 3);
  // Before any settings, at its own sending rate: the fastest the pairing allows, DR5.
  CHECK(opened[0].at == at(milliseconds(50)));
  CHECK(opened[0].value == 1u << protocol::DataRate::dr5);
  for (const host::Record& window : opened) {
    CHECK(window.frequency_hz == kReplyFrequencyHz);
    CHECK(window.until.is_never());
  }
  // Version 1's DR3 from 0.15 s; version 2's DR4 from 60.025 s.
  bool dr3 = false;
  bool dr4 = false;
  for (const host::Record& window : opened) {
    dr3 = dr3 || (window.value == 1u << protocol::DataRate::dr3 && window.at < at(seconds(1)));
    dr4 = dr4 || (window.value == 1u << protocol::DataRate::dr4 &&
                  window.at == at(seconds(60) + milliseconds(25)));
  }
  CHECK(dr3);
  CHECK(dr4);
  CHECK(opened.back().value == 1u << protocol::DataRate::dr4);
  // It hears the hub's commands at the new rate.
  site.command_at(seconds(90), action::test, 5);
  site.run_until(seconds(92));
  CHECK_FALSE(site.siren.records().kind(RecordKind::reception).type(type::siren_command).empty());
}

TEST_CASE(
    "SR1 §2: every transmission is on the site channel at the sending rate, after a check, "
    "and receive resumes when it ends") {
  host::SirenConfig config;
  config.send_data_rate = protocol::DataRate::dr2;
  SirenSite site({}, config);
  site.command_at(seconds(10), action::test, 5);
  site.run_until(seconds(320));
  INFO(site.dump());
  const auto sent = site.siren.records().kind(RecordKind::transmission).records();
  const auto checks = site.siren.records().kind(RecordKind::channel_check).records();
  REQUIRE(sent.size() >= 3);  // the settings' LoRa answer, the command's, the LoRa check
  REQUIRE(checks.size() == sent.size());
  for (std::size_t i = 0; i < sent.size(); ++i) {
    INFO("transmission at " << sent[i].at);
    CHECK(sent[i].frequency_hz == kSiteFrequencyHz);
    CHECK(sent[i].rssi_dbm == 14);
    if (sent[i].at > at(seconds(1))) {
      CHECK(sent[i].data_rate == protocol::DataRate::dr2);
    }
    CHECK(checks[i].at == sent[i].at);
    CHECK(checks[i].frequency_hz == kSiteFrequencyHz);
    CHECK_FALSE(site.siren.records()
                    .kind(RecordKind::rx_window)
                    .between(sent[i].until, sent[i].until + milliseconds(1))
                    .empty());
  }
}

TEST_CASE("§2: a report never cuts off a command that is arriving") {
  host::SirenConfig no_wifi;
  no_wifi.wifi = false;
  SirenSite site({}, no_wifi);
  site.run_until(seconds(1));
  // A regular report due after the start-up's traffic, with a command on the air from 50 ms
  // before it.
  const device::Instant due =
      next_in_rhythm(site.due(SirenTimer::wifi_report), seconds(30), at(seconds(45)));
  site.command_at(due - at(milliseconds(50)), action::sound_alarm, 30);
  site.sim.run_until(due + seconds(1));
  INFO(site.dump());
  const auto heard =
      site.siren.records().kind(RecordKind::reception).type(type::siren_command).records();
  REQUIRE(heard.size() == 1);
  CHECK(heard[0].at < due + milliseconds(10));
  CHECK(site.sounding());
  // The report waited for the command's end, then the answer came first.
  const auto sent =
      site.on_air(type::siren_report).between(due + milliseconds(-50), due + seconds(1));
  REQUIRE(sent.count() == 2);
  CHECK(sent.records()[0].from >= heard[0].at);
}

TEST_CASE("§2 LR5: when routine airtime runs out, answers still go and the limit holds") {
  host::SirenConfig slow;
  slow.wifi = false;
  slow.send_data_rate = protocol::DataRate::dr0;  // 1.65 s per report
  SirenSite site({}, slow);
  // With Wi-Fi gone, a report every 30 s on LoRa would need 198 s an hour.
  site.command_at(seconds(15 * 60), action::sound_alarm, 30);
  site.command_at(seconds(25 * 60), action::off, 0);
  site.run_until(seconds(2 * 3600));
  INFO(site.dump());
  const auto answers = site.reports(reason::command_answer, HubPath::radio);
  bool sound_answered = false;
  bool off_answered = false;
  for (const HubReport& report : answers) {
    sound_answered = sound_answered ||
                     (report.at > at(seconds(15 * 60)) && report.at < at(seconds(15 * 60 + 5)) &&
                      report.report.state == protocol::SirenState::sounding_alarm);
    off_answered =
        off_answered || (report.at > at(seconds(25 * 60)) && report.at < at(seconds(25 * 60 + 5)) &&
                         report.report.state == protocol::SirenState::off);
  }
  CHECK(sound_answered);
  CHECK(off_answered);
  // Routine reports were held back for airtime, and the hour's limit was never passed.
  CHECK(site.reports(reason::wifi_report_failed).size() < 2 * 3600 / 30 / 4);
  // A packet that waited for airtime used no counter: every counter on the air is the next one.
  const auto counters = site.siren.records().kind(RecordKind::transmission).records();
  for (std::size_t i = 1; i < counters.size(); ++i) {
    CHECK(counters[i].label.counter == counters[i - 1].label.counter + 1);
  }
  const host::Selection sent = site.siren.records().kind(RecordKind::transmission);
  CHECK(sent.busiest_hour() <= seconds(36));
  // Routine traffic, everything but Started and the two answers, kept to four fifths (§2).
  const auto essential = [](const host::Record& r) {
    const auto near = [&r](std::int64_t s) {
      return r.from >= at(seconds(s)) && r.from < at(seconds(s + 5));
    };
    return r.label.type == type::started || near(15 * 60) || near(25 * 60);
  };
  CHECK(sent.where([&](const host::Record& r) { return !essential(r); }).busiest_hour() <=
        milliseconds(28800));
}

TEST_CASE("§2 D73: LoRa checks are routine: they never use the hour's last fifth") {
  host::SirenConfig busy;
  busy.send_data_rate = protocol::DataRate::dr0;
  busy.lora_check_interval_units = 1;  // every 15 s: 396 s of airtime an hour if unchecked
  SirenSite site({}, busy);
  site.run_until(seconds(2 * 3600));
  const host::Selection checks =
      site.on_air(type::siren_report).between(at(seconds(60)), at(seconds(2 * 3600)));
  CHECK(checks.count() > 20);
  CHECK(checks.busiest_hour() <= milliseconds(28800));
  CHECK_FALSE(site.reports(reason::lora_check).empty());
}

TEST_CASE("D101 FW9: through a gateway, the same packets carry commands and reports") {
  host::HubOptions options;
  options.mode = host::HubMode::gateway_link;
  host::Simulation sim;
  host::TestHub hub(sim, options);
  ScriptGatewayLog gateway_log;
  host::DeviceSpec gateway_spec;
  gateway_spec.name = "gateway";
  gateway_spec.role = script_gateway(ScriptGatewayConfig{}, gateway_log);
  hub.add_gateway(sim.add_device(gateway_spec));
  host::DeviceSpec siren_spec;
  siren_spec.name = "siren";
  siren_spec.role = siren_role();
  host::SimDevice& siren = sim.add_device(siren_spec);
  host::SirenConfig config;
  config.wifi = false;
  hub.add_siren(siren, config);
  sim.schedule(at(seconds(60)), [&]() { hub.command_siren("siren", action::sound_alarm, 300); });
  sim.run_until(at(seconds(320)));
  INFO(siren.records().dump() << hub.dump());
  CHECK(siren.board().siren_io.output_state);
  const auto reports = hub.received_from("siren", type::siren_report);
  bool answered = false;
  bool checked = false;
  for (const host::HubPacket& packet : reports) {
    CHECK(packet.path == HubPath::gateway);
    const auto report = packet.as<protocol::SirenReport>();
    answered = answered || report.reason == reason::command_answer;
    checked = checked || report.reason == reason::lora_check;
  }
  CHECK(answered);
  CHECK(checked);
  CHECK(hub.decisions(HubAction::siren_confirmed, "siren").size() >= 2);
}

TEST_CASE("FW7: a radio that refuses is tried again every second, and comes back") {
  SirenSite site;
  site.run_until(seconds(1));
  // The second LoRa check, well clear of the start-up; the radio refuses everything around it.
  const device::Instant due = site.due(SirenTimer::lora_check) + seconds(300);
  site.sim.schedule(due + seconds(-1), [&]() { site.siren.board().radio.refuse_all = true; });
  site.sim.schedule(due + milliseconds(2500),
                    [&]() { site.siren.board().radio.refuse_all = false; });
  site.sim.run_until(due + seconds(10));
  INFO(site.dump());
  // Tried at the due time and every second after: it went on the first try after the radio came
  // back, 3 s late.
  const auto checks = site.on_air(type::siren_report).between(due + seconds(-1), due + seconds(10));
  REQUIRE(checks.count() == 1);
  CHECK(checks.records()[0].from > due + seconds(3));
  CHECK(checks.records()[0].from < due + seconds(3) + milliseconds(100));
  CHECK(site.reports(reason::lora_check).size() == 2);
  // Receive came back too, and both faults reached the hub.
  CHECK(windows(site).back().at > due + seconds(3));
  CHECK_FALSE(site.logged(siren_log::lora_not_sent).empty());
  CHECK_FALSE(site.logged(siren_log::listen_failed).empty());
}

TEST_CASE("FW7: receive refused at start-up is tried again every second") {
  SirenSite site;
  site.siren.board().radio.refuse_all = true;
  site.sim.schedule(at(seconds(5)), [&]() { site.siren.board().radio.refuse_all = false; });
  site.run_until(seconds(10));
  INFO(site.dump());
  const auto opened = windows(site);
  REQUIRE_FALSE(opened.empty());
  // Nothing else happens until the 30 s report; the retry alone brings receive back.
  CHECK(opened[0].at > at(seconds(5)));
  CHECK(opened[0].at < at(seconds(6)));
}

TEST_CASE("§4 design: a radio fault while listening resets the radio and listening resumes") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  REQUIRE(bench.board.radio.calls_of(RadioCall::Kind::receive).size() == 1);
  bench.radio_event(bench.board.radio.fault(at_seconds(5)), at_seconds(5));
  CHECK(bench.board.radio.calls_of(RadioCall::Kind::recover).size() == 1);
  const auto receives = bench.board.radio.calls_of(RadioCall::Kind::receive);
  REQUIRE(receives.size() == 2);
  CHECK(receives[1].at == at_seconds(5));
  CHECK(receives[1].rx.channel.frequency_hz == kReplyFrequencyHz);
  CHECK(receives[1].rx.timeout == device::Duration{});
}

TEST_CASE("§4 design: a send whose end never comes is recovered and sent again") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  // Wi-Fi never comes up: at 31 s Started goes on LoRa.
  bench.wait_until(at_seconds(31));
  REQUIRE(bench.board.radio.calls_of(RadioCall::Kind::detect_activity).size() == 1);
  bench.radio_event(bench.board.radio.cad_done(at_seconds(31), false), at_seconds(31));
  REQUIRE(bench.board.radio.calls_of(RadioCall::Kind::transmit).size() == 1);
  // No tx_done: the port's guard passes, the radio is recovered, and the item waits 1 s.
  const device::Instant guard = bench.wake().at;
  CHECK(guard < at_seconds(32));
  bench.wait_until(guard);
  CHECK(bench.board.radio.calls_of(RadioCall::Kind::recover).size() == 1);
  CHECK(bench.state().lora.started);
  bench.wait_until(guard + seconds(1));
  CHECK(bench.board.radio.calls_of(RadioCall::Kind::detect_activity).size() == 2);
  CHECK(bench.state().lora.in_flight == roles::siren::LoraItem::started);
}

}  // namespace
}  // namespace hsn::test::siren
