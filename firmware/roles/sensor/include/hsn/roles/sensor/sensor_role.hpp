#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>

#include "hsn/device/events.hpp"
#include "hsn/device/hal/radio.hpp"
#include "hsn/device/hal/sensor_io.hpp"
#include "hsn/device/role.hpp"
#include "hsn/device/services.hpp"
#include "hsn/device/services/record.hpp"
#include "hsn/device/status.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/packet.hpp"
#include "hsn/roles/sensor/sensor_constants.hpp"
#include "hsn/roles/sensor/sensor_log_codes.hpp"
#include "hsn/roles/sensor/sensor_state.hpp"

namespace hsn::roles::sensor {

/** The longest a sensor stays awake: a retry run, a countdown and a local alarm (design §6). */
constexpr device::Duration kSensorLongestAwake = kLongestAwake;

/**
 * The battery-powered door sensor (design §7, protocol §6–8). It reports every door, cover and
 * button change at once and retries for 10 minutes; listens for the hub's answers bound to its
 * own counters; keeps the settings and the armed state the hub sends; buzzes for the hub's
 * countdown, or for its own when an armed opening goes unanswered, then sounds its own alarm;
 * sends heartbeats in the hub's slot or at its interval ±10%, falling back to slower data rates
 * when answers stop; sends its warnings over LoRa after heartbeats; handles the button's press
 * and holds, including the factory reset of D89; and sleeps deep whenever it is idle.
 *
 * The behaviour is split by concern over the files in src/: boot, inputs, button, reports,
 * radio, replies, alerts, heartbeat, sleep.
 */
class SensorRole final : public device::Role {
public:
  SensorRole(device::Services& services, device::SensorIo& io);

  std::uint8_t role_id() const override;
  void handle(const device::Event& event) override;
  device::Wake next_wake() const override;
  protocol::MutableByteView state_bytes() override;
  std::uint8_t state_layout() const override;
  std::uint8_t state_id() const override;
  device::Duration longest_awake() const override;
  void report_again(device::Instant now) override;

  /** The state, for tests. */
  const SensorState& state() const {
    return state_;
  }

private:
  // sensor_role.cpp: the order of work after every event.
  /** Runs everything that is due and can run, then keeps the radio as the state needs it. */
  void advance(device::Instant now);
  /** Plays the buzzer the state asks for and keeps the stuck-awake bookkeeping. */
  void finish(device::Instant now);

  // boot.cpp: start-up and wake (§6, Started).
  /** Restores or starts the state; a start-up sends Started. */
  void on_boot(const device::BootInfo& boot, device::Instant now);
  /** No retained memory: settings from flash, disarmed, inputs as found (§6). */
  void cold_start(device::Instant now);
  /** The clock restarted: every instant in the state means nothing, so all count from now. */
  void rebase_clock(device::Instant now);
  /** Compares the inputs with the retained levels and reports what changed while asleep. */
  void read_inputs_after_wake(device::WakeMask woke_by, device::Instant now);

  // inputs.cpp: door, cover, external power.
  void on_input(const device::InputEvent& input, device::Instant now);
  /** The door changed: count it, and report it at once (§7, DS12). */
  void door_changed(device::Instant at, device::Instant now);
  /** The cover changed: report it at once (DS9). */
  void cover_changed(device::Instant at, device::Instant now);

  // button.cpp: press, holds, pairing window, factory reset (DS7, DS8, D88, D89, PR4).
  void button_pressed(device::Instant at, device::Instant now);
  void button_released(device::Instant at, device::Instant now);
  /** Reports a button action, unless a factory reset is under way. */
  void report_button(std::uint8_t action, device::Instant now);
  /** A 15-second hold: D89 when armed, otherwise the reset goes ahead. */
  void reset_hold(device::Instant now);
  /** Sends action 4 once, waits for its one listen window, then erases (D89, PR4). */
  void begin_going_ahead(device::Instant now);
  /** Erases through the setup service and asks for a restart (PR4). */
  void erase_and_restart(device::Instant now);
  void run_button_timers(device::Instant now);

