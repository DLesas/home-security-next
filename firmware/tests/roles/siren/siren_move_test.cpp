// Moving the site (protocol section 7, "Changing the site's channel or rate"; section 6, siren
// settings; D115): the siren's site channel and sending rate are settings of its own, stored with
// the rest; the pairing gives their first values; a settings packet that moves them is answered
// as any settings packet is, and they are used from the next transmission on. Commands are always
// heard on 869.525 MHz at the command rate.

#include "siren_bench.hpp"
#include "siren_support.hpp"

namespace hsn::test::siren {
namespace {

using device::LinkKind;
using device::StoreKey;
using roles::siren::SirenTimer;

constexpr std::uint32_t kChannel1Hz = 868300000;  // the pairing's channel in these tests
constexpr std::uint32_t kChannel2Hz = 868500000;

/** A site that checks the LoRa path every minute, so a test sees one soon after a move. */
host::SirenConfig checks_every_minute() {
  host::SirenConfig config;
  config.lora_check_interval_units = 4;
  return config;
}

/** Announces and, with no sensor to wait for, switches the site at once. */
void move_site(SirenSite& site, const host::SiteMove& move) {
  site.hub.announce_move(move);
  REQUIRE(site.hub.switch_move());
}

/** The siren's LoRa transmissions in [from, to). */
std::vector<host::Record> sent_between(const SirenSite& site, device::Instant from,
                                       device::Instant to) {
  return site.siren.records().kind(RecordKind::transmission).between(from, to).records();
}

TEST_CASE(
    "D115 §7: a move with Wi-Fi up: the settings come and are answered on Wi-Fi, and the "
    "next LoRa check goes on the new channel and rate") {
  SirenSite site({}, checks_every_minute());
  site.run_until(seconds(60));
  const std::size_t settings_writes = site.flash_writes(roles::siren::kSettingsKey);
  host::SiteMove move;
  move.site_channel = protocol::SiteChannel::mhz_868_5;
  move.send_data_rate = protocol::DataRate::dr2;
  move_site(site, move);
  const std::uint8_t version = site.hub.settings_version("siren");
  site.run_until(seconds(200));
  INFO(site.dump());
  // The settings on Wi-Fi first, answered there with the version they bring.
  const auto received = site.siren.records()
                            .kind(RecordKind::link_received)
                            .type(type::siren_settings)
                            .between(at(seconds(60)), at(seconds(61)))
                            .records();
  REQUIRE(received.size() == 1);
  bool answered = false;
  for (const HubReport& report : site.reports(reason::command_answer, HubPath::link)) {
    answered =
        answered || (report.at > at(seconds(60)) && report.report.settings_version == version);
  }
  CHECK(answered);
  CHECK(site.role().state().settings.site_channel == protocol::SiteChannel::mhz_868_5);
  CHECK(site.role().state().settings.send_data_rate == protocol::DataRate::dr2);
  // Everything sent from then on is on 868.5 MHz at DR2, and the hub hears it there.
  const auto after = sent_between(site, at(seconds(60)), at(seconds(200)));
  REQUIRE_FALSE(after.empty());
  for (const host::Record& record : after) {
    CHECK(record.frequency_hz == kChannel2Hz);
    CHECK(record.data_rate == protocol::DataRate::dr2);
  }
  bool checked = false;
  for (const HubReport& report : site.reports(reason::lora_check, HubPath::radio)) {
    checked = checked || report.at > at(seconds(60));
  }
  CHECK(checked);
  CHECK(site.hub.move_followed("siren"));
  // Commands are still heard on 869.525 MHz, at the command rate, which did not move.
  const auto windows = site.siren.records().kind(RecordKind::rx_window).records();
  CHECK(windows.back().frequency_hz == 869525000u);
  CHECK(windows.back().value == 1u << protocol::DataRate::dr5);
  // One flash write for the change.
  CHECK(site.flash_writes(roles::siren::kSettingsKey) == settings_writes + 1);
}

TEST_CASE(
    "D115 §7: a move with Wi-Fi down: the settings come over LoRa, and the answer goes on "
    "the new channel and rate") {
  SirenSite site;
  site.sim.schedule(at(seconds(30)), [&]() {
    site.siren.board().network.fail_connect = true;
    site.hub.drop_link("siren", LinkKind::network);
  });
  site.run_until(seconds(100));
  host::SiteMove move;
  move.site_channel = protocol::SiteChannel::mhz_868_5;
  move.send_data_rate = protocol::DataRate::dr2;
  move_site(site, move);
  const std::uint8_t version = site.hub.settings_version("siren");
  site.run_until(seconds(130));
  INFO(site.dump());
  const auto heard = site.siren.records()
                         .kind(RecordKind::reception)
                         .type(type::siren_settings)
                         .between(at(seconds(100)), at(seconds(130)))
                         .records();
  REQUIRE_FALSE(heard.empty());
  // The answer: the first transmission after the settings, on the new channel and rate.
  const auto answer = sent_between(site, heard[0].at, at(seconds(130)));
  REQUIRE_FALSE(answer.empty());
  CHECK(answer[0].frequency_hz == kChannel2Hz);
  CHECK(answer[0].data_rate == protocol::DataRate::dr2);
  bool answered = false;
  for (const HubReport& report : site.reports(reason::command_answer, HubPath::radio)) {
    answered = answered || (report.at > heard[0].at && report.report.settings_version == version);
  }
  CHECK(answered);
  CHECK(site.hub.move_followed("siren"));
}

TEST_CASE("D115: channel only, rate only, and both") {
  struct Case {
    const char* name;
    std::optional<std::uint8_t> channel;
    std::optional<std::uint8_t> rate;
    std::uint32_t frequency_hz;
    std::uint8_t data_rate;
  };
  const Case cases[] = {
      {"channel", protocol::SiteChannel::mhz_868_1, std::nullopt, 868100000u,
       protocol::DataRate::dr5},
      {"rate", std::nullopt, protocol::DataRate::dr2, kChannel1Hz, protocol::DataRate::dr2},
      {"both", protocol::SiteChannel::mhz_868_5, protocol::DataRate::dr2, kChannel2Hz,
       protocol::DataRate::dr2},
  };
  for (const Case& test : cases) {
    INFO(test.name);
    SirenSite site({}, checks_every_minute());
    site.run_until(seconds(60));
    host::SiteMove move;
    move.site_channel = test.channel;
    move.send_data_rate = test.rate;
    move_site(site, move);
    site.run_until(seconds(200));
    const auto after = sent_between(site, at(seconds(60)), at(seconds(200)));
    REQUIRE_FALSE(after.empty());
    for (const host::Record& record : after) {
      CHECK(record.frequency_hz == test.frequency_hz);
      CHECK(record.data_rate == test.data_rate);
    }
    CHECK(site.hub.move_followed("siren"));
    bool checked = false;
    for (const HubReport& report : site.reports(reason::lora_check, HubPath::radio)) {
      checked = checked || report.at > at(seconds(60));
    }
    CHECK(checked);
  }
}

/** Siren settings for the bench, moving the site channel to `channel`. */
Bytes settings_on_channel(std::uint8_t version, std::uint8_t channel, std::uint32_t counter) {
  protocol::SirenSettings settings;
  settings.settings_version = version;
  settings.wifi_report_interval_seconds = 30;
  settings.lora_check_interval_units = 20;
  settings.max_sound_seconds = 300;
  settings.send_data_rate = protocol::DataRate::dr5;
  settings.command_data_rate = protocol::DataRate::dr5;
  settings.site_channel = channel;
  return hub_packet(settings, counter, protocol::Binding::none(), kAddress,
                    protocol::PacketLimit::link);
}

TEST_CASE("§3 §6: a channel this version does not know keeps the one held, and is answered") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.link_up(at_seconds(2));
  bench.wifi_packet(settings_on_channel(2, protocol::SiteChannel::mhz_868_5, 10), at_seconds(5));
  REQUIRE(bench.state().settings.site_channel == protocol::SiteChannel::mhz_868_5);
  const std::size_t sent_before = bench.board.network.sent.size();
  bench.wifi_packet(settings_on_channel(3, 7, 11), at_seconds(6));
  CHECK(bench.state().settings.settings_version == 3);
  CHECK(bench.state().settings.site_channel == protocol::SiteChannel::mhz_868_5);
  CHECK(bench.board.network.sent.size() == sent_before + 1);  // the answer
}

TEST_CASE("D115: a stored channel this version does not know gives the pairing's") {
  Bench bench;
  roles::siren::SirenSettingsHeld stored;
  stored.settings_version = 4;
  stored.wifi_report_interval_seconds = 30;
  stored.lora_check_interval_units = 20;
  stored.send_data_rate = protocol::DataRate::dr5;
  stored.command_data_rate = protocol::DataRate::dr5;
  stored.site_channel = 9;
  stored.max_sound_seconds = 300;
  device::Record<roles::siren::SirenSettingsHeld> record(
      bench.board.storage, roles::siren::kSettingsKey, roles::siren::kSettingsRecordVersion, {});
  REQUIRE(record.update(stored) == device::HalError::none);
  bench.boot(BootKind::power_on, at_seconds(1));
  CHECK(bench.state().settings.settings_version == 4);
  CHECK(bench.state().settings.site_channel == protocol::SiteChannel::mhz_868_3);
}

TEST_CASE("D115: once settings have moved it, the pairing's channel no longer matters") {
  Bench bench;
  // A pairing whose channel this version does not know, and stored settings on 868.5 MHz.
  device::Record<device::PairingRecord> pairing(bench.board.storage, device::StoreKey::pairing,
                                                device::kPairingRecordVersion, {});
  REQUIRE(pairing.load() == device::HalError::none);
  device::PairingRecord odd = pairing.get();
  odd.site_channel = 7;
  REQUIRE(pairing.update(odd) == device::HalError::none);
  roles::siren::SirenSettingsHeld stored;
  stored.settings_version = 4;
  stored.wifi_report_interval_seconds = 30;
  stored.lora_check_interval_units = 20;
  stored.send_data_rate = protocol::DataRate::dr5;
  stored.command_data_rate = protocol::DataRate::dr5;
  stored.site_channel = protocol::SiteChannel::mhz_868_5;
  stored.max_sound_seconds = 300;
  device::Record<roles::siren::SirenSettingsHeld> record(
      bench.board.storage, roles::siren::kSettingsKey, roles::siren::kSettingsRecordVersion, {});
  REQUIRE(record.update(stored) == device::HalError::none);
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.quiet_timers();
  bench.set_timer(SirenTimer::started_lora, at_seconds(31));
  bench.wait_until(at_seconds(31));
  const auto checks = bench.board.radio.calls_of(host::RadioCall::Kind::detect_activity);
  REQUIRE(checks.size() == 1);
  CHECK(checks[0].cad.channel.frequency_hz == kChannel2Hz);
  // Nothing to warn about: the channel it sends on is a good one.
  const device::LogState& log = bench.instance->services.core.log;
  for (std::size_t i = 0; i < log.count; ++i) {
    CHECK(log.records[(log.start + i) % device::kLogCapacity].code != siren_log::no_site_channel);
  }
}

TEST_CASE("D115: before any settings, the siren sends on the pairing's channel") {
  Bench bench;  // paired on channel 1, 868.3 MHz
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.quiet_timers();
  bench.set_timer(SirenTimer::started_lora, at_seconds(31));
  bench.wait_until(at_seconds(31));  // no Wi-Fi: Started goes on LoRa, with no settings yet
  REQUIRE(bench.state().settings.settings_version == 0);
  const auto checks = bench.board.radio.calls_of(host::RadioCall::Kind::detect_activity);
  REQUIRE(checks.size() == 1);
  CHECK(checks[0].cad.channel.frequency_hz == kChannel1Hz);
  CHECK(checks[0].cad.channel.data_rate == protocol::DataRate::dr5);
}

TEST_CASE("D115 design §5: a restart and a power loss after a move keep the new settings") {
  for (const bool power_loss : {false, true}) {
    INFO((power_loss ? "power loss" : "restart"));
    SirenSite site({}, checks_every_minute());
    site.run_until(seconds(60));
    host::SiteMove move;
    move.site_channel = protocol::SiteChannel::mhz_868_5;
    move.send_data_rate = protocol::DataRate::dr2;
    move_site(site, move);
    if (power_loss) {
      site.siren.power_loss(at(seconds(80)));
    } else {
      site.siren.restart(at(seconds(80)));
    }
    site.run_until(seconds(240));
    INFO(site.dump());
    CHECK(site.siren.boots() == 2);
    CHECK(site.role().state().settings.site_channel == protocol::SiteChannel::mhz_868_5);
    CHECK(site.role().state().settings.send_data_rate == protocol::DataRate::dr2);
    // The hub, on the new channel and rate, still hears the checks; nothing went on the old.
    for (const host::Record& record : sent_between(site, at(seconds(80)), at(seconds(240)))) {
      CHECK(record.frequency_hz == kChannel2Hz);
      CHECK(record.data_rate == protocol::DataRate::dr2);
    }
    bool checked = false;
    for (const HubReport& report : site.reports(reason::lora_check, HubPath::radio)) {
      checked = checked || report.at > at(seconds(81));
    }
    CHECK(checked);
  }
}

TEST_CASE("D115: a siren that sounds during a move keeps sounding") {
  SirenSite site;
  site.command_at(seconds(50), action::sound_alarm, 120);
  site.run_until(seconds(60));
  host::SiteMove move;
  move.site_channel = protocol::SiteChannel::mhz_868_5;
  move.send_data_rate = protocol::DataRate::dr2;
  move_site(site, move);
  site.run_until(seconds(169));
  INFO(site.dump());
  CHECK(site.sounding());
  const auto outputs = site.outputs();
  REQUIRE(outputs.size() == 1);
  site.run_until(seconds(171));
  CHECK_FALSE(site.sounding());
  CHECK(site.outputs()[1].first == at(seconds(170) + milliseconds(25)));
}

TEST_CASE("§7 D115: the move's settings wait behind an unconfirmed command, then arrive") {
  SirenSite site;
  site.run_until(seconds(30));
  // None of the siren's answers reach the hub: the command stays unconfirmed.
  site.siren.board().network.refuse_sends = true;
  site.sim.medium().set_path_loss_one_way(site.siren.station(), site.hub.station(), 200);
  site.command_at(seconds(40), action::test, 20);
  site.run_until(seconds(41));
  host::SiteMove move;
  move.site_channel = protocol::SiteChannel::mhz_868_5;
  move_site(site, move);
  site.run_until(seconds(50));
  // One at a time: no settings yet.
  CHECK(site.siren.records()
            .kind(RecordKind::link_received)
            .type(type::siren_settings)
            .between(at(seconds(40)), at(seconds(50)))
            .empty());
  CHECK(site.role().state().settings.site_channel == protocol::SiteChannel::mhz_868_3);
  // Wi-Fi takes the answers again: the command is confirmed, then the settings come.
  site.siren.board().network.refuse_sends = false;
  site.run_until(seconds(60));
  INFO(site.dump());
  CHECK(site.hub.decisions(HubAction::siren_confirmed, "siren").size() >= 2);
  CHECK(site.role().state().settings.site_channel == protocol::SiteChannel::mhz_868_5);
  CHECK(site.hub.move_followed("siren"));
}

}  // namespace
}  // namespace hsn::test::siren
