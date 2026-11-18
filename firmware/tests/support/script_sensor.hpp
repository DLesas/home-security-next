#pragma once

// A scripted sensor for the test hub's tests: the smallest device that speaks the sensor's side
// of the protocol through the core's SecureChannel and RadioPort. It is not the sensor role: no
// retries (but one, while it holds next settings), no deep sleep, no local alarm. It follows a
// move of the site as protocol section 7 says a sensor does, keeping the next settings in RAM. It
// sends a door report on every door change and listens for the reply, sends heartbeats and listens
// at the reply moment, keeps the settings a reply carries, and after a reply that started a
// countdown listens for the disarmed notice (a heartbeat meanwhile ends that listening: give it no
// heartbeats in countdown tests). It can log scripted entries and send them over LoRa as the sensor
// does: one entry at warning or above after a heartbeat, kept in the core's log until the hub's
// reply to that packet arrives.

#include <array>
#include <cstdint>
#include <vector>

#include "hsn/device/events.hpp"
#include "hsn/device/hal/sensor_io.hpp"
#include "hsn/device/role.hpp"
#include "hsn/device/services.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/messages.hpp"
#include "script_log.hpp"

namespace hsn::test {

/** How a ScriptSensor behaves. */
struct ScriptSensorConfig {
  std::uint8_t send_data_rate = 5;
  /** How long it listens after an event report. */
  device::Duration listen_time = device::milliseconds(1500);
  /** Time between heartbeats; zero for none. */
  device::Duration heartbeat_every;
  /** Every Nth heartbeat asks for a reply. */
  std::uint8_t link_check_every = 5;
  /** Send Started at boot. */
  bool send_started = false;
  /**
   * From this heartbeat on (counting from 1; 0 never) it falls back: it listens at its sending
   * rate and sets flag bit 7, until a reply tells it a reply rate again (protocol section 7).
   */
  std::uint32_t fall_back_at_heartbeat = 0;
  /** Added to every door report's age: a report that reaches the hub late. */
  std::uint16_t extra_age_seconds = 0;
  std::int8_t power_dbm = 14;
  /** Entries it logs, in time order, into the core's log. */
  std::vector<ScriptLogEntry> log_entries;
  /**
   * After each heartbeat's reply window, send one log entries packet over LoRa if the log holds
   * an entry at warning or above: the oldest such, released only when the hub's reply bound to
   * that packet arrives (protocol section 6).
   */
  bool send_logs = false;
};

/** A move it followed (protocol section 7): when it took the new settings, and which. */
struct ScriptSensorMove {
  /** The board's clock. */
  device::Instant at;
  std::uint8_t site_channel = 0;
  std::uint8_t send_data_rate = 0;
};

/** What a ScriptSensor heard, kept by the test. */
struct ScriptSensorLog {
  struct Heard {
    /** The board's clock. */
    device::Instant at;
    std::uint8_t type = 0;
    /** Meaningful for replies. */
    protocol::Reply reply;
    /** The counter of its own packet the hub's packet was bound to. */
    std::uint32_t answered = 0;
  };
  std::vector<Heard> heard;
  /** Counters it sent, in order. */
  std::vector<std::uint32_t> sent;
  /** Hub packets that failed open_bound. */
  std::uint32_t rejected = 0;
  /** A log entries packet it sent, and whether the hub's reply to it came. */
  struct LogSend {
    std::uint32_t counter = 0;
    std::uint16_t code = 0;
    bool answered = false;
  };
  std::vector<LogSend> log_sends;
  /** Moves it followed, and the next settings the latest reply announced (0xFF: stays). */
  std::vector<ScriptSensorMove> moves;
  std::uint8_t next_site_channel = protocol::kStaysAsItIs;
  std::uint8_t next_send_data_rate = protocol::kStaysAsItIs;

  /** How many packets of one type it accepted. */
  std::size_t count(std::uint8_t type) const;
};

/** The scripted sensor. */
class ScriptSensor final : public device::Role {
public:
  ScriptSensor(device::Services& services, device::SensorIo& io, const ScriptSensorConfig& config,
               ScriptSensorLog& log);

  std::uint8_t role_id() const override;
  void handle(const device::Event& event) override;
  device::Wake next_wake() const override;
  protocol::MutableByteView state_bytes() override;
  std::uint8_t state_layout() const override;
  std::uint8_t state_id() const override;
  device::Duration longest_awake() const override;
  void report_again(device::Instant) override {}

private:
  enum class Sent : std::uint8_t { nothing, heartbeat, event, log };

  bool port_busy() const;
  void choose_settings();
  void on_unanswered(device::Instant now);
  void adopt(const protocol::Reply& reply, bool answered_on_next, device::Instant now);
  void send_event(std::uint8_t type, device::Instant now, bool retry = false);
  void send_heartbeat(device::Instant now);
  void send_log(device::Instant now);
  bool send_sealed(std::size_t size, device::Instant now);
  protocol::SensorStatus status(bool reply_wanted);
  void listen(device::Duration timeout, device::Instant now);
  void on_radio(const device::RadioEvent& radio, device::Instant now);
  void on_packet(protocol::ByteView packet, device::Instant now);
  void run_timers(device::Instant now);
  std::uint8_t reply_rate() const;

  device::Services& services_;
  device::SensorIo& io_;
  ScriptSensorConfig config_;
  ScriptSensorLog& log_;
  protocol::Reply held_;
  bool holds_settings_ = false;
  /**
   * A move of the site (protocol section 7): the current channel and rate, the next ones a reply
   * announced, and which settings the packet being sent and the latest reply-wanted one use.
   */
  std::uint8_t channel_ = 0;
  std::uint8_t rate_ = 0;
  bool has_next_ = false;
  std::uint8_t next_channel_ = 0;
  std::uint8_t next_rate_ = 0;
  /** A reply-wanted packet went unanswered: the next goes on the other settings. */
  bool other_settings_ = false;
  /** The packet being sent goes on the next settings; it listens at its sending rate. */
  bool sending_on_next_ = false;
  bool sending_other_ = false;
  /** The latest reply-wanted packet: its counter until answered, and its settings. */
  std::uint32_t awaiting_ = 0;
  bool awaiting_on_next_ = false;
  std::uint8_t awaiting_type_ = 0;
  bool at_send_rate_ = false;
  bool door_open_ = false;
  std::uint8_t change_count_ = 0;
  device::Instant door_changed_at_;
  std::uint32_t heartbeats_ = 0;
  Sent last_sent_ = Sent::nothing;
  std::uint8_t waiting_event_ = 0;
  std::array<std::uint32_t, device::kMaxBoundCandidates> exchange_{};
  std::size_t exchange_size_ = 0;
  std::uint32_t heartbeat_counter_ = 0;
  ScriptLogger logger_;
  /** When to send a log entries packet: after the heartbeat's reply window. */
  device::Instant log_at_ = device::Instant::never();
  bool log_waiting_ = false;
  /** The latest log entries packet sent, until its reply arrives. */
  std::uint32_t log_counter_ = 0;
  device::Instant heartbeat_at_ = device::Instant::never();
  device::Instant reply_at_ = device::Instant::never();
  device::Instant listen_until_ = device::Instant::never();
  /** The end of the current timed listening, kept across packets meant for others. */
  device::Instant window_end_;
  std::array<std::uint8_t, 64> packet_{};
  std::array<std::uint8_t, 4> state_{};
};

static_assert(device::is_complete_role<ScriptSensor>, "a role must override every Role method");

}  // namespace hsn::test
