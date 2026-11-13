// The report pace (protocol section 7, pacing; SR6, D73, LR5): with Wi-Fi down at a slow rate,
// regular LoRa reports wait for their paced moment, but a report of a change (the cover opening,
// mains lost, the sounder stopping by itself) never waits for the pace: only for airtime. The
// regular report that was waiting still goes at its paced moment, with the newest state.

#include <cstring>

#include "hsn/device/services/radio_plan.hpp"
#include "siren_bench.hpp"
#include "siren_support.hpp"

namespace hsn::test::siren {
namespace {

using device::Input;
using device::LinkKind;
using roles::siren::SirenTimer;

/** Wi-Fi goes for good at this true instant; the hub hears the siren on LoRa only after it. */
constexpr std::int64_t kWifiGone = 120;

/** The slow rates the pace matters at. */
constexpr std::uint8_t kSlowRates[] = {protocol::DataRate::dr2, protocol::DataRate::dr0};

/** A siren paired to send and hear at `rate` only. */
host::HubOptions hub_at(std::uint8_t rate) {
  host::HubOptions options;
  options.allowed_data_rate_mask = static_cast<std::uint8_t>(1u << rate);
  return options;
}

host::SirenConfig siren_at(std::uint8_t rate) {
  host::SirenConfig config;
  config.send_data_rate = rate;
  config.command_data_rate = rate;
  return config;
}

/** Takes the network away at kWifiGone. */
void lose_wifi(SirenSite& site) {
  site.sim.schedule(at(seconds(kWifiGone)), [&site]() {
    site.siren.board().network.fail_connect = true;
    site.hub.drop_link("siren", LinkKind::network);
  });
}

/**
 * The longest from a change to the hub having its report: the channel check, the report on the
 * air, the hub's processing, and a small margin.
 */
device::Duration change_reach(std::uint8_t rate) {
  const host::HubOptions defaults;
  return device::cad_duration(rate).value() +
         device::time_on_air(rate, roles::siren::kReportPacketSize).value() + defaults.processing +
         milliseconds(50);
}

/** Runs to `when` and checks that a regular report is waiting for the pace then. */
device::Instant run_to_paced_hold(SirenSite& site, device::Instant when) {
  site.sim.run_until(when);
  const roles::siren::SirenState& state = site.role().state();
  REQUIRE(state.lora.wifi_failed);
  REQUIRE(state.timers.armed(SirenTimer::report_pace));
  REQUIRE(state.timers.at(SirenTimer::report_pace) > when + seconds(5));
  return state.timers.at(SirenTimer::report_pace);
}

/** The first report the hub accepted in [from, to), or none. */
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
    "§7 pacing: the cover opening is reported at once, and the waiting report still goes "
    "at its paced moment with the newest state") {
  for (const std::uint8_t rate : kSlowRates) {
    INFO("DR" << static_cast<int>(rate));
    SirenSite site(hub_at(rate), siren_at(rate));
    lose_wifi(site);
    const device::Instant opened = at(seconds(170));
    site.siren.set_input(Input::cover, true, opened);
    const device::Instant paced = run_to_paced_hold(site, opened + milliseconds(-100));
    site.sim.run_until(paced + change_reach(rate) + seconds(1));
    INFO(site.dump());
    const auto change = first_report(site, opened, paced);
    REQUIRE(change.has_value());
    CHECK(change->at <= opened + change_reach(rate));
    CHECK(change->path == HubPath::radio);
    CHECK(change->report.reason == reason::wifi_report_failed);
    CHECK(change->report.flags.cover_open);
    // Nothing else until the paced moment; then the waiting report, cover open.
    const auto regular = first_report(site, change->at + milliseconds(1), paced + seconds(60));
    REQUIRE(regular.has_value());
    CHECK(regular->at >= paced);
    CHECK(regular->at <= paced + change_reach(rate));
    CHECK(regular->report.flags.cover_open);
  }
}

TEST_CASE("§7 pacing: mains lost is reported at once while a report waits for the pace") {
  for (const std::uint8_t rate : kSlowRates) {
    INFO("DR" << static_cast<int>(rate));
    SirenSite site(hub_at(rate), siren_at(rate));
    site.siren.board().power.external = true;
    lose_wifi(site);
    const device::Instant lost = at(seconds(170));
    site.siren.set_input(Input::external_power, false, lost);
    const device::Instant paced = run_to_paced_hold(site, lost + milliseconds(-100));
    site.sim.run_until(lost + change_reach(rate) + seconds(1));
    INFO(site.dump());
    const auto change = first_report(site, lost, paced);
    REQUIRE(change.has_value());
    CHECK(change->at <= lost + change_reach(rate));
    CHECK(change->report.reason == reason::wifi_report_failed);
    CHECK_FALSE(change->report.flags.on_mains);
  }
}

TEST_CASE("§7 pacing: the sounder stopping by itself is reported at once while a report waits") {
  for (const std::uint8_t rate : kSlowRates) {
    INFO("DR" << static_cast<int>(rate));
    SirenSite site(hub_at(rate), siren_at(rate));
    lose_wifi(site);
    // Sent on LoRa only; it stops about 170 s in, inside a pace hold at either rate.
    site.command_at(seconds(kWifiGone + 5), action::sound_alarm, 43);
    site.run_until(seconds(kWifiGone + 20));
    REQUIRE(site.sounding());
    const device::Instant stops = site.role().state().stop_at;  // drift 0: true time
    const device::Instant paced = run_to_paced_hold(site, stops + milliseconds(-100));
    site.sim.run_until(stops + change_reach(rate) + seconds(1));
    INFO(site.dump());
    CHECK_FALSE(site.sounding());
    const auto change = first_report(site, stops, paced);
    REQUIRE(change.has_value());
    CHECK(change->at <= stops + change_reach(rate));
    CHECK(change->report.reason == reason::wifi_report_failed);
    CHECK(change->report.state == protocol::SirenState::off);
    CHECK(change->report.sounding_seconds_left == 0);
  }
}

TEST_CASE("§7 pacing: the link going down is reported at once, though a LoRa check set a pace") {
  const std::uint8_t rate = protocol::DataRate::dr2;
  SirenSite site(hub_at(rate), siren_at(rate));
  // The first LoRa check sets the pace for 82 s; the link drops 20 s after it.
  site.run_until(seconds(1));
  const device::Instant check = site.due(SirenTimer::lora_check);
  const device::Instant dropped = check + seconds(20);
  site.sim.schedule(dropped, [&site]() {
    site.siren.board().network.fail_connect = true;
    site.hub.drop_link("siren", LinkKind::network);
  });
  site.sim.run_until(dropped + milliseconds(-100));
  REQUIRE(site.role().state().lora.last_routine_report >= check);
  site.sim.run_until(dropped + change_reach(rate) + seconds(1));
  INFO(site.dump());
  const auto change = first_report(site, dropped, dropped + seconds(30));
  REQUIRE(change.has_value());
  CHECK(change->at <= dropped + change_reach(rate));
  CHECK(change->report.reason == reason::wifi_report_failed);
  CHECK_FALSE(change->report.flags.wifi_connected);
}

/** Rewrites the role's state, as a retained copy that passed its CRC would carry it. */
void edit_state(Bench& bench, void (*edit)(roles::siren::SirenState&)) {
  roles::siren::SirenState state = bench.state();
  edit(state);
  const protocol::MutableByteView bytes = bench.instance->role.state_bytes();
  REQUIRE(bytes.size() == sizeof(state));
  std::memcpy(bytes.data(), &state, sizeof(state));
}

TEST_CASE("§7 pacing: an item waiting for the pace does not hold back the items after it") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.quiet_timers();
  bench.deliver(Event::from_link(at_seconds(16), bench.board.network.down_event()), at_seconds(16));
  // A regular report waits for the pace, and a log entry waits behind it in the outbox.
  edit_state(bench, [](roles::siren::SirenState& state) {
    state.lora.change = false;
    state.lora.wifi_failed = true;
    state.lora.log = true;
    state.lora.last_routine_report = at_seconds(17);
  });
  const std::size_t checks =
      bench.board.radio.calls_of(host::RadioCall::Kind::detect_activity).size();
  bench.timer(at_seconds(18));
  CHECK(bench.state().timers.armed(SirenTimer::report_pace));
  CHECK(bench.state().lora.wifi_failed);
  // The log entry went to the port meanwhile.
  CHECK(bench.state().lora.in_flight == roles::siren::LoraItem::log);
  CHECK(bench.board.radio.calls_of(host::RadioCall::Kind::detect_activity).size() == checks + 1);
}

TEST_CASE("§7 pacing: a change report lost to a radio fault is tried again a second later") {
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  bench.quiet_timers();
  bench.deliver(Event::from_link(at_seconds(16), bench.board.network.down_event()), at_seconds(16));
  bench.deliver(
      Event::from_input(at_seconds(20), device::InputEvent{Input::cover, true, at_seconds(20)}),
      at_seconds(20));
  REQUIRE(bench.state().lora.in_flight == roles::siren::LoraItem::change);
  // The radio fails during the channel check: the port recovers it, and the report waits 1 s.
  bench.radio_event(bench.board.radio.fault(at_seconds(20)), at_seconds(20));
  CHECK(bench.state().lora.change);
  CHECK(bench.state().lora.in_flight == roles::siren::LoraItem::none);
  bench.wait_until(at_seconds(21));
  CHECK(bench.state().lora.in_flight == roles::siren::LoraItem::change);
  CHECK_FALSE(bench.state().lora.change);
}

}  // namespace
}  // namespace hsn::test::siren
