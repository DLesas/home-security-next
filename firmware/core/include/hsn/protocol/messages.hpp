#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <tuple>

#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/cipher.hpp"
#include "hsn/protocol/error.hpp"
#include "hsn/protocol/layout.hpp"

namespace hsn::protocol {

/** Message type bytes (section 5). */
namespace message_type {
constexpr std::uint8_t heartbeat = 0x01;
constexpr std::uint8_t door_changed = 0x02;
constexpr std::uint8_t cover_changed = 0x03;
constexpr std::uint8_t button = 0x04;
constexpr std::uint8_t started = 0x05;
constexpr std::uint8_t update_query = 0x06;
constexpr std::uint8_t update_status = 0x07;
constexpr std::uint8_t siren_report = 0x10;
constexpr std::uint8_t hello = 0x20;
constexpr std::uint8_t forwarded_packet = 0x21;
constexpr std::uint8_t gateway_status = 0x22;
constexpr std::uint8_t transmit_result = 0x23;
constexpr std::uint8_t interference = 0x24;
constexpr std::uint8_t log_entries = 0x30;
constexpr std::uint8_t reply = 0x81;
constexpr std::uint8_t disarmed_notice = 0x82;
constexpr std::uint8_t update_offer = 0x83;
constexpr std::uint8_t key_change = 0x84;
constexpr std::uint8_t siren_command = 0x90;
constexpr std::uint8_t siren_settings = 0x91;
constexpr std::uint8_t welcome = 0xA0;
constexpr std::uint8_t transmit_request = 0xA1;
constexpr std::uint8_t gateway_settings = 0xA2;
}  // namespace message_type

/** Device roles (sections 6 and 10). */
struct Role {
  static constexpr std::uint8_t sensor = 1;
  static constexpr std::uint8_t siren = 2;
  static constexpr std::uint8_t gateway = 3;
  static constexpr std::array<std::uint8_t, 3> known{sensor, siren, gateway};
};

/** Button actions in a button packet (section 6). */
struct ButtonAction {
  static constexpr std::uint8_t short_press = 1;
  static constexpr std::uint8_t pairing_hold_ignored = 2;
  static constexpr std::uint8_t factory_reset_hold_while_armed = 3;
  static constexpr std::uint8_t factory_reset_going_ahead = 4;
  static constexpr std::array<std::uint8_t, 4> known{
      short_press, pairing_hold_ignored, factory_reset_hold_while_armed, factory_reset_going_ahead};
};

/** Siren command actions (section 6). */
struct SirenAction {
  static constexpr std::uint8_t off = 0;
  static constexpr std::uint8_t sound_alarm = 1;
  static constexpr std::uint8_t test = 2;
  static constexpr std::uint8_t report_now = 3;
  static constexpr std::array<std::uint8_t, 4> known{off, sound_alarm, test, report_now};
};

/** Siren states in a siren report (section 6). */
struct SirenState {
  static constexpr std::uint8_t off = 0;
  static constexpr std::uint8_t sounding_alarm = 1;
  static constexpr std::uint8_t testing = 2;
  static constexpr std::array<std::uint8_t, 3> known{off, sounding_alarm, testing};
};

/** Why a siren sent a report (section 6). */
struct SirenReportReason {
  static constexpr std::uint8_t regular = 0;
  static constexpr std::uint8_t command_answer = 1;
  static constexpr std::uint8_t lora_check = 2;
  static constexpr std::uint8_t wifi_report_failed = 3;
  static constexpr std::array<std::uint8_t, 4> known{regular, command_answer, lora_check,
                                                     wifi_report_failed};
};

/** When a transmit request is sent (section 6). */
struct TransmitWhen {
  static constexpr std::uint8_t at_time = 0;
  static constexpr std::uint8_t as_soon_as_possible = 1;
  static constexpr std::array<std::uint8_t, 2> known{at_time, as_soon_as_possible};
};

/** Transmit request priorities (section 6). */
struct TransmitPriority {
  static constexpr std::uint8_t normal = 0;
  static constexpr std::uint8_t siren_command = 1;
  static constexpr std::array<std::uint8_t, 2> known{normal, siren_command};
};

/** Transmit results (section 6). */
struct TransmitOutcome {
  static constexpr std::uint8_t sent = 0;
  static constexpr std::uint8_t too_late = 1;
  static constexpr std::uint8_t no_airtime = 2;
  static constexpr std::uint8_t radio_busy = 3;
  static constexpr std::uint8_t not_valid = 4;
  static constexpr std::array<std::uint8_t, 5> known{sent, too_late, no_airtime, radio_busy,
                                                     not_valid};
};

/** Interference events (section 6). */
struct InterferenceEvent {
  static constexpr std::uint8_t ended = 0;
  static constexpr std::uint8_t started = 1;
  static constexpr std::array<std::uint8_t, 2> known{ended, started};
};

/** Site channels: 868.1, 868.3 and 868.5 MHz (section 6, gateway settings). */
struct SiteChannel {
  static constexpr std::uint8_t mhz_868_1 = 0;
  static constexpr std::uint8_t mhz_868_3 = 1;
  static constexpr std::uint8_t mhz_868_5 = 2;
  static constexpr std::array<std::uint8_t, 3> known{mhz_868_1, mhz_868_3, mhz_868_5};
};

/** Three-byte firmware version (section 3, "Firmware versions"). */
struct FirmwareVersion {
  std::uint8_t major = 0;
  std::uint8_t minor = 0;
  std::uint8_t patch = 0;

