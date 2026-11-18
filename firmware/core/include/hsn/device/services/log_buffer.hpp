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
/** An essential packet went past the legal airtime hour (D111). */
constexpr std::uint16_t airtime_past_limit = 0x000A;

// Updates and the key change (m3-updates-design.md sections 2, 5 and 7).

/** An offer or a download was refused; the number is the UpdateReason. Warning. */
constexpr std::uint16_t update_refused = 0x000B;
/** This boot follows a rollback; the number is the failed version, major·65536 + minor·256 +
 * patch. Warning. */
constexpr std::uint16_t update_rolled_back = 0x000C;
/** The running image passed its health condition and was confirmed. Info. */
constexpr std::uint16_t update_confirmed = 0x000D;
/** The image on trial could not be confirmed, or refused itself. Error. */
constexpr std::uint16_t update_trial_failed = 0x000E;
/** A transfer frame no transfer wanted: no grant, no outstanding Get, a bad CRC. Debug. */
constexpr std::uint16_t transfer_dropped = 0x000F;
/** Something that is not a transfer frame arrived on the Bluetooth link. Warning. */
constexpr std::uint16_t bluetooth_ignored = 0x0010;
/** A Bluetooth Open with a wrong tag; the number is the count in this window. Warning. */
constexpr std::uint16_t session_refused = 0x0011;
/** The device key was changed after a hub restore. Info. */
constexpr std::uint16_t key_changed = 0x0012;
/** A key change could not be stored or imported; the number is the step that failed. Error. */
constexpr std::uint16_t key_change_failed = 0x0013;
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
  /** In the latest prepare()'s packet: release() removes it, and it takes no more repeats. */
  bool in_packet = false;
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
 *
 * Both paths use the same two calls, with one packet in flight at a time:
 *
 * - Wi-Fi and USB, entries as they arise: `prepare(now, out)` takes every kept entry, oldest
 *   first, as many as fit; seal and send it, and once `link.send` takes the packet, `release()`.
 * - LoRa, one entry as routine traffic after a heartbeat or LoRa check:
 *   `prepare(now, out, LogLevel::warning, 1)` takes the oldest entry at warning or above and
 *   skips the lower ones, which stay. A sensor calls `release()` when the hub's reply bound to
 *   that packet arrives; without one it calls nothing, and the next prepare offers the same entry
 *   again (D110). A siren, which gets no reply, releases once the radio has sent the packet.
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
   * Builds a log entries message of the oldest kept entries at or above `at_least`, at most
   * `most` of them and as many as fit in the scratch space, each dated by its age at `now` in
   * tenths of a second (protocol section 6), and returns how many it holds; 0 when there is
   * nothing to send. Lower entries are skipped and kept. `out` views the scratch space, valid
   * until the next prepare(). Nothing is removed: the entries taken become this packet's, and
   * those of any earlier prepare() stop being a packet's.
   */
  std::size_t prepare(Instant now, protocol::LogEntries& out, LogLevel at_least = LogLevel::debug,
                      std::size_t most = kLogCapacity);

  /**
   * Removes exactly the entries of the latest prepare()'s packet, and no others: entries added
   * since stay, and a repeat of an entry in the packet has started a new entry, which stays too.
   * An entry of the packet pushed out meanwhile by newer ones is already gone. Does nothing when
   * there is no packet, so a second call removes nothing.
   */
  void release();

private:
  LogState& state_;
  /** Type byte plus every entry at its largest text (number and repeat count included). */
  std::array<std::uint8_t, 1 + kLogCapacity * 64> scratch_{};
};

}  // namespace hsn::device
