// Sirens powered up together (protocol §7 "Siren reports"; D52, D73): four sirens that boot at
// the same instant with identical clocks and no Wi-Fi report over LoRa, each timer started at a
// random point in its interval, so their reports do not collide for ever and the hub never
// counts one silent.

#include <algorithm>
#include <iomanip>
#include <sstream>

#include "system_site.hpp"

namespace hsn::test::system {
namespace {

/** Sirens that come back together after a power cut. */
constexpr std::size_t kSirens = 4;
/** Regular reports every 30 s (§7 "Siren reports", §8). */
constexpr Duration kReportInterval = seconds(30);
/** A siren is silent after 2 missed reports (D52, D73): the hub must hear one of every two. */
constexpr std::int64_t kMissedBeforeSilent = 2;
/**
 * A report may wait for a clear channel: up to 5 busy checks of up to 2 s (§2 "Listening before
 * sending").
 */
constexpr Duration kChannelWait = seconds(5 * 2);
/** The hour measured, after every siren's Started went out on LoRa (30 s, §6). */
constexpr std::int64_t kFrom = 120;
constexpr std::int64_t kHour = 3600;

TEST_CASE(
    "§7 D52 D73: four sirens powered up together without Wi-Fi: their LoRa reports reach the "
    "hub, with no standing collision") {
  SystemSite site;
  host::SimDevice& gateway = site.gateway("gateway");
  host::SirenConfig no_wifi;
  no_wifi.wifi = false;
  std::vector<host::SimDevice*> sirens;
  for (std::size_t i = 0; i < kSirens; ++i) {
    // The same power-on instant and the same clock: only the role's random phase tells them apart.
    sirens.push_back(&site.siren("siren" + std::to_string(i), no_wifi));
  }
  const Instant from = at_s(kFrom);
  const Instant until = at_s(kFrom + kHour);
  site.run_until(until);
  INFO(site.hub.dump());

  std::size_t sent_total = 0;
  std::size_t heard_total = 0;
  Duration longest_gap;
  for (host::SimDevice* siren : sirens) {
    INFO(siren->name());
    const std::size_t sent_here =
        siren->records()
            .kind(RecordKind::transmission)
            .between(from, until)
            .where([](const Record& r) { return r.frequency_hz == kSiteHz; })
            .count();
    const std::size_t heard_here =
        gateway.records()
            .kind(RecordKind::reception)
            .between(from, until)
            .where([&](const Record& r) { return r.peer == siren->actor(); })
            .count();
    sent_total += sent_here;
    heard_total += heard_here;
    CHECK(sent_here >= static_cast<std::size_t>(kHour / (kReportInterval.us / 1000000)));
    // The hub heard it all hour, never missing two reports in a row.
    std::vector<Instant> accepted;
    for (const host::HubPacket& packet : site.hub.received_from(siren->name())) {
      if (packet.at >= from && packet.at < until) {
        accepted.push_back(packet.at);
      }
    }
    REQUIRE(accepted.size() > 1);
    CHECK(accepted.front() - from < kReportInterval + kChannelWait);
    for (std::size_t i = 1; i < accepted.size(); ++i) {
      longest_gap = std::max(longest_gap, accepted[i] - accepted[i - 1]);
    }
    CHECK(until - accepted.back() < kReportInterval + kChannelWait);
  }
  std::ostringstream line;
  line << std::fixed << std::setprecision(1) << "sirens together: sent " << sent_total << ", heard "
       << heard_total << ", lost on the air "
       << 100.0 * static_cast<double>(sent_total - heard_total) / static_cast<double>(sent_total)
       << "% over an hour, longest gap between reports heard " << in_seconds(longest_gap) << " s";
  MESSAGE(line.str());
  CHECK(longest_gap < Duration{kReportInterval.us * kMissedBeforeSilent} + kChannelWait);
}

}  // namespace
}  // namespace hsn::test::system