  /**
   * Wire layout: major, minor, patch.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("major", &FirmwareVersion::major),
                           field("minor", &FirmwareVersion::minor),
                           field("patch", &FirmwareVersion::patch));
  }
};

/** Flags of a sensor status body (section 6). */
struct SensorFlags {
  bool door_open = false;
  bool cover_open = false;
  bool usb_power = false;
  bool charging = false;
  bool reply_wanted = false;
  bool local_alarm_sounded = false;
  bool buzzing = false;
  /** The sensor listens for this packet's answer at the rate it was sent at (section 7). */
  bool listening_at_send_rate = false;

  /**
   * Bits 0 to 7, in order.
   */
  static constexpr auto flag_bits() {
    return std::make_tuple(
        field("doorOpen", &SensorFlags::door_open), field("coverOpen", &SensorFlags::cover_open),
        field("usbPower", &SensorFlags::usb_power), field("charging", &SensorFlags::charging),
        field("replyWanted", &SensorFlags::reply_wanted),
        field("localAlarmSounded", &SensorFlags::local_alarm_sounded),
        field("buzzing", &SensorFlags::buzzing),
        field("listeningAtSendRate", &SensorFlags::listening_at_send_rate));
  }
};

/** The body shared by heartbeat, door changed and cover changed (section 6). */
struct SensorStatus {
  std::uint8_t settings_version = 0;
  SensorFlags flags;
  std::uint8_t battery_code = 0;
  std::int8_t temperature_celsius = 0;
  std::uint8_t door_change_count = 0;
  std::uint16_t event_age_seconds = 0;

  /**
   * Wire layout, 7 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("settingsVersion", &SensorStatus::settings_version),
                           field("flags", &SensorStatus::flags),
                           field("batteryCode", &SensorStatus::battery_code),
                           field("temperatureCelsius", &SensorStatus::temperature_celsius),
                           field("doorChangeCount", &SensorStatus::door_change_count),
                           field("eventAgeSeconds", &SensorStatus::event_age_seconds));
  }
};

/** Heartbeat (0x01). */
struct Heartbeat : SensorStatus {
  static constexpr std::uint8_t type = message_type::heartbeat;
};

/** Door changed (0x02). */
struct DoorChanged : SensorStatus {
  static constexpr std::uint8_t type = message_type::door_changed;
};

/** Cover changed (0x03). */
struct CoverChanged : SensorStatus {
  static constexpr std::uint8_t type = message_type::cover_changed;
};

/** Button (0x04): a sensor status followed by the button action. */
struct Button : SensorStatus {
  static constexpr std::uint8_t type = message_type::button;
  /** See ButtonAction. */
  std::uint8_t button_action = 0;

  /**
   * Wire layout, 8 bytes: the sensor status, then the action.
   */
  static constexpr auto layout() {
    return std::tuple_cat(SensorStatus::layout(),
                          std::make_tuple(field("buttonAction", &Button::button_action)));
  }
};

/** Image flags of a Started (m3-updates-design.md section 5). */
struct StartedImageFlags {
  /** The running image is on trial: not yet confirmed (PENDING_VERIFY). */
  bool on_trial = false;
  /** The image tried since the last confirmed one was rolled back. */
  bool rolled_back = false;

  /**
   * Bits 0 and 1.
   */
  static constexpr auto flag_bits() {
    return std::make_tuple(field("onTrial", &StartedImageFlags::on_trial),
                           field("rolledBack", &StartedImageFlags::rolled_back));
  }
};

/** The fields Started gained at its end for updates (m3-updates-design.md section 5). */
struct StartedImage {
  StartedImageFlags flags;
  /** The version that was rolled back; zeros for none. */
  FirmwareVersion failed_version;

