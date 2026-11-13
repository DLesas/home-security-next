// Logs and flash faults (protocol section 6; D110, FW6, HN(a)40): every failure path records an
// entry with a siren code; entries go to the hub over Wi-Fi as they arise, and while Wi-Fi is down
// one entry at warning or above goes on LoRa after each LoRa check. Settings are stored only when
// they change, and a failed flash write never stops the output.

#include <cstring>

#include "hsn/psa/psa_packet_cipher.hpp"
#include "siren_bench.hpp"
#include "siren_support.hpp"

namespace hsn::test::siren {
namespace {

using device::LogLevel;
using device::StoreKey;
using roles::siren::SirenTimer;

TEST_CASE("D110 §7: a counter that cannot be saved is logged, and the output switches anyway") {
  SirenSite site;
  site.sim.schedule(at(seconds(9)), [&]() { site.siren.board().storage.fail_next_writes = 1; });
  site.command_at(seconds(10), action::sound_alarm, 60);
  site.run_until(seconds(12));
  INFO(site.dump());
  CHECK(site.sounding());
  const auto failed = site.siren.records().kind(RecordKind::flash_write).records();
  REQUIRE_FALSE(failed.empty());
  CHECK(failed.back().flag);  // the write failed
  CHECK(site.reports(reason::command_answer, HubPath::link).size() >= 2);
  // The entry went over Wi-Fi in the same moment it arose.
  const auto logged = site.logged(siren_log::counter_not_saved);
  REQUIRE(logged.size() == 1);
  CHECK(logged[0].path == HubPath::link);
  CHECK(logged[0].level == static_cast<std::uint8_t>(LogLevel::error));
  CHECK(logged[0].at == at(seconds(10) + milliseconds(50)));
  CHECK(logged[0].made_at == at(seconds(10) + milliseconds(50)));
}

TEST_CASE(
    "D110 FW6: with Wi-Fi down, one entry at warning or above goes on LoRa after each "
    "LoRa check, and the rest follow on Wi-Fi when it is back") {
  SirenSite site;
  site.siren.board().network.fail_connect = true;
  site.run_until(seconds(1));
  const device::Instant first_check = site.due(SirenTimer::lora_check);
  // Warnings: the first failed connect at 0.05 s, the cover opened between the first two
  // checks. The retries after the first are info, as is the unknown action: those never go on
  // LoRa.
  site.command_at(first_check - at(seconds(0)) + seconds(50), 9, 0);
  site.siren.set_input(device::Input::cover, true, first_check + seconds(100));
  const device::Instant back = first_check + seconds(350);
  site.sim.schedule(back, [&]() { site.siren.board().network.fail_connect = false; });
  site.sim.run_until(back + seconds(50));
  INFO(site.dump());
  const auto checks = site.reports(reason::lora_check);
  const auto logs = site.on_air(type::log_entries).records();
  REQUIRE(checks.size() == 2);
  REQUIRE(logs.size() == 2);
  // Each straight after its check: the hub had the check 50 ms after it ended, and the entry
  // went after a 3 ms channel check.
  for (std::size_t i = 0; i < 2; ++i) {
    CHECK(logs[i].from >= checks[i].at + milliseconds(-50));
    CHECK(logs[i].from < checks[i].at);
  }
  const auto by_lora = site.hub.log_entries_from("siren");
  std::size_t on_lora = 0;
  for (const host::HubLogEntry& entry : by_lora) {
    if (entry.path == HubPath::radio) {
      on_lora += 1;
      CHECK(entry.level >= static_cast<std::uint8_t>(LogLevel::warning));
    }
  }
  CHECK(on_lora == 2);
  // Each entry left the buffer once sent: the second packet carries the other one.
  std::vector<device::Instant> made;
  for (const host::HubLogEntry& entry : by_lora) {
    if (entry.path == HubPath::radio) {
      made.push_back(entry.made_at);
    }
  }
  REQUIRE(made.size() == 2);
  CHECK(made[0] != made[1]);
  // One entry per LoRa packet: two packets, two entries, two counters.
  CHECK(logs[0].label.counter != logs[1].label.counter);
  // Back on Wi-Fi: the info entry, kept all along, goes there.
  const auto unknown = site.logged(siren_log::unknown_action);
  REQUIRE(unknown.size() == 1);
  CHECK(unknown[0].path == HubPath::link);
  CHECK(unknown[0].at > back);
  CHECK(unknown[0].made_at < first_check + seconds(51));
}

TEST_CASE("D110: with Wi-Fi up, nothing is logged on LoRa") {
  SirenSite site;
  site.command_at(seconds(100), 9, 0);
  site.run_until(seconds(620));
  CHECK(site.on_air(type::log_entries).empty());
  CHECK(site.logged(siren_log::unknown_action).size() == 1);
}

TEST_CASE("D110: an up link that refuses packets is not down: logs wait for it, not for LoRa") {
  SirenSite site;
  site.run_until(seconds(1));
  const device::Instant first_report = site.due(SirenTimer::wifi_report);
  const device::Instant first_check = site.due(SirenTimer::lora_check);
  // Refusing from 5 s; the first refused report logs a warning; a check comes after it; then the
  // link takes packets again.
  const device::Instant refused_report = next_in_rhythm(first_report, seconds(30), at(seconds(5)));
  const device::Instant check =
      next_in_rhythm(first_check, seconds(300), refused_report + seconds(1));
  const device::Instant accepts = check + seconds(30);
  site.sim.schedule(at(seconds(5)), [&]() { site.siren.board().network.refuse_sends = true; });
  site.sim.schedule(accepts, [&]() { site.siren.board().network.refuse_sends = false; });
  site.sim.run_until(accepts + seconds(31));
  INFO(site.dump());
  // The check went while the refusal's warning was waiting, and took no log entry with it.
  bool checked = false;
  for (const HubReport& report : site.reports(reason::lora_check)) {
    checked = checked || (report.at > check && report.at < accepts);
  }
  CHECK(checked);
  CHECK(site.on_air(type::log_entries).empty());
  const auto refused = site.logged(siren_log::wifi_report_failed);
  REQUIRE_FALSE(refused.empty());
  CHECK(refused[0].path == HubPath::link);
  CHECK(refused[0].at > accepts);
}

TEST_CASE("§6 FW6: settings that cannot be stored are held and logged, and stored later") {
  SirenSite site;
  // At 0.15 s the settings bring a counter write and a settings write; both fail.
  site.sim.schedule(at(milliseconds(120)),
                    [&]() { site.siren.board().storage.fail_next_writes = 2; });
  site.siren.restart(at(seconds(20)));
  site.run_until(seconds(40));
  INFO(site.dump());
  CHECK(site.logged(siren_log::settings_not_saved).size() == 1);
  CHECK(site.logged(siren_log::counter_not_saved).size() == 1);
  // Held all the same: the answer carries version 1.
  const auto answers = site.reports(reason::command_answer, HubPath::link);
  REQUIRE_FALSE(answers.empty());
  CHECK(answers[0].at < at(seconds(1)));
  CHECK(answers[0].report.settings_version == 1);
  // After the restart nothing was stored, so the hub sends them again and they are stored.
  const auto started = site.hub.received_from("siren", type::started);
  REQUIRE(started.size() == 2);
  CHECK(started[1].as<protocol::Started>().settings_version == 0);
  CHECK(site.flash_writes(roles::siren::kSettingsKey) == 2);
  CHECK(site.siren.board().storage.has(roles::siren::kSettingsKey));
  CHECK(site.role().state().settings.settings_version == 1);
}

/** Siren settings sealed by the bench's hub key. */
Bytes settings_packet(std::uint8_t version, std::uint8_t interval, std::uint32_t counter) {
  protocol::SirenSettings settings;
  settings.settings_version = version;
  settings.wifi_report_interval_seconds = interval;
  settings.lora_check_interval_units = 20;
  settings.max_sound_seconds = 120;
  settings.send_data_rate = 5;
  settings.command_data_rate = 4;
  return hub_packet(settings, counter, protocol::Binding::none(), kAddress,
                    protocol::PacketLimit::link);
}

TEST_CASE("§6 HN(a)40: settings are stored only when they change, and answered each time") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.link_up(at_seconds(2));
  const std::size_t sent_before = bench.board.network.sent.size();
  bench.wifi_packet(settings_packet(3, 20, 10), at_seconds(5));
  CHECK(bench.board.storage.write_count(roles::siren::kSettingsKey) == 1);
  CHECK(bench.state().settings.command_data_rate == 4);
  // The same settings under a newer counter: the counter is saved, the settings are not.
  bench.wifi_packet(settings_packet(3, 20, 11), at_seconds(6));
  CHECK(bench.board.storage.write_count(roles::siren::kSettingsKey) == 1);
  CHECK(bench.board.storage.write_count(StoreKey::command_counter) == 2);
  // A change is stored.
  bench.wifi_packet(settings_packet(4, 15, 12), at_seconds(7));
  CHECK(bench.board.storage.write_count(roles::siren::kSettingsKey) == 2);
  CHECK(bench.state().settings.wifi_report_interval_seconds == 15);
  // The new interval starts at a random point within one interval (§7).
  CHECK(bench.state().timers.at(roles::siren::SirenTimer::wifi_report) > at_seconds(7));
  CHECK(bench.state().timers.at(roles::siren::SirenTimer::wifi_report) <= at_seconds(22));
  // Each was answered on Wi-Fi.
  CHECK(bench.board.network.sent.size() == sent_before + 3);
}

TEST_CASE("§6: settings with a longest time of 0 keep the value held, with a warning") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.link_up(at_seconds(2));
  bench.wifi_packet(settings_packet(3, 20, 10), at_seconds(5));
  REQUIRE(bench.state().settings.max_sound_seconds == 120);
  protocol::SirenSettings zero;
  zero.settings_version = 4;
  zero.wifi_report_interval_seconds = 30;
  zero.lora_check_interval_units = 20;
  zero.max_sound_seconds = 0;
  zero.send_data_rate = 5;
  zero.command_data_rate = 5;
  bench.wifi_packet(
      hub_packet(zero, 11, protocol::Binding::none(), kAddress, protocol::PacketLimit::link),
      at_seconds(6));
  CHECK(bench.state().settings.settings_version == 4);
  CHECK(bench.state().settings.max_sound_seconds == 120);
  // Logged as a warning; the link is up, so it went to the hub at once.
  bool warned = false;
  for (const host::FakeLink::Sent& sent : bench.board.network.sent) {
    const HubOpened opened = hub_open(view_of(sent.packet), protocol::Binding::none());
    if (opened.type != type::log_entries) {
      continue;
    }
    protocol::LogEntries entries;
    REQUIRE(protocol::decode_body(view_of(opened.body), entries) == protocol::Error::none);
    protocol::LogEntryReader reader(entries.entries);
    protocol::LogEntry entry;
    while (reader.next(entry)) {
      warned = warned || (entry.code == siren_log::invalid_setting &&
                          entry.level == static_cast<std::uint8_t>(LogLevel::warning));
    }
  }
  CHECK(warned);
  // The siren can still sound.
  bench.wifi_packet(Bench::sound(60, 12), at_seconds(7));
  CHECK(bench.board.siren_io.output_state);
  CHECK(bench.state().stop_at == at_seconds(67));
}

