#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <type_traits>

#include "hsn/device/events.hpp"
#include "hsn/device/hal/gateway_io.hpp"
#include "hsn/device/hal/link.hpp"
#include "hsn/device/role.hpp"
#include "hsn/device/services.hpp"
#include "hsn/device/services/record.hpp"
#include "hsn/device/time.hpp"
#include "hsn/device/timers.hpp"
#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/packet.hpp"
#include "hsn/roles/gateway/gateway_settings.hpp"
#include "hsn/roles/gateway/log_codes.hpp"
#include "hsn/roles/gateway/noise_monitor.hpp"
#include "hsn/roles/gateway/transmit_queue.hpp"

namespace hsn::roles::gateway {

/** The gateway's timers (design section 7). */
enum class GatewayTimer : std::uint8_t {
  /** The next gateway status (GW6). */
  status,
  /** The next noise sample (GW11). */
  noise_sample,
  /** The next connection attempt after a failure (protocol section 7, back-off). */
  reconnect,
  /** A hello on the network link gives up waiting for its welcome. */
  welcome_timeout,
  /** The next hello on USB while a computer is attached (protocol section 10). */
  usb_hello,
  /** The USB attempt's window for a welcome closes. */
  usb_window,
  /** The next try of USB while on Wi-Fi (protocol section 10). */
  usb_retry,
  /** A reception or transmission outlasted its time, or a failed radio is tried again. */
  radio_guard,
  count,
};

/** Number of gateway timers. */
constexpr std::size_t kGatewayTimerCount = static_cast<std::size_t>(GatewayTimer::count);

/** Where the connection to the hub stands (design section 7). */
enum class ConnectionPhase : std::uint8_t {
  /** No link: waiting for the back-off to end. */
  idle,
  /** The network link is starting; `up` or `down` will follow. */
  connecting,
  /** A hello has gone; nothing but its welcome is accepted. */
  awaiting_welcome,
  /** Welcomed: everything both ways is bound to the session. */
  connected,
};

/** What the radio is doing (design section 7). */
enum class RadioMode : std::uint8_t {
  /** Not working: a failed call, waiting to be tried again. */
  off,
  /** Receiving continuously on the site channel, nothing arriving. */
  listening,
  /** A header was seen: a packet is arriving, so nothing may be sent (protocol section 7). */
  receiving,
  /** Sending on 869.525 MHz, deaf to the site channel. */
  transmitting,
};

/** The connection to the hub. */
struct ConnectionState {
  ConnectionPhase phase = ConnectionPhase::idle;
  /** The link the connection uses. */
  device::LinkKind link = device::LinkKind::network;
  /** Failures since the last welcome: the back-off step (protocol section 7). */
  std::uint8_t failures = 0;
  /** Bumped by every welcome, so a result can tell its connection is gone. */
  std::uint8_t generation = 0;
  /** Settings have arrived on this connection. */
  bool settings_received = false;
  /** Started has gone out since this start-up (protocol section 6). */
  bool started_sent = false;
  /** A hello is out on USB while the connection is on Wi-Fi (protocol section 10). */
  bool probing = false;
  device::SessionState session;
  /** The USB hello's session while probing. */
  device::SessionState probe;
};

/** The radio, and the transmission on the air. */
struct RadioState {
  RadioMode mode = RadioMode::off;
  /** The data rate listened at (O14: one at a time). */
  std::uint8_t data_rate = 0;
  /** The site channel listened on, numbered as in gateway settings. */
  std::uint8_t site_channel = 0;
  /** New settings came during a reception: listen again once it ends. */
  bool listen_again = false;
  /** A transmit request is on the air. */
  bool sending = false;
  std::uint32_t request = 0;
  /** The connection the request came on. */
  std::uint8_t request_generation = 0;
  /** When it started, for its result (protocol section 6). */
  device::Instant sent_at;
};

/** Packets since the last status (protocol section 6, gateway status). */
struct PacketCounts {
  std::uint16_t received = 0;
  std::uint16_t crc_failed = 0;
};

/**
 * The gateway's state, kept in the retained block like every role's, though nothing in it needs
 * to survive a reset: every boot starts a new connection (design section 7). The transmit queue
 * and its packets live in the role object.
 */
struct GatewayState {
  ConnectionState connection;
  RadioState radio;
  PacketCounts packets;
  HeldSettings settings;
  NoiseState noise;
  device::TimerSet<GatewayTimer, kGatewayTimerCount> timers;
};

/** Why a heard packet did not reach the hub; each has its own log code (gateway_log). */
enum class ForwardLoss : std::uint8_t {
  /** No connection, or not yet welcomed. */
  not_connected = 1,
  /** The forwarded packet could not be sealed (a resume point not written, design section 4). */
  seal_failed = 2,
  /** The link's send queue was full. */
  link_busy = 3,
  /** The link was down, or refused the packet for another reason. */
  link_down = 4,
};

/** What became of one packet to the hub (gateway_role.hpp, seal_and_send). */
enum class SendOutcome : std::uint8_t {
  /** The link took it. */
  sent,
  /** There is no link of that kind on this board. */
  not_connected,
  /** It could not be sealed: no counter, or its resume point not written (design section 4). */
  seal_failed,
  /** The link's send queue was full. */
  link_busy,
  /** The link was down, or refused it for another reason. */
  link_down,
};

/** A SendOutcome and the service status or HAL error behind it, for the caller's log entry. */
struct SendResult {
  SendOutcome outcome = SendOutcome::sent;
  std::int32_t detail = 0;
};

/** Number of transmit result codes this version lists (protocol section 6). */
constexpr std::size_t kTransmitOutcomeCount = protocol::TransmitOutcome::known.size();

/**
 * What the gateway carried since it started: plain RAM, kept beside the state rather than in it,
 * for tests and diagnostics. Nothing on the wire carries these totals.
 */
struct CarriedCounts {
  /** Packets heard with a good CRC and at least 18 bytes. */
  std::uint32_t heard = 0;
  /** Of those, the ones whose forwarded packet the link took. */
  std::uint32_t forwarded = 0;
  /** Of those, the ones lost, each logged with its ForwardLoss. */
  std::uint32_t forwards_lost = 0;
  /** Transmit requests opened, valid or not. */
  std::uint32_t requests = 0;
  /** Results the link took, by TransmitOutcome. */
  std::array<std::uint32_t, kTransmitOutcomeCount> results{};
  /** Results that could not be sent: their connection had ended. */
  std::uint32_t results_lost = 0;
  /** Requests answered "radio busy" because the queue was full. */
  std::uint32_t queue_full = 0;
  /** Requests answered "radio busy" because a siren command took their place. */
  std::uint32_t displaced = 0;
  /** The most requests the queue has held at once. */
  std::uint8_t queue_highest = 0;
};

/** Bumped whenever GatewayState changes. */
constexpr std::uint8_t kGatewayStateLayout = 2;

static_assert(std::is_trivially_copyable_v<GatewayState>, "the retained block is copied as bytes");

/**
 * The gateway (design section 7): it carries packets between the radio and the hub and never
 * answers a device itself (GW3, D71). It forwards every packet it hears on the site channel,
 * sends the hub's packets on 869.525 MHz when the hub asks, reports its status, watches the noise
 * for interference, and keeps one connection to the hub on USB or Wi-Fi. It never sleeps.
 */
class GatewayRole final : public device::Role {
public:
  GatewayRole(device::Services& services, device::GatewayIo& io);