  /**
   * Wire layout, 4 bytes, at Started's offset 8.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("flags", &StartedImage::flags),
                           field("failedVersion", &StartedImage::failed_version));
  }
};

/** Started (0x05), sent once after every start-up. */
struct Started {
  static constexpr std::uint8_t type = message_type::started;
  /** See Role. */
  std::uint8_t role = 0;
  FirmwareVersion firmware_version;
  std::uint8_t reset_cause = 0;
  std::uint16_t last_fatal_error = 0;
  std::uint8_t settings_version = 0;
  /**
   * The running image's state, added for updates. Absent, the body is the older 8 bytes, which a
   * receiver still accepts; present, 12.
   */
  Appended<StartedImage> image;

  /**
   * Wire layout: 8 bytes, then the image fields' 4 when present.
   */
  static constexpr auto layout() {
    return std::make_tuple(
        field("role", &Started::role), field("firmwareVersion", &Started::firmware_version),
        field("resetCause", &Started::reset_cause),
        field("lastFatalError", &Started::last_fatal_error),
        field("settingsVersion", &Started::settings_version), field("image", &Started::image));
  }
};

/** Image id: the first 8 bytes of the image's SHA-256 (m3-updates-design.md section 3). */
using ImageId = std::array<std::uint8_t, 8>;

/** What a device holds of an image, in an update query (m3-updates-design.md section 5). */
struct UpdateHeld {
  static constexpr std::uint8_t nothing = 0;
  static constexpr std::uint8_t part = 1;
  static constexpr std::uint8_t verified = 2;
  static constexpr std::array<std::uint8_t, 3> known{nothing, part, verified};
};

/** Flags of an update query. */
struct UpdateQueryFlags {
  /** The device holds Wi-Fi details (D47). */
  bool has_wifi_details = false;
  /** On USB power, or on mains. */
  bool external_power = false;

  /**
   * Bits 0 and 1.
   */
  static constexpr auto flag_bits() {
    return std::make_tuple(field("hasWifiDetails", &UpdateQueryFlags::has_wifi_details),
                           field("externalPower", &UpdateQueryFlags::external_power));
  }
};

/**
 * Update query (0x06), any device to the hub: sent when a reply carries "update available", and on
 * every (re)connection while the device holds part of an image.
 */
struct UpdateQuery {
  static constexpr std::uint8_t type = message_type::update_query;
  /** The image held; zeros for none. */
  ImageId image_id{};
  /** See UpdateHeld. */
  std::uint8_t held = 0;
  /** Bytes held, up to the last checkpoint. */
  std::uint32_t bytes_held = 0;
  /** Battery, encoded as in a sensor status (battery_code_from_millivolts). */
  std::uint8_t battery_code = 0;
  UpdateQueryFlags flags;

  /**
   * Wire layout, 15 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(
        field("imageId", &UpdateQuery::image_id), field("held", &UpdateQuery::held),
        field("bytesHeld", &UpdateQuery::bytes_held),
        field("batteryCode", &UpdateQuery::battery_code), field("flags", &UpdateQuery::flags));
  }
};

/** Stages in an update status (m3-updates-design.md section 5). */
struct UpdateStage {
  static constexpr std::uint8_t fetching = 1;
  static constexpr std::uint8_t verified = 2;
  static constexpr std::uint8_t refused = 3;
  /** Sent just before the restart into the new image. */
  static constexpr std::uint8_t installing = 4;
  static constexpr std::uint8_t confirmed = 5;
  static constexpr std::uint8_t cancelled = 6;
  static constexpr std::array<std::uint8_t, 6> known{fetching,   verified,  refused,
                                                     installing, confirmed, cancelled};
};

/** Reasons in an update status (m3-updates-design.md section 5). */
struct UpdateReason {
  static constexpr std::uint8_t none = 0;
  static constexpr std::uint8_t battery = 1;
  static constexpr std::uint8_t armed = 2;
  static constexpr std::uint8_t no_wifi = 3;
  static constexpr std::uint8_t hub_not_found = 4;
  static constexpr std::uint8_t link_lost = 5;
  static constexpr std::uint8_t bad_header = 6;
  static constexpr std::uint8_t wrong_hub = 7;
  static constexpr std::uint8_t wrong_role = 8;
  static constexpr std::uint8_t too_large = 9;
  static constexpr std::uint8_t bad_signature = 10;
  static constexpr std::uint8_t hash_mismatch = 11;
  static constexpr std::uint8_t flash = 12;
  static constexpr std::uint8_t image_check = 13;
  /** The Bluetooth window ended. */
  static constexpr std::uint8_t window_ended = 14;
  static constexpr std::uint8_t session_refused = 15;
  static constexpr std::uint8_t on_trial = 16;
  /** A gateway wrote no sector for its bound because a transmission always waited. */
  static constexpr std::uint8_t radio_busy = 17;
  static constexpr std::array<std::uint8_t, 18> known{
      none,       battery,     armed,        no_wifi,         hub_not_found, link_lost,
      bad_header, wrong_hub,   wrong_role,   too_large,       bad_signature, hash_mismatch,
      flash,      image_check, window_ended, session_refused, on_trial,      radio_busy};
};

/** Update status (0x07), any device to the hub. */
struct UpdateStatus {
  static constexpr std::uint8_t type = message_type::update_status;
  ImageId image_id{};
  /** See UpdateStage. */
  std::uint8_t stage = 0;
  /** See UpdateReason. */
  std::uint8_t reason = 0;
  std::uint32_t bytes_written = 0;

