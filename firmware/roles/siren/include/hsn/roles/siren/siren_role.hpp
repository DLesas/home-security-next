#pragma once

#include <array>
#include <cstdint>
#include <optional>

#include "hsn/device/events.hpp"
#include "hsn/device/hal/siren_io.hpp"
#include "hsn/device/role.hpp"
#include "hsn/device/services.hpp"
#include "hsn/device/services/radio_port.hpp"
#include "hsn/device/services/record.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/packet.hpp"
#include "hsn/roles/siren/siren_state.hpp"

namespace hsn::roles::siren {

/** The path a hub packet came by, and its answer goes back by (§7, siren command). */
enum class Path : std::uint8_t {
  wifi,
  lora,
};

/** Telemetry read once per event, for the reports (§6, siren report). */
struct Telemetry {
  bool on_mains = false;
  bool cell_fitted = false;
  bool charging = false;
  bool cover_open = false;
  /** 0 when no cell is fitted. */
  std::uint16_t cell_millivolts = 0;
  std::int8_t temperature_c = 0;
};

/**
 * The siren controller (design section 7): an always-powered board that switches a separate
 * sounder (D42) on the hub's commands only (D7), heard over Wi-Fi and LoRa at once (D36, D73),
 * reports its state on both paths, stops by itself (SR5) and keeps sounding through a reset
 * (D80).
 *
 * For firmware updates (m3-updates-design.md sections 2, 5, 6) it takes an update offer under the
 * command rule on either path and passes it to the update service, sends the service's queries
 * and statuses on Wi-Fi (a status that is not progress on LoRa when Wi-Fi is down), refuses an
 * offer while it is off mains, and installs only when its output is off: an "install now" that
 * comes while it sounds waits for the output to stop. A new image is healthy once a command or
 * settings packet opened on either path and one LoRa transmission completed. It sounds and answers
 * on both paths throughout. After a hub restore it takes a Key change under the same rule, changes
 * its key and answers with a report on the path it came by, under the new key (section 7).
 *
 * Its source is split by concern: boot, output, commands, reports, LoRa, Wi-Fi and updates.
 */
class SirenRole final : public device::Role {
public:
  SirenRole(device::Services& services, device::SirenIo& io);

  std::uint8_t role_id() const override;
  void handle(const device::Event& event) override;
  device::Wake next_wake() const override;
  protocol::MutableByteView state_bytes() override;
  std::uint8_t state_layout() const override;
  std::uint8_t state_id() const override;
  device::Duration longest_awake() const override;
  void report_again(device::Instant now) override;

  /** The role's state, for tests and diagnostics. */
  const SirenState& state() const {
    return state_;
  }

private:
  // siren_boot.cpp
  /** Starts afresh after any boot, keeping the output only when D80 says so. */
  void on_boot(const device::BootInfo& boot, device::Instant now);
  /** Carries the sounding over a reset that kept the retained block (D80). */
  void resume_output(const SirenState& kept, const device::BootInfo& boot, device::Instant now);
  /** Loads the settings record, or the defaults. */
  void load_settings(device::Instant now);
  /** The settings until the hub sends some (§2, §6). */
  SirenSettingsHeld default_settings() const;
  /** The fastest data rate the pairing allows (§7, "Data rate"). */
  std::uint8_t fastest_allowed_rate() const;

  // siren_output.cpp
  /** Sounds as `output_state` for `seconds`, capped by the settings (SR5); 0 means off. */
  void start_sounding(std::uint8_t output_state, std::uint16_t seconds, device::Instant now);
  /** Stops the output. */
  void stop_sounding();
  /** Switches the sounder when its level changes. */
  void drive_output(bool on);
  /** Whole seconds of sounding left, rounded up (§6, siren report). */
  std::uint16_t seconds_left(device::Instant now) const;

