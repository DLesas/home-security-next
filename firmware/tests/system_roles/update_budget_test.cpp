// The write budget on a rollout day (m3-updates-design.md section 4, "Durability": "The budget
// test's ordinary day does not change; it gains a rollout day with its own line"; section 8, "Hub
// tests"; hub-design.md section 5, "Budget"; m2-design.md section 3): a day of the largest home
// (home C: 64 sensors, 8 sirens, 3 gateways, hub/test/budget/budget.test.ts) with the real roles
// through the real hub in lockstep, its real writer on a real file with section 5's rules, and a
// rollout to every device approved at 08:00; and the same day without the rollout, to tell the
// rollout's own cost. Here, not in hub/test/budget/, because the hub's own world has no device
// that takes an update; the lockstep hub writes its writer's figures at its clean stop
// (shell/lockstep/files.ts). In the doctest suite "long": each day takes about two minutes.
//
// Measured and printed: commits by reason, WAL megabytes, the longest turn and the longest
// transfer frame's answer. Checked against the budget's lines for home C, and with HSN_TIMING=1
// section 3's loop limit; a line passed is a FOUND, never a line raised.

#ifdef HSN_LOCKSTEP

#include <cstdlib>
#include <memory>
#include <random>
#include <set>
#include <sstream>

#include "update_site.hpp"

namespace hsn::test::system {
namespace {

/** hub/test/budget/budget.test.ts: home C's day, measured plus 10% (`lineOf(1680)`), and 80 MB. */
constexpr std::int64_t kHomeCCommits = 1848;
constexpr double kHomeCWalMegabytes = 80;
/** The design's estimate for the rollout itself: about eight "now" commits a device (section 4). */
constexpr std::int64_t kRolloutCommitsPerDevice = 8;
/** Section 3's loop limit: 20 ms ‡ a turn on a Pi 4 (m2-design.md section 3, "The loop's time"). */
constexpr double kTurnLimitMs = 20;
/** Home C's devices (section 6): 3 gateways, 8 sirens, 64 sensors. */
constexpr std::size_t kHomeCDevices = 3 + 8 + 64;

/** One day's figures, from the lockstep hub's clean stop. */
struct DayFigures {
  std::int64_t commits = 0;
  std::string by_reason;
  double megabytes = 0;
  double turn_ms = 0;
  double transfer_ms = 0;
  std::size_t confirmed = 0;
  std::string status;