  /**
   * Wire layout, 14 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("imageId", &UpdateStatus::image_id),
                           field("stage", &UpdateStatus::stage),
                           field("reason", &UpdateStatus::reason),
                           field("bytesWritten", &UpdateStatus::bytes_written));
  }
};

/** Flags of a siren report (section 6). */
struct SirenReportFlags {
  bool on_mains = false;
  bool cell_fitted = false;
  bool charging = false;
  bool cover_open = false;
  bool wifi_connected = false;

  /**
   * Bits 0 to 4, in order.
   */
  static constexpr auto flag_bits() {
    return std::make_tuple(field("onMains", &SirenReportFlags::on_mains),
                           field("cellFitted", &SirenReportFlags::cell_fitted),
                           field("charging", &SirenReportFlags::charging),
                           field("coverOpen", &SirenReportFlags::cover_open),
                           field("wifiConnected", &SirenReportFlags::wifi_connected));
  }
};

/** Siren report (0x10). */
struct SirenReport {
  static constexpr std::uint8_t type = message_type::siren_report;
  std::uint8_t settings_version = 0;
  /** See SirenState. */
  std::uint8_t state = 0;
  std::uint16_t sounding_seconds_left = 0;
  std::uint16_t last_command_counter_low = 0;
  SirenReportFlags flags;
  std::uint8_t cell_battery_code = 0;
  std::int8_t temperature_celsius = 0;
  /** See SirenReportReason. */
  std::uint8_t reason = 0;

  /**
   * Wire layout, 10 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("settingsVersion", &SirenReport::settings_version),
                           field("state", &SirenReport::state),
                           field("soundingSecondsLeft", &SirenReport::sounding_seconds_left),
                           field("lastCommandCounterLow", &SirenReport::last_command_counter_low),
                           field("flags", &SirenReport::flags),
                           field("cellBatteryCode", &SirenReport::cell_battery_code),
                           field("temperatureCelsius", &SirenReport::temperature_celsius),
                           field("reason", &SirenReport::reason));
  }
};

/** Hello (0x20), the first packet of a gateway connection. */
struct Hello {
  static constexpr std::uint8_t type = message_type::hello;
  std::array<std::uint8_t, 8> gateway_random{};
  FirmwareVersion firmware_version;
  std::uint8_t settings_version = 0;

  /**
   * Wire layout, 12 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("gatewayRandom", &Hello::gateway_random),
                           field("firmwareVersion", &Hello::firmware_version),
                           field("settingsVersion", &Hello::settings_version));
  }
};

/** Forwarded packet (0x21): a radio packet a gateway heard, with how it heard it. */
struct ForwardedPacket {
  static constexpr std::uint8_t type = message_type::forwarded_packet;
  std::uint32_t received_at_micros = 0;
  std::int16_t rssi_dbm = 0;
  std::int8_t snr_quarter_db = 0;
  /** See DataRate. */
  std::uint8_t data_rate = 0;
  /** See SiteChannel. */
  std::uint8_t site_channel = 0;
  /** The packet as received: a view into the input, 18 to 255 bytes. */
  CarriedPacket packet;

