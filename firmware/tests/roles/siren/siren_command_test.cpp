// Commands on two paths, one counter (protocol sections 4 and 7; SR2, SR3, SR4, SR7, D7, D36,
// D73, HN(a)40): the first copy is acted on and answered on its path, a repeat is answered again
// without a flash write, an older counter gets nothing, and the hub's one-at-a-time rule holds.

#include "device_support.hpp"
#include "siren_support.hpp"

namespace hsn::test::siren {
namespace {

using device::LinkKind;
using device::StoreKey;

/** The hub's counter of the n-th siren command it sealed (copies on both paths count once). */
std::uint32_t command_counter(const SirenSite& site, std::size_t n = 0) {
  std::vector<std::uint32_t> counters;
  for (const host::HubSent& sent : site.hub.sent_to("siren", type::siren_command)) {
    if (counters.empty() || counters.back() < sent.counter) {
      counters.push_back(sent.counter);
    }
  }
  REQUIRE(counters.size() > n);
  return counters[n];
}

/** Answers (reason 1) naming one counter, on one path. */
std::vector<HubReport> answers_to(const SirenSite& site, std::uint32_t counter, HubPath path) {
  std::vector<HubReport> found;
  for (const HubReport& report : site.reports(reason::command_answer, path)) {
    if (report.report.last_command_counter_low == (counter & 0xFFFFu)) {
      found.push_back(report);
    }
  }
  return found;
}

TEST_CASE(
    "SR7 D73: the Wi-Fi copy comes first; it is acted on, and both copies are answered "
    "on their own paths") {
  SirenSite site;
  site.command_at(seconds(10), action::sound_alarm, 60);
  site.run_until(seconds(12));
  INFO(site.dump());
  const std::uint32_t counter = command_counter(site);
  // Acted on once, when the Wi-Fi copy arrived 25 ms after the hub sent it.
  const auto outputs = site.outputs();
  REQUIRE(outputs.size() == 1);
  CHECK(outputs[0].first == at(seconds(10) + milliseconds(25)));
  CHECK(outputs[0].second);
  // One counter write, before the first answer; the LoRa copy wrote nothing.
  CHECK(site.siren.records()
            .kind(RecordKind::flash_write)
            .between(at(seconds(5)), at(seconds(12)))
            .count() == 1);
  CHECK(site.flash_writes(StoreKey::command_counter) == 2);  // settings at start-up, then this
  // Answered on Wi-Fi, then the LoRa copy answered on LoRa: both name the command.
  const auto by_wifi = answers_to(site, counter, HubPath::link);
  const auto by_lora = answers_to(site, counter, HubPath::radio);
  REQUIRE(by_wifi.size() == 1);
  REQUIRE(by_lora.size() == 1);
  CHECK(by_wifi[0].at < by_lora[0].at);
  CHECK(by_wifi[0].report.state == protocol::SirenState::sounding_alarm);
  CHECK(by_wifi[0].report.sounding_seconds_left == 60);
  CHECK(by_lora[0].report.state == protocol::SirenState::sounding_alarm);
  const auto confirmed = site.hub.decisions(HubAction::siren_confirmed, "siren");
  REQUIRE(confirmed.size() == 2);
  CHECK(confirmed[1].value == static_cast<std::int64_t>(HubPath::link));
}

TEST_CASE(
    "SR7 D73: the LoRa copy comes first; it is acted on, and the Wi-Fi copy is answered "
    "as a repeat") {
  host::HubOptions slow_wifi;
  slow_wifi.link_latency = milliseconds(300);
  SirenSite site(slow_wifi);
  site.command_at(seconds(10), action::test, 20);
  site.run_until(seconds(12));
  INFO(site.dump());
  const std::uint32_t counter = command_counter(site);
  const auto outputs = site.outputs();
  REQUIRE(outputs.size() == 1);
  // The LoRa copy ended 56.6 ms after the hub started it; Wi-Fi took 300 ms.
  CHECK(outputs[0].first < at(seconds(10) + milliseconds(100)));
  CHECK(site.siren.records()
            .kind(RecordKind::flash_write)
            .between(at(seconds(5)), at(seconds(12)))
            .count() == 1);
  const auto by_lora = answers_to(site, counter, HubPath::radio);
  const auto by_wifi = answers_to(site, counter, HubPath::link);
  REQUIRE(by_lora.size() == 1);
  REQUIRE(by_wifi.size() == 1);
  CHECK(by_lora[0].report.state == protocol::SirenState::testing);
  // The repeat is answered the same way: the same state, the same counter.
  CHECK(by_wifi[0].report.state == protocol::SirenState::testing);
  CHECK(by_wifi[0].report.sounding_seconds_left <= 20);
  CHECK(site.hub.decisions(HubAction::siren_confirmed, "siren").back().value ==
        static_cast<std::int64_t>(HubPath::radio));
  // Nothing else happened for the repeat: the stop time is still 20 s from the LoRa copy.
  const auto heard =
      site.siren.records().kind(RecordKind::reception).type(type::siren_command).records();
  REQUIRE_FALSE(heard.empty());
  site.run_until(seconds(32));
  const auto later = site.outputs();
  REQUIRE(later.size() == 2);
  CHECK(later[1].first == heard[0].at + seconds(20));
}

TEST_CASE("D36: with Wi-Fi gone, the LoRa copy alone is acted on and answered on LoRa") {
  host::SirenConfig no_wifi;
  no_wifi.wifi = false;
  SirenSite site({}, no_wifi);
  site.command_at(seconds(60), action::sound_alarm, 30);
  site.run_until(seconds(62));
  INFO(site.dump());
  CHECK(site.sounding());
  const auto by_lora = answers_to(site, command_counter(site), HubPath::radio);
  REQUIRE(by_lora.size() == 1);
  CHECK(by_lora[0].report.state == protocol::SirenState::sounding_alarm);
  CHECK(site.siren.records().kind(RecordKind::link_sent).empty());
}

TEST_CASE("D36: with the radio cut, the Wi-Fi copy alone is acted on and answered on Wi-Fi") {
  SirenSite site;
  site.sim.medium().cut(site.siren.station(), site.hub.station());
  site.command_at(seconds(10), action::sound_alarm, 30);
  site.run_until(seconds(15));
  INFO(site.dump());
  CHECK(site.sounding());
  const std::uint32_t counter = command_counter(site);
  CHECK(answers_to(site, counter, HubPath::link).size() == 1);
  // No copy came by LoRa, so nothing was answered there.
  CHECK(site.on_air(type::siren_report).empty());
}

TEST_CASE("SR4 HN(a)40: every repeat of the latest is answered, with one flash write in all") {
  SirenSite site;
  // The siren hears every copy, but none of its answers reach the hub: the hub repeats for a
  // minute, every 2 s on Wi-Fi and every 5 s on LoRa.
  site.sim.schedule(at(seconds(5)), [&]() {
    site.siren.board().network.refuse_sends = true;
    site.sim.medium().set_path_loss_one_way(site.siren.station(), site.hub.station(), 200);
  });
  site.command_at(seconds(10), action::sound_alarm, 120);
  site.run_until(seconds(75));
  INFO(site.dump());
  const auto copies = site.hub.sent_to("siren", type::siren_command);
  REQUIRE(copies.size() >= 40);
  CHECK(site.hub.decisions(HubAction::siren_unreachable, "siren").size() == 1);
  // One write and one switch-on for the command, however many copies came.
  CHECK(site.siren.records()
            .kind(RecordKind::flash_write)
            .between(at(seconds(5)), at(seconds(75)))
            .count() == 1);
  CHECK(site.outputs().size() == 1);
  // Every copy the siren heard is answered within a second, on LoRa: the Wi-Fi answers were
  // refused, so they go there too.
  const auto heard = site.siren.records()
                         .kind(RecordKind::link_received)
                         .kind(RecordKind::reception)
                         .type(type::siren_command)
                         .records();
  CHECK(heard.size() >= 35);
  for (const host::Record& copy : heard) {
    INFO("copy at " << copy.at);
    CHECK_FALSE(site.on_air(type::siren_report).between(copy.at, copy.at + seconds(1)).empty());
  }
}

TEST_CASE("§7: a late copy of an older command is dropped in silence") {
  host::SirenConfig slow_commands;
  slow_commands.command_data_rate = protocol::DataRate::dr0;  // 1.48 s on air
  SirenSite site({}, slow_commands);
  site.command_at(seconds(10), action::sound_alarm, 60);
  // A newer command replaces it while its LoRa copy is still on the air.
  site.command_at(seconds(10) + milliseconds(500), action::off, 0);
  site.run_until(seconds(20));
  INFO(site.dump());
  const auto commands = site.hub.sent_to("siren", type::siren_command);
  REQUIRE(commands.size() >= 3);
  const std::uint32_t older = command_counter(site, 0);
  // The older LoRa copy ended at 11.48 s, after the newer command had come by Wi-Fi.
  const auto heard =
      site.siren.records().kind(RecordKind::reception).type(type::siren_command).records();
  REQUIRE(heard.size() >= 2);
  CHECK(heard[0].label.counter == older);
  CHECK(heard[0].at > at(seconds(11)));
  // Nothing went out for it: no answer, no write, no switch.
  CHECK(site.on_air(type::siren_report).between(heard[0].at, heard[1].at).empty());
  CHECK(answers_to(site, older, HubPath::radio).empty());
  const auto outputs = site.outputs();
  REQUIRE(outputs.size() == 2);
  CHECK(outputs[1].first == at(seconds(10) + milliseconds(525)));
  CHECK_FALSE(outputs[1].second);
  CHECK_FALSE(site.sounding());
  CHECK(site.flash_writes(StoreKey::command_counter) == 3);
}

TEST_CASE(
    "§7 one at a time: settings wait for an unconfirmed command, then come and are "
    "answered") {
  SirenSite site;
  site.command_at(seconds(10), action::test, 30);
  site.sim.schedule(at(seconds(10) + milliseconds(1)),
                    [&]() { site.hub.change_siren("siren", settings_with(20)); });
  site.run_until(seconds(13));
  INFO(site.dump());
  const auto received = site.siren.records().kind(RecordKind::link_received).records();
  // At start-up the settings of version 1; then the command, then version 2's settings.
  REQUIRE(received.size() == 3);
  CHECK(received[1].label.type == type::siren_command);
  CHECK(received[2].label.type == type::siren_settings);
  CHECK(received[1].label.counter < received[2].label.counter);
  CHECK(site.role().state().settings.settings_version == 2);
  CHECK(site.role().state().settings.max_sound_seconds == 20);
  // The settings' answer names them and the version they bring.
  const auto answered = answers_to(site, received[2].label.counter, HubPath::link);
  REQUIRE(answered.size() == 1);
  CHECK(answered[0].report.settings_version == 2);
  // The command was carried out before the new cap came, so it keeps its 30 s.
  CHECK(answered[0].report.state == protocol::SirenState::testing);
  CHECK(answered[0].report.sounding_seconds_left == 30);
}

TEST_CASE("§7 one at a time: a newer command replaces a waiting one; each is acted on in turn") {
  SirenSite site;
  site.command_at(seconds(10), action::sound_alarm, 90);
  site.command_at(seconds(10) + milliseconds(10), action::test, 15);
  site.run_until(seconds(30));
  INFO(site.dump());
  const auto outputs = site.outputs();
  REQUIRE(outputs.size() == 2);
  CHECK(outputs[0].second);
  // The second command's 15 s count from its arrival, 10.035 s.
  CHECK(outputs[1].first == at(seconds(25) + milliseconds(35)));
  CHECK_FALSE(outputs[1].second);
}

TEST_CASE("SR2 D7: nothing but a hub command switches the output") {
  SirenSite site;
  site.siren.set_input(device::Input::cover, true, at(seconds(20)));
  site.siren.set_input(device::Input::external_power, true, at(seconds(30)));
  site.siren.set_input(device::Input::external_power, false, at(seconds(40)));
  site.run_until(seconds(100));
  INFO(site.dump());
  CHECK(site.outputs().empty());
  CHECK(site.reports().size() >= 5);
  site.command_at(seconds(100), action::sound_alarm, 10);
  site.run_until(seconds(101));
  CHECK(site.outputs().size() == 1);
}

TEST_CASE("SR3: a forged packet and a replayed older command change nothing") {
  SirenSite site;
  site.command_at(seconds(10), action::sound_alarm, 120);
  site.command_at(seconds(20), action::off, 0);
  site.run_until(seconds(30));
  const auto sound = site.hub.sent_to("siren", type::siren_command)[0];
  const std::size_t answers_before = site.reports(reason::command_answer).size();
  host::LinkWire& wire = site.siren.wire(LinkKind::network);
  // Sealed with a key that is not the siren's.
  protocol::SirenCommand forged;
  forged.action = action::sound_alarm;
  forged.sound_seconds = 600;
  const std::uint32_t address = site.siren.services()->channel.address();
  wire.send_to_device(
      hub_packet(forged, 1000, protocol::Binding::none(), address, protocol::PacketLimit::link));
  site.run_until(seconds(31));
  // The hub's own sound command again, after the newer off.
  wire.send_to_device(sound.packet);
  site.run_until(seconds(32));
  INFO(site.dump());
  CHECK_FALSE(site.sounding());
  CHECK(site.outputs().size() == 2);
  CHECK(site.reports(reason::command_answer).size() == answers_before);
  // The forgery is a fault and is logged; the replay is expected and is not.
  CHECK(site.logged(siren_log::packet_dropped).size() == 1);
  CHECK(site.flash_writes(StoreKey::command_counter) == 3);
}

TEST_CASE("§3: an action the siren does not know does nothing and is still answered") {
  SirenSite site;
  site.command_at(seconds(10), 9, 30);
  site.run_until(seconds(12));
  INFO(site.dump());
  CHECK(site.outputs().empty());
  const auto answered = answers_to(site, command_counter(site), HubPath::link);
  REQUIRE(answered.size() == 1);
  CHECK(answered[0].report.state == protocol::SirenState::off);
  const auto logged = site.logged(siren_log::unknown_action);
  REQUIRE(logged.size() == 1);
  CHECK(logged[0].text == "unknown action 9");
}

TEST_CASE("§6: report now is answered with the current state and changes nothing") {
  SirenSite site;
  site.command_at(seconds(10), action::sound_alarm, 100);
  site.command_at(seconds(30), action::report_now, 0);
  site.run_until(seconds(32));
  const auto answered = answers_to(site, command_counter(site, 1), HubPath::link);
  REQUIRE(answered.size() == 1);
  CHECK(answered[0].report.state == protocol::SirenState::sounding_alarm);
  CHECK(answered[0].report.sounding_seconds_left == 80);
  CHECK(site.outputs().size() == 1);
}

TEST_CASE("§6: off stops the output at once") {
  SirenSite site;
  site.command_at(seconds(10), action::sound_alarm, 100);
  site.command_at(seconds(20), action::off, 0);
  site.run_until(seconds(22));
  const auto outputs = site.outputs();
  REQUIRE(outputs.size() == 2);
  CHECK(outputs[1].first == at(seconds(20) + milliseconds(25)));
  CHECK_FALSE(outputs[1].second);
  const auto answered = answers_to(site, command_counter(site, 1), HubPath::link);
  REQUIRE(answered.size() == 1);
  CHECK(answered[0].report.state == protocol::SirenState::off);
  CHECK(answered[0].report.sounding_seconds_left == 0);
}

TEST_CASE("§6: seconds to sound are capped by the settings' longest time") {
  SirenSite site({}, settings_with(20));
  site.command_at(seconds(10), action::sound_alarm, 60);
  site.run_until(seconds(40));
  INFO(site.dump());
  const auto outputs = site.outputs();
  REQUIRE(outputs.size() == 2);
  CHECK(outputs[1].first == at(seconds(30) + milliseconds(25)));
  const auto answered = answers_to(site, command_counter(site), HubPath::link);
  REQUIRE_FALSE(answered.empty());
  CHECK(answered[0].report.sounding_seconds_left == 20);
}

TEST_CASE("§6: zero seconds to sound leaves the output off, answered") {
  SirenSite site;
  site.command_at(seconds(10), action::sound_alarm, 0);
  site.run_until(seconds(12));
  CHECK(site.outputs().empty());
  const auto answered = answers_to(site, command_counter(site), HubPath::link);
  REQUIRE(answered.size() == 1);
  CHECK(answered[0].report.state == protocol::SirenState::off);
}

}  // namespace
}  // namespace hsn::test::siren