  // siren_commands.cpp
  /** Judges a hub packet with the command rule (§4, §7) and acts on it. */
  void on_hub_packet(protocol::ByteView packet, Path path, device::Instant now);
  /** Logs a packet the channel refused, when it was meant for this siren. */
  void log_refused(protocol::ByteView packet, protocol::PacketLimit limit,
                   const device::Outcome<device::CommandOpen>& opened, device::Instant now);
  /** Carries out a new command (§6, siren command). */
  void act_on_command(const protocol::SirenCommand& command, device::Instant now);
  /** Takes new settings, storing them only when they change (§6, siren settings). */
  void apply_settings(const protocol::SirenSettings& settings, device::Instant now);

  // siren_reports.cpp
  /** Reads the telemetry once per event. */
  const Telemetry& telemetry();
  /** Builds a report of the current state (§6, siren report). */
  protocol::SirenReport build_report(std::uint8_t reason, device::Instant now);
  /**
   * A report on Wi-Fi, or on LoRa when Wi-Fi fails (§7). A `change` (cover, mains, the output
   * stopping, the link going down) goes on LoRa at once; a regular one keeps the routine pace.
   */
  void report(device::Instant now, bool change);
  /** Answers a command or settings packet on the path it came by (§7). */
  void answer(Path path, device::Instant now);
  /** Sends a report on Wi-Fi; HalError::none when the link took it. */
  device::HalError send_report_wifi(std::uint8_t reason, device::Instant now);
  /** Hands a sealed packet in link_packet_ to the network link. */
  device::HalError send_sealed_wifi(const device::Outcome<device::Sealed>& sealed,
                                    device::Instant now);
  /** A cover or mains change: logged, and reported at once (task item 5). */
  void on_input(const device::InputEvent& input, device::Instant now);

  // siren_lora.cpp
  /** Hands a radio event to the port, and a received packet to the command rule. */
  void on_radio(const device::RadioEvent& radio, device::Instant now);
  /** Acts on what the port reports. */
  void on_port(const device::PortReport& report, device::Instant now);
  /** Puts an item that did not go back in the outbox and waits before retrying. */
  void requeue(LoraItem item, device::Instant now);
  /** Holds LoRa sending until `until`: everything, or routine traffic only. */
  void hold_lora(device::Instant until, bool all);
  /** Sends the most urgent waiting LoRa item when the port is free (§2 priorities). */
  void pump_lora(device::Instant now);
  /** True when `item` waits in the outbox. */
  bool lora_pending(LoraItem item) const;
  /**
   * The one place that decides whether a waiting item may be tried now: an airtime or fault
   * hold (lora_wait), and for paced items only, the report pace (report_pace), armed here.
   */
  bool lora_held(LoraItem item, device::Instant now);
  /** Tries one item: true when it went to the port or must wait, false when it was dropped. */
  bool send_lora_item(LoraItem item, device::Instant now);
  /** Seals an item into radio_packet_; size 0 when there is nothing to send. */
  device::Outcome<device::Sealed> seal_lora_item(LoraItem item, device::Instant now);
  /** Clears an item from the outbox; a check also covers a waiting Wi-Fi-failed report. */
  void take_lora_item(LoraItem item);
  /** An item's transmission on the site channel at the sending rate (§2). */
  std::optional<device::Transmission> transmission(LoraItem item) const;
  /**
   * The least time between routine reports so that, sent back to back, they fit their share of
   * the hour: at slow rates they are spread out evenly instead of bunching until the budget runs
   * out and then falling silent.
   */
  device::Duration routine_report_pace() const;
  /** Keeps continuous receive on 869.525 MHz at the command rate (§2, §7). */
  void keep_listening(device::Instant now);

  // siren_wifi.cpp
  /** Handles a network link event; USB packets are not for the role. */
  void on_link(const device::LinkEvent& link, device::Instant now);
  /** A failed connect is a warning when it starts a run of failures, info after that. */
  device::LogLevel connect_failure_level() const;
  /** Starts a connect with the pairing's link target. */
  void connect(device::Instant now);
  /** The link came up: Started (once), then a report. */
  void on_wifi_up(device::Instant now);
  /** A connect failed or the link went down: back off (§7). */
  void on_wifi_failed(device::Instant now);
  /** Sends Started on Wi-Fi; true when the link took it. */
  bool send_started_wifi(device::Instant now);
  /** Started has gone out: clears a reported fatal error (FW5). */
  void started_sent(device::Instant now);
  /** Sends every kept log entry on Wi-Fi as it arises (D110). */
  void flush_logs_wifi(device::Instant now);

