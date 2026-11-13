#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <type_traits>

#include "hsn/device/services/secure_channel.hpp"
#include "hsn/device/time.hpp"
#include "hsn/device/timers.hpp"
#include "hsn/protocol/messages.hpp"

// The door sensor's whole state between wakes (design §5): one trivially copyable struct that
// Device keeps in the retained block. Nothing here is written to flash except the settings
// record, StoredSettings, and that never holds the armed state or the settings version.

namespace hsn::roles::sensor {

/** The sensor's timers (design §7). */
enum class SensorTimer : std::uint8_t {
  /** The next heartbeat: its slot, or the interval ±10% (§7). */
  next_heartbeat,
  /** The moment to open the heartbeat reply window, 20 ms before the reply moment (§8). */
  reply_moment,
  /** The next try of the report exchange: a retry, a new change, or the end of an airtime wait. */
  retry,
  /** The end of the hub's countdown (§7, "Door opens while armed"). */
  countdown_end,
  /** The next phase of the local alarm: its countdown's end, then the alarm's end (DS6). */
  local_alarm,
  /** The end of the pairing window (DS7). */
  pairing_end,
  /** The next button hold mark, 5 s then 15 s, for the LED feedback (DS7). */
  button_hold,
  count,
};

/** Reports the exchange carries, one bit each; a try sends the first set bit in this order. */
namespace report_bit {
/** Factory reset going ahead: one try, then the erase (D89, PR4). */
constexpr std::uint8_t going_ahead = 0x01;
constexpr std::uint8_t door = 0x02;
constexpr std::uint8_t cover = 0x04;
constexpr std::uint8_t started = 0x08;
constexpr std::uint8_t button = 0x10;
/** Every report bit. */
constexpr std::uint8_t all = 0x1F;
}  // namespace report_bit

/** What one of the sensor's recent packets was, for the hub packets bound to it (§4). */
enum class TryKind : std::uint8_t {
  none,
  going_ahead,
  door,
  cover,
  started,
  button,
  heartbeat,
  log,
  /** A door report of the opening whose countdown the hub runs: the disarmed notice's binding. */
  countdown,
  /**
   * A countdown's report after its first disarmed notice: the second copy still opens and is
   * ignored (§6), until the next opening or until newer counters push it out.
   */
  settled,
};

/** The alert the buzzer plays, if any (design §7, parallel states). */
enum class Alert : std::uint8_t {
  none,
  /** The hub said "countdown started": buzz and listen continuously (D24, DS12, DS13). */
  hub_countdown,
  /** No reply to an armed opening: buzz for the stored countdown from the opening (DS6). */
  local_countdown,
  /** Then the sensor's own alarm, about 3 minutes (DS6, D88). */
  local_alarm,
};

/** Where a factory-reset hold stands (DS7, DS8, D89). */
enum class ResetPhase : std::uint8_t {
  none,
  /** Armed: reported with action 3, reset warning sounding, waiting through the retry run. */
  armed_wait,
  /** Action 4 goes once, then its one listen window, then the erase. */
  going_ahead,
};

/** The latest door opening, for the local alarm (DS6). */
enum class Opening : std::uint8_t {
  none,
  /** Reported, but no reply has answered a door report since. */
  unanswered,
  /** Its local alarm has started; it does not start again for this opening. */
  alarmed,
};

/** The sensor's top-level state, for the watchdog breadcrumb (design §6, §7). */
enum class TopState : std::uint8_t {
  idle,
  reporting,
  heartbeat_listen,
  alerting,
  resetting,
};

/**
 * The settings held from the hub, as stored in flash (design §5): without the armed state, which
 * lives in retained memory only (§6, G1), and without the settings version, which changes with
 * every arming and would otherwise cost a flash write each time; the version is retained only, so
 * after a power loss the sensor holds none and the hub answers it (§6). No padding, as Record
 * requires.
 */
struct StoredSettings {
  /** Clock correction, units of 10 ppm (§6, reply). */
  std::int16_t clock_correction_ten_ppm = 0;
  /** This sensor's countdown, seconds (D86, DS14). */
  std::uint8_t countdown_seconds = 0;
  /** Heartbeat interval, units of 15 s (DS4). */
  std::uint8_t heartbeat_interval_units = 0;
  /** Ask for a reply on every Nth heartbeat (D72). */
  std::uint8_t link_check_every = 0;
  /** Data rate to send at (§7). */
  std::uint8_t send_data_rate = 0;
  /** Data rate replies come at (§7, "Faster replies"). */
  std::uint8_t reply_data_rate = 0;
  /** The site channel it sends on: the pairing's, until a move replaces it (§7, D115). */
  std::uint8_t site_channel = 0;
  /** The data rates it may send at, one bit each: the pairing's, until a move (§7, D115). */
  std::uint8_t allowed_rate_mask = 0;
  /** The channel the site is moving to, or protocol::kStaysAsItIs (§6, reply; §7). */
  std::uint8_t next_site_channel = protocol::kStaysAsItIs;
  /** The sending rate the site is moving to, or protocol::kStaysAsItIs (§6, reply; §7). */
  std::uint8_t next_send_data_rate = protocol::kStaysAsItIs;
  /** Written as zero. */
  std::uint8_t reserved = 0;
};

/**
 * The counters of the sensor's recent packets that a hub packet may still answer, with what
 * each was (§4, "Bindings"): the current report exchange's tries, the countdown's opening, the
 * latest heartbeat and log packet. At most 16; a new one replaces the oldest. Plain data.
 */
class TryRing {
public:
  /** Adds a counter, and whether it went on the next settings of a move; the oldest goes. */
  void add(std::uint32_t counter, TryKind kind, bool on_next = false);