  std::uint8_t role_id() const override;
  void handle(const device::Event& event) override;
  device::Wake next_wake() const override;
  protocol::MutableByteView state_bytes() override;
  std::uint8_t state_layout() const override;
  std::uint8_t state_id() const override;
  device::Duration longest_awake() const override;
  void report_again(device::Instant now) override;

  /**
   * Returns the state, for tests and diagnostics.
   */
  const GatewayState& state() const {
    return state_;
  }

  /**
   * Returns what the gateway carried since it started, for tests and diagnostics.
   */
  const CarriedCounts& counts() const {
    return counts_;
  }

  /**
   * Returns the transmit queue, for tests and diagnostics.
   */
  const TransmitQueue& queue() const {
    return queue_;
  }

private:
  // gateway_role.cpp: start-up and timers.
  void boot(device::Instant now);
  void run_timers(device::Instant now);

  // connection.cpp: USB or Wi-Fi, hello and welcome, back-off.
  device::Link* link(device::LinkKind kind) const;
  void start_connection(device::Instant now);
  void start_usb_attempt(device::Instant now);
  void start_network_attempt(device::Instant now);
  void start_usb_probe(device::Instant now);
  void send_usb_hello(device::SessionState& session, device::Instant now);
  void send_hello(device::LinkKind kind, device::SessionState& session, device::Instant now);
  void usb_window_closed(device::Instant now);
  void connection_failed(device::Instant now, std::uint16_t code, std::int32_t value);
  void end_connection(device::Instant now);
  void welcomed(device::Instant now);
  void on_link(const device::LinkEvent& event, device::Instant now);
  void on_hub_packet(const device::LinkEvent& event, device::Instant now);
  void on_message(const protocol::OpenedPacket& opened, device::Instant now);
  bool session_open() const;

