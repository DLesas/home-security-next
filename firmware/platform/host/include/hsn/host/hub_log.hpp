#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "hsn/device/time.hpp"
#include "hsn/host/simulation_error.hpp"
#include "hsn/protocol/messages.hpp"

namespace hsn::host {

using Bytes = std::vector<std::uint8_t>;

/** How a packet reached the hub or left it. */
enum class HubPath : std::uint8_t {
  /** The hub's own ideal radio (direct radio mode). */
  radio,
  /** Through a gateway: forwarded to the hub, or a transmit request to it. */
  gateway,
  /** A device's own link: a siren's Wi-Fi, a gateway's USB or WebSocket. */
  link,
};

/** What the hub made of a packet it received. */
enum class HubVerdict : std::uint8_t {
  accepted,
  /** The replay window or the connection's rule has seen it (a second gateway's copy). */
  duplicate,
  too_old,
  /** The tag did not check: wrong key, wrong binding or damaged. */
  bad_tag,
  /** No device has this address. */
  unknown_address,
  /** Not a packet, or its body does not decode. */
  malformed,
  /** A gateway packet with no connection open for it. */
  no_session,
};

/** One packet the hub received, accepted or not. */
struct HubPacket {
  /** True instant the hub had it. */
  device::Instant at;
  /** The device it came from, or "" when unknown. */
  std::string from;
  HubPath path = HubPath::radio;
  /** The gateway it came through, for HubPath::gateway. */
  std::string via;
  HubVerdict verdict = HubVerdict::accepted;
  std::uint32_t counter = 0;
  std::uint8_t type = 0;
  /** The decrypted body, when the tag checked. */
  Bytes body;
  std::int16_t rssi_dbm = 0;
  std::int8_t snr_quarter_db = 0;
  std::uint8_t data_rate = 0;

  /** Decodes the body as message M; throws SimulationError on a mismatch. */
  template <typename M>
  M as() const {
    M message{};
    if (type != M::type || protocol::decode_body(protocol::ByteView(body.data(), body.size()),
                                                 message) != protocol::Error::none) {
      throw SimulationError("hub packet from " + from + " is not of the type asked for");
    }
    return message;
  }
};

/** One packet the hub sent, or handed to a gateway to send. */
struct HubSent {
  /** True instant it went on the air (hub radio) or was handed to a link or gateway. */
  device::Instant at;
  /** The device it is for. */
  std::string to;
  HubPath path = HubPath::radio;
  /** The gateway asked to send it, for HubPath::gateway. */
  std::string via;
  std::uint32_t counter = 0;
  std::uint8_t type = 0;
  /** Data rate on the air (radio paths). */
  std::uint8_t data_rate = 0;
  Bytes packet;
};

/**
 * One log entry a device sent (protocol section 6, log entries), on any path. A sensor keeps an
 * entry it sent over LoRa until the hub's reply arrives, so when that reply is lost the hub gets
 * the same entry again in a later packet. The audit record keeps every copy the hub received, so
 * an entry is never lost by being taken for another, and marks a later copy with the counter of
 * the packet that first carried it.
 */
struct HubLogEntry {
  /** True instant the hub had the packet. */
  device::Instant at;
  /** When the entry was made: the packet's arrival less the entry's age. */
  device::Instant made_at;
  /** The device it came from. */
  std::string from;
  HubPath path = HubPath::radio;
  /** The gateway it came through, for HubPath::gateway. */
  std::string via;
  /** The counter of the packet that carried it. */
  std::uint32_t counter = 0;
  std::uint32_t age_tenths = 0;
  std::uint8_t level = 0;
  std::uint16_t code = 0;
  std::string text;
  /**
   * For a sensor's entry already recorded from an earlier packet (same level, code and text,
   * made within HubOptions::log_repeat_tolerance of it): that first packet's counter. 0 for a
   * new entry.
   */
  std::uint32_t repeat_of = 0;
};

/** What the hub decided. */
enum class HubAction : std::uint8_t {
  armed,
  disarmed,
  /** A reply to a sensor was sealed and handed to a path. value: its counter. */
  reply,
  /** A heartbeat reply's fixed moment found the radio busy (direct radio). */
  reply_skipped,
  /** An as-soon-as-possible packet could not start before its latest moment (direct radio). */
  too_late,
  /** A door opened while armed: the countdown runs. value: seconds left. */
  countdown_started,
  /** Another report of an opening whose countdown runs. value: seconds left. */
  countdown_continued,
  /** A late report: the countdown had ended; sirens sound for what is left. value: seconds. */
  late_report_sirens,
  /** A report so late even the sirens' time has passed: a notification only. value: the
   * opening's true time in seconds. */
  late_report_notification,
  /** A door report while disarmed: nothing happens. */
  report_while_disarmed,
  /** A countdown ended while armed: the sirens sound. */
  alarm,
  /** A disarmed notice was sent. value: the counter it is bound to. */
  disarmed_notice,
  /** A sensor said its local alarm sounded (flag bit 5). */
  local_alarm_reported,
  /** A siren command was issued. value: action × 65,536 + seconds. */
  siren_command,
  /** Siren settings were issued. value: the settings version. */
  siren_settings,
  /** A siren report confirmed the pending command or settings. value: the HubPath. */
  siren_confirmed,
  /** A minute passed without confirmation (protocol section 7). */
  siren_unreachable,
  /** A gateway's hello was answered with a welcome. */
  gateway_welcomed,
  /** Gateway settings were sent. value: the settings version. */
  gateway_settings,
  /** A gateway reported a transmit request's result. value: TransmitOutcome. */
  transmit_result,
  /** A packet had no gateway to go through. */
  no_path,
};

/** One decision, with when and for which device. */
struct HubDecision {
  /** True instant it was decided. */
  device::Instant at;
  HubAction action = HubAction::armed;
  /** The device it is about, or "" for the whole system. */
  std::string device;
  std::int64_t value = 0;
};

/** Returns the snake-case name of a hub action. */
const char* hub_action_name(HubAction action);

/** Returns the snake-case name of a verdict. */
const char* hub_verdict_name(HubVerdict verdict);

}  // namespace hsn::host
