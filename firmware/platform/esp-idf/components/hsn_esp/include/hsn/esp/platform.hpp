#pragma once

#include <cstdint>

#include "hsn/device/events.hpp"
#include "hsn/device/services.hpp"
#include "hsn/esp/basics.hpp"
#include "hsn/esp/clock.hpp"
#include "hsn/esp/event_queue.hpp"
#include "hsn/esp/firmware_slots.hpp"
#include "hsn/esp/indicators.hpp"
#include "hsn/esp/inputs.hpp"
#include "hsn/esp/network_link.hpp"
#include "hsn/esp/nvs_storage.hpp"
#include "hsn/esp/radio.hpp"
#include "hsn/esp/retained.hpp"
#include "hsn/esp/role_io.hpp"
#include "hsn/esp/usb_link.hpp"
#include "hsn/esp/waiter.hpp"
#include "hsn/esp/watchdog.hpp"
#include "hsn/psa/psa_packet_cipher.hpp"
#include "hsn/psa/psa_update_crypto.hpp"

namespace hsn::esp {

/**
 * Everything on the board, built once as a static in app_main: the hardware behind every core
 * interface, the role I/O, the waiter, and the Hal the core's Services are built on. Bluetooth is
 * owned by Bluetooth; DisplayLabel drives the e-paper on the shared SPI bus.
 *
 * Start-up, in order (app_main): start_early() (the clock, then the task watchdog, so a hang in
 * what follows resets the chip: design section 6, "It is started first in app_main"); then
 * start_storage(), which gives the stored role (D103); then start(role), which brings up the rest
 * for that role and imports the paired device key into the packet cipher and the update crypto
 * together (PsaKeyImport, as the platform must at start-up: key_import.hpp).
 */
class EspPlatform {
public:
  EspPlatform();
  EspPlatform(const EspPlatform&) = delete;
  EspPlatform& operator=(const EspPlatform&) = delete;

  void start_early();
  /** Starts NVS and returns the stored role, or 0 (none, or unreadable). */
  std::uint8_t start_storage();
  /** Starts the rest for `role`; false when something the board needs did not start. */
  bool start(std::uint8_t role);

  device::Hal& hal() {
    return hal_;
  }
  device::Event boot_event() const;
  /** Prints what this boot is to the console: the first thing to read on the bench. */
  void log_boot(std::uint8_t role, const device::Event& boot) const;

  EspClock& clock() {
    return clock_;
  }
  EspWatchdog& watchdog() {
    return watchdog_;
  }
  EspWaiter& waiter() {
    return waiter_;
  }
  EspSensorIo& sensor_io() {
    return sensor_io_;
  }
  EspSirenIo& siren_io() {
    return siren_io_;
  }
  EspGatewayIo& gateway_io() {
    return gateway_io_;
  }

private:
  EspClock clock_;
  EventQueue queue_;
  EspWatchdog watchdog_;
  NvsStorage storage_;
  EspRetainedMemory retained_;
  EspRandom random_;
  EspPower power_;
  EspFirmwareSlots slots_;
  psa::PsaPacketCipher cipher_;
  psa::PsaUpdateCrypto update_crypto_;
  psa::PsaKeyImport key_import_;
  EspRadio radio_;
  Inputs inputs_;
  Indicators indicators_;
  Analog analog_;
  UsbLink usb_;
  NetworkLink network_;
  EspSensorIo sensor_io_;
  EspSirenIo siren_io_;
  EspGatewayIo gateway_io_;
  device::BuildInfo build_;
  Bluetooth bluetooth_;
  DisplayLabel display_;
  EspWaiter waiter_;
  device::Hal hal_;
  bool radio_ready_ = false;
  bool key_loaded_ = false;
};

}  // namespace hsn::esp