TEST_CASE("§6: a stored longest time of 0 is replaced by the default, with a warning") {
  Bench bench;
  roles::siren::SirenSettingsHeld stored;
  stored.settings_version = 7;
  stored.wifi_report_interval_seconds = 30;
  stored.lora_check_interval_units = 20;
  stored.send_data_rate = 5;
  stored.command_data_rate = 5;
  stored.max_sound_seconds = 0;
  device::Record<roles::siren::SirenSettingsHeld> record(
      bench.board.storage, roles::siren::kSettingsKey, roles::siren::kSettingsRecordVersion, {});
  REQUIRE(record.update(stored) == device::HalError::none);
  bench.boot(BootKind::power_on, at_seconds(1));
  CHECK(bench.state().settings.settings_version == 7);
  CHECK(bench.state().settings.max_sound_seconds == roles::siren::kDefaultMaxSoundSeconds);
  const device::LogState& log = bench.instance->services.core.log;
  bool warned = false;
  for (std::size_t i = 0; i < log.count; ++i) {
    const device::LogRecord& entry = log.records[(log.start + i) % device::kLogCapacity];
    warned = warned || (entry.code == siren_log::invalid_setting &&
                        entry.level == static_cast<std::uint8_t>(LogLevel::warning));
  }
  CHECK(warned);
}

