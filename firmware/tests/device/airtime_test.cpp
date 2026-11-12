// Airtime over a rolling hour per sub-band (protocol section 2, LR5).

#include <deque>
#include <utility>

#include "device/device_support.hpp"
#include "hsn/device/services/airtime.hpp"
#include "hsn/host/fake_random.hpp"

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

TEST_CASE("routine traffic stops at four fifths; essential traffic waits, never breaks the limit") {
  device::AirtimeState state;
  AirtimeBudget budget(state);
  const Instant start = at_seconds(3600 * 5);
  const Duration packet = device::milliseconds(1483);  // a sensor status at SF12
  Instant now = start;
  int routine = 0;
  while (budget.admit(Band::g1, packet, TxClass::routine, now).allowed) {
    budget.record(Band::g1, now, packet);
    now = now + device::seconds(10);
    routine += 1;
  }
  CHECK(routine == 19);  // 19 × 1.483 s ≤ 28.8 s < 20 × 1.483 s
  int essential = 0;
  while (budget.admit(Band::g1, packet, TxClass::essential, now).allowed) {
    budget.record(Band::g1, now, packet);
    now = now + device::seconds(10);
    essential += 1;
  }
  CHECK(essential == 5);  // up to 36 s
  const auto refused = budget.admit(Band::g1, packet, TxClass::essential, now);
  CHECK_FALSE(refused.allowed);
  // The first transmission leaves the window about an hour after it, and then one more fits.
  CHECK(refused.earliest > start + device::seconds(3600));
  CHECK(refused.earliest <= start + device::seconds(3600 + 60));
  CHECK(budget.admit(Band::g1, packet, TxClass::essential, refused.earliest).allowed);
  // A packet larger than the whole allowance never fits.
  CHECK(budget.admit(Band::g1, device::seconds(40), TxClass::essential, now).earliest.is_never());
}

TEST_CASE("over days of random traffic, no 60-minute window ever passes the limit") {
  device::AirtimeState state;
  AirtimeBudget budget(state);
  host::FakeRandom hardware(11);
  device::RandomSource random(hardware);
  std::deque<std::pair<Instant, Duration>> sent;
  Instant now = at_seconds(1000);
  for (int step = 0; step < 20000; ++step) {
    now = now + random.between(device::seconds(1), device::seconds(30));
    const Duration packet = random.between(device::milliseconds(50), device::milliseconds(1700));
    const TxClass tx_class = random.below(3) == 0 ? TxClass::essential : TxClass::routine;
    if (!budget.admit(Band::g1, packet, tx_class, now).allowed) {
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
    REQUIRE(window_us <= device::seconds(36).us);
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
  // Rebased to the restarted clock: all of it counts for the next hour, then none of it.
  budget.rebase(at_seconds(10));
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
