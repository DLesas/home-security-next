// Airtime over a rolling hour per sub-band (protocol section 2, LR5).

#include <deque>
#include <utility>

#include "device_support.hpp"
#include "hsn/device/services/airtime.hpp"
#include "hsn/host/fake_random.hpp"
#include "hsn/protocol/radio.hpp"

namespace hsn::test {
namespace {

using device::AirtimeBudget;
using device::Band;
using device::Duration;
using device::TxClass;

TEST_CASE("frequencies fall in their sub-bands and limits") {
  CHECK(device::band_of(868100000) == Band::g1);
  CHECK(device::band_of(868500000) == Band::g1);
  CHECK(device::band_of(device::kReplyFrequencyHz) == Band::g3);
  CHECK_FALSE(device::band_of(869000000).has_value());
  CHECK(AirtimeBudget::allowance(Band::g1, TxClass::essential) == device::seconds(36));
  CHECK(AirtimeBudget::allowance(Band::g1, TxClass::routine) == device::milliseconds(28800));
  CHECK(AirtimeBudget::allowance(Band::g3, TxClass::routine) == device::seconds(288));
  CHECK(device::site_channel_frequency(1) == 868300000u);
  CHECK_FALSE(device::site_channel_frequency(3).has_value());
}

/** A sensor status at SF12. */
constexpr Duration kSf12Status = device::milliseconds(1483);

/** Fills a budget from `start`: 19 routine then 5 essential SF12 packets, 10 s apart. */
Instant fill_hour(AirtimeBudget& budget, Instant start) {
  Instant now = start;
  int routine = 0;
  while (budget.admit(Band::g1, kSf12Status, TxClass::routine, now).allowed) {
    budget.record(Band::g1, now, kSf12Status);
    now = now + device::seconds(10);
    routine += 1;
  }
  CHECK(routine == 19);  // 19 × 1.49 s ≤ 28.8 s < 20 × 1.49 s
  int essential = 0;
  while (true) {
    const auto admission = budget.admit(Band::g1, kSf12Status, TxClass::essential, now);
    if (admission.past_limit) {
      break;
    }
    // Inside the hour: admitted at once, unflagged.
    REQUIRE(admission.allowed);
    CHECK(admission.earliest == now);
    budget.record(Band::g1, now, kSf12Status);
    now = now + device::seconds(10);
    essential += 1;
  }
  CHECK(essential == 5);  // up to 36 s
  return now;
}

TEST_CASE("routine traffic stops at four fifths, and is told when it fits again") {
  device::AirtimeState state;
  AirtimeBudget budget(state);
  const Instant start = at_seconds(3600 * 5);
  const Instant full = fill_hour(budget, start);
  // At 100% of the hour, as at 80%: refused until the first packet leaves the window.
  const auto refused = budget.admit(Band::g1, kSf12Status, TxClass::routine, full);
  CHECK_FALSE(refused.allowed);
  CHECK_FALSE(refused.past_limit);
  CHECK(refused.earliest > start + device::seconds(3600));
  CHECK(refused.earliest <= start + device::seconds(3600 + 60));
  CHECK(budget.admit(Band::g1, kSf12Status, TxClass::routine, refused.earliest).allowed);
}

TEST_CASE("past the legal hour an essential packet goes after a gap of nine times its airtime") {
  device::AirtimeState state;
  AirtimeBudget budget(state);
  const Instant full = fill_hour(budget, at_seconds(3600 * 5));
  // The last packet started 10 s before `full` and lasted 1.483 s; the gap is 9 × 1.483 s.
  const Instant last_end = full + device::seconds(-10) + kSf12Status;
  const Instant gap_end = last_end + Duration{9 * kSf12Status.us};
  const auto waiting = budget.admit(Band::g1, kSf12Status, TxClass::essential, full);
  CHECK_FALSE(waiting.allowed);
  CHECK(waiting.past_limit);
  CHECK(waiting.earliest == gap_end);
  CHECK_FALSE(
      budget.admit(Band::g1, kSf12Status, TxClass::essential, gap_end + device::microseconds(-1))
          .allowed);
  const auto past = budget.admit(Band::g1, kSf12Status, TxClass::essential, gap_end);
  CHECK(past.allowed);
  CHECK(past.past_limit);
  CHECK(past.earliest == gap_end);
  // It is counted: the hour reads above its limit, and routine traffic stays refused longer.
  const Duration before = budget.used_last_hour(Band::g1, gap_end);
  budget.record(Band::g1, gap_end, kSf12Status);
  CHECK(budget.used_last_hour(Band::g1, gap_end) == before + device::milliseconds(1490));
  CHECK(budget.used_last_hour(Band::g1, gap_end) > device::seconds(36));
  CHECK_FALSE(budget.admit(Band::g1, kSf12Status, TxClass::routine, gap_end).allowed);
}

TEST_CASE("back to back for an hour, past the limit a device sends at most a tenth of the time") {
  for (const std::uint8_t data_rate :
       {protocol::DataRate::dr5, protocol::DataRate::dr2, protocol::DataRate::dr0}) {
    INFO("data rate " << int{data_rate});
    device::AirtimeState state;
    AirtimeBudget budget(state);
    const Duration airtime = device::time_on_air(data_rate, 25).value();
    const Instant start = at_seconds(10000);
    const Instant end = start + device::seconds(3600);
    Instant now = start;
    Instant previous_end;
    Instant first_past = Instant::never();
    std::int64_t past_us = 0;
    while (now < end) {
      const auto admission = budget.admit(Band::g1, airtime, TxClass::essential, now);
      if (!admission.allowed) {
        REQUIRE(admission.earliest > now);
        now = admission.earliest;
        continue;
      }
      if (admission.past_limit) {
        if (first_past.is_never()) {
          first_past = now;
        } else {
          CHECK(now - previous_end >= Duration{9 * airtime.us});
        }
        past_us += airtime.us;
      }
      budget.record(Band::g1, now, airtime);
      previous_end = now + airtime;
      now = previous_end;
    }
    REQUIRE_FALSE(first_past.is_never());
    // From the first packet past the limit to the end of the hour: at most a tenth, plus that one.
    CHECK(past_us <= (end - first_past).us / 10 + airtime.us);
  }
}

TEST_CASE("routine traffic alone never takes a 60-minute window past four fifths") {
  device::AirtimeState state;
  AirtimeBudget budget(state);
  host::FakeRandom hardware(11);
  device::RandomSource random(hardware);
  std::deque<std::pair<Instant, Duration>> sent;
  Instant now = at_seconds(1000);
  for (int step = 0; step < 20000; ++step) {
    now = now + random.between(device::seconds(1), device::seconds(30));
    const Duration packet = random.between(device::milliseconds(50), device::milliseconds(1700));
    if (!budget.admit(Band::g1, packet, TxClass::routine, now).allowed) {
      continue;
    }
    budget.record(Band::g1, now, packet);
    sent.emplace_back(now, packet);
    while (!sent.empty() && now - sent.front().first >= device::seconds(3600)) {
      sent.pop_front();
    }
    std::int64_t window_us = 0;
    for (const auto& [at, length] : sent) {
      window_us += (length.us + 9999) / 10000 * 10000;
    }
    REQUIRE(window_us <= device::milliseconds(28800).us);
  }
}

TEST_CASE("a clock that went back keeps counting what was sent") {
  device::AirtimeState state;
  AirtimeBudget budget(state);
  for (int i = 0; i < 20; ++i) {
    budget.record(Band::g3, at_seconds(7200 + 3 * i), device::seconds(15));
  }
  CHECK(budget.used_last_hour(Band::g3, at_seconds(10)) == device::seconds(300));
  budget.record(Band::g3, at_seconds(10), device::seconds(50));
  CHECK(budget.used_last_hour(Band::g3, at_seconds(7200)) == device::seconds(350));
  // Rebased to the restarted clock: all of it counts for the next hour, then none of it, and the
  // last transmission is taken to have ended at the reset.
  budget.rebase(at_seconds(10));
  // 350 s + 15 s is past the 360 s hour: the gap of 9 × 15 s counts from the reset.
  const auto after_reset =
      budget.admit(Band::g3, device::seconds(15), TxClass::essential, at_seconds(10));
  CHECK_FALSE(after_reset.allowed);
  CHECK(after_reset.past_limit);
  CHECK(after_reset.earliest == at_seconds(10 + 135));
  CHECK(budget.used_last_hour(Band::g3, at_seconds(10)) == device::seconds(350));
  CHECK(budget.used_last_hour(Band::g3, at_seconds(10 + 3600)) == device::seconds(350));
  CHECK(budget.used_last_hour(Band::g3, at_seconds(10 + 3700)) == device::Duration{});
}

TEST_CASE("a saturated bucket still counts as full") {
  device::AirtimeState state;
  AirtimeBudget budget(state);
  for (int i = 0; i < 100; ++i) {
    budget.record(Band::g3, at_seconds(60), device::seconds(9));
  }
  CHECK_FALSE(budget.admit(Band::g3, device::milliseconds(100), TxClass::essential, at_seconds(61))
                  .allowed);
}

TEST_CASE("gateway status airtime in hundredths of a percent") {
  device::AirtimeState state;
  AirtimeBudget budget(state);
  budget.record(Band::g3, at_seconds(100), device::seconds(36));
  CHECK(budget.used_hundredths_of_percent(Band::g3, at_seconds(200)) == 100);
  CHECK(budget.used_hundredths_of_percent(Band::g3, at_seconds(100 + 3700)) == 0);
}

}  // namespace
}  // namespace hsn::test
