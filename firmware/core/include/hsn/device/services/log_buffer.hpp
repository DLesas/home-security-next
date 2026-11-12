#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "hsn/device/time.hpp"
#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/messages.hpp"

namespace hsn::device {

/** Log levels, as sent in log entries (protocol section 6). */
enum class LogLevel : std::uint8_t {
  debug = 0,
  info = 1,
  warning = 2,
  error = 3,
  critical = 4,
};

/** Log code ranges, so roles add codes without touching the core (design section 4). */
namespace log_code {
constexpr std::uint16_t core_first = 0x0000;
constexpr std::uint16_t sensor_first = 0x1000;
constexpr std::uint16_t siren_first = 0x2000;
constexpr std::uint16_t gateway_first = 0x3000;
constexpr std::uint16_t platform_first = 0x4000;

constexpr std::uint16_t retained_lost = 0x0001;
constexpr std::uint16_t clock_reset = 0x0002;
constexpr std::uint16_t storage_failed = 0x0003;
constexpr std::uint16_t radio_guard = 0x0004;
constexpr std::uint16_t radio_refused = 0x0005;
constexpr std::uint16_t setup_ignored = 0x0006;
constexpr std::uint16_t retained_too_large = 0x0007;
constexpr std::uint16_t fatal = 0x0008;
constexpr std::uint16_t unknown_type = 0x0009;
}  // namespace log_code

/** Longest text kept per entry; a number may follow it. */
constexpr std::size_t kLogTextSize = 24;

/** Entries kept. */
constexpr std::size_t kLogCapacity = 8;

/** One kept entry: plain data. */
struct LogRecord {
  Instant at;
  std::uint16_t code = 0;
  std::uint8_t level = 0;
  /** How many times in a row this code was logged; 1 for a single entry. */
  std::uint8_t repeats = 0;
  std::uint8_t text_size = 0;
  std::array<std::uint8_t, kLogTextSize> text{};
};

/** The kept entries, oldest first from `start`: plain data in the retained block. */
struct LogState {
  std::array<LogRecord, kLogCapacity> records{};
  std::uint8_t start = 0;
  std::uint8_t count = 0;
  /** Entries below this level are not kept. */
  std::uint8_t min_level = 0;
  /** Entries pushed out by newer ones since the last drain. */
  std::uint16_t dropped = 0;
};

/**
 * A bounded log (FW6) that drains into log entries packets (protocol section 6). Text is a
 * constant, optionally followed by one number, formatted without the C library. A repeat of the
 * newest entry's code counts up instead of taking a new slot; when full, the oldest goes.
 */
class LogBuffer {
public:
  explicit LogBuffer(LogState& state) : state_(state) {}

  /**
   * Keeps entries at or above `level` only (a sensor keeps warnings and above).
   */
  void set_min_level(LogLevel level);

  /**
   * Adds an entry. `text` is a constant, cut to kLogTextSize bytes.
   */
  void add(Instant now, LogLevel level, std::uint16_t code, const char* text);

  /**
   * Adds an entry with a number after the text.
   */
  void add(Instant now, LogLevel level, std::uint16_t code, const char* text, std::int32_t value);

  /**
   * Returns the number of kept entries.
   */
  std::size_t size() const {
    return state_.count;
  }

  /**
   * Builds a log entries message of as many of the oldest entries as fit in the scratch space,
   * each dated by its age at `now` in tenths of a second (protocol section 6), and returns how
   * many it holds; 0 when there is nothing to send. `out` views the scratch space, valid until
   * the next prepare(). Nothing is removed: call release() once a link has taken the packet.
   */
  std::size_t prepare(Instant now, protocol::LogEntries& out);

  /**
   * Removes the `count` oldest entries.
   */
  void release(std::size_t count);

private:
  LogState& state_;
  /** Type byte plus every entry at its largest text (number and repeat count included). */
  std::array<std::uint8_t, 1 + kLogCapacity * 64> scratch_{};
};

}  // namespace hsn::device