TEST_CASE("§3: settings with a rate or interval it cannot use keep the values held") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.link_up(at_seconds(2));
  protocol::SirenSettings odd;
  odd.settings_version = 2;
  odd.wifi_report_interval_seconds = 0;
  odd.lora_check_interval_units = 0;
  odd.max_sound_seconds = 50;
  odd.send_data_rate = 9;
  odd.command_data_rate = 7;
  bench.wifi_packet(
      hub_packet(odd, 10, protocol::Binding::none(), kAddress, protocol::PacketLimit::link),
      at_seconds(5));
  const roles::siren::SirenSettingsHeld& held = bench.state().settings;
  CHECK(held.settings_version == 2);
  CHECK(held.max_sound_seconds == 50);
  CHECK(held.wifi_report_interval_seconds == roles::siren::kDefaultWifiReportSeconds);
  CHECK(held.lora_check_interval_units == roles::siren::kDefaultLoraCheckUnits);
  CHECK(held.send_data_rate == protocol::DataRate::dr5);
  CHECK(held.command_data_rate == protocol::DataRate::dr5);
}

TEST_CASE("§3: a command with a body too short moves no counter") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.link_up(at_seconds(2));
  psa::PsaPacketCipher cipher;
  REQUIRE(cipher.set_key(kKey) == protocol::Error::none);
  const std::array<std::uint8_t, 2> plaintext{type::siren_command, action::sound_alarm};
  Bytes packet(64);
  const auto sealed = protocol::seal_packet(
      cipher, {protocol::Direction::from_hub, kAddress, 10}, protocol::Binding::none(),
      protocol::ByteView(plaintext), protocol::PacketLimit::link,
      protocol::MutableByteView(packet.data(), packet.size()));
  REQUIRE(sealed.ok());
  packet.resize(sealed.value());
  bench.wifi_packet(packet, at_seconds(5));
  CHECK(bench.board.storage.write_count(StoreKey::command_counter) == 0);
  // A valid command with a lower counter is still new.
  bench.wifi_packet(Bench::sound(30, 9), at_seconds(6));
  CHECK(bench.board.siren_io.output_state);
}

