// The connection to the hub (protocol sections 4, 7 and 10; D81, D97): USB while a computer is
// attached and answers, otherwise Wi-Fi with USB tried again every 30 seconds; a hello with a
// fresh random value, the welcome opened under its binding, then everything bound to the session;
// a failed connection retried on the back-off schedule.

#include <limits>

#include "hsn/device/services/retry.hpp"
#include "hsn/roles/gateway/gateway_role.hpp"

namespace hsn::roles::gateway {
namespace {

/** Packs a service's status and the codec's detail into one log value. */
std::int32_t refusal_value(device::Status status, protocol::Error detail) {
  constexpr unsigned kStatusShift = 8;
  return static_cast<std::int32_t>((static_cast<unsigned>(status) << kStatusShift) |
                                   static_cast<unsigned>(detail));
}

}  // namespace

device::Link* GatewayRole::link(device::LinkKind kind) const {
  return kind == device::LinkKind::usb ? services_.hal.usb : services_.hal.network;
}

bool GatewayRole::session_open() const {
  return state_.connection.phase == ConnectionPhase::connected &&
         state_.connection.session.welcomed;
}

void GatewayRole::start_connection(device::Instant now) {
  // USB first while a computer is attached, unless a USB attempt failed less than 30 s ago
  // (protocol section 10): then Wi-Fi, and USB again when its retry comes.
  if (link(device::LinkKind::usb) != nullptr && !state_.timers.armed(GatewayTimer::usb_retry) &&
      io_.usb_host()) {
    start_usb_attempt(now);
    return;
  }
  start_network_attempt(now);
}

void GatewayRole::start_usb_attempt(device::Instant now) {
  ConnectionState& connection = state_.connection;
  connection.phase = ConnectionPhase::awaiting_welcome;
  connection.link = device::LinkKind::usb;
  connection.probing = false;
  device::Link* usb = link(device::LinkKind::usb);
  if (!usb->up()) {
    const device::HalError error = usb->connect(services_.setup.pairing().link_target());
    if (error != device::HalError::none) {
      // A serial port carries hellos without being "up"; note it and go on.
      services_.log.add(now, device::LogLevel::warning, gateway_log::connect_failed, "usb connect",
                        static_cast<std::int32_t>(error));
    }
  }
  state_.timers.arm(GatewayTimer::usb_window, now + kUsbWelcomeWindow);
  state_.timers.arm(GatewayTimer::usb_retry, now + kUsbRetryInterval);
  send_usb_hello(connection.session, now);
}

void GatewayRole::start_network_attempt(device::Instant now) {
  ConnectionState& connection = state_.connection;
  connection.link = device::LinkKind::network;
  connection.phase = ConnectionPhase::connecting;
  connection.session = device::SessionState{};
  if (link(device::LinkKind::usb) != nullptr && !state_.timers.armed(GatewayTimer::usb_retry)) {
    // Keep looking for a computer on USB while on Wi-Fi (protocol section 10).
    state_.timers.arm(GatewayTimer::usb_retry, now + kUsbRetryInterval);
  }
  device::Link* network = link(device::LinkKind::network);
  if (network == nullptr) {
    connection_failed(now, gateway_log::connect_failed, 0);
    return;
  }
  const device::HalError error = network->connect(services_.setup.pairing().link_target());
  if (error != device::HalError::none) {
    connection_failed(now, gateway_log::connect_failed, static_cast<std::int32_t>(error));
  }
}

void GatewayRole::start_usb_probe(device::Instant now) {
  ConnectionState& connection = state_.connection;
  if (connection.link == device::LinkKind::usb && connection.phase != ConnectionPhase::idle) {
    return;
  }
  state_.timers.arm(GatewayTimer::usb_retry, now + kUsbRetryInterval);
  device::Link* usb = link(device::LinkKind::usb);
  if (usb == nullptr || connection.probing || !io_.usb_host()) {
    return;
  }
  connection.probing = true;
  if (!usb->up()) {
    const device::HalError error = usb->connect(services_.setup.pairing().link_target());
    if (error != device::HalError::none) {
      services_.log.add(now, device::LogLevel::warning, gateway_log::connect_failed, "usb connect",
                        static_cast<std::int32_t>(error));
    }
  }
  state_.timers.arm(GatewayTimer::usb_window, now + kUsbWelcomeWindow);
  send_usb_hello(connection.probe, now);
}

void GatewayRole::send_usb_hello(device::SessionState& session, device::Instant now) {
  send_hello(device::LinkKind::usb, session, now);
  // Every 2 s while the window is open (protocol section 10).
  const device::Instant next = now + kUsbHelloInterval;
  if (next < state_.timers.at(GatewayTimer::usb_window)) {
    state_.timers.arm(GatewayTimer::usb_hello, next);
  }
}

void GatewayRole::send_hello(device::LinkKind kind, device::SessionState& session,
                             device::Instant now) {
  // A fresh value straight from the hardware for every hello: each opens a new connection.
  protocol::RandomValue random{};
  services_.random.fill(protocol::MutableByteView(random));
  session.begin(random);
  protocol::Hello hello;
  hello.gateway_random = random;
  hello.firmware_version = services_.hal.build.version;
  hello.settings_version = state_.settings.version;
  const SendResult result = seal_and_send(hello, protocol::Binding::none(), kind);
  if (result.outcome == SendOutcome::seal_failed) {
    services_.log.add(now, device::LogLevel::error, gateway_log::seal_failed, "hello seal",
                      result.detail);
  } else if (result.outcome != SendOutcome::sent) {
    services_.log.add(now, device::LogLevel::warning, gateway_log::link_send_failed, "hello send",
                      result.detail);
  }
}

void GatewayRole::usb_window_closed(device::Instant now) {
  ConnectionState& connection = state_.connection;
  state_.timers.cancel(GatewayTimer::usb_hello);
  services_.log.add(now, device::LogLevel::info, gateway_log::usb_no_welcome, "no usb welcome");
  if (connection.probing) {
    connection.probing = false;
    connection.probe = device::SessionState{};
    return;
  }
  if (connection.link == device::LinkKind::usb &&
      connection.phase == ConnectionPhase::awaiting_welcome) {
    start_network_attempt(now);
  }
}

void GatewayRole::end_connection(device::Instant now) {
  ConnectionState& connection = state_.connection;
  drop_requests(now);
  connection.phase = ConnectionPhase::idle;
  connection.session = device::SessionState{};
  connection.probe = device::SessionState{};
  connection.probing = false;
  connection.settings_received = false;
  state_.timers.cancel(GatewayTimer::status);
  state_.timers.cancel(GatewayTimer::welcome_timeout);
  state_.timers.cancel(GatewayTimer::usb_hello);
  state_.timers.cancel(GatewayTimer::usb_window);
}

void GatewayRole::connection_failed(device::Instant now, std::uint16_t code, std::int32_t value) {
  services_.log.add(now, device::LogLevel::warning, code, "connection failed", value);
  end_connection(now);
  ConnectionState& connection = state_.connection;
  if (connection.failures < std::numeric_limits<std::uint8_t>::max()) {
    connection.failures += 1;
  }
  // 1, 2, 4, 8, 15, then every 30 s (protocol section 7), each gap counted from this failure.
  const auto next = device::RetrySchedule(device::kReconnect)
                        .after_failure(now, connection.failures, services_.random);
  state_.timers.arm(GatewayTimer::reconnect, next.value_or(now + kUsbRetryInterval));
}

void GatewayRole::welcomed(device::Instant now) {
  ConnectionState& connection = state_.connection;
  connection.phase = ConnectionPhase::connected;
  connection.failures = 0;
  connection.generation = static_cast<std::uint8_t>(connection.generation + 1u);
  connection.settings_received = false;
  state_.timers.cancel(GatewayTimer::welcome_timeout);
  state_.timers.cancel(GatewayTimer::usb_hello);
  state_.timers.cancel(GatewayTimer::usb_window);
  state_.timers.cancel(GatewayTimer::reconnect);
  if (connection.link == device::LinkKind::usb) {
    // Welcomed on USB: USB only (protocol section 10).
    state_.timers.cancel(GatewayTimer::usb_retry);
  }
  state_.timers.arm(GatewayTimer::status, now + status_interval(state_.settings));
}

void GatewayRole::on_link(const device::LinkEvent& event, device::Instant now) {
  ConnectionState& connection = state_.connection;
  switch (event.kind) {
    case device::LinkEventKind::up:
      if (event.link == device::LinkKind::network && connection.link == device::LinkKind::network &&
          connection.phase == ConnectionPhase::connecting) {
        connection.phase = ConnectionPhase::awaiting_welcome;
        state_.timers.arm(GatewayTimer::welcome_timeout, now + kWelcomeTimeout);
        send_hello(device::LinkKind::network, connection.session, now);
      }
      break;
    case device::LinkEventKind::down:
      // A USB port with no hub behind it goes down while hellos still go out on it; only the
      // connection's own link going down ends the connection.
      if (event.link == connection.link && connection.phase != ConnectionPhase::idle &&
          !(event.link == device::LinkKind::usb &&
            connection.phase == ConnectionPhase::awaiting_welcome)) {
        connection_failed(now, gateway_log::link_down, static_cast<std::int32_t>(event.link));
      }
      break;
    case device::LinkEventKind::packet:
      on_hub_packet(event, now);
      break;
  }
}

void GatewayRole::on_hub_packet(const device::LinkEvent& event, device::Instant now) {
  ConnectionState& connection = state_.connection;
  device::SessionState* session = nullptr;
  bool probe = false;
  if (event.link == connection.link && (connection.phase == ConnectionPhase::awaiting_welcome ||
                                        connection.phase == ConnectionPhase::connected)) {
    session = &connection.session;
  } else if (event.link == device::LinkKind::usb && connection.probing) {
    session = &connection.probe;
    probe = true;
  }
  if (session == nullptr) {
    services_.log.add(now, device::LogLevel::warning, gateway_log::hub_packet_refused,
                      "no connection", static_cast<std::int32_t>(event.link));
    return;
  }
  const bool was_welcomed = session->welcomed;
  const auto opened = services_.channel.open_session(event.packet, *session);
  if (!opened.ok()) {
    services_.log.add(now, device::LogLevel::warning, gateway_log::hub_packet_refused,
                      "hub packet refused", refusal_value(opened.status(), opened.detail()));
    return;
  }
  if (!was_welcomed) {
    if (probe) {
      // Welcomed on USB while on Wi-Fi: USB only from now on (protocol section 10).
      drop_requests(now);
      connection.session = connection.probe;
      connection.probe = device::SessionState{};
      connection.probing = false;
      connection.link = device::LinkKind::usb;
      if (link(device::LinkKind::network) != nullptr) {
        link(device::LinkKind::network)->disconnect();
      }
    }
    welcomed(now);
    return;
  }
  on_message(opened.value(), now);
}

void GatewayRole::on_message(const protocol::OpenedPacket& opened, device::Instant now) {
  switch (opened.type) {
    case protocol::message_type::gateway_settings: {
      protocol::GatewaySettings settings;
      const protocol::Error error = protocol::decode_body(opened.body, settings);
      if (error != protocol::Error::none) {
        services_.log.add(now, device::LogLevel::warning, gateway_log::unexpected_type,
                          "settings malformed", static_cast<std::int32_t>(error));
        return;
      }
      apply_settings(settings, now);
      return;
    }
    case protocol::message_type::transmit_request: {
      counts_.requests += 1;
      protocol::TransmitRequest request;
      const protocol::Error error = protocol::decode_body(opened.body, request);
      if (error != protocol::Error::none) {
        // Its packet is not 18 to 255 bytes, or the body is short (protocol section 6).
        services_.log.add(now, device::LogLevel::warning, gateway_log::request_malformed,
                          "request malformed", static_cast<std::int32_t>(error));
        answer(opened.header.counter, protocol::TransmitOutcome::not_valid, now, now);
        return;
      }
      on_transmit_request(request, opened.header.counter, now);
      return;
    }
    default:
      // A receiver drops and logs a type it does not know (protocol section 5); a known one meant
      // for someone else is dropped and logged too.
      services_.log.add(now, device::LogLevel::warning,
                        protocol::is_known_message_type(opened.type)
                            ? gateway_log::unexpected_type
                            : device::log_code::unknown_type,
                        "unexpected type", opened.type);
      return;
  }
}

}  // namespace hsn::roles::gateway