  /** True when a counter's packet went on the next settings of a move (§7, D115). */
  bool sent_on_next(std::uint32_t counter) const;

  /** Removes every counter of one kind. */
  void remove(TryKind kind);

  /** Removes the report exchange's counters, keeping the countdown's, heartbeat's and log's. */
  void remove_reports();

  /** Gives every counter of one kind another kind. */
  void retag(TryKind from, TryKind to);

  /** Returns what a counter was, or none. */
  TryKind kind_of(std::uint32_t counter) const;

  /** Writes the counters newest first into `out` and returns how many (§4: newest first). */
  std::size_t newest_first(std::array<std::uint32_t, device::kMaxBoundCandidates>& out) const;

private:
  std::array<std::uint32_t, device::kMaxBoundCandidates> counters_{};
  std::array<TryKind, device::kMaxBoundCandidates> kinds_{};
  /** One bit per slot: that packet went on the next settings. */
  std::uint16_t on_next_ = 0;
};

/** Adds one to a counter byte, stopping at its largest value: every count here is bounded. */
constexpr std::uint8_t saturating_increment(std::uint8_t count) {
  return count == std::numeric_limits<std::uint8_t>::max() ? count
                                                           : static_cast<std::uint8_t>(count + 1);
}

/** A sound that is not known to be playing: forces the next buzzer call after a start-up. */
constexpr std::uint8_t kSoundUnknown = 0xFF;

/**
 * The sensor's whole state, kept in the retained block between wakes (design §5). Instants are
 * on the board's own clock.
 */
struct SensorState {
  // From the hub's replies: retained only (§6, design §5).
  /** Armed, as the last reply said; false after a start with no retained memory (§6). */
  bool armed = false;
  /** The settings version held; 0 when none is held since a start with no retained memory. */
  std::uint8_t settings_version = 0;
  /** The settings in force, a copy of the flash record. */
  StoredSettings settings;

