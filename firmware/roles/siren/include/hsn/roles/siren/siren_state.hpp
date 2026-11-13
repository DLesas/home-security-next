#pragma once

#include <cstddef>
#include <cstdint>
#include <type_traits>

#include "hsn/device/time.hpp"
#include "hsn/device/timers.hpp"

namespace hsn::roles::siren {

/** The siren's timers (design section 7). The radio port keeps its own guard deadline. */
enum class SirenTimer : std::uint8_t {
  /** The output stops by itself (SR5). */
  auto_stop,
  /** The next regular report, on Wi-Fi (§7, siren reports). */
  wifi_report,
  /** The next LoRa check (§7, siren reports). */
  lora_check,
  /** The next Wi-Fi connect attempt (§7 back-off). */
  reconnect,
  /** Started goes on LoRa if Wi-Fi has not come up by then (§6, Started). */
  started_lora,
  /** LoRa sending waits until then: for airtime (§2) or after a radio fault. */
  lora_wait,
  /** Continuous receive is tried again then, after the radio refused it. */
  listen_retry,
  /**
   * A packet is arriving (its header was seen): sending waits until it has ended or this passes,
   * so a report never cuts off a command (receiving comes first, §7).
   */
  receiving,
  /**
   * Routine reports (checks, regular failed reports) wait until then, so they spread evenly over
   * the hour's airtime (§7, pacing). Reports of a change never wait for it.
   */
  report_pace,
  count,
};

/** Number of SirenTimer values. */
constexpr std::size_t kSirenTimerCount = static_cast<std::size_t>(SirenTimer::count);

/** Settings held from the hub's siren settings (§6); also the flash record, so no padding. */
struct SirenSettingsHeld {
  /** 0 until the hub has sent settings. */
  std::uint8_t settings_version = 0;
  std::uint8_t wifi_report_interval_seconds = 0;
  /** Units of 15 seconds. */
  std::uint8_t lora_check_interval_units = 0;
  /** See protocol::DataRate. */
  std::uint8_t send_data_rate = 0;
  /** The rate the siren listens for commands at. See protocol::DataRate. */
  std::uint8_t command_data_rate = 0;
  std::uint8_t reserved = 0;
  /** Caps a command's seconds to sound. */
  std::uint16_t max_sound_seconds = 0;
};

static_assert(std::has_unique_object_representations_v<SirenSettingsHeld>,
              "a stored record has no padding");

/** The Wi-Fi path's state (design section 7). */
enum class WifiPath : std::uint8_t {
  down,
  connecting,
  up,
};

/** What a LoRa transmission carries, in order of priority (§2, "Airtime budgets"). */
enum class LoraItem : std::uint8_t {
  none,
  /** A report answering a command or settings packet that came by LoRa or failed on Wi-Fi. */
  answer,
  /** Started, when Wi-Fi did not come up in time (§6). */
  started,
  /**
   * A report of a change (cover, mains, the output stopping, the link going down) that could not
   * go on Wi-Fi: reason 3, urgent (essential, D111), and never paced (§7).
   */
  change,
  /** The LoRa check (§7); paced. */
  check,
  /** A regular report whose Wi-Fi send failed (§7); paced. */
  wifi_failed,
  /** One log entry at warning or above, after a LoRa check while Wi-Fi is down (D110). */
  log,
};

/** Number of LoraItem values that are something to send. */
constexpr std::size_t kLoraItemCount = 6;

/** What waits to go on LoRa, and what the radio port is sending now. */
struct LoraOutbox {
  bool answer = false;
  bool started = false;
  bool check = false;
  bool change = false;
  bool wifi_failed = false;
  bool log = false;
  /** What the port is sending for the siren; none when it is free. */
  LoraItem in_flight = LoraItem::none;
  /**
   * What the lora_wait timer holds back: everything (a radio fault, or essential traffic out of
   * airtime), or only routine traffic (out of airtime), so an answer never waits behind a LoRa
   * check (§2). The pace is a separate timer, report_pace.
   */
  bool wait_holds_all = false;
  /** When the latest paced report (a check or a regular failed report) went, for the pace. */
  device::Instant last_routine_report;
};

/** No data rate: the radio is not listening for the siren. */
constexpr std::uint8_t kNoDataRate = 0xFF;

/**
 * The siren's whole state, kept in the retained block, so a reset that keeps it resumes the
 * sounding (design section 5, D80). After any boot only the output part is carried over; the rest
 * is rebuilt, because links and the radio start afresh and settings come from flash.
 */
struct SirenState {
  /** The output: see protocol::SirenState (off, sounding for an alarm, testing). */
  std::uint8_t output_state = 0;
  /** When the output stops by itself, on the board's clock; never while off. */
  device::Instant stop_at = device::Instant::never();
  /** The latest event's `now`: after a clock reset, how much sounding was left (D80). */
  device::Instant last_seen;
  /** Settings in force: from flash, the hub, or the defaults. */
  SirenSettingsHeld settings;
  WifiPath wifi_path = WifiPath::down;
  /** Failed connects in a row, for the back-off. */
  std::uint8_t reconnect_attempt = 0;
  /** Started has not gone out yet since this start-up. */
  bool started_pending = false;
  /** The rate the latest receive was started at; it matters only while the port is receiving. */
  std::uint8_t listen_rate = kNoDataRate;
  LoraOutbox lora;
  device::TimerSet<SirenTimer, kSirenTimerCount> timers;
};

static_assert(std::is_trivially_copyable_v<SirenState>, "the retained block is copied as bytes");

/** Bumped whenever SirenState changes, so an older retained copy is discarded. */
constexpr std::uint8_t kSirenStateLayout = 5;

}  // namespace hsn::roles::siren