  // siren_updates.cpp
  /** What goes to the hub next about an update: the siren's own refusal, or the service's. */
  struct UpdateOut {
    device::UpdatePacket packet;
    bool refusal = false;
  };
  /** The siren's refusal if one waits, else the update service's packet. */
  UpdateOut next_update(device::Instant now) const;
  /** An update offer opened under the command rule, on `path`. */
  void on_offer(const protocol::UpdateOffer& offer, Path path, device::Instant now);
  /** A Key change opened under the command rule (§7): the key changes; the answer follows. */
  void on_key_change(protocol::ByteView body, Path path, device::Instant now);
  /** Sends what the update service asks: on Wi-Fi, or a status on LoRa when Wi-Fi is down. */
  void pump_update(device::Instant now);
  /** Seals an update packet (`out`) into `buffer` under `limit`. */
  device::Outcome<device::Sealed> seal_update(const UpdateOut& out, protocol::PacketLimit limit,
                                              protocol::MutableByteView buffer);
  /** What was sealed went: the refusal is cleared, or the service is told. */
  void update_sent(const UpdateOut& out, device::Instant now);
  /** Calls the update service's healthy() once the siren's condition holds (section 2). */
  void check_health(device::Instant now);
  /** Hands over an "install now" that waited for the output to stop. */
  void release_install(device::Instant now);

  // siren_role.cpp
  /** Runs every due timer. */
  void run_timers(device::Instant now);
  /** Re-arms a periodic timer one interval after it was due, or after now when it fell behind. */
  void rearm(SirenTimer timer, device::Instant due, device::Duration interval, device::Instant now);
  /**
   * Arms a periodic timer to first fire at a random point within one interval from now (§7), so
   * sirens that start together do not keep the same rhythm.
   */
  void arm_at_random_phase(SirenTimer timer, device::Duration interval, device::Instant now);
  /** The Wi-Fi report interval in force. */
  device::Duration wifi_report_interval() const;
  /** The LoRa check interval in force. */
  device::Duration lora_check_interval() const;

  device::Services& services_;
  device::SirenIo& io_;
  device::Record<SirenSettingsHeld> settings_record_;
  SirenState state_;
  /** This event's telemetry, read on first use. */
  Telemetry telemetry_;
  bool telemetry_read_ = false;
  /** Scratch for packets sealed for the network link. */
  std::array<std::uint8_t, protocol::kMaxLinkPacketSize> link_packet_{};
  /** Scratch for packets sealed for the radio. */
  std::array<std::uint8_t, protocol::kMaxRadioPacketSize> radio_packet_{};

  // RAM only, for this boot: updates and the key change.
  /** The siren's own refusal of an offer (off mains), until it has gone. */
  bool refusal_pending_ = false;
  std::uint8_t refusal_reason_ = 0;
  protocol::ImageId refusal_image_{};
  /** The update packet in the LoRa outbox's flight, to tell the service once it is on air. */
  UpdateOut lora_update_;
  /** An "install now" that came while the output sounded, and the path it came by. */
  bool install_waiting_ = false;
  protocol::UpdateOffer install_offer_;
  Path install_path_ = Path::wifi;
  /** The health condition's two halves (m3-updates-design.md section 2). */
  bool hub_packet_opened_ = false;
  bool lora_sent_ = false;
  /** The path the latest Key change came by: report_again() answers on it. */
  Path key_change_path_ = Path::wifi;
  /**
   * This event opened a Key change: nothing more is sent in it, so that if the key changed, the
   * first packet under the new key is the answer report_again() sends.
   */
  bool key_change_in_event_ = false;
};

static_assert(device::is_complete_role<SirenRole>, "a role must override every Role method");
static_assert(sizeof(SirenState) <= device::kMaxRoleStateSize, "fits the retained block");

}  // namespace hsn::roles::siren
