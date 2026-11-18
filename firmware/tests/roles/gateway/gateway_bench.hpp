#pragma once

// Helpers for the gateway role's scenario tests: the real role on the bench, with the test hub in
// gateway link mode or with LinkHub, a hub end written here that sends whatever a test asks for
// (a wrong welcome, a replay, a request at a chosen moment) and keeps everything the gateway
// sent, opened. Requirement and decision numbers in test names refer to software.md and
// architecture.md; "§" to protocol.md.

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "device_support.hpp"
#include "hsn/host/link_wire.hpp"
#include "hsn/host/provisioning.hpp"
#include "hsn/protocol/binding.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/packet.hpp"
#include "hsn/psa/psa_packet_cipher.hpp"
#include "hsn/roles/gateway/gateway_role.hpp"
#include "sim_support.hpp"

namespace hsn::test {

using roles::gateway::GatewayRole;
namespace type = protocol::message_type;

/** The real gateway role on the board's gateway I/O. */
inline host::RoleFactory gateway_role() {
  return host::make_role<GatewayRole>(&host::HostBoard::gateway_io);
}

/** Adds a gateway running the real role, paired with the site's hub. */
host::SimDevice& add_gateway(Site& site, const std::string& name,
                             const host::GatewayConfig& config = {}, std::int32_t drift_ppm = 0);

/** The running gateway role of a device. */
inline GatewayRole& gateway_of(host::SimDevice& device) {
  return device.role<GatewayRole>();
}

/** Accepted packets the hub had from a device, decoded as M. */
template <typename M>
std::vector<M> hub_got(const host::TestHub& hub, const std::string& from) {
  std::vector<M> found;
  for (const host::HubPacket& packet : hub.received_from(from, M::type)) {
    found.push_back(packet.as<M>());
  }
  return found;
}

/** A forwarded packet as the hub got it, with its own copy of the packet carried. */
struct Forwarded {
  device::Instant at;
  /** Every field but the packet, whose view is cleared. */
  protocol::ForwardedPacket meta;
  Bytes packet;
};

/** Decodes a forwarded packet body. */
Forwarded decode_forwarded(device::Instant at, const Bytes& body);

/** The forwarded packets the test hub accepted from a gateway, in order. */
std::vector<Forwarded> forwarded_by(const host::TestHub& hub, const std::string& gateway);

/** The counter in a radio packet's clear part. */
std::uint32_t counter_in(const Bytes& packet);

/** Hub decisions of one kind about one device, as their values. */
std::vector<std::int64_t> decision_values(const host::TestHub& hub, host::HubAction action,
                                          const std::string& device);

/** The packets a board's radio was asked to send, in order. */
std::vector<Bytes> transmitted(host::SimDevice& device);

/** A radio packet of `size` bytes from the hub to `address` with `counter`: opaque to a gateway. */
Bytes opaque_packet(std::uint32_t address, std::uint32_t counter, std::size_t size = 21);

/** One packet a Talker puts on the air at an instant of its own clock. */
struct Burst {
  device::Instant at;
  Bytes packet;
  std::uint8_t data_rate = 5;
  std::uint32_t frequency_hz = 868300000;
  std::int8_t power_dbm = 14;
};

/**
 * A test-only radio that sends given bytes at given times, without listening first: short
 * packets, colliding packets and packets nobody holds the key of, which no real device sends.
 */
class Talker final : public device::Role {
public:
  Talker(device::Services& services, std::vector<Burst> bursts)
      : services_(services), bursts_(std::move(bursts)) {}

  std::uint8_t role_id() const override {
    return protocol::Role::sensor;
  }
  void handle(const device::Event& event) override;
  device::Wake next_wake() const override;
  protocol::MutableByteView state_bytes() override {
    return protocol::MutableByteView(state_);
  }
  std::uint8_t state_layout() const override {
    return 1;
  }
  std::uint8_t state_id() const override {
    return 0;
  }
  device::Duration longest_awake() const override {
    return device::Duration{};
  }
  void report_again(device::Instant) override {}

private:
  device::Services& services_;
  std::vector<Burst> bursts_;
  std::size_t next_ = 0;
  std::array<std::uint8_t, 4> state_{};
};

static_assert(device::is_complete_role<Talker>, "a role must override every Role method");

/** Adds a Talker, paired as a sensor so that its role runs. */
host::SimDevice& add_talker(host::Simulation& sim, const std::string& name,
                            std::vector<Burst> bursts);

/** A gateway pairing for boards driven by LinkHub. */
host::Provisioning gateway_pairing(std::uint32_t address = 0x6A7E0001);

/** A sensor pairing on the same site. */
host::Provisioning sensor_on_site(std::uint32_t address);

/**
 * The hub end of one gateway's link, scripted by the test: by default it welcomes every hello and
 * sends its settings, like the hub; a test can hold the welcome, send one bound to anything,
 * replay recorded packets, and send transmit requests with any fields. Everything the gateway
 * sends is kept, opened under the session it was sent in.
 */
class LinkHub final : public host::LinkPeer {
public:
  /** One packet from the gateway. */
  struct Got {
    device::Instant at;
    device::LinkKind link = device::LinkKind::network;
    std::uint32_t counter = 0;
    /** 0 when it did not open under the current session or as a hello. */
    std::uint8_t type = 0;
    Bytes body;
    Bytes packet;
  };

