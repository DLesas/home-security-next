#pragma once

#include <array>
#include <cstdint>

#include "hsn/device/time.hpp"
#include "hsn/roles/gateway/constants.hpp"

namespace hsn::roles::gateway {

/** Where the interference watch stands (design section 7: normal, suspected, alerting). */
enum class InterferencePhase : std::uint8_t {
  /** The level is near normal. */
  normal,
  /** The level is above normal by the threshold, not yet for long enough. */
  suspected,
  /** It has lasted: "interference started" has gone to the hub. */
  alerting,
};

/** The noise readings and the interference watch: plain data, part of the role's state. */
struct NoiseState {
  /** Samples since the last status, oldest overwritten once full. */
  std::array<std::int8_t, kNoiseSampleCount> samples{};
  std::uint8_t sample_count = 0;
  std::uint8_t next_sample = 0;
  std::int8_t highest = kNoNoiseReading;
  /** The learned normal level in sixteenths of a dB, and how many samples it has learned. */
  std::int32_t normal_scaled = 0;
  std::uint16_t learned = 0;
  InterferencePhase phase = InterferencePhase::normal;
  /** When the level first stood above normal in the current episode. */
  device::Instant since;
  /** Sum and count of the episode's samples, for the level reported with it. */
  std::int32_t episode_sum = 0;
  std::uint16_t episode_samples = 0;
};

/** What a sample changed for the hub. */
enum class InterferenceChange : std::uint8_t {
  none,
  started,
  ended,
};

/** One interference message's contents (protocol section 6, interference). */
struct InterferenceReport {
  InterferenceChange change = InterferenceChange::none;
  std::int8_t noise_dbm = 0;
  std::uint16_t duration_seconds = 0;
};

/** The interference alert settings in force (protocol section 6, gateway settings). */
struct InterferenceLimits {
  std::uint8_t threshold_db = kDefaultInterferenceDb;
  std::uint8_t seconds = kDefaultInterferenceSeconds;
};

/**
 * The gateway's noise watch (GW11, D82): samples taken while listening, their median and highest
 * since the last status, a normal level learned by integer averaging from quiet samples, and the
 * interference episodes. Interference starts when every sample for `seconds` stands more than
 * `threshold_db` above normal, so a single packet on the air, which lasts at most a few seconds,
 * never starts one; it ends with the first sample back within the threshold. Integer arithmetic
 * only; every loop is bounded by kNoiseSampleCount.
 */
class NoiseMonitor {
public:
  explicit NoiseMonitor(NoiseState& state) : state_(state) {}

  /**
   * Takes one sample at `now` and returns what changed for the hub.
   */
  InterferenceReport sample(device::Instant now, std::int16_t level_dbm,
                            const InterferenceLimits& limits);

  /**
   * Returns the median of the samples since the last status, or kNoNoiseReading.
   */
  std::int8_t median() const;

  /**
   * Returns the highest sample since the last status, or kNoNoiseReading.
   */
  std::int8_t highest() const {
    return state_.highest;
  }

  /**
   * Returns the learned normal level, rounded to the nearest dB, or kNoNoiseReading before the
   * first sample.
   */
  std::int8_t normal() const;

  /**
   * Starts a new status period: forgets the samples, keeps the normal level and any episode.
   */
  void start_period();

  /**
   * Forgets everything: a new channel has its own noise.
   */
  void reset();

private:
  void keep(std::int8_t level);
  void learn(std::int8_t level);
  InterferenceReport report(InterferenceChange change, device::Instant now) const;

  NoiseState& state_;
};

}  // namespace hsn::roles::gateway
