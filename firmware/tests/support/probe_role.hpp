#pragma once

// A test-only role for the Simulation's own tests: it wakes periodically, from deep or light
// sleep, optionally sends a heartbeat each time, counts its wakes in retained memory and its
// events in RAM, and can be told to make too many hardware calls.

#include <array>
#include <cstdint>
#include <vector>

#include "hsn/device/events.hpp"
#include "hsn/device/hal/sensor_io.hpp"
#include "hsn/device/role.hpp"
#include "hsn/device/services.hpp"
#include "hsn/device/services/record.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/bytes.hpp"

namespace hsn::test {

/** How a ProbeRole behaves. */
struct ProbeConfig {
  /** Time between periodic wakes, on the board's own clock. */
  device::Duration period = device::seconds(180);
  /** Sleep deep between wakes (a reset each time), or light. */
  bool deep = true;
  /** Send a heartbeat-sized packet on the site channel at DR5 on every wake. */
  bool transmit = false;
  /** Extra door_open() reads in every handle(), to break the hardware-call budget. */
  std::uint32_t extra_calls = 0;
  /** Inputs that end a deep sleep. */
  device::WakeMask deep_wake_inputs = device::WakeMask::of(device::Input::door);
  /** Leave the radio in continuous receive on the site channel at DR5 when it goes to sleep. */
  bool listen_before_sleep = false;
  /** Write the wake count to flash every this many wakes; 0 never. */
  std::uint32_t flash_every = 0;
};

/** What a ProbeRole saw, kept by the test across every boot. */
struct ProbeLog {
  struct Entry {
    /** The board's clock at the event. */
    device::Instant local;
    device::EventKind kind = device::EventKind::boot;
    device::BootInfo boot;
    device::InputEvent input;
    /** Wakes counted in retained memory, at this event. */
    std::uint32_t wakes = 0;
    /** Events seen in this boot's RAM, this one included. */
    std::uint32_t ram_events = 0;
  };
  std::vector<Entry> entries;
  /** Periodic wakes, as local instants. */
  std::vector<device::Instant> wakes;
};

/** The probe's retained state. */
struct ProbeState {
  device::Instant next;
  std::uint32_t wakes = 0;
  std::uint32_t spare = 0;
};

/** The probe's flash record. */
struct ProbeCount {
  std::uint32_t wakes = 0;
};

/** The test-only periodic role. */
class ProbeRole final : public device::Role {
public:
  ProbeRole(device::Services& services, device::SensorIo& io, const ProbeConfig& config,
            ProbeLog& log);

  std::uint8_t role_id() const override;
  void handle(const device::Event& event) override;
  device::Wake next_wake() const override;
  protocol::MutableByteView state_bytes() override;
  std::uint8_t state_layout() const override;
  std::uint8_t state_id() const override;
  device::Duration longest_awake() const override;

  /** Events this boot has seen: RAM, lost on every reset. */
  std::uint32_t ram_events() const {
    return ram_events_;
  }

  /** The wake count in retained memory. */
  std::uint32_t wakes() const {
    return state_.wakes;
  }

private:
  void wake(device::Instant now);
  void send(device::Instant now);

  device::Services& services_;
  device::SensorIo& io_;
  ProbeConfig config_;
  ProbeLog& log_;
  ProbeState state_;
  device::Record<ProbeCount> count_;
  std::uint32_t ram_events_ = 0;
  std::array<std::uint8_t, 64> packet_{};
};

static_assert(device::is_complete_role<ProbeRole>, "a role must override every Role method");

}  // namespace hsn::test