  /**
   * Wire layout: 9 bytes, then the packet to the end of the body.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("receivedAtMicros", &ForwardedPacket::received_at_micros),
                           field("rssiDbm", &ForwardedPacket::rssi_dbm),
                           field("snrQuarterDb", &ForwardedPacket::snr_quarter_db),
                           field("dataRate", &ForwardedPacket::data_rate),
                           field("siteChannel", &ForwardedPacket::site_channel),
                           field("packet", &ForwardedPacket::packet));
  }
};

/** Flags of a gateway status (section 6). */
struct GatewayStatusFlags {
  bool usb_connected = false;
  bool cell_fitted = false;
  bool on_mains = false;

  /**
   * Bits 0 to 2, in order.
   */
  static constexpr auto flag_bits() {
    return std::make_tuple(field("usbConnected", &GatewayStatusFlags::usb_connected),
                           field("cellFitted", &GatewayStatusFlags::cell_fitted),
                           field("onMains", &GatewayStatusFlags::on_mains));
  }
};

/** Gateway status (0x22). */
struct GatewayStatus {
  static constexpr std::uint8_t type = message_type::gateway_status;
  std::uint8_t settings_version = 0;
  std::uint32_t uptime_seconds = 0;
  std::uint16_t airtime_hundredths_percent = 0;
  std::int8_t noise_median_dbm = 0;
  std::int8_t noise_highest_dbm = 0;
  std::int8_t normal_noise_dbm = 0;
  std::uint16_t packets_received = 0;
  std::uint16_t packets_crc_failed = 0;
  std::int8_t wifi_rssi_dbm = 0;
  GatewayStatusFlags flags;

  /**
   * Wire layout, 16 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(
        field("settingsVersion", &GatewayStatus::settings_version),
        field("uptimeSeconds", &GatewayStatus::uptime_seconds),
        field("airtimeHundredthsPercent", &GatewayStatus::airtime_hundredths_percent),
        field("noiseMedianDbm", &GatewayStatus::noise_median_dbm),
        field("noiseHighestDbm", &GatewayStatus::noise_highest_dbm),
        field("normalNoiseDbm", &GatewayStatus::normal_noise_dbm),
        field("packetsReceived", &GatewayStatus::packets_received),
        field("packetsCrcFailed", &GatewayStatus::packets_crc_failed),
        field("wifiRssiDbm", &GatewayStatus::wifi_rssi_dbm), field("flags", &GatewayStatus::flags));
  }
};

/** Transmit result (0x23). */
struct TransmitResult {
  static constexpr std::uint8_t type = message_type::transmit_result;
  std::uint32_t request_counter = 0;
  /** See TransmitOutcome. */
  std::uint8_t result = 0;
  std::uint32_t sent_at_micros = 0;

  /**
   * Wire layout, 9 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("requestCounter", &TransmitResult::request_counter),
                           field("result", &TransmitResult::result),
                           field("sentAtMicros", &TransmitResult::sent_at_micros));
  }
};

/** Interference (0x24), sent when interference starts and ends. */
struct Interference {
  static constexpr std::uint8_t type = message_type::interference;
  /** See InterferenceEvent. */
  std::uint8_t event = 0;
  std::int8_t noise_dbm = 0;
  std::uint16_t duration_seconds = 0;

  /**
   * Wire layout, 4 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("event", &Interference::event),
                           field("noiseDbm", &Interference::noise_dbm),
                           field("durationSeconds", &Interference::duration_seconds));
  }
};

/** Longest log text in bytes (section 6). */
constexpr std::size_t kMaxLogTextSize = 64;

/** One log entry; its text is a view into the input or into the caller's data. */
struct LogEntry {
  /** How long before the packet was sealed the entry was made, in tenths of a second. */
  std::uint32_t age_tenths = 0;
  std::uint8_t level = 0;
  std::uint16_t code = 0;
  LengthPrefixed<kMaxLogTextSize, TextContent> text;

  /**
   * Wire layout: 8 bytes, then the text.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("ageTenths", &LogEntry::age_tenths),
                           field("level", &LogEntry::level), field("code", &LogEntry::code),
                           field("text", &LogEntry::text));
  }
};

/**
 * The entries of a log entries body: empty when default-constructed, otherwise validated as one
 * or more whole entries filling the body exactly. Only decoding and LogEntriesWriter fill one;
 * read it with LogEntryReader. Encoding an empty list fails with Error::truncated.
 */
class LogEntryList {
public:
  /**
   * Returns the encoded entries, back to back.
   */
  constexpr ByteView encoded() const {
    return encoded_;
  }

private:
  friend class LogEntriesWriter;
  friend Error decode_log_entry_list(ByteView bytes, LogEntryList& out);
  ByteView encoded_;
};

/**
 * Validates `bytes` as one or more whole log entries and wraps them; used by the body decoder.
 */
Error decode_log_entry_list(ByteView bytes, LogEntryList& out);

/** Log entries (0x30). */
struct LogEntries {
  static constexpr std::uint8_t type = message_type::log_entries;
  LogEntryList entries;