  /** A hub end for a gateway paired as `pairing`. */
  LinkHub(host::Simulation& sim, host::SimDevice& gateway, const host::Provisioning& pairing);
  LinkHub(const LinkHub&) = delete;
  LinkHub& operator=(const LinkHub&) = delete;

  /** Attaches to one of the gateway's links; USB also tells the board a computer is there. */
  void attach(device::LinkKind kind, device::Duration latency = milliseconds(25));

  /** Welcome every hello and send the settings (true by default). */
  bool auto_welcome = true;

  /** The settings sent after a welcome. */
  protocol::GatewaySettings settings;

  /** Welcomes the latest hello, bound to `binding` (by default the hello's random value). */
  void welcome(const std::optional<protocol::Binding>& binding = std::nullopt);

  /** Seals a message from the hub with the next counter. */
  template <typename M>
  Bytes seal(const M& message, const protocol::Binding& binding);

  /** Sends a message bound to the current session, now. */
  template <typename M>
  Bytes send(const M& message) {
    Bytes packet = seal(message, session_binding());
    send_raw(packet);
    return packet;
  }

  /** Seals a plaintext (type byte, then body) as written, bound to the current session. */
  Bytes seal_plaintext(const Bytes& plaintext);

  /** Sends bytes as they are on the attached link. */
  void send_raw(const Bytes& packet);

  /** A transmit request for an opaque packet; times are on the gateway's clock. */
  protocol::TransmitRequest request(std::uint8_t when, std::uint32_t gateway_time,
                                    const Bytes& packet, std::uint8_t data_rate = 5,
                                    std::uint8_t priority = protocol::TransmitPriority::normal,
                                    std::int8_t power_dbm = 14) const;

  /** Sends a transmit request and returns its counter, which the result names. */
  std::uint32_t send_request(const protocol::TransmitRequest& request);

  /** The binding of the current session. */
  protocol::Binding session_binding() const {
    return protocol::Binding::session(gateway_random, hub_random);
  }

  /** Everything the gateway sent that opened, of one type. */
  std::vector<Got> got(std::uint8_t message_type) const;

  /** Every transmit result, decoded. */
  std::vector<protocol::TransmitResult> results() const;

  /** Every forwarded packet, decoded. */
  std::vector<Forwarded> forwarded() const;

  /** Every gateway status, decoded. */
  std::vector<protocol::GatewayStatus> statuses() const;

  /** Every interference message, decoded. */
  std::vector<protocol::Interference> interference() const;

  /** The codes of every log entry the gateway sent, in order. */
  std::vector<std::uint16_t> log_codes() const;

  /** The result for one request, if any came. */
  std::optional<protocol::TransmitResult> result_for(std::uint32_t counter) const;

  // LinkPeer
  void link_up(host::LinkWire& wire) override;
  void link_down(host::LinkWire& wire) override;
  void link_packet(host::LinkWire& wire, const Bytes& packet) override;

  std::vector<Got> received;
  /** Packets that opened neither as a hello nor under the session. */
  std::uint32_t unopened = 0;
  std::uint32_t hellos = 0;
  /** The provision results that reached the hub, in order (§10 setup messages). */
  std::vector<std::uint8_t> provision_results;
  std::uint32_t link_ups = 0;
  protocol::RandomValue gateway_random{};
  protocol::RandomValue hub_random{};
  /** The welcome last sent, for replaying. */
  Bytes last_welcome;
  std::uint32_t next_counter = 1;

private:
  Bytes seal_bytes(const Bytes& plaintext, const protocol::Binding& binding);

  host::Simulation& sim_;
  host::SimDevice& gateway_;
  std::uint32_t address_;
  psa::PsaPacketCipher cipher_;
  host::LinkWire* wire_ = nullptr;
  std::uint64_t hub_seed_ = 0x51ED;
};

template <typename M>
Bytes LinkHub::seal(const M& message, const protocol::Binding& binding) {
  Bytes plaintext(protocol::kMaxLinkPacketSize);
  const auto size = protocol::encode_plaintext(
      message, protocol::MutableByteView(plaintext.data(), plaintext.size()));
  REQUIRE(size.ok());
  plaintext.resize(size.value());
  return seal_bytes(plaintext, binding);
}

/** A scripted sensor paired by hand, with no hub to answer it. */
host::SimDevice& add_lone_sensor(host::Simulation& sim, const std::string& name,
                                 const ScriptSensorConfig& config, ScriptSensorLog& log,
                                 std::uint32_t address);

/** A gateway running the real role, paired by hand, with a LinkHub on its network link. */
struct LinkSite {
  explicit LinkSite(std::uint8_t listen_mask = 0x20, host::SimulationOptions options = {});

  host::Simulation sim;
  host::SimDevice& gateway;
  LinkHub hub;
};

}  // namespace hsn::test
