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
  /** The end of this device's last recorded transmission on the band (D111's gap). */
  Instant last_end;
};

/**
 * Past the legal hour an essential packet waits nine times its own airtime after the device's
 * last transmission (D111): the device then sends at most one tenth of the time, so a faulty one,
 * a stuck door switch, can never take more than a tenth of the channel from the other devices.
 */
constexpr std::int64_t kPastLimitGapFactor = 9;

/** Every band's recent airtime: plain data, kept in the retained block (design section 5). */
struct AirtimeState {
  std::array<BandUsage, kBandCount> bands{};
};

/** Priority classes (protocol section 2, "Airtime budgets"). */
enum class TxClass : std::uint8_t {
  /** Regular: four fifths of the hour, never more: heartbeats, checks, logs, ordinary replies. */
  routine,
  /**
   * Urgent: the whole hour, and past it with the D111 gap: door, cover, button and started
   * reports, a siren's answers and change reports, siren commands.
   */
  essential,
};

/** Whether a transmission fits now, and if not, when it will. */
struct Admission {
  bool allowed = false;
  /** When it would be admitted, or never when it cannot be. */
  Instant earliest = Instant::never();
  /**
   * An essential packet that does not fit the legal hour: when allowed, it goes past the limit
   * (D111) and the sender logs it; when refused, it is waiting for the gap.
   */
  bool past_limit = false;
};

/**
 * Airtime over a rolling hour per sub-band (LR5, protocol section 2). Routine traffic stays inside
 * four fifths of the hour. Essential traffic may use the whole hour and, by D111, goes even past
 * it, each packet after a gap of kPastLimitGapFactor times its airtime since the device's last
 * transmission on the band. Everything sent is counted, past the limit too, so routine traffic
 * stays refused until the hour is back inside it.
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
   * Judges a transmission of `airtime` starting now. Routine: allowed inside four fifths of the
   * hour, otherwise refused with the time it will fit. Essential: allowed inside the hour; past it,
   * allowed once the gap since the last transmission has passed, otherwise refused with the end of
   * the gap (or the time it fits the hour again, when that is sooner), with `past_limit` set.
   */
  Admission admit(Band band, Duration airtime, TxClass tx_class, Instant now) const;

  /**
   * Records a transmission that started at `start`, rounded up to 10 ms.
   */
  void record(Band band, Instant start, Duration airtime);

  /**
   * After the clock restarted (design section 5): the recorded times mean nothing, so every
   * band's whole recent airtime is counted again as sent in the current minute, and its last
   * transmission is taken to have ended now. That keeps it counted for a full hour from now, on
   * the safe side, without waiting for the old clock.
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
  Instant fits_hour_at(Band band, Duration counted, Duration allowed, Instant now) const;

  AirtimeState& state_;
};

}  // namespace hsn::device
