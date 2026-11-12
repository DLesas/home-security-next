#include "hsn/device/services/airtime.hpp"

namespace hsn::device {
namespace {

constexpr std::uint64_t kMinuteUs = 60000000;

std::uint32_t minute_of(Instant at) {
  return static_cast<std::uint32_t>(at.us / kMinuteUs);
}

std::size_t slot(std::uint32_t minute) {
  return minute % kAirtimeBuckets;
}

/** True when the bucket of `minute` still counts at minute `now`. */
bool counts(std::uint32_t minute, std::uint32_t now) {
  return static_cast<std::uint64_t>(minute) + (kAirtimeBuckets - 1) >= now;
}

const BandUsage& usage(const AirtimeState& state, Band band) {
  return state.bands[static_cast<std::size_t>(band)];
}

/** Airtime in units, rounded up. */
std::int64_t units_of(Duration airtime) {
  return airtime.us <= 0 ? 0 : (airtime.us + kAirtimeUnitUs - 1) / kAirtimeUnitUs;
}

std::uint16_t saturated(std::int64_t units) {
  return static_cast<std::uint16_t>(units > 0xFFFF ? 0xFFFF : units);
}

}  // namespace

Duration AirtimeBudget::allowance(Band band, TxClass tx_class) {
  const Duration limit = hourly_limit(band);
  return tx_class == TxClass::essential ? limit : Duration{limit.us / 5 * 4};
}

Duration AirtimeBudget::used_last_hour(Band band, Instant now) const {
  const BandUsage& band_usage = usage(state_, band);
  const std::uint32_t current = minute_of(now);
  std::int64_t total = 0;
  for (std::uint32_t back = 0; back < kAirtimeBuckets && back <= band_usage.newest_minute; ++back) {
    const std::uint32_t minute = band_usage.newest_minute - back;
    if (counts(minute, current)) {
      total += band_usage.units[slot(minute)];
    }
  }
  return microseconds(total * kAirtimeUnitUs);
}

Admission AirtimeBudget::admit(Band band, Duration airtime, TxClass tx_class, Instant now) const {
  const Duration allowed = allowance(band, tx_class);
  // Rounded up, as record() will count it.
  const Duration counted = microseconds(units_of(airtime) * kAirtimeUnitUs);
  Admission admission;
  if (counted > allowed) {
    return admission;
  }
  const Duration used = used_last_hour(band, now);
  if (used + counted <= allowed) {
    admission.allowed = true;
    admission.earliest = now;
    return admission;
  }
  // Walk the counted buckets from the oldest: each stops counting 61 minutes after its minute.
  const BandUsage& band_usage = usage(state_, band);
  const std::uint32_t current = minute_of(now);
  std::int64_t freed = 0;
  for (std::uint32_t back = kAirtimeBuckets; back > 0; --back) {
    if (back - 1 > band_usage.newest_minute) {
      continue;
    }
    const std::uint32_t minute = band_usage.newest_minute - (back - 1);
    if (!counts(minute, current)) {
      continue;
    }
    freed += band_usage.units[slot(minute)];
    if (used - microseconds(freed * kAirtimeUnitUs) + counted <= allowed) {
      const std::uint64_t drop_minute = static_cast<std::uint64_t>(minute) + kAirtimeBuckets;
      admission.earliest = latest(now, Instant{drop_minute * kMinuteUs});
      return admission;
    }
  }
  return admission;
}

void AirtimeBudget::record(Band band, Instant start, Duration airtime) {
  BandUsage& band_usage = state_.bands[static_cast<std::size_t>(band)];
  const std::uint32_t minute = minute_of(start);
  if (minute > band_usage.newest_minute) {
    // Clear the buckets of the minutes skipped since the newest one, at most all of them.
    const std::uint32_t skipped = minute - band_usage.newest_minute;
    const std::uint32_t clear = skipped < kAirtimeBuckets ? skipped : kAirtimeBuckets;
    for (std::uint32_t i = 0; i < clear; ++i) {
      band_usage.units[slot(minute - i)] = 0;
    }
    band_usage.newest_minute = minute;
  }
  // A start before the newest minute (a clock that went back) is added to the newest bucket,
  // which keeps it counted for longer: on the safe side.
  const std::size_t index = slot(band_usage.newest_minute);
  band_usage.units[index] = saturated(band_usage.units[index] + units_of(airtime));
}

void AirtimeBudget::rebase(Instant now) {
  for (BandUsage& band_usage : state_.bands) {
    std::int64_t total = 0;
    for (std::uint16_t& bucket : band_usage.units) {
      total += bucket;
      bucket = 0;
    }
    band_usage.newest_minute = minute_of(now);
    band_usage.units[slot(band_usage.newest_minute)] = saturated(total);
  }
}

std::uint16_t AirtimeBudget::used_hundredths_of_percent(Band band, Instant now) const {
  // used ÷ 3,600 s × 10,000 = used in ms ÷ 360, rounded to the nearest.
  const std::int64_t used_ms = used_last_hour(band, now).us / 1000;
  const std::int64_t hundredths = (used_ms + 180) / 360;
  return static_cast<std::uint16_t>(hundredths > 0xFFFF ? 0xFFFF : hundredths);
}

}  // namespace hsn::device
