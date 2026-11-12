#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "hsn/device/services/radio_plan.hpp"
#include "hsn/device/time.hpp"

namespace hsn::device {

/**
 * Buckets per band: 61 one-minute buckets, so a sum over them covers at least the last full
 * hour and over-counts by at most one minute, on the safe side.
 */
constexpr std::size_t kAirtimeBuckets = 61;

/** The unit of a bucket: 10 ms, so one bucket holds up to 655 s, above either band's limit. */
constexpr std::int64_t kAirtimeUnitUs = 10000;

/**
 * One band's recent airtime: units of 10 ms per minute, indexed by minute number modulo 61. A
 * bucket saturates at 655.35 s, which is above both limits, so saturation always means "full".
 */
struct BandUsage {
  /** The newest minute number written (instant ÷ 60 s). */
  std::uint32_t newest_minute = 0;
  std::array<std::uint16_t, kAirtimeBuckets> units{};
};

/** Every band's recent airtime: plain data, kept in the retained block (design section 5). */
struct AirtimeState {
  std::array<BandUsage, kBandCount> bands{};
};

/** Priority classes (protocol section 2, "Airtime budgets"). */
enum class TxClass : std::uint8_t {
  /** May use four fifths of the hour: heartbeats, LoRa checks, ordinary transmit requests. */
  routine,
  /** May use all of it: door, cover, button and started reports, command answers, commands. */
  essential,
};

/** Whether a transmission fits now, and if not, when it will. */
struct Admission {
  bool allowed = false;
  /** When it would fit, or never when it cannot fit at all. */
  Instant earliest = Instant::never();
};

/**
 * Airtime over a rolling hour per sub-band (LR5). Every transmitter enforces its own limit; the
 * limit is never broken: an essential packet that does not fit waits (protocol section 2).
 */
class AirtimeBudget {
public:
  explicit AirtimeBudget(AirtimeState& state) : state_(state) {}

  /**
   * Returns the airtime a class may use per hour: the band's limit, or four fifths of it for
   * routine traffic.
   */
  static Duration allowance(Band band, TxClass tx_class);

  /**
   * Judges a transmission of `airtime` starting now.
   */
  Admission admit(Band band, Duration airtime, TxClass tx_class, Instant now) const;

  /**
   * Records a transmission that started at `start`, rounded up to 10 ms.
   */
  void record(Band band, Instant start, Duration airtime);

  /**
   * After the clock restarted (design section 5): the recorded times mean nothing, so every
   * band's whole recent airtime is counted again as sent in the current minute. That keeps it
   * counted for a full hour from now, on the safe side, without waiting for the old clock.
   */
  void rebase(Instant now);

  /**
   * Returns the airtime used in the last hour, at minute resolution, over-counting by at most a
   * minute.
   */
  Duration used_last_hour(Band band, Instant now) const;

  /**
   * Returns the airtime used in the last hour in hundredths of a percent of the hour, as a
   * gateway status reports it (protocol section 6).
   */
  std::uint16_t used_hundredths_of_percent(Band band, Instant now) const;

private:
  AirtimeState& state_;
};

}  // namespace hsn::device
