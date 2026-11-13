// Urgent traffic past the legal hour (protocol section 2; D111, SR4, SR6): with Wi-Fi down and
// the hour's 36 s already used, reports of a change and answers still go, after the gap of nine
// times their airtime; regular reports and checks wait until the hour is back inside the limit;
// a cover that never stops changing cannot make the siren send more than a tenth of the time.
// And the siren hears the hub while it waits for a busy channel.

#include <optional>

#include "hsn/device/services/radio_plan.hpp"
#include "siren_bench.hpp"
#include "siren_support.hpp"

namespace hsn::test::siren {
namespace {

using device::Input;
using device::LinkKind;

constexpr std::int64_t kWifiGone = 120;
/** When the test fills the siren's legal hour, and the minute it is counted in. */
constexpr std::int64_t kHourUsedAt = 200;
constexpr std::uint32_t kHourUsedMinute = kHourUsedAt / 60;
/** The legal hour on the site channel, in the airtime record's 10 ms units (36 s). */
constexpr std::uint16_t kLegalHourUnits = 3600;
/** When the filled minute stops counting: 61 minutes after it began (design section 4). */
constexpr std::int64_t kHourBackAt = (kHourUsedMinute + device::kAirtimeBuckets) * 60;

constexpr std::uint8_t kSlowRates[] = {protocol::DataRate::dr2, protocol::DataRate::dr0};

/** A siren paired to send and hear at `rate` only, losing Wi-Fi at kWifiGone. */
struct SlowSite {
  explicit SlowSite(std::uint8_t rate_in)
      : rate(rate_in), site(hub_at(rate_in), siren_at(rate_in), quiet()) {
    site.sim.schedule(at(seconds(kWifiGone)), [this]() {
      site.siren.board().network.fail_connect = true;
      site.hub.drop_link("siren", LinkKind::network);
    });
  }

  static host::HubOptions hub_at(std::uint8_t r) {
    host::HubOptions options;
    options.allowed_data_rate_mask = static_cast<std::uint8_t>(1u << r);
    return options;
  }
  static host::SirenConfig siren_at(std::uint8_t r) {
    host::SirenConfig config;
    config.send_data_rate = r;
    config.command_data_rate = r;
    return config;
  }
  static host::SimulationOptions quiet() {
    host::SimulationOptions options;
    options.keep_fake_records = false;
    return options;
  }

  /** At kHourUsedAt, the siren's record shows its whole legal hour used in that minute. */
  void use_the_hour() {
    site.sim.schedule(at(seconds(kHourUsedAt)), [this]() {
      device::BandUsage& g1 =
          site.siren.services()->core.airtime.bands[static_cast<std::size_t>(device::Band::g1)];
      g1.newest_minute = kHourUsedMinute;
      g1.units[kHourUsedMinute % device::kAirtimeBuckets] = kLegalHourUnits;
    });
  }

  /** One report's time on air. */
  device::Duration report_airtime() const {
    return device::time_on_air(rate, roles::siren::kReportPacketSize).value();
  }

  /**
   * The longest from an urgent event to the hub having its packet, past the legal hour: the gap
   * of nine airtimes, the channel check, the packet, the hub's processing and a small margin.
   */
  device::Duration urgent_reach() const {
    const host::HubOptions defaults;
    return device::Duration{report_airtime().us * device::kPastLimitGapFactor} +
           device::cad_duration(rate).value() + report_airtime() + defaults.processing +
           milliseconds(50);
  }