  /**
   * Wire layout: entries to the end of the body.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("entries", &LogEntries::entries));
  }
};

/**
 * Visits the entries of a validated list one at a time, without copying.
 */
class LogEntryReader {
public:
  /**
   * Starts at the first entry.
   */
  explicit LogEntryReader(const LogEntryList& list) : reader_(list.encoded()) {}

  /**
   * Reads the next entry into `out`; returns false after the last one.
   */
  [[nodiscard]] bool next(LogEntry& out);

private:
  ByteReader reader_;
};

/**
 * Builds a log entries plaintext (type byte, then entries) in a caller's buffer, one entry at a
 * time. An entry is written whole or not at all.
 */
class LogEntriesWriter {
public:
  /**
   * Starts a plaintext in `out`.
   */
  explicit LogEntriesWriter(MutableByteView out) : out_(out) {}

  /**
   * Appends one entry. Fails with Error::bad_length for text over 64 bytes, or
   * Error::buffer_too_small when the entry does not fit.
   */
  Error append(const LogEntry& entry);

  /**
   * Returns the plaintext size; Error::truncated while no entry has been appended.
   */
  Result<std::size_t> finish() const;

  /**
   * Returns the entries appended so far as a list.
   */
  LogEntryList entries() const;

private:
  MutableByteView out_;
  std::size_t size_ = 0;
};

/** Flags of a reply (section 6). */
struct ReplyFlags {
  bool armed = false;
  bool countdown_started = false;
  bool update_available = false;

  /**
   * Bits 0 to 2, in order.
   */
  static constexpr auto flag_bits() {
    return std::make_tuple(field("armed", &ReplyFlags::armed),
                           field("countdownStarted", &ReplyFlags::countdown_started),
                           field("updateAvailable", &ReplyFlags::update_available));
  }
};

/**
 * In a reply's next site channel or next sending rate: that setting stays as it is. With both
 * fields at this value no move of the site is announced (section 6, D115).
 */
constexpr std::uint8_t kStaysAsItIs = 0xFF;

/** Reply (0x81), bound to the sensor packet it answers. */
struct Reply {
  static constexpr std::uint8_t type = message_type::reply;
  std::uint8_t settings_version = 0;
  ReplyFlags flags;
  std::uint8_t countdown_seconds = 0;
  std::uint8_t countdown_remaining_seconds = 0;
  std::uint8_t heartbeat_interval_units = 0;
  std::uint8_t link_check_every = 0;
  /** See DataRate. */
  std::uint8_t send_data_rate = 0;
  /** See DataRate. */
  std::uint8_t reply_data_rate = 0;
  std::uint16_t next_heartbeat_tenths = 0;
  /** Clock correction in units of 10 ppm; see ppm_from_clock_correction. */
  std::int16_t clock_correction_ten_ppm = 0;
  /** The channel the site is moving to (see SiteChannel), or kStaysAsItIs. */
  std::uint8_t next_site_channel = kStaysAsItIs;
  /** The data rate the site is moving to (see DataRate), or kStaysAsItIs. */
  std::uint8_t next_send_data_rate = kStaysAsItIs;

  /**
   * Wire layout, 14 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("settingsVersion", &Reply::settings_version),
                           field("flags", &Reply::flags),
                           field("countdownSeconds", &Reply::countdown_seconds),
                           field("countdownRemainingSeconds", &Reply::countdown_remaining_seconds),
                           field("heartbeatIntervalUnits", &Reply::heartbeat_interval_units),
                           field("linkCheckEvery", &Reply::link_check_every),
                           field("sendDataRate", &Reply::send_data_rate),
                           field("replyDataRate", &Reply::reply_data_rate),
                           field("nextHeartbeatTenths", &Reply::next_heartbeat_tenths),
                           field("clockCorrectionTenPpm", &Reply::clock_correction_ten_ppm),
                           field("nextSiteChannel", &Reply::next_site_channel),
                           field("nextSendDataRate", &Reply::next_send_data_rate));
  }
};

/** Disarmed notice (0x82): no body. */
struct DisarmedNotice {
  static constexpr std::uint8_t type = message_type::disarmed_notice;