  std::string describe() const {
    std::ostringstream out;
    out << commits << " commits " << by_reason << ", " << megabytes
        << " MB of WAL frames, longest turn " << turn_ms << " ms, longest transfer frame "
        << transfer_ms << " ms, " << confirmed << " of " << kHomeCDevices << " confirmed";
    return out.str();
  }
};

/** A day of home C, with or without the rollout at 08:00. */
DayFigures run_day(bool rollout) {
  host::SimulationOptions simulation;
  simulation.keep_fake_records = false;
  SystemSite site(one_rate_site(), simulation);
  std::vector<std::string> everyone;
  std::vector<host::SimDevice*> doors;
  for (int g = 0; g < 3; ++g) {
    site.gateway("gateway" + std::to_string(g));
    everyone.push_back("gateway" + std::to_string(g));
  }
  for (int s = 0; s < 8; ++s) {
    site.siren("siren" + std::to_string(s));
    everyone.push_back("siren" + std::to_string(s));
  }
  for (int d = 0; d < 64; ++d) {
    // Powered on over a minute, so their Started packets do not all collide.
    doors.push_back(
        &site.sensor("door" + std::to_string(d), {}, 0, host::at(milliseconds(1000 * d))));
    everyone.push_back("door" + std::to_string(d));
  }
  // About 20 door changes a day per sensor, disarmed (logged only, D46).
  std::mt19937 random(7);
  for (host::SimDevice* door : doors) {
    std::vector<std::int64_t> moments;
    for (std::int64_t k = 0; k < kDoorChangesPerDay; ++k) {
      moments.push_back(draw(random, 600'000'000, kDay * 1'000'000));
    }
    std::sort(moments.begin(), moments.end());
    for (std::size_t k = 0; k < moments.size(); ++k) {
      door->set_input(Input::door, k % 2 == 0, host::at(microseconds(moments[k])));
    }
  }
  site.run_until(at_s(8 * 3600));
  if (rollout) {
    const host::RemoteImage& image =
        site.hub.add_own_build(host::make_test_image(kNewVersion, 60000), kNewVersion);
    site.hub.rollout_start(image.id);
  }
  // A siren on trial gets `hsn siren test` once, standing in for the "report now" the hub owes it
  // and does not send (FOUND F1); without it the siren pilot rolls back and the rollout pauses
  // after its pilots.
  std::set<std::string> tested;
  while (site.sim.now() < at_s(kDay)) {
    site.run_until(std::min(at_s(kDay), site.sim.now() + seconds(60)));
    for (int n = 0; n < 8 && rollout; ++n) {
      const std::string name = "siren" + std::to_string(n);
      const bool on_trial = !site.hub.decisions(HubAction::firmware_on_trial, name).empty() &&
                            site.hub.decisions(HubAction::firmware_confirmed, name).empty();
      if (on_trial && tested.insert(name).second) {
        site.hub.command_siren(name, protocol::SirenAction::test, 1);
      }
    }
  }
  DayFigures out;
  if (rollout) {
    out.status = json::write(site.hub.rollout_status());
  }
  for (const std::string& name : everyone) {
    out.confirmed += site.hub.decisions(HubAction::firmware_confirmed, name).size() == 1 ? 1 : 0;
  }
  CHECK(critical_events(site.hub).empty());
  site.hub.stop();
  REQUIRE(site.hub.run_stats().size() == 1);
  const json::Value& figures = site.hub.run_stats()[0];
  out.commits = figures.at("commits").as_int();
  out.by_reason = json::write(figures.at("commitsByReason"));
  out.megabytes = static_cast<double>(figures.at("walBytes").as_int()) / (1024 * 1024);
  out.turn_ms = static_cast<double>(figures.at("longestTurnUs").as_int()) / 1000;
  out.transfer_ms = static_cast<double>(figures.at("longestTransferUs").as_int()) / 1000;
  return out;
}

/** Each day once, for every case that asks for it. */
const DayFigures& day_of(bool rollout) {
  static std::unique_ptr<DayFigures> with;
  static std::unique_ptr<DayFigures> without;
  std::unique_ptr<DayFigures>& held = rollout ? with : without;
  if (held == nullptr) {
    held = std::make_unique<DayFigures>(run_day(rollout));
    const std::string which = rollout ? "a rollout day" : "the same day without it";
    MESSAGE("home C, " << which << ": " << held->describe());
  }
  return *held;
}

bool timing() {
  const char* set = std::getenv("HSN_TIMING");
  return set != nullptr && std::string(set) == "1";
}

TEST_SUITE("long") {
  TEST_CASE("section 5: home C's day in this world, without a rollout, within the budget's lines") {
    const DayFigures& day = day_of(false);
    CHECK(day.commits <= kHomeCCommits);
    CHECK(day.megabytes <= kHomeCWalMegabytes);
    if (timing()) {
      CHECK(day.turn_ms <= kTurnLimitMs);
    }
  }

  TEST_CASE(
      "section 4: a rollout day of home C: every device confirmed, the rollout's commits within "
      "the design's estimate, the day's within home C's line and the estimate") {
    const DayFigures& day = day_of(true);
    INFO(day.status);
    CHECK(day.confirmed == kHomeCDevices);
    const DayFigures& ordinary = day_of(false);
    const std::int64_t estimate =
        kRolloutCommitsPerDevice * static_cast<std::int64_t>(kHomeCDevices);
    MESSAGE("the rollout's own cost: " << day.commits - ordinary.commits << " commits, "
                                       << day.megabytes - ordinary.megabytes << " MB");
    CHECK(day.commits - ordinary.commits <= estimate);
    CHECK(day.commits <= kHomeCCommits + estimate);
    if (timing()) {
      CHECK(day.turn_ms <= kTurnLimitMs);
      CHECK(day.transfer_ms <= kTurnLimitMs);
    }
  }

  TEST_CASE("section 5: a rollout day of home C within home C's WAL line (80 MB)") {
    const DayFigures& day = day_of(true);
    CHECK(day.megabytes <= kHomeCWalMegabytes);
  }
}

}  // namespace
}  // namespace hsn::test::system

#endif
