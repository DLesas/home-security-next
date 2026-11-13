// The output (SR5, SR9, D42, D80): it stops by itself when its seconds run out, a test sounds as
// "testing", and the output and its stop time survive any restart that is not a power-on while
// the retained block is intact, and only then.

#include "siren_bench.hpp"
#include "siren_support.hpp"

namespace hsn::test::siren {
namespace {

using device::BootKind;

TEST_CASE("SR5: the siren stops by itself when its seconds run out, with no off") {
  SirenSite site;
  site.command_at(seconds(10), action::sound_alarm, 30);
  site.run_until(seconds(60));
  INFO(site.dump());
  CHECK(site.hub.sent_to("siren", type::siren_command).size() == 2);  // one command, two paths
  const auto outputs = site.outputs();
  REQUIRE(outputs.size() == 2);
  CHECK(outputs[1].first == at(seconds(40) + milliseconds(25)));
  CHECK_FALSE(outputs[1].second);
  // It says so at once.
  const auto regular = site.reports(reason::regular, HubPath::link);
  bool told = false;
  for (const HubReport& report : regular) {
    if (report.at == at(seconds(40) + milliseconds(50))) {
      told = report.report.state == protocol::SirenState::off;
    }
  }
  CHECK(told);
}

TEST_CASE("SR5: it stops by itself with both paths to the hub gone") {
  SirenSite site;
  site.command_at(seconds(10), action::sound_alarm, 30);
  site.sim.schedule(at(seconds(11)), [&]() {
    site.hub.drop_link("siren", device::LinkKind::network);
    site.siren.board().network.fail_connect = true;
    site.sim.medium().cut(site.siren.station(), site.hub.station());
  });
  site.run_until(seconds(60));
  INFO(site.dump());
  const auto outputs = site.outputs();
  REQUIRE(outputs.size() == 2);
  CHECK(outputs[1].first == at(seconds(40) + milliseconds(25)));
  CHECK_FALSE(site.sounding());
}

TEST_CASE("SR9: a test sounds as testing for its seconds, then stops by itself") {
  SirenSite site;
  site.command_at(seconds(10), action::test, 5);
  site.run_until(seconds(20));
  const auto answered = site.reports(reason::command_answer, HubPath::link);
  REQUIRE(answered.size() >= 2);
  CHECK(answered.back().report.state == protocol::SirenState::testing);
  CHECK(answered.back().report.sounding_seconds_left == 5);
  const auto outputs = site.outputs();
  REQUIRE(outputs.size() == 2);
  CHECK(outputs[1].first == at(seconds(15) + milliseconds(25)));
}

TEST_CASE("§6: seconds left count down in the regular reports") {
  SirenSite site;
  site.command_at(seconds(10), action::sound_alarm, 100);
  site.run_until(seconds(75));
  const auto regular = site.reports(reason::regular, HubPath::link);
  // The stop is at 110.025 s; each report says how far away, rounded up, when it was sent (25 ms
  // before the hub had it).
  const device::Instant stop = at(seconds(110) + milliseconds(25));
  std::size_t seen = 0;
  for (const HubReport& report : regular) {
    if (report.at < at(seconds(11))) {
      continue;
    }
    const device::Duration left = stop - (report.at + milliseconds(-25));
    const std::int64_t expected = (left.us + seconds(1).us - 1) / seconds(1).us;
    CHECK(report.report.state == protocol::SirenState::sounding_alarm);
    CHECK(report.report.sounding_seconds_left == expected);
    seen += 1;
  }
  CHECK(seen == 2);  // two of the 30 s reports fall between 11 and 75 s
}

TEST_CASE("D80: a restart while sounding resumes for the time left") {
  SirenSite site;
  site.command_at(seconds(10), action::sound_alarm, 60);
  site.siren.restart(at(seconds(30)));
  site.run_until(seconds(80));
  INFO(site.dump());
  CHECK(site.siren.boots() == 2);
  const auto outputs = site.outputs();
  REQUIRE(outputs.size() == 4);
  // Low during the reset, as the hardware is; on again as soon as the siren boots.
  CHECK(outputs[1].first == at(seconds(30)));
  CHECK_FALSE(outputs[1].second);
  CHECK(outputs[2].first == at(seconds(30) + milliseconds(50)));
  CHECK(outputs[2].second);
  // The stop time is the one the command set, not 60 s from the restart.
  CHECK(outputs[3].first == at(seconds(70) + milliseconds(25)));
  CHECK_FALSE(outputs[3].second);
  const auto resumed = site.logged(siren_log::resumed);
  REQUIRE(resumed.size() == 1);
  CHECK(resumed[0].text == "resumed 40");
  // The first report after the restart shows it sounding, with the time left.
  const auto after = site.reports(reason::regular, HubPath::link);
  bool seen = false;
  for (const HubReport& report : after) {
    if (!seen && report.at > at(seconds(30))) {
      seen = true;
      CHECK(report.report.state == protocol::SirenState::sounding_alarm);
      CHECK(report.report.sounding_seconds_left == 40);
    }
  }
  CHECK(seen);
}

TEST_CASE("D80: a power loss while sounding comes back off") {
  SirenSite site;
  site.command_at(seconds(10), action::sound_alarm, 60);
  site.siren.power_loss(at(seconds(30)));
  site.run_until(seconds(80));
  INFO(site.dump());
  CHECK(site.siren.boots() == 2);
  CHECK_FALSE(site.sounding());
  // Low when the power went, and never on again.
  const auto outputs = site.outputs();
  REQUIRE(outputs.size() == 2);
  CHECK(outputs[1].first == at(seconds(30)));
  CHECK_FALSE(outputs[1].second);
  CHECK(site.logged(siren_log::resumed).empty());
  const auto regular = site.reports(reason::regular, HubPath::link);
  REQUIRE_FALSE(regular.empty());
  CHECK(regular.back().report.state == protocol::SirenState::off);
}

TEST_CASE("D80: corrupted retained memory comes back off, and says so") {
  SirenSite site;
  site.command_at(seconds(10), action::sound_alarm, 60);
  site.sim.schedule(at(seconds(30)), [&]() { site.siren.board().retained.corrupt(700); });
  site.siren.restart(at(seconds(30)));
  site.run_until(seconds(80));
  INFO(site.dump());
  CHECK_FALSE(site.sounding());
  const auto outputs = site.outputs();
  REQUIRE(outputs.size() == 2);
  CHECK(outputs[1].first == at(seconds(30)));
  CHECK_FALSE(outputs[1].second);
  CHECK(site.logged(siren_log::retained_lost).size() == 1);
  CHECK(site.logged(siren_log::resumed).empty());
}

TEST_CASE("D80: the sounder is low while the board resets, and on again when it boots") {
  SirenSite site;
  site.command_at(seconds(10), action::sound_alarm, 60);
  site.siren.restart(at(seconds(30)));
  site.run_until(seconds(30) + milliseconds(10));
  CHECK_FALSE(site.sounding());
  site.run_until(seconds(31));
  CHECK(site.sounding());
}

TEST_CASE("D80: a power-on is off even when the retained block is intact") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.link_up(at_seconds(2));
  bench.wifi_packet(Bench::sound(60, 5), at_seconds(10));
  REQUIRE(bench.board.siren_io.output_state);
  // The block is intact (the bench keeps it), but this start is a power-on.
  bench.boot(BootKind::power_on, at_seconds(20));
  CHECK(bench.instance->device.retained_status() == device::RetainedStatus::intact);
  CHECK_FALSE(bench.board.siren_io.output_state);
  CHECK(bench.state().output_state == protocol::SirenState::off);
  // The same block after another reset resumes.
  bench.boot(BootKind::power_on, at_seconds(21));
  bench.link_up(at_seconds(22));
  bench.wifi_packet(Bench::sound(60, 6), at_seconds(25));
  bench.boot(BootKind::other_reset, at_seconds(30));
  CHECK(bench.board.siren_io.output_state);
  CHECK(bench.state().stop_at == at_seconds(85));
}

TEST_CASE("D80: a restart after the stop time has passed comes back off") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.link_up(at_seconds(2));
  bench.wifi_packet(Bench::sound(10, 5), at_seconds(10));
  bench.boot(BootKind::other_reset, at_seconds(30));
  CHECK_FALSE(bench.board.siren_io.output_state);
  CHECK(bench.state().output_state == protocol::SirenState::off);
}