  // Sending and listening (§7).
  /** The rate it sends at: the settings' rate, or slower after unanswered packets (LR4). */
  std::uint8_t send_rate = 0;
  /** The next packet goes on the next settings of a move: the last one went unanswered (§7). */
  bool use_next = false;
  /** Listening for answers at the sending rate, flag bit 7 (§7, data rate). */
  bool listen_at_send_rate = false;
  /** Reply-wanted packets in a row that went unanswered. */
  std::uint8_t misses = 0;
  /** Misses at the current sending rate since the fall-back's last step (§7). */
  std::uint8_t misses_at_rate = 0;
  /** The hub's heartbeat slot is in force (§7, heartbeat slots). */
  bool slotted = false;
  /** Heartbeats since the last one that asked for a reply. */
  std::uint8_t heartbeats_since_check = 0;
  /** The latest heartbeat asked for a reply. */
  bool heartbeat_wants_reply = false;
  /** After the heartbeat's reply window, one log entries packet may go (§6, D110). */
  bool log_due = false;
  /** The retry waits for the D111 gap past the legal hour, in light sleep (§2). */
  bool gap_wait = false;
  /** What the radio is sending now; set when the port takes a packet. */
  TryKind tx_kind = TryKind::none;
  /** What the latest report try was. */
  TryKind report_kind = TryKind::none;

  // Inputs as last reported.
  bool door_open = false;
  bool cover_open = false;
  bool button_down = false;
  bool external_power = false;
  /** Door change count, one per open and close, wrapping at 256 (§6). */
  std::uint8_t change_count = 0;

  // The report exchange (§7, "No reply from the hub").
  /** Reports not yet answered. */
  std::uint8_t waiting = 0;
  /** Reports with a change no try has carried yet: they go at once. */
  std::uint8_t unsent = 0;
  /** Tries made since the exchange's origin. */
  std::uint8_t attempt = 0;
  /** The button report's action (§6, protocol::ButtonAction). */
  std::uint8_t button_action = 0;
  Opening opening = Opening::none;

  // Parallel states (design §7).
  Alert alert = Alert::none;
  ResetPhase reset = ResetPhase::none;
  bool pairing = false;
  /** Flag bit 5: the local alarm sounded since the last reply (§6). */
  bool local_alarm_sounded = false;
  /** The buzzer's continuous sound as last set (device::Sound), or kSoundUnknown. */
  std::uint8_t sound = kSoundUnknown;
  TopState top_state = TopState::idle;

  /** The first packet that carried flag bit 5; a reply to it or a later one clears the flag. */
  std::uint32_t alarm_flag_counter = 0;
  /** The latest packet sent, and when its transmission ended (§7: slots count from there). */
  std::uint32_t last_counter = 0;
  device::Instant last_tx_end;
  /** When the latest heartbeat's transmission ended: its reply's slot counts from there. */
  device::Instant heartbeat_tx_end;

  // Instants.
  device::Instant door_changed_at;
  device::Instant door_opened_at;
  device::Instant cover_changed_at;
  device::Instant button_event_at;
  device::Instant button_pressed_at;
  /** When the exchange's retry schedule counts from: its newest change (§7). */
  device::Instant origin;
  /** When the next heartbeat was planned for, the base of the one after (§7). */
  device::Instant heartbeat_planned;
  /** The latest low-battery chirp, or never (DS11). */
  device::Instant chirped_at = device::Instant::never();
  /** Since when the sensor has not allowed deep sleep (design §6). */
  device::Instant awake_since;
  /** The stuck-awake bound counts from here: the latest input, or external power (design §6). */
  device::Instant awake_bound_from;

  // Listening windows; never when closed.
  /** After the latest report try: the event listen time (§8). */
  device::Instant report_window_end = device::Instant::never();
  /** Around the heartbeat reply moment (§8). */
  device::Instant heartbeat_window_end = device::Instant::never();
  /** After a log entries packet: the event listen time (§6, §8). */
  device::Instant log_window_end = device::Instant::never();

  TryRing tries;
  device::TimerSet<SensorTimer, static_cast<std::size_t>(SensorTimer::count)> timers;
};

static_assert(std::is_trivially_copyable_v<SensorState>, "the retained block is copied as bytes");

/** A fresh state, copied from here rather than built on the stack. */
constexpr SensorState kFreshState{};

/** Bumped whenever SensorState changes: an old retained copy is then discarded. */
constexpr std::uint8_t kSensorStateLayout = 5;

}  // namespace hsn::roles::sensor