  /**
   * Wire layout: empty.
   */
  static constexpr auto layout() {
    return std::make_tuple();
  }
};

/** Actions in an update offer (m3-updates-design.md section 5). */
struct UpdateAction {
  /** Discard anything held. */
  static constexpr std::uint8_t nothing = 0;
  /** Fetch on the link this offer came by. */
  static constexpr std::uint8_t fetch = 1;
  static constexpr std::uint8_t join_wifi_and_fetch = 2;
  static constexpr std::uint8_t open_bluetooth = 3;
  /** Install the verified image now. */
  static constexpr std::uint8_t install_now = 4;
  /** Keep what is held and wait. */
  static constexpr std::uint8_t wait = 5;
  /**
   * Fetch on the link this offer came by without waiting for the radio to be quiet: a gateway a
   * person chose to update although its site is always busy (m3-updates-design.md section 5).
   */
  static constexpr std::uint8_t forced_fetch = 6;
  static constexpr std::array<std::uint8_t, 7> known{
      nothing, fetch, join_wifi_and_fetch, open_bluetooth, install_now, wait, forced_fetch};
};

/**
 * Update offer (0x83), hub to any device: bound to the packet it answers for a sensor, as settings
 * are for a siren (strictly higher counter), in the session for a gateway.
 */
struct UpdateOffer {
  static constexpr std::uint8_t type = message_type::update_offer;
  /** See UpdateAction. */
  std::uint8_t action = 0;
  ImageId image_id{};
  /** The file's bytes: the 128-byte image header and the image. */
  std::uint32_t file_bytes = 0;
  FirmwareVersion version;
  /** The Bluetooth session nonce for action 3, else zeros. */
  std::array<std::uint8_t, 8> bluetooth_nonce{};
  /** The Bluetooth window for action 3, in units of 10 seconds. */
  std::uint8_t bluetooth_window_units = 0;

  /**
   * Wire layout, 25 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(
        field("action", &UpdateOffer::action), field("imageId", &UpdateOffer::image_id),
        field("fileBytes", &UpdateOffer::file_bytes), field("version", &UpdateOffer::version),
        field("bluetoothNonce", &UpdateOffer::bluetooth_nonce),
        field("bluetoothWindowUnits", &UpdateOffer::bluetooth_window_units));
  }
};

/**
 * Key change (0x84), hub to any device after a hub restore (m3-updates-design.md section 7): the
 * device's new key, sealed under the old one with the answer's usual binding. "Report again" is
 * always meant: the device's next packet goes under the new key.
 */
struct KeyChange {
  static constexpr std::uint8_t type = message_type::key_change;
  DeviceKey new_key{};

  /**
   * Wire layout, 16 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("newKey", &KeyChange::new_key));
  }
};

/** Siren command (0x90). */
struct SirenCommand {
  static constexpr std::uint8_t type = message_type::siren_command;
  /** See SirenAction. */
  std::uint8_t action = 0;
  std::uint16_t sound_seconds = 0;

  /**
   * Wire layout, 3 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("action", &SirenCommand::action),
                           field("soundSeconds", &SirenCommand::sound_seconds));
  }
};

/** Siren settings (0x91). */
struct SirenSettings {
  static constexpr std::uint8_t type = message_type::siren_settings;
  std::uint8_t settings_version = 0;
  std::uint8_t wifi_report_interval_seconds = 0;
  std::uint8_t lora_check_interval_units = 0;
  std::uint16_t max_sound_seconds = 0;
  /** See DataRate. */
  std::uint8_t send_data_rate = 0;
  /** See DataRate. */
  std::uint8_t command_data_rate = 0;
  /** The site channel to send on, numbered as in gateway settings; see SiteChannel. */
  std::uint8_t site_channel = 0;

  /**
   * Wire layout, 8 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(
        field("settingsVersion", &SirenSettings::settings_version),
        field("wifiReportIntervalSeconds", &SirenSettings::wifi_report_interval_seconds),
        field("loraCheckIntervalUnits", &SirenSettings::lora_check_interval_units),
        field("maxSoundSeconds", &SirenSettings::max_sound_seconds),
        field("sendDataRate", &SirenSettings::send_data_rate),
        field("commandDataRate", &SirenSettings::command_data_rate),
        field("siteChannel", &SirenSettings::site_channel));
  }
};

/** Welcome (0xA0), bound to the gateway's hello. */
struct Welcome {
  static constexpr std::uint8_t type = message_type::welcome;
  std::array<std::uint8_t, 8> hub_random{};

