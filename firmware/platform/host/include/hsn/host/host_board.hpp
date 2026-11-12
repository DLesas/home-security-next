#pragma once

#include <cstdint>

#include "hsn/device/device.hpp"
#include "hsn/device/events.hpp"
#include "hsn/device/hal/build_info.hpp"
#include "hsn/device/runner.hpp"
#include "hsn/device/services.hpp"
#include "hsn/host/call_meter.hpp"
#include "hsn/host/fake_clock.hpp"
#include "hsn/host/fake_io.hpp"
#include "hsn/host/fake_link.hpp"
#include "hsn/host/fake_radio.hpp"
#include "hsn/host/fake_random.hpp"
#include "hsn/host/fake_retained.hpp"
#include "hsn/host/fake_storage.hpp"
#include "hsn/host/fake_waiter.hpp"
#include "hsn/host/fake_watchdog.hpp"
#include "hsn/protocol/cipher.hpp"
#include "hsn/psa/psa_packet_cipher.hpp"

namespace hsn::host {

/**
 * One simulated board's hardware: everything that outlives a reset. The device objects
 * (Services, the role, Device, Runner) are built on top of it by HostInstance and rebuilt on
 * every simulated deep-sleep wake or reset, while the board's flash and retained memory stay.
 * Step B's Simulation holds one board per device.
 */
class HostBoard {
public:
  explicit HostBoard(std::uint64_t seed = 1);
  HostBoard(const HostBoard&) = delete;
  HostBoard& operator=(const HostBoard&) = delete;

  /** The hardware as the core sees it; change hal().build before building an instance. */
  device::Hal& hal() {
    return hal_;
  }

  /** Imports the device key into the cipher, as the platform does at start-up. */
  void set_key(const protocol::DeviceKey& key);

  /** A boot event at the current time. */
  device::Event boot_event(device::BootKind kind,
                           device::WakeMask woke_by = device::WakeMask()) const;

  /** A power loss: retained memory is garbage, the watchdog record starts again. */
  void power_loss(std::uint32_t seed = 0x9E3779B9u);

  /** Counts every call the device makes to this board's hardware (not the clock or watchdog). */
  CallMeter calls;
  FakeClock clock;
  FakeStorage storage;
  FakeRetainedMemory retained;
  FakeRadio radio;
  FakeRandom random;
  FakePower power;
  FakeLink usb;
  FakeLink network;
  FakeWatchdog watchdog;
  FakeWaiter waiter;
  FakeSensorIo sensor_io;
  FakeSirenIo siren_io;
  FakeGatewayIo gateway_io;
  psa::PsaPacketCipher cipher;

private:
  device::Hal hal_;
};

/**
 * The device objects of one boot, built in place on a board. `R` is a role built from
 * (Services&, Args...). Destroy and rebuild it to simulate a reset.
 */
template <typename R>
class HostInstance {
public:
  template <typename... Args>
  explicit HostInstance(HostBoard& board, Args&... args)
      : services(board.hal()),
        role(services, args...),
        device(services, &role),
        runner(device, board.watchdog) {}

  device::Services services;
  R role;
  device::Device device;
  device::Runner runner;
};

}  // namespace hsn::host
