#pragma once

#include <array>
#include <cstdint>
#include <optional>

#include "hsn/device/services/random_source.hpp"
#include "hsn/device/time.hpp"

namespace hsn::device {

/**
 * A retry or back-off table: gaps between tries, then a fixed gap, with an optional random extra
 * wait and a give-up time. Stateless: the caller keeps the origin and the attempt number.
 */
struct RetryTable {
  /** Gaps before retries 1, 2, … in milliseconds; the rest use then_every_ms. */
  std::array<std::uint32_t, 8> gaps_ms{};
  std::uint8_t gap_count = 0;
  /** Gap after the listed ones; 0 means no more retries after them. */
  std::uint32_t then_every_ms = 0;
  /** No retry is planned more than this long after the origin; 0 means never give up. */
  std::uint32_t give_up_after_ms = 0;
  /** Each retry adds a random wait of up to its gap ÷ this; 0 means none. */
  std::uint8_t jitter_divisor = 0;
};

/**
 * Sensor reports (protocol section 7, "No reply from the hub"): about 2, 5 and 10 s after the
 * event, then every 60 s, up to 10 minutes, each plus up to half the gap before it.
 */
constexpr RetryTable kSensorReportRetries{{2000, 3000, 5000}, 3, 60000, 600000, 2};

/**
 * Reconnecting to the hub (protocol section 7, "Gateway connection"): after 1, 2, 4, 8, 15 s,
 * then every 30 s, for ever. Used by gateways and sirens.
 */
constexpr RetryTable kReconnect{{1000, 2000, 4000, 8000, 15000}, 5, 30000, 0, 0};

/** Plans retries from a table. */
class RetrySchedule {
public:
  explicit constexpr RetrySchedule(const RetryTable& table) : table_(table) {}

  /**
   * Returns the gap before retry `attempt` (1 for the first retry), or nothing when the table
   * has no such retry.
   */
  std::optional<Duration> gap(std::uint8_t attempt) const;

  /**
   * Returns the planned offset of retry `attempt` from the origin, without jitter, or nothing.
   */
  std::optional<Duration> base_offset(std::uint8_t attempt) const;

  /**
   * Returns when retry `attempt` is due: origin + base offset + a random part of its gap, and
   * never before `not_before`, which is when the previous try's listening ended (protocol
   * section 7). Nothing once the base offset passes the give-up time.
   */
  std::optional<Instant> retry_time(Instant origin, std::uint8_t attempt, Instant not_before,
                                    RandomSource& random) const;

  /**
   * Returns when to try again after a failure that ended at `failed_at`: its gap plus jitter.
   * Used for reconnects, which count gaps from each failure, not from an origin.
   */
  std::optional<Instant> after_failure(Instant failed_at, std::uint8_t attempt,
                                       RandomSource& random) const;

private:
  Duration jitter(Duration gap, RandomSource& random) const;

  RetryTable table_;
};

/**
 * Returns `nominal` moved by a random amount of up to `percent` per cent either way: a sensor's
 * heartbeat before the hub has given it a slot (protocol section 7).
 */
Duration jittered(Duration nominal, std::uint8_t percent, RandomSource& random);

}  // namespace hsn::device
