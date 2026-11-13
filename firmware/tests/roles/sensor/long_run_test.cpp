// A year in the life of a door sensor (design sections 5, 6 and 8; LR5, DS2, FW4): 365 simulated
// days of heartbeats and 20 door changes a day, armed every night. Flash writes stay within the
// design's yearly budget, airtime within 1% in every rolling hour, exactly one deep sleep per wake,
// and the sensor is never stuck awake.

#include <cstdint>
#include <vector>

#include "sensor_bench.hpp"

namespace hsn::test::sensor {
namespace {

/** The sensor's flash budget for a year (design section 5): ≈ 2,850 resume points + ≈ 10. */
constexpr std::size_t kYearlyFlashWrites = 2860;

/** 1% of an hour (protocol section 2). */
constexpr device::Duration kHourlyAirtime = seconds(36);

constexpr std::int64_t kDay = 24 * 3600;

/** One transmission's span, kept after the timeline is cleared. */
struct Span {
  Instant from;
  Instant until;
};

/** The most airtime in any rolling hour, exact: windows that start at a transmission's start. */
device::Duration busiest_hour(const std::vector<Span>& spans) {
  device::Duration busiest{};
  std::size_t end = 0;
  device::Duration inside{};
  for (std::size_t start = 0; start < spans.size(); ++start) {
    const Instant limit = spans[start].from + seconds(3600);
    while (end < spans.size() && spans[end].until <= limit) {
      inside = inside + (spans[end].until - spans[end].from);
      ++end;
    }
    // A transmission cut by the window's end counts the part inside it.
    device::Duration partial{};
    if (end < spans.size() && spans[end].from < limit) {
      partial = limit - spans[end].from;
    }
    const device::Duration total = inside + partial;
    busiest = total > busiest ? total : busiest;
    if (end > start) {
      inside = inside - (spans[start].until - spans[start].from);
    } else {
      end = start + 1;
    }
  }
  return busiest;
}

TEST_CASE(
    "long run: 365 days within the flash budget, 1% airtime every hour, one deep sleep per "
    "wake") {
  host::SimulationOptions options;
  options.keep_fake_records = false;
  Bench bench({}, options);
  host::SimDevice& door = bench.add();
  std::vector<Span> spans;
  std::size_t flash_writes = 0;
  std::size_t boots = 0;
  std::size_t deep_sleeps = 0;
  std::size_t door_changes = 0;
  std::uint64_t seed = 12345;
  for (std::int64_t day = 0; day < 365; ++day) {
    const Instant midnight = at(seconds(day * kDay));
    // Armed from 22:00 to 07:00; ten openings, each closed a minute later, in the daytime.
    bench.sim.schedule(midnight + seconds(7 * 3600), [&bench]() { bench.hub.disarm(); });
    bench.sim.schedule(midnight + seconds(22 * 3600), [&bench]() { bench.hub.arm(); });
    for (int opening = 0; opening < 10; ++opening) {
      seed = seed * 6364136223846793005ULL + 1442695040888963407ULL;
      // One per 78-minute slot from 08:00, at a random moment in its first hour: never two open.
      const std::int64_t offset =
          8 * 3600 + opening * 4680 + static_cast<std::int64_t>((seed >> 33) % 3600);
      door.set_input(Input::door, true, midnight + seconds(offset));
      door.set_input(Input::door, false, midnight + seconds(offset + 60));
    }
    bench.sim.run_until(midnight + seconds(kDay));
    for (const Record& record : door.records().kind(RecordKind::transmission).records()) {
      spans.push_back(Span{record.from, record.until});
    }
    flash_writes += door.records().kind(RecordKind::flash_write).count();
    boots += door.records().kind(RecordKind::boot).count();
    deep_sleeps += door.records().kind(RecordKind::deep_sleep).count();
    door_changes += door.records().kind(RecordKind::input).count();
    // Between two boots at most one deep sleep (design section 6).
    std::size_t since_boot = 0;
    for (const Record& record :
         door.records().kind(RecordKind::boot).kind(RecordKind::deep_sleep).records()) {
      since_boot = record.kind == RecordKind::boot ? 0 : since_boot + 1;
      REQUIRE(since_boot <= 1);
    }
    REQUIRE(door.records().kind(RecordKind::restart).count() == 0);
    bench.sim.timeline().clear();
  }
  INFO("flash writes " << flash_writes << ", boots " << boots << ", deep sleeps " << deep_sleeps);
  CHECK(door_changes == 365 * 20);
  // Every door change reached the hub.
  CHECK(bench.hub.received_from("door", type::door_changed).size() >= 365 * 20);
  // Flash within the design's budget (section 5).
  CHECK(flash_writes <= kYearlyFlashWrites);
  CHECK(door.board().storage.write_count(roles::sensor::kSettingsKey) <= 10);
  // 1% of every rolling hour (protocol section 2).
  CHECK(busiest_hour(spans) <= kHourlyAirtime);
  // Each wake ends in exactly one deep sleep; never stuck awake, never a fatal restart (FW4).
  CHECK(deep_sleeps <= boots);
  CHECK(deep_sleeps + 1 >= boots);
  CHECK_FALSE(door.board().storage.has(device::StoreKey::fatal_error));
  // About 480 heartbeats a day, at most one wake each.
  CHECK(bench.hub.received_from("door", type::heartbeat).size() >= 365 * 440);
}

}  // namespace
}  // namespace hsn::test::sensor
