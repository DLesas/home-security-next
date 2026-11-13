#pragma once

// A scripted gateway for the test hub's tests in gateway link mode: it connects one link, sends a
// hello with a fresh random value, opens everything from the hub with the core's open_session,
// forwards every packet it receives on the site channel at one data rate, and carries out
// transmit requests on 869.525 MHz, at a time on its own clock or as soon as possible, never while
// it is receiving, answering each with a transmit result. It can log scripted entries and send
// them over its link as they arise, once welcomed. Not the gateway role: no airtime budget, no
// status, no noise, no reconnects, one data rate.

#include <array>
#include <cstdint>
#include <deque>
#include <vector>

#include "hsn/device/events.hpp"
#include "hsn/device/hal/gateway_io.hpp"
#include "hsn/device/role.hpp"
#include "hsn/device/services.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/messages.hpp"
#include "script_log.hpp"

namespace hsn::test {

/** How a ScriptGateway behaves. */
struct ScriptGatewayConfig {
  /** The data rate it listens at on the site channel. */
  std::uint8_t listen_data_rate = 5;
  /** Connect over USB instead of the network link. */
  bool use_usb = false;
  /**
   * How long after settings arrive it applies their channel and rate: zero, at once, as a
   * gateway does; longer for a gateway that is late to follow a move (protocol section 7).
   */
  device::Duration apply_settings_after;
  /** Entries it logs, in time order; each goes over its link as it arises, once welcomed. */
  std::vector<ScriptLogEntry> log_entries;
};

/** What a ScriptGateway did, kept by the test. */
struct ScriptGatewayLog {
  struct Result {
    std::uint32_t request = 0;
    std::uint8_t outcome = 0;
  };
  std::uint32_t hellos = 0;
  std::uint32_t welcomes = 0;
  std::uint32_t settings = 0;
  std::uint8_t settings_version = 0;
  std::uint32_t forwarded = 0;
  std::uint32_t requests = 0;
  /** Requests with siren-command priority. */
  std::uint32_t siren_requests = 0;
  /** Requests for a given time. */
  std::uint32_t timed_requests = 0;
  /** Hub packets open_session refused. */
  std::uint32_t rejected = 0;
  std::vector<Result> results;
  /** Log entries packets its link took. */
  std::uint32_t log_packets = 0;
};

/** The scripted gateway. */
class ScriptGateway final : public device::Role {
public:
  ScriptGateway(device::Services& services, device::GatewayIo& io,
                const ScriptGatewayConfig& config, ScriptGatewayLog& log);

  std::uint8_t role_id() const override;
  void handle(const device::Event& event) override;
  device::Wake next_wake() const override;
  protocol::MutableByteView state_bytes() override;
  std::uint8_t state_layout() const override;
  std::uint8_t state_id() const override;
  device::Duration longest_awake() const override;

private:
  /** A transmit request waiting for the radio. */
  struct Request {
    std::uint32_t counter = 0;
    std::uint8_t data_rate = 0;
    std::int8_t power_dbm = 0;
    bool siren_command = false;
    /** At this local instant (at a given time), or no later than it (as soon as possible). */
    device::Instant when = device::Instant::never();
    std::vector<std::uint8_t> packet;
  };

  device::Link* link() const;
  void send_to_hub(std::size_t size);
  void listen();
  void on_link(const device::LinkEvent& link, device::Instant now);
  void on_request(const protocol::TransmitRequest& request, std::uint32_t counter,
                  device::Instant now);
  void on_radio(const device::RadioEvent& radio, device::Instant now);
  void transmit(const Request& request, device::Instant now);
  void result(std::uint32_t counter, std::uint8_t outcome, device::Instant now);
  void serve_queue(device::Instant now);
  void send_logs(device::Instant now);
  void apply_settings();

  device::Services& services_;
  device::GatewayIo& io_;
  ScriptGatewayConfig config_;
  ScriptGatewayLog& log_;
  device::SessionState session_;
  std::uint8_t site_channel_ = 1;
  /** The one rate it listens at: its config's, until settings name one (protocol section 6). */
  std::uint8_t listen_rate_ = 5;
  /** Settings received and not yet applied, and when they will be. */
  protocol::GatewaySettings arrived_;
  device::Instant apply_at_ = device::Instant::never();
  bool transmitting_ = false;
  bool receiving_ = false;
  bool scheduled_ = false;
  Request at_time_;
  std::deque<Request> queue_;
  ScriptLogger logger_;
  std::array<std::uint8_t, protocol::kMaxLinkPacketSize> out_{};
  std::array<std::uint8_t, 4> state_{};
};

static_assert(device::is_complete_role<ScriptGateway>, "a role must override every Role method");

}  // namespace hsn::test