TEST_CASE("D80: after a clock reset it sounds for what was left at the last event") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.link_up(at_seconds(2));
  bench.wifi_packet(Bench::sound(60, 5), at_seconds(10));
  bench.timer(at_seconds(30));
  // The RTC restarted: the new clock reads less than the last `now` seen.
  bench.boot(BootKind::other_reset, at_seconds(5));
  CHECK(bench.instance->device.retained_status() == device::RetainedStatus::clock_reset);
  CHECK(bench.board.siren_io.output_state);
  // 40 s were left at 30 s; they count again from 5 s.
  CHECK(bench.state().stop_at == at_seconds(45));
}

TEST_CASE("D40 AL6: before any settings, a command is cut to the product default of 300 s") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.link_up(at_seconds(2));
  bench.wifi_packet(Bench::sound(5000, 5), at_seconds(10));
  CHECK(bench.state().settings.settings_version == 0);
  CHECK(bench.state().stop_at == at_seconds(10 + roles::siren::kDefaultMaxSoundSeconds));
  CHECK(roles::siren::kDefaultMaxSoundSeconds == 300);
}

TEST_CASE("§3 D110: an authenticated command is acted on whatever the Wi-Fi path's state") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  REQUIRE(bench.state().wifi_path == roles::siren::WifiPath::connecting);
  // Still connecting, as far as the role knows: acted on; the answer falls back to LoRa.
  bench.wifi_packet(Bench::sound(30, 5), at_seconds(5));
  CHECK(bench.board.siren_io.output_state);
  CHECK(bench.state().lora.in_flight == roles::siren::LoraItem::answer);
  // Down, as far as the role knows: the same.
  bench.deliver(Event::from_link(at_seconds(6), bench.board.network.down_event()), at_seconds(6));
  REQUIRE(bench.state().wifi_path == roles::siren::WifiPath::down);
  protocol::SirenCommand off;
  off.action = action::off;
  bench.wifi_packet(
      hub_packet(off, 6, protocol::Binding::none(), kAddress, protocol::PacketLimit::link),
      at_seconds(7));
  CHECK_FALSE(bench.board.siren_io.output_state);
  CHECK((bench.state().lora.answer ||
         bench.state().lora.in_flight == roles::siren::LoraItem::answer));
  CHECK(bench.board.storage.write_count(device::StoreKey::command_counter) == 2);
}

}  // namespace
}  // namespace hsn::test::siren