  // reports.cpp: the report exchange (§7, "No reply from the hub", DS3).
  /** Adds reports to the exchange; they go at once, and the retry run counts from now. */
  void queue_report(std::uint8_t bits, device::Instant now);
  void run_tries(device::Instant now);
  /** Sends the most important waiting report, with the newest state and age (DS3, §2). */
  void send_try(device::Instant now);
  /** Plans the next retry, never before `not_before`; gives up after 10 minutes (§7). */
  void next_retry(device::Instant not_before, device::Instant now);
  void give_up(device::Instant now);
  /** A reply answered a try of `kind`. */
  void report_answered(TryKind kind, device::Instant now);
  /** The latest try's listening ended unanswered. */
  void report_window_closed(device::Instant now);
  /** Builds a status body with the newest state, read now, before the radio sends (D109). */
  protocol::SensorStatus status(bool reply_wanted, device::Instant event_at, bool has_age,
                                device::Instant now);
  /** True while a try must wait: the radio is sending, or the last try is still listened for. */
  bool try_blocked() const;

  // radio.cpp: sending through the port, listening windows (§2, §7, §8).
  void on_radio(const device::RadioEvent& radio, device::Instant now);
  void on_port_report(const device::PortReport& report, const device::RadioEvent* radio,
                      device::Instant now);
  void on_sent(device::Instant at, device::Instant now);
  void on_send_failed(device::Instant now);
  /** Encodes, checks the budget first, seals and sends; Status::deferred with deferred_until_. */
  template <typename Message>
  device::Status send_message(const Message& message, device::TxClass tx_class, TryKind kind,
                              device::Instant now);
  device::Status start_send(const device::Sealed& sealed, const device::Transmission& transmission,
                            TryKind kind, device::Instant now);
  /** The site channel at the sending rate, or nothing when the pairing's channel is unknown. */
  std::optional<device::RadioChannel> site_channel() const;
  /** Closes the listening windows that have ended. */
  void close_windows(device::Instant now);
  /** Listens as the windows and the countdown ask, or puts the radio to sleep (LR7). */
  void keep_listening(device::Instant now);
  void listen(device::Duration timeout, device::Instant now);
  /** True while it holds the next settings of a move of the site (§7, D115). */
  bool holds_next() const;
  /** The sending rate of the settings in use: the next ones' after a miss during a move. */
  std::uint8_t send_rate_in_use() const;
  /** The rate replies come at: the reply rate, or the sending rate after fall-back (§7). */
  std::uint8_t listen_rate() const;
  /** True when the sensor says flag bit 7: it listens at the rate it sends at (§6, §7). */
  bool at_send_rate() const;
  bool port_busy() const;
  /** True while a timed receive is going on: its end closes the windows. */
  bool timed_receive() const;
  bool window_open() const;
  /** True while the radio must not be touched: a timed receive, or a packet arriving (§8). */
  bool radio_held() const;

  // replies.cpp: what the hub sends (§4, §6).
  void on_packet(protocol::ByteView packet, device::Instant now);
  void on_reply(const protocol::Reply& reply, std::uint32_t answered, TryKind kind,
                device::Instant now);
  /** Keeps the reply's settings: flash only when a stored field changes (design §5). */
  void apply_settings(const protocol::Reply& reply, device::Instant now);
  void ensure_settings_loaded(device::Instant now);
  /** The next settings become the current ones, for good (§7, D115). */
  void adopt_next();
  /** A reply-wanted packet went unanswered: the data-rate fall-back (§7). */
  void note_miss(device::Instant now);
  /** A disarmed notice bound to a counter of `kind`; the second copy is ignored (§6). */
  void on_disarmed(TryKind kind, device::Instant now);

  // alerts.cpp: countdown, local alarm, buzzer, battery (DS6, DS11–DS13, D24, D88, D109).
  void start_hub_countdown(std::uint8_t remaining_seconds, device::Instant now);
  /** An armed opening's first try went unanswered: the stored countdown, then the alarm. */
  void start_local_alarm(device::Instant now);
  void begin_alarm(device::Instant from, device::Instant now);
  void stop_alerts();
  void run_alert_timers(device::Instant now);
  device::Sound desired_sound() const;
  void check_battery(std::uint16_t millivolts, device::Instant now);