  std::uint8_t rate;
  SirenSite site;
};

/** The first report the hub accepted in [from, to). */
std::optional<HubReport> first_report(const SirenSite& site, device::Instant from,
                                      device::Instant to) {
  for (const HubReport& report : site.reports()) {
    if (report.at >= from && report.at < to) {
      return report;
    }
  }
  return std::nullopt;
}

TEST_CASE(
    "D111: past the legal hour, a change and an answer still go after the gap, and "
    "regular reports wait until the hour is back inside the limit") {
  for (const std::uint8_t rate : kSlowRates) {
    INFO("DR" << static_cast<int>(rate));
    SlowSite slow(rate);
    SirenSite& site = slow.site;
    slow.use_the_hour();
    const device::Instant opened = at(seconds(kHourUsedAt + 5));
    site.siren.set_input(Input::cover, true, opened);
    const device::Instant commanded = at(seconds(kHourUsedAt + 60));
    site.command_at(seconds(kHourUsedAt + 60), action::test, 5);
    // Every packet past the limit is logged by the port. Logs cannot leave while Wi-Fi is down,
    // and later entries push old ones out of the 8, so read the siren's own log early.
    site.run_until(seconds(kHourUsedAt + 120));
    const device::LogState& log = site.siren.services()->core.log;
    bool logged = false;
    for (std::size_t i = 0; i < log.count; ++i) {
      logged = logged || log.records[(log.start + i) % device::kLogCapacity].code ==
                             device::log_code::airtime_past_limit;
    }
    CHECK(logged);
    site.run_until(seconds(kHourBackAt + 600));
    INFO(site.dump());

    // The cover: a change report, past the limit, within the gap.
    const auto change = first_report(site, opened, opened + seconds(60));
    REQUIRE(change.has_value());
    CHECK(change->at <= opened + slow.urgent_reach());
    CHECK(change->report.flags.cover_open);
    CHECK(change->report.reason == reason::wifi_report_failed);
    // The command: acted on when it arrived, and answered within the gap.
    const auto heard =
        site.siren.records().kind(RecordKind::reception).type(type::siren_command).records();
    REQUIRE_FALSE(heard.empty());
    CHECK(heard[0].at >= commanded);
    const auto outputs = site.outputs();
    REQUIRE_FALSE(outputs.empty());
    CHECK(outputs[0].first == heard[0].at);
    const auto answered = site.reports(reason::command_answer, HubPath::radio);
    REQUIRE_FALSE(answered.empty());
    CHECK(answered.back().at <= heard[0].at + slow.urgent_reach());
    // Nothing regular went while the hour was used: only those two, and the sounder stopping.
    const auto sent = site.siren.records()
                          .kind(RecordKind::transmission)
                          .between(at(seconds(kHourUsedAt)), at(seconds(kHourBackAt)))
                          .records();
    CHECK(sent.size() == 3);
    for (const host::Record& record : sent) {
      CHECK(record.label.type == type::siren_report);
    }
    // Back inside the limit, regular reports and checks go again.
    const auto later = site.siren.records()
                           .kind(RecordKind::transmission)
                           .between(at(seconds(kHourBackAt)), at(seconds(kHourBackAt + 600)));
    CHECK(later.count() >= 2);
  }
}

TEST_CASE(
    "D111: a cover that changes every 2 s for an hour: past the legal hour, a tenth of the "
    "time on air") {
  for (const std::uint8_t rate : kSlowRates) {
    INFO("DR" << static_cast<int>(rate));
    SlowSite slow(rate);
    SirenSite& site = slow.site;
    const std::int64_t from = kWifiGone + 30;
    const std::int64_t until = from + 3600;
    bool open = true;
    for (std::int64_t s = from; s < until; s += 2) {
      site.siren.set_input(Input::cover, open, at(seconds(s)));
      open = !open;
    }
    site.run_until(seconds(until));
    const host::Selection sent = site.siren.records().kind(RecordKind::transmission);
    MESSAGE("DR" << static_cast<int>(rate) << " cover storm: busiest hour " << sent.busiest_hour()
                 << ", busiest 10 minutes " << sent.busiest(device::seconds(600)));
    // Inside the legal hour urgent reports go back to back; past it each waits nine of its
    // airtimes. So once the 36 s are used, any ten minutes hold a tenth at most (plus the packet
    // a window cuts), and the busiest hour holds the 36 s plus a tenth.
    const host::Selection past = sent.between(at(seconds(from + 600)), at(seconds(until)));
    CHECK(past.busiest(seconds(600)) <= seconds(60) + slow.report_airtime());
    CHECK(sent.busiest_hour() <= seconds(36 + 360));
    // The legal hour was used up, so this storm really ran past it.
    CHECK(sent.busiest_hour() > seconds(36));
  }
}

TEST_CASE("§2: a command that comes while the siren waits for a busy channel is acted on then") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  // Wi-Fi never came up: at 31 s Started is due on LoRa, and the channel is busy.
  bench.wait_until(at_seconds(31));
  REQUIRE(bench.state().lora.in_flight == roles::siren::LoraItem::started);
  const std::size_t receives = bench.board.radio.calls_of(host::RadioCall::Kind::receive).size();
  bench.radio_event(bench.board.radio.cad_done(at_seconds(31), true), at_seconds(31));
  REQUIRE(bench.instance->services.radio_port.state() == device::PortState::backing_off);
  // The port listens again for the wait, at the command rate.
  const auto listening = bench.board.radio.calls_of(host::RadioCall::Kind::receive);
  REQUIRE(listening.size() == receives + 1);
  CHECK(listening.back().rx.channel.frequency_hz == device::kReplyFrequencyHz);
  CHECK(listening.back().rx.timeout == device::Duration{});
  // The hub's command arrives during the wait: acted on at once, its answer queued behind.
  const Instant arrives = at_seconds(31) + milliseconds(100);
  bench.radio_packet(Bench::sound(30, 5), arrives);
  CHECK(bench.board.siren_io.output_state);
  CHECK(bench.state().lora.answer);
  CHECK(bench.instance->services.radio_port.state() == device::PortState::backing_off);
  CHECK(bench.state().lora.in_flight == roles::siren::LoraItem::started);
}

}  // namespace
}  // namespace hsn::test::siren
