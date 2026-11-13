#pragma once

// Helpers for the device-layer tests: a small test role, pairing a fake board, and the hub's side
// of the packet rules.

#include <doctest/doctest.h>

#include <cstdint>
#include <functional>
#include <vector>

#include "hsn/device/events.hpp"
#include "hsn/device/role.hpp"
#include "hsn/device/services.hpp"
#include "hsn/host/host_board.hpp"
// Every test file that checks instants or durations must see their stream operators, or doctest's
// printer for them differs between files and the linker may keep the one that prints "{?}".
#include "hsn/host/sim_time.hpp"
#include "hsn/protocol/binding.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/packet.hpp"
#include "hsn/psa/psa_packet_cipher.hpp"

namespace hsn::test {

using Bytes = std::vector<std::uint8_t>;
using device::Instant;

constexpr protocol::DeviceKey kKey{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15};
constexpr std::uint32_t kAddress = 0x1A2B3C4D;

inline Instant at_seconds(std::int64_t s) {
  return Instant{} + device::seconds(s);
}

/** The state a TestRole keeps in the retained block. */
struct TestState {
  std::uint32_t events = 0;
  std::uint8_t state_id = 3;
  std::uint8_t reserved[3] = {};
};

/**
 * A role for testing Device and Runner: it counts events in its retained state, records every
 * event it sees, and returns whatever Wake the test sets.
 */
class TestRole final : public device::Role {
public:
  explicit TestRole(device::Services& services, std::uint8_t id = protocol::Role::sensor)
      : services_(services), id_(id) {}

  std::uint8_t role_id() const override {
    return id_;
  }
  void handle(const device::Event& event) override {
    state.events += 1;
    seen.push_back(event);
    if (on_event) {
      on_event(event);
    }
  }
  device::Wake next_wake() const override {
    return wake;
  }
  protocol::MutableByteView state_bytes() override {
    if (big_state) {
      return protocol::MutableByteView(big.data(), big.size());
    }
    return protocol::MutableByteView(reinterpret_cast<std::uint8_t*>(&state), sizeof(state));
  }
  std::uint8_t state_layout() const override {
    return layout;
  }
  std::uint8_t state_id() const override {
    return state.state_id;
  }
  device::Duration longest_awake() const override {
    return longest;
  }

  device::Services& services() {
    return services_;
  }

  TestState state;
  std::vector<device::Event> seen;
  device::Wake wake;
  device::Duration longest;
  std::uint8_t layout = 1;
  bool big_state = false;
  std::vector<std::uint8_t> big = std::vector<std::uint8_t>(2000);
  std::function<void(const device::Event&)> on_event;

private:
  device::Services& services_;
  std::uint8_t id_;
};

static_assert(device::is_complete_role<TestRole>, "a role must override every Role method");

/** Stores a role, a pairing and a fresh resume point, as Set role and Provision would. */
void pair_board(host::HostBoard& board, std::uint8_t role, std::uint32_t address = kAddress);

/**
 * Seals raw plaintext (type byte, then body) from the hub to a device: for bodies no encoder
 * writes, such as one shorter than its type's fields.
 */
Bytes hub_packet_plaintext(const Bytes& plaintext, std::uint32_t counter,
                           const protocol::Binding& binding, std::uint32_t address = kAddress,
                           protocol::PacketLimit limit = protocol::PacketLimit::radio);

/** Seals a packet from the hub to a device. */
template <typename Message>
Bytes hub_packet(const Message& message, std::uint32_t counter, const protocol::Binding& binding,
                 std::uint32_t address = kAddress,
                 protocol::PacketLimit limit = protocol::PacketLimit::radio) {
  Bytes plaintext(protocol::kMaxLinkPacketSize);
  const auto size = protocol::encode_plaintext(
      message, protocol::MutableByteView(plaintext.data(), plaintext.size()));
  REQUIRE(size.ok());
  plaintext.resize(size.value());
  return hub_packet_plaintext(plaintext, counter, binding, address, limit);
}

/** What the hub reads from a device packet. */
struct HubOpened {
  protocol::Error error = protocol::Error::none;
  protocol::PacketHeader header;
  std::uint8_t type = 0;
  Bytes body;
};

/** Opens a device packet as the hub would. */
HubOpened hub_open(protocol::ByteView packet, const protocol::Binding& binding,
                   protocol::PacketLimit limit = protocol::PacketLimit::link);

inline protocol::ByteView view_of(const Bytes& bytes) {
  return protocol::ByteView(bytes.data(), bytes.size());
}

}  // namespace hsn::test