  /**
   * Wire layout, 8 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("hubRandom", &Welcome::hub_random));
  }
};

/** Transmit request (0xA1): a radio packet for the gateway to send on 869.525 MHz. */
struct TransmitRequest {
  static constexpr std::uint8_t type = message_type::transmit_request;
  /** See TransmitWhen. */
  std::uint8_t when = 0;
  std::uint32_t gateway_time_micros = 0;
  /** See DataRate. */
  std::uint8_t data_rate = 0;
  std::int8_t power_dbm = 0;
  /** See TransmitPriority. */
  std::uint8_t priority = 0;
  /** The packet to send: a view into the input, 18 to 255 bytes. */
  CarriedPacket packet;

  /**
   * Wire layout: 8 bytes, then the packet to the end of the body.
   */
  static constexpr auto layout() {
    return std::make_tuple(field("when", &TransmitRequest::when),
                           field("gatewayTimeMicros", &TransmitRequest::gateway_time_micros),
                           field("dataRate", &TransmitRequest::data_rate),
                           field("powerDbm", &TransmitRequest::power_dbm),
                           field("priority", &TransmitRequest::priority),
                           field("packet", &TransmitRequest::packet));
  }
};

/** Gateway settings (0xA2). */
struct GatewaySettings {
  static constexpr std::uint8_t type = message_type::gateway_settings;
  std::uint8_t settings_version = 0;
  /** See SiteChannel. */
  std::uint8_t site_channel = 0;
  /** One bit per data rate index; unknown bits pass through. */
  std::uint8_t listen_data_rate_mask = 0;
  std::uint8_t status_interval_seconds = 0;
  std::uint8_t interference_threshold_db = 0;
  std::uint8_t interference_seconds = 0;
  std::int8_t default_tx_power_dbm = 0;
  std::int8_t siren_tx_power_dbm = 0;

  /**
   * Wire layout, 8 bytes.
   */
  static constexpr auto layout() {
    return std::make_tuple(
        field("settingsVersion", &GatewaySettings::settings_version),
        field("siteChannel", &GatewaySettings::site_channel),
        field("listenDataRateMask", &GatewaySettings::listen_data_rate_mask),
        field("statusIntervalSeconds", &GatewaySettings::status_interval_seconds),
        field("interferenceThresholdDb", &GatewaySettings::interference_threshold_db),
        field("interferenceSeconds", &GatewaySettings::interference_seconds),
        field("defaultTxPowerDbm", &GatewaySettings::default_tx_power_dbm),
        field("sirenTxPowerDbm", &GatewaySettings::siren_tx_power_dbm));
  }
};

/** Every message type of version 1, for dispatch on the type byte. */
using Messages =
    std::tuple<Heartbeat, DoorChanged, CoverChanged, Button, Started, UpdateQuery, UpdateStatus,
               SirenReport, Hello, ForwardedPacket, GatewayStatus, TransmitResult, Interference,
               LogEntries, Reply, DisarmedNotice, UpdateOffer, KeyChange, SirenCommand,
               SirenSettings, Welcome, TransmitRequest, GatewaySettings>;

/**
 * Decodes a body into `out`. A body shorter than its fields is Error::truncated; extra bytes are
 * ignored (section 11). `out` is left unchanged on error. Instantiated for every type in Messages.
 */
template <typename Message>
Error decode_body(ByteView body, Message& out);

/**
 * Writes the plaintext of a message, its type byte then its body, and returns its size.
 * Instantiated for every type in Messages.
 */
template <typename Message>
Result<std::size_t> encode_plaintext(const Message& message, MutableByteView out);

/**
 * Returns true when `type` is a message type of version 1.
 */
constexpr bool is_known_message_type(std::uint8_t type) {
  bool known = false;
  for_each_type<Messages>([&](auto tag) { known = known || decltype(tag)::type::type == type; });
  return known;
}

/**
 * Decodes the body of message `type` and passes the decoded struct to `visitor`, which must
 * accept every type in Messages. Returns Error::unknown_type for a type version 1 does not list.
 */
template <typename Visitor>
Error decode_message(std::uint8_t type, ByteView body, Visitor&& visitor) {
  Error error = Error::unknown_type;
  for_each_type<Messages>([&](auto tag) {
    using Message = typename decltype(tag)::type;
    if (Message::type != type) {
      return;
    }
    Message message;
    error = decode_body(body, message);
    if (error == Error::none) {
      visitor(static_cast<const Message&>(message));
    }
  });
  return error;
}

}  // namespace hsn::protocol