  /**
   * The one way a packet goes to the hub: seals `message` under `binding` and sends it on the
   * link of `kind`. Logs nothing; each caller logs and counts as it needs.
   */
  template <typename Message>
  SendResult seal_and_send(const Message& message, const protocol::Binding& binding,
                           device::LinkKind kind);

  /**
   * Sends a message bound to the session on the connection's link; false, with a log entry for
   * a failure, when it did not go. Silent when there is no session: the callers check first.
   */
  template <typename Message>
  bool send_to_hub(const Message& message, device::Instant now);

  // radio.cpp: listening, forwarding, guards, noise.
  void listen(device::Instant now);
  void on_radio(const device::RadioEvent& event, device::Instant now);
  void reception_ended(device::Instant now);
  void forward(const device::RadioEvent& event, device::Instant now);
  void forward_lost(device::Instant now, ForwardLoss cause, std::int32_t detail);
  void recover_radio(device::Instant now, std::uint16_t code, std::int32_t value);
  void radio_guard_passed(device::Instant now);
  void sample_noise(device::Instant now);

  // transmit.cpp: transmit requests and their results.
  void on_transmit_request(const protocol::TransmitRequest& request, std::uint32_t counter,
                           device::Instant now);
  void serve_queue(device::Instant now);
  bool start_transmission(std::size_t index, device::Instant now);
  void transmission_done(device::Instant now, std::uint8_t outcome);
  void answer(std::uint32_t counter, std::uint8_t outcome, device::Instant sent_at,
              device::Instant now);
  void drop_requests(device::Instant now);

  // reports.cpp: settings, status, Started, interference, logs.
  void apply_settings(const protocol::GatewaySettings& settings, device::Instant now);
  void send_status(device::Instant now);
  void send_started(device::Instant now);
  void send_interference(const InterferenceReport& report, device::Instant now);
  void flush_log(device::Instant now);

  device::Services& services_;
  device::GatewayIo& io_;
  GatewayState state_;
  TransmitQueue queue_;
  CarriedCounts counts_;
  device::Record<HeldSettings> stored_settings_;
  /** Room for one sealed packet to the hub. */
  std::array<std::uint8_t, protocol::kMaxLinkPacketSize> out_{};
};

static_assert(device::is_complete_role<GatewayRole>, "a role must override every Role method");
static_assert(sizeof(GatewayState) <= device::kMaxRoleStateSize, "fits the retained block");

template <typename Message>
SendResult GatewayRole::seal_and_send(const Message& message, const protocol::Binding& binding,
                                      device::LinkKind kind) {
  device::Link* target = link(kind);
  if (target == nullptr) {
    return SendResult{SendOutcome::not_connected,
                      static_cast<std::int32_t>(device::HalError::unsupported)};
  }
  const auto sealed = services_.channel.seal(message, binding, protocol::PacketLimit::link,
                                             protocol::MutableByteView(out_));
  if (!sealed.ok()) {
    return SendResult{SendOutcome::seal_failed, static_cast<std::int32_t>(sealed.status())};
  }
  const device::HalError error = target->send(protocol::ByteView(out_).first(sealed.value().size));
  if (error == device::HalError::none) {
    return SendResult{};
  }
  return SendResult{
      error == device::HalError::busy ? SendOutcome::link_busy : SendOutcome::link_down,
      static_cast<std::int32_t>(error)};
}

template <typename Message>
bool GatewayRole::send_to_hub(const Message& message, device::Instant now) {
  if (!session_open()) {
    return false;
  }
  const SendResult result =
      seal_and_send(message, state_.connection.session.binding(), state_.connection.link);
  if (result.outcome == SendOutcome::seal_failed) {
    services_.log.add(now, device::LogLevel::error, gateway_log::seal_failed, "seal failed",
                      result.detail);
  } else if (result.outcome != SendOutcome::sent) {
    services_.log.add(now, device::LogLevel::warning, gateway_log::link_send_failed, "send failed",
                      Message::type);
  }
  return result.outcome == SendOutcome::sent;
}

}  // namespace hsn::roles::gateway