  // heartbeat.cpp: heartbeats, slots, log entries over LoRa (§6, §7, D110).
  /** Plans the next heartbeat at the interval ±10% from `base` (§7). */
  void plan_unslotted(device::Instant base);
  /** The heartbeat interval at the current rate, scaled by the clock correction (§6, §7). */
  device::Duration interval() const;
  /** Scales a sleep time by the hub's clock correction (§6, reply). */
  device::Duration corrected(device::Duration nominal) const;
  void run_heartbeat_timers(device::Instant now);
  void send_heartbeat(device::Instant now);
  void heartbeat_window_closed(device::Instant now);
  /** The hub's slot: the next heartbeat `tenths` after `answered_end`, the answered packet's end.
   */
  void take_slot(device::Instant answered_end, std::uint16_t tenths);
  void run_log(device::Instant now);

  // sleep.cpp: how deeply to sleep (DS1, §10, design §6).
  bool can_sleep_deep() const;

  device::Services& services_;
  device::SensorIo& io_;
  SensorState state_;
  /** The settings record in flash (design §5). */
  device::Record<StoredSettings> settings_record_;
  /** RAM only: what this boot knows. */
  bool settings_loaded_ = false;
  bool radio_asleep_ = false;
  /** The kind of the latest receive the role started; read only while the port is receiving. */
  bool rx_continuous_ = false;
  /** A packet's header has come on the current receive: it is received whole. */
  bool rx_arriving_ = false;
  bool restart_ = false;
  device::Instant deferred_until_ = device::Instant::never();
  /** The latest deferral was an urgent packet waiting for the D111 gap. */
  bool deferred_past_limit_ = false;
  std::array<std::uint32_t, device::kMaxBoundCandidates> candidates_{};
  std::array<std::uint8_t, protocol::kMaxRadioPacketSize> packet_{};
};

static_assert(device::is_complete_role<SensorRole>, "a role must override every Role method");
static_assert(sizeof(SensorState) <= device::kMaxRoleStateSize, "fits the retained block");

template <typename Message>
device::Status SensorRole::send_message(const Message& message, device::TxClass tx_class,
                                        TryKind kind, device::Instant now) {
  deferred_until_ = device::Instant::never();
  if (radio_held()) {
    // A packet is arriving, or a timed receive runs: nothing is sent over it (§8).
    return device::Status::busy;
  }
  const std::optional<device::RadioChannel> channel = site_channel();
  if (!channel.has_value()) {
    services_.log.add(now, device::LogLevel::error, sensor_log::no_site_channel, "no site channel");
    return device::Status::refused;
  }
  device::Transmission transmission;
  transmission.channel = *channel;
  transmission.power_dbm = kTxPowerDbm;
  transmission.tx_class = tx_class;
  transmission.listen_first = true;
  // The budget is judged before a counter is taken, so a refused packet costs no counter (§2).
  const auto plain = protocol::encode_plaintext(message, protocol::MutableByteView(packet_));
  if (!plain.ok()) {
    services_.log.add(now, device::LogLevel::error, sensor_log::seal_failed, "encode failed");
    return device::Status::protocol_error;
  }
  const device::Admission admission =
      services_.radio_port.check(transmission, protocol::kPacketOverhead + plain.value(), now);
  if (!admission.allowed) {
    deferred_until_ = admission.earliest;
    deferred_past_limit_ = admission.past_limit;
    return device::Status::deferred;
  }
  const auto sealed =
      services_.channel.seal(message, protocol::Binding::none(), protocol::PacketLimit::radio,
                             protocol::MutableByteView(packet_));
  if (!sealed.ok()) {
    services_.log.add(now, device::LogLevel::error, sensor_log::seal_failed, "seal failed",
                      static_cast<std::int32_t>(sealed.status()));
    return sealed.status();
  }
  return start_send(sealed.value(), transmission, kind, now);
}

}  // namespace hsn::roles::sensor
