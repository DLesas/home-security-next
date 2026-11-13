#pragma once

// A test-only transmitter for the sensor's radio-trouble tests: from a given instant it sends
// given packets straight through the radio, with no channel check and no budget, once or back to
// back until a stop instant. As a jammer it keeps the site channel busy; as a replayer it puts a
// recorded hub packet on 869.525 MHz.

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "hsn/device/events.hpp"
#include "hsn/device/role.hpp"
#include "hsn/device/services.hpp"
#include "hsn/device/time.hpp"
#include "hsn/host/provisioning.hpp"
#include "hsn/host/simulation.hpp"
#include "hsn/protocol/bytes.hpp"

namespace hsn::test::sensor {

/** What a TestTransmitter sends, and when. */
struct TransmitterConfig {
  device::RadioChannel channel;
  std::int8_t power_dbm = 14;
  /** Sent in turn. */
  std::vector<std::vector<std::uint8_t>> packets;
  /**
   * When to start, and (back to back) when to stop: true times when given to add_transmitter,
   * which turns them into the board's clock, which starts at zero when the board powers on.
   */
  device::Instant start;
  device::Instant stop;
  /** Back to back until `stop`, or each packet once. */
  bool repeat = false;
};

/** The transmitter role; paired as a sensor so Device runs it. */
class TestTransmitter final : public device::Role {
public:
  TestTransmitter(device::Services& services, const TransmitterConfig& config);

  std::uint8_t role_id() const override;
  void handle(const device::Event& event) override;
  device::Wake next_wake() const override;
  protocol::MutableByteView state_bytes() override;
  std::uint8_t state_layout() const override;
  std::uint8_t state_id() const override;
  device::Duration longest_awake() const override;

private:
  void send_next(device::Instant now);

  device::Services& services_;
  TransmitterConfig config_;
  std::size_t next_ = 0;
  bool sending_ = false;
  bool done_ = false;
  std::array<std::uint8_t, 4> state_{};
};

static_assert(device::is_complete_role<TestTransmitter>, "a role must override every Role method");

/**
 * Adds a transmitter to a simulation, powered on now and paired as a sensor of its own address.
 */
host::SimDevice& add_transmitter(host::Simulation& sim, const std::string& name,
                                 const TransmitterConfig& config, std::uint32_t address);

}  // namespace hsn::test::sensor
