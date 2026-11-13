// Thirty simulated days (design sections 5 and 8; SR6, D52, LR5, HN(a)40): a daily test, an
// alarm, a six-hour Wi-Fi outage and a restart. Flash writes stay inside the design's budget,
// LoRa airtime inside 1% in every rolling hour, and the hub is never a minute without a report.

#include "siren_support.hpp"

namespace hsn::test::siren {
namespace {

using device::LinkKind;
using device::StoreKey;

constexpr std::int64_t kDay = 24 * 3600;
constexpr std::int64_t kDays = 30;

/** The design's siren flash budget (section 5): about 2,150 writes a year, for 30 days. */
constexpr std::size_t kFlashBudget = 2150 * kDays / 365 + 1;

TEST_CASE("30 days: flash within budget, airtime within 1% every hour, never silent") {
  host::SimulationOptions options;
  options.keep_fake_records = false;
  SirenSite site({}, {}, options);
  for (std::int64_t day = 0; day < kDays; ++day) {
    // SR9: a short test from the settings page every morning.
    site.command_at(seconds(day * kDay + 10 * 3600), action::test, 5);
  }
  site.command_at(seconds(12 * kDay + 3 * 3600), action::sound_alarm, 180);
  site.command_at(seconds(12 * kDay + 3 * 3600 + 60), action::off, 0);
  // Day 5: the network fails for six hours.
  site.sim.schedule(at(seconds(5 * kDay)), [&]() {
    site.siren.board().network.fail_connect = true;
    site.hub.drop_link("siren", LinkKind::network);
  });
  site.sim.schedule(at(seconds(5 * kDay + 6 * 3600)),
                    [&]() { site.siren.board().network.fail_connect = false; });
  site.siren.restart(at(seconds(20 * kDay)));
  site.run_until(seconds(kDays * kDay));

  // Flash: inside the design's budget, and the resume point only every 1,024 packets.
  const std::size_t writes = site.siren.records().kind(RecordKind::flash_write).count();
  const std::size_t packets =
      site.siren.records().kind(RecordKind::link_sent).kind(RecordKind::transmission).count();
  CHECK(writes <= kFlashBudget);
  CHECK(site.flash_writes(StoreKey::counter_resume) <= packets / 1024 + 2);
  // One command counter per command, the settings once.
  CHECK(site.flash_writes(StoreKey::command_counter) == kDays + 2 + 1);
  CHECK(site.flash_writes(roles::siren::kSettingsKey) == 1);
  CHECK(site.siren.records()
            .kind(RecordKind::flash_write)
            .where([](const host::Record& r) { return r.flag; })
            .empty());

  // LoRa: 1% of every rolling hour at most.
  const host::Selection on_air = site.siren.records().kind(RecordKind::transmission);
  CHECK(on_air.busiest_hour() <= seconds(36));
  // About a check every 5 minutes, plus the outage's reports every 30 s.
  CHECK(on_air.count() >= kDays * kDay / 300);

  // D52: reports never stopped for a minute, on whichever path worked.
  device::Instant last = at(seconds(1));
  device::Duration longest;
  for (const host::HubPacket& packet : site.hub.received_from("siren", type::siren_report)) {
    longest = packet.at - last > longest ? packet.at - last : longest;
    last = packet.at;
  }
  CHECK(longest <= seconds(31));
  CHECK(site.hub.decisions(HubAction::siren_unreachable).empty());
  CHECK(site.siren.boots() == 2);
  CHECK_FALSE(site.sounding());
}

}  // namespace
}  // namespace hsn::test::siren