TEST_CASE("§3 FW6: a body too short to act on is dropped and logged, and not answered") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.link_up(at_seconds(2));
  const std::size_t sent_before = bench.board.network.sent.size();
  // A siren command with its action byte only: the tag checks, the body does not.
  psa::PsaPacketCipher cipher;
  REQUIRE(cipher.set_key(kKey) == protocol::Error::none);
  const std::array<std::uint8_t, 2> plaintext{type::siren_command, action::sound_alarm};
  Bytes packet(64);
  const auto sealed = protocol::seal_packet(
      cipher, {protocol::Direction::from_hub, kAddress, 10}, protocol::Binding::none(),
      protocol::ByteView(plaintext), protocol::PacketLimit::link,
      protocol::MutableByteView(packet.data(), packet.size()));
  REQUIRE(sealed.ok());
  packet.resize(sealed.value());
  bench.wifi_packet(packet, at_seconds(5));
  // The hub's retry of the same packet is dropped the same way.
  bench.wifi_packet(packet, at_seconds(6));
  CHECK_FALSE(bench.board.siren_io.output_state);
  // Only the log entries went out, once for each copy.
  REQUIRE(bench.board.network.sent.size() == sent_before + 2);
  for (std::size_t i = sent_before; i < bench.board.network.sent.size(); ++i) {
    CHECK(hub_open(view_of(bench.board.network.sent[i].packet), protocol::Binding::none()).type ==
          type::log_entries);
  }
}

}  // namespace
}  // namespace hsn::test::siren

