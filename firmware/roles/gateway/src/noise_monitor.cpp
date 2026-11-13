#include "hsn/roles/gateway/noise_monitor.hpp"

#include <limits>

namespace hsn::roles::gateway {
namespace {

constexpr std::int16_t kLowestDbm = std::numeric_limits<std::int8_t>::min();
constexpr std::int16_t kHighestDbm = std::numeric_limits<std::int8_t>::max();
constexpr std::uint16_t kMaxCount = std::numeric_limits<std::uint16_t>::max();

/** A reading as the one-byte dBm fields carry it, limited to their range. */
std::int8_t to_field(std::int32_t dbm) {
  if (dbm < kLowestDbm) {
    return static_cast<std::int8_t>(kLowestDbm);
  }
  if (dbm > kHighestDbm) {
    return static_cast<std::int8_t>(kHighestDbm);
  }
  return static_cast<std::int8_t>(dbm);
}

/** Divides, rounding to the nearest whole number with an exact half up (protocol section 3). */
std::int32_t divide_rounded(std::int32_t value, std::int32_t divisor) {
  const std::int32_t shifted = value + divisor / 2;
  std::int32_t quotient = shifted / divisor;
  if (shifted % divisor != 0 && shifted < 0) {
    quotient -= 1;
  }
  return quotient;
}

}  // namespace

void NoiseMonitor::keep(std::int8_t level) {
  state_.samples[state_.next_sample] = level;
  state_.next_sample = static_cast<std::uint8_t>((state_.next_sample + 1u) % kNoiseSampleCount);
  if (state_.sample_count < kNoiseSampleCount) {
    state_.sample_count += 1;
  }
  if (state_.highest == kNoNoiseReading || level > state_.highest) {
    state_.highest = level;
  }
}

void NoiseMonitor::learn(std::int8_t level) {
  const std::int32_t scaled = static_cast<std::int32_t>(level) * kNoiseScale;
  if (state_.learned == 0) {
    state_.normal_scaled = scaled;
    state_.learned = 1;
    return;
  }
  // A running mean over the first samples, then a moving average of weight kNormalNoiseWeight.
  const std::int32_t weight = state_.learned < kNormalNoiseWeight
                                  ? static_cast<std::int32_t>(state_.learned) + 1
                                  : kNormalNoiseWeight;
  state_.normal_scaled += (scaled - state_.normal_scaled) / weight;
  state_.learned = static_cast<std::uint16_t>(weight);
}

InterferenceReport NoiseMonitor::report(InterferenceChange change, device::Instant now) const {
  InterferenceReport out;
  out.change = change;
  out.noise_dbm = state_.episode_samples == 0
                      ? kNoNoiseReading
                      : to_field(state_.episode_sum / state_.episode_samples);
  const std::int64_t lasted = (now - state_.since).us / kMicrosPerSecond;
  out.duration_seconds = static_cast<std::uint16_t>(lasted < 0           ? 0
                                                    : lasted > kMaxCount ? kMaxCount
                                                                         : lasted);
  return out;
}

InterferenceReport NoiseMonitor::sample(device::Instant now, std::int16_t level_dbm,
                                        const InterferenceLimits& limits) {
  const std::int8_t level = to_field(level_dbm);
  keep(level);
  if (state_.learned == 0) {
    learn(level);
    return InterferenceReport{};
  }
  const bool above =
      static_cast<std::int32_t>(level) > static_cast<std::int32_t>(normal()) + limits.threshold_db;
  if (above) {
    if (state_.phase == InterferencePhase::normal) {
      state_.phase = InterferencePhase::suspected;
      state_.since = now;
      state_.episode_sum = 0;
      state_.episode_samples = 0;
    }
    if (state_.episode_samples < kMaxCount) {
      state_.episode_sum += level;
      state_.episode_samples += 1;
    }
    if (state_.phase == InterferencePhase::suspected &&
        now - state_.since >= device::seconds(limits.seconds)) {
      state_.phase = InterferencePhase::alerting;
      return report(InterferenceChange::started, now);
    }
    return InterferenceReport{};
  }
  // Back within the threshold: a suspicion is forgotten, an alert ends. Only quiet samples teach
  // the normal level, so interference never becomes normal.
  const bool was_alerting = state_.phase == InterferencePhase::alerting;
  const InterferenceReport ended = report(InterferenceChange::ended, now);
  state_.phase = InterferencePhase::normal;
  learn(level);
  return was_alerting ? ended : InterferenceReport{};
}

std::int8_t NoiseMonitor::median() const {
  const std::size_t count = state_.sample_count;
  if (count == 0) {
    return kNoNoiseReading;
  }
  // The lower median by counting, without sorting a copy: bounded by kNoiseSampleCount squared.
  const std::size_t rank = (count - 1) / 2;
  for (std::size_t i = 0; i < count; ++i) {
    std::size_t below = 0;
    std::size_t same = 0;
    for (std::size_t j = 0; j < count; ++j) {
      below += state_.samples[j] < state_.samples[i] ? 1u : 0u;
      same += state_.samples[j] == state_.samples[i] ? 1u : 0u;
    }
    if (below <= rank && rank < below + same) {
      return state_.samples[i];
    }
  }
  return kNoNoiseReading;
}

std::int8_t NoiseMonitor::normal() const {
  if (state_.learned == 0) {
    return kNoNoiseReading;
  }
  return to_field(divide_rounded(state_.normal_scaled, kNoiseScale));
}

void NoiseMonitor::start_period() {
  state_.sample_count = 0;
  state_.next_sample = 0;
  state_.highest = kNoNoiseReading;
}

void NoiseMonitor::reset() {
  state_ = NoiseState{};
}

}  // namespace hsn::roles::gateway
