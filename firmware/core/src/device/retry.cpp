#include "hsn/device/services/retry.hpp"

namespace hsn::device {

std::optional<Duration> RetrySchedule::gap(std::uint8_t attempt) const {
  if (attempt == 0) {
    return std::nullopt;
  }
  const std::size_t count =
      table_.gap_count < table_.gaps_ms.size() ? table_.gap_count : table_.gaps_ms.size();
  if (attempt <= count) {
    return milliseconds(table_.gaps_ms[attempt - 1u]);
  }
  if (table_.then_every_ms == 0) {
    return std::nullopt;
  }
  return milliseconds(table_.then_every_ms);
}

std::optional<Duration> RetrySchedule::base_offset(std::uint8_t attempt) const {
  if (!gap(attempt).has_value()) {
    return std::nullopt;
  }
  const std::size_t count =
      table_.gap_count < table_.gaps_ms.size() ? table_.gap_count : table_.gaps_ms.size();
  std::int64_t total_ms = 0;
  for (std::size_t i = 0; i < count && i < attempt; ++i) {
    total_ms += table_.gaps_ms[i];
  }
  if (attempt > count) {
    total_ms += static_cast<std::int64_t>(attempt - count) * table_.then_every_ms;
  }
  if (table_.give_up_after_ms != 0 && total_ms > table_.give_up_after_ms) {
    return std::nullopt;
  }
  return milliseconds(total_ms);
}

Duration RetrySchedule::jitter(Duration gap, RandomSource& random) const {
  if (table_.jitter_divisor == 0) {
    return Duration{};
  }
  return random.between(Duration{}, Duration{gap.us / table_.jitter_divisor});
}

std::optional<Instant> RetrySchedule::retry_time(Instant origin, std::uint8_t attempt,
                                                 Instant not_before, RandomSource& random) const {
  const auto offset = base_offset(attempt);
  if (!offset.has_value()) {
    return std::nullopt;
  }
  const Instant planned = origin + *offset + jitter(*gap(attempt), random);
  return latest(planned, not_before);
}

std::optional<Instant> RetrySchedule::after_failure(Instant failed_at, std::uint8_t attempt,
                                                    RandomSource& random) const {
  const auto wait = gap(attempt);
  if (!wait.has_value()) {
    return std::nullopt;
  }
  return failed_at + *wait + jitter(*wait, random);
}

Duration jittered(Duration nominal, std::uint8_t percent, RandomSource& random) {
  const std::int64_t spread = nominal.us / 100 * percent;
  return nominal + random.between(Duration{-spread}, Duration{spread});
}

}  // namespace hsn::device
