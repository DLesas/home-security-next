// A day without Wi-Fi at each data rate (protocol sections 2, 6 and 7; SR6, D52, D73, D110,
// LR5): the hub hears the siren on LoRa only. Airtime stays within 1% in every rolling hour, the
// log sends a handful of entries for distinct conditions rather than one per check, commands are
// still acted on and answered, and the longest silence the hub sees is measured: it sets the
// hub's silence rule at slow rates.

#include "siren_support.hpp"

namespace hsn::test::siren {
namespace {

using device::LinkKind;

constexpr std::int64_t kHour = 3600;
/** The outage starts once the siren holds its settings, and lasts a day. */
constexpr std::int64_t kOutageStart = 120;
constexpr std::int64_t kOutageEnd = kOutageStart + 24 * kHour;

/** What a day without Wi-Fi looked like at one rate. */
struct Outage {
  device::Duration busiest_hour;
  std::size_t lora_log_packets = 0;
  device::Duration longest_silence;
  std::size_t commands = 0;
  std::size_t answered = 0;
};

Outage day_without_wifi(std::uint8_t rate) {
  host::HubOptions options;
  options.allowed_data_rate_mask = static_cast<std::uint8_t>(1u << rate);
  host::SirenConfig config;
  config.send_data_rate = rate;
  config.command_data_rate = rate;
  host::SimulationOptions simulation;
  simulation.keep_fake_records = false;
  SirenSite site(options, config, simulation);
  site.sim.schedule(at(seconds(kOutageStart)), [&]() {
    site.siren.board().network.fail_connect = true;
    site.hub.drop_link("siren", LinkKind::network);
  });
  // A short test every hour, half way through it: whichever hour is the busiest has one.
  Outage outage;
  for (std::int64_t hour = 0; hour < 24; ++hour) {
    site.command_at(seconds(kOutageStart + hour * kHour + kHour / 2), action::test, 5);
    outage.commands += 1;
  }
  site.run_until(seconds(kOutageEnd));
  INFO(site.hub.decisions(HubAction::siren_unreachable).size());

  const host::Selection sent = site.siren.records().kind(RecordKind::transmission);
  outage.busiest_hour = sent.busiest_hour();
  outage.lora_log_packets = sent.type(type::log_entries).count();
  device::Instant last = at(seconds(kOutageStart));
  for (const HubReport& report : site.reports()) {
    if (report.at < at(seconds(kOutageStart))) {
      continue;
    }
    CHECK(report.path == HubPath::radio);
    outage.longest_silence =
        report.at - last > outage.longest_silence ? report.at - last : outage.longest_silence;
    last = report.at;
  }
  // Every command was acted on and its answer reached the hub.
  std::vector<std::uint32_t> counters;
  for (const host::HubSent& command : site.hub.sent_to("siren", type::siren_command)) {
    if (counters.empty() || counters.back() < command.counter) {
      counters.push_back(command.counter);
    }
  }
  for (const std::uint32_t counter : counters) {
    for (const HubReport& report : site.reports(reason::command_answer, HubPath::radio)) {
      if (report.report.last_command_counter_low == (counter & 0xFFFFu)) {
        outage.answered += 1;
        break;
      }
    }
  }
  CHECK(site.outputs().size() == 2 * outage.commands);
  CHECK(site.hub.decisions(HubAction::siren_unreachable).empty());
  return outage;
}

void check_day(const Outage& outage) {
  CHECK(outage.busiest_hour <= seconds(36));
  CHECK(outage.lora_log_packets <= 5);
  CHECK(outage.answered == outage.commands);
}

TEST_CASE("D52 D110: a day without Wi-Fi at DR5: reports every 30 s on LoRa, few log entries") {
  const Outage outage = day_without_wifi(protocol::DataRate::dr5);
  MESSAGE("DR5: longest silence " << outage.longest_silence << ", busiest hour "
                                  << outage.busiest_hour << ", LoRa log packets "
                                  << outage.lora_log_packets);
  check_day(outage);
  CHECK(outage.longest_silence <= seconds(31));
}

TEST_CASE("LR5 D110: a day without Wi-Fi at DR2: within airtime, commands still answered") {
  const Outage outage = day_without_wifi(protocol::DataRate::dr2);
  MESSAGE("DR2: longest silence " << outage.longest_silence << ", busiest hour "
                                  << outage.busiest_hour << ", LoRa log packets "
                                  << outage.lora_log_packets);
  check_day(outage);
  // Paced to 412 ms × 3,600 s ÷ 18 s = 82.4 s, not bunched until the budget runs out.
  CHECK(outage.longest_silence <= seconds(90));
}

TEST_CASE("LR5 D110: a day without Wi-Fi at DR0: within airtime, commands still answered") {
  const Outage outage = day_without_wifi(protocol::DataRate::dr0);
  MESSAGE("DR0: longest silence " << outage.longest_silence << ", busiest hour "
                                  << outage.busiest_hour << ", LoRa log packets "
                                  << outage.lora_log_packets);
  check_day(outage);
  // Paced to 1,647 ms × 3,600 s ÷ 18 s = 329.4 s, plus whatever went just before (an answer, a
  // log entry).
  CHECK(outage.longest_silence <= seconds(345));
}

}  // namespace
}  // namespace hsn::test::siren