namespace hsn::test::siren {
namespace {

/** Every log code in the role's own log now. */
std::vector<std::uint16_t> kept_codes(Bench& bench) {
  std::vector<std::uint16_t> codes;
  const device::LogState& log = bench.instance->services.core.log;
  for (std::size_t i = 0; i < log.count; ++i) {
    codes.push_back(log.records[(log.start + i) % device::kLogCapacity].code);
  }
  return codes;
}

bool has_code(Bench& bench, std::uint16_t code) {
  for (const std::uint16_t kept : kept_codes(bench)) {
    if (kept == code) {
      return true;
    }
  }
  return false;
}

/** The level of the newest kept entry with `code`, or -1. */
int level_of(Bench& bench, std::uint16_t code) {
  const device::LogState& log = bench.instance->services.core.log;
  int level = -1;
  for (std::size_t i = 0; i < log.count; ++i) {
    const device::LogRecord& entry = log.records[(log.start + i) % device::kLogCapacity];
    if (entry.code == code) {
      level = entry.level;
    }
  }
  return level;
}

TEST_CASE("D110: a run of failed connects is a warning once, then info") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.deliver(Event::from_link(at_seconds(16), bench.board.network.down_event()), at_seconds(16));
  CHECK(level_of(bench, siren_log::wifi_connect_failed) == static_cast<int>(LogLevel::warning));
  // The retry at 17 s fails too: only info this time.
  bench.wait_until(at_seconds(17));
  bench.deliver(Event::from_link(at_seconds(32), bench.board.network.down_event()), at_seconds(32));
  CHECK(level_of(bench, siren_log::wifi_connect_failed) == static_cast<int>(LogLevel::info));
  // Up, then down again: the loss is the warning, and the failed reconnect after it is info.
  bench.wait_until(at_seconds(34));
  bench.link_up(at_seconds(35));
  bench.deliver(Event::from_link(at_seconds(40), bench.board.network.down_event()), at_seconds(40));
  bench.wait_until(at_seconds(41));
  bench.deliver(Event::from_link(at_seconds(56), bench.board.network.down_event()), at_seconds(56));
  CHECK(level_of(bench, siren_log::wifi_down) == static_cast<int>(LogLevel::warning));
  CHECK(level_of(bench, siren_log::wifi_connect_failed) == static_cast<int>(LogLevel::info));
}

/** Rewrites the role's state as a corrupted retained copy that passed its CRC would. */
void set_send_rate(Bench& bench, std::uint8_t rate) {
  roles::siren::SirenState state = bench.state();
  state.settings.send_data_rate = rate;
  const protocol::MutableByteView bytes = bench.instance->role.state_bytes();
  REQUIRE(bytes.size() == sizeof(state));
  std::memcpy(bytes.data(), &state, sizeof(state));
}

TEST_CASE("D110: a LoRa item that can never fit is dropped, and the drop is logged") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  // A rate the airtime table does not know: no admission, ever.
  set_send_rate(bench, 9);
  bench.wait_until(at_seconds(31));  // Started and the report are due on LoRa
  CHECK(bench.board.radio.calls_of(host::RadioCall::Kind::detect_activity).empty());
  CHECK(bench.state().lora.in_flight == roles::siren::LoraItem::none);
  CHECK_FALSE(bench.state().lora.started);
  CHECK(level_of(bench, siren_log::lora_dropped) == static_cast<int>(LogLevel::error));
}

TEST_CASE(
    "D110 D111: routine traffic waiting for airtime is info; an answer sent past the hour "
    "is the port's warning") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.link_up(at_seconds(2));
  bench.board.network.refuse_sends = true;  // so the entries stay in the buffer to be read
  // Fill the hour's site-channel budget: routine traffic is out.
  device::BandUsage& g1 = bench.instance->services.core.airtime.bands[0];
  g1.newest_minute = 0;
  g1.units[0] = 3480;
  bench.wait_until(at_seconds(301));  // the LoRa check
  CHECK(level_of(bench, siren_log::lora_deferred) == static_cast<int>(LogLevel::info));
  g1.units[0] = 3600;  // and now all of the legal hour
  // The answer cannot go on Wi-Fi; on LoRa it goes at once, past the legal hour (D111).
  bench.wifi_packet(Bench::sound(30, 5), at_seconds(303));
  CHECK(bench.board.siren_io.output_state);
  REQUIRE(bench.state().lora.in_flight == roles::siren::LoraItem::answer);
  bench.radio_event(bench.board.radio.cad_done(at_seconds(303), false), at_seconds(303));
  CHECK(bench.board.radio.calls_of(host::RadioCall::Kind::transmit).size() == 1);
  CHECK(level_of(bench, device::log_code::airtime_past_limit) ==
        static_cast<int>(LogLevel::warning));
  // Sent; the next answer waits for the gap of nine airtimes, which is only info.
  bench.radio_event(bench.board.radio.tx_done(at_seconds(303) + milliseconds(70)),
                    at_seconds(303) + milliseconds(70));
  protocol::SirenCommand off;
  off.action = action::off;
  bench.wifi_packet(
      hub_packet(off, 6, protocol::Binding::none(), kAddress, protocol::PacketLimit::link),
      at_seconds(303) + milliseconds(80));
  CHECK(bench.state().lora.answer);
  CHECK(bench.state().timers.armed(roles::siren::SirenTimer::lora_wait));
  CHECK(level_of(bench, siren_log::lora_deferred) == static_cast<int>(LogLevel::info));
}

TEST_CASE("§10: a non-setup packet on USB is not a command") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.deliver(Event::from_link(at_seconds(5), bench.board.usb.packet_event(Bench::sound(60, 5))),
                at_seconds(5));
  CHECK_FALSE(bench.board.siren_io.output_state);
  CHECK(bench.board.storage.write_count(device::StoreKey::command_counter) == 0);
  CHECK(has_code(bench, siren_log::usb_packet_ignored));
}

