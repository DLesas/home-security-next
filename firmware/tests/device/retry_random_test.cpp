// Retry tables (protocol section 7) and the random source.

#include <set>

#include "device_support.hpp"
#include "hsn/device/services/random_source.hpp"
#include "hsn/device/services/retry.hpp"
#include "hsn/host/fake_random.hpp"

namespace hsn::test {
namespace {

using device::Duration;
using device::RetrySchedule;

TEST_CASE("sensor retries: about 2, 5, 10 s, then every 60 s, up to 10 minutes") {
  const RetrySchedule schedule(device::kSensorReportRetries);
  const std::int64_t expected[] = {2, 5, 10, 70, 130, 190, 250, 310, 370, 430, 490, 550};
  for (std::uint8_t attempt = 1; attempt <= 12; ++attempt) {
    const auto offset = schedule.base_offset(attempt);
    REQUIRE(offset.has_value());
    CHECK(*offset == device::seconds(expected[attempt - 1]));
  }
  CHECK_FALSE(schedule.base_offset(13).has_value());
  CHECK_FALSE(schedule.base_offset(0).has_value());
}

TEST_CASE("each retry waits up to half the gap before it, never before the listening ended") {
  host::FakeRandom hardware(7);
  device::RandomSource random(hardware);
  const RetrySchedule schedule(device::kSensorReportRetries);
  const Instant origin = at_seconds(100);
  bool low_half = false;
  bool high_half = false;
  for (int round = 0; round < 2000; ++round) {
    const auto first = schedule.retry_time(origin, 1, origin, random);
    REQUIRE(first.has_value());
    CHECK(*first >= origin + device::seconds(2));
    CHECK(*first <= origin + device::seconds(3));
    low_half = low_half || *first < origin + device::milliseconds(2500);
    high_half = high_half || *first > origin + device::milliseconds(2500);
    const auto fourth = schedule.retry_time(origin, 4, origin, random);
    REQUIRE(fourth.has_value());
    CHECK(*fourth >= origin + device::seconds(70));
    CHECK(*fourth <= origin + device::seconds(100));
  }
  CHECK(low_half);
  CHECK(high_half);
  // At SF12 the first try's listening ends after the first retry's planned time (decision G4).
  const Instant listen_end = origin + device::milliseconds(4600);
  const auto first = schedule.retry_time(origin, 1, listen_end, random);
  REQUIRE(first.has_value());
  CHECK(*first == listen_end);
}

TEST_CASE("reconnects wait 1, 2, 4, 8, 15, then 30 s after each failure, for ever") {
  host::FakeRandom hardware(1);
  device::RandomSource random(hardware);
  const RetrySchedule schedule(device::kReconnect);
  const std::int64_t gaps[] = {1, 2, 4, 8, 15, 30, 30};
  for (std::uint8_t attempt = 1; attempt <= 7; ++attempt) {
    const auto next = schedule.after_failure(at_seconds(50), attempt, random);
    REQUIRE(next.has_value());
    CHECK(*next == at_seconds(50 + gaps[attempt - 1]));
  }
  CHECK(schedule.after_failure(at_seconds(0), 250, random).has_value());
}

TEST_CASE("an unslotted heartbeat stays within ten per cent") {
  host::FakeRandom hardware(3);
  device::RandomSource random(hardware);
  for (int round = 0; round < 1000; ++round) {
    const Duration interval = device::jittered(device::seconds(180), 10, random);
    CHECK(interval >= device::seconds(162));
    CHECK(interval <= device::seconds(198));
  }
}

TEST_CASE("the random source stays in bounds and repeats with the same seed") {
  host::FakeRandom first_hardware(42);
  host::FakeRandom second_hardware(42);
  device::RandomSource first(first_hardware);
  device::RandomSource second(second_hardware);
  std::set<std::uint32_t> seen;
  for (int round = 0; round < 1000; ++round) {
    const std::uint32_t value = first.below(10);
    CHECK(value < 10);
    seen.insert(value);
    CHECK(second.below(10) == value);
    const Duration wait = first.between(device::milliseconds(200), device::milliseconds(2000));
    CHECK(wait == second.between(device::milliseconds(200), device::milliseconds(2000)));
    CHECK(wait >= device::milliseconds(200));
    CHECK(wait <= device::milliseconds(2000));
  }
  CHECK(seen.size() == 10);
  CHECK(first.below(0) == 0);
  CHECK(first.between(device::seconds(3), device::seconds(1)) == device::seconds(3));
}

}  // namespace
}  // namespace hsn::test