TEST_CASE("FW6: a packet that cannot be sealed is logged") {
  Bench bench;
  bench.board.storage.fail_writes = true;  // the first packet must save its resume point
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.link_up(at_seconds(2));
  CHECK(bench.board.network.sent.empty());
  CHECK(has_code(bench, siren_log::seal_failed));
  // Started could not go on Wi-Fi, so it waits for LoRa.
  CHECK(bench.state().lora.started);
}

TEST_CASE("FW6 §3: only packets for this siren that fail their checks are logged") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  protocol::SirenCommand command;
  command.action = action::sound_alarm;
  command.sound_seconds = 30;
  // Another device's packet on 869.525 MHz: not this siren's business.
  bench.radio_packet(hub_packet(command, 7, protocol::Binding::none(), kAddress + 1),
                     at_seconds(5));
  CHECK(kept_codes(bench).empty());
  // This siren's address with a damaged tag: a fault.
  Bytes damaged = hub_packet(command, 8, protocol::Binding::none());
  damaged.back() ^= 0x01;
  bench.radio_packet(damaged, at_seconds(6));
  CHECK(has_code(bench, siren_log::packet_dropped));
  // A hub packet of a type a siren does not take.
  protocol::DisarmedNotice notice;
  bench.radio_packet(hub_packet(notice, 9, protocol::Binding::none()), at_seconds(7));
  CHECK(has_code(bench, siren_log::unexpected_type));
  CHECK_FALSE(bench.board.siren_io.output_state);
  CHECK(bench.board.radio.calls_of(host::RadioCall::Kind::detect_activity).empty());
}

TEST_CASE("D110: an entry on its way over LoRa is not also sent when Wi-Fi comes back") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.quiet_timers();
  // Wi-Fi never came up; the platform reports the connect down.
  bench.deliver(Event::from_link(at_seconds(16), bench.board.network.down_event()), at_seconds(16));
  REQUIRE(has_code(bench, siren_log::wifi_connect_failed));
  // A LoRa check at 301 s: its channel check and send, then the log entry's.
  bench.set_timer(roles::siren::SirenTimer::lora_check, at_seconds(301));
  bench.wait_until(at_seconds(301));
  const auto clear = [&](std::int64_t s) {
    bench.radio_event(bench.board.radio.cad_done(at_seconds(s), false), at_seconds(s));
  };
  const auto sent = [&](std::int64_t s) {
    bench.radio_event(bench.board.radio.tx_done(at_seconds(s)), at_seconds(s));
  };
  // Send whatever is pending until the log entry is on its way.
  for (std::int64_t s = 302; s < 320 && bench.state().lora.in_flight != roles::siren::LoraItem::log;
       s += 2) {
    clear(s);
    sent(s + 1);
  }
  REQUIRE(bench.state().lora.in_flight == roles::siren::LoraItem::log);
  bench.radio_event(bench.board.radio.cad_done(at_seconds(321), false), at_seconds(321));
  // Wi-Fi comes up while the entry is on the air (92 ms at DR5), and then it is sent.
  const std::size_t before = bench.board.network.sent.size();
  bench.link_up(at_seconds(321) + milliseconds(20));
  const Instant done = at_seconds(321) + milliseconds(93);
  bench.radio_event(bench.board.radio.tx_done(done), done);
  CHECK(bench.board.radio.calls_of(host::RadioCall::Kind::recover).empty());
  // Released by the LoRa send, and never sent on Wi-Fi as well.
  CHECK_FALSE(has_code(bench, siren_log::wifi_connect_failed));
  for (std::size_t i = before; i < bench.board.network.sent.size(); ++i) {
    const HubOpened opened =
        hub_open(view_of(bench.board.network.sent[i].packet), protocol::Binding::none());
    if (opened.type != type::log_entries) {
      continue;
    }
    protocol::LogEntries entries;
    REQUIRE(protocol::decode_body(view_of(opened.body), entries) == protocol::Error::none);
    protocol::LogEntryReader reader(entries.entries);
    protocol::LogEntry entry;
    while (reader.next(entry)) {
      CHECK(entry.code != siren_log::wifi_connect_failed);
    }
  }
  CHECK(bench.board.network.sent.size() > before);  // Started and a report went on Wi-Fi
}

}  // namespace
}  // namespace hsn::test::siren
