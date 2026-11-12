#include "hsn/host/host_board.hpp"

namespace hsn::host {

HostBoard::HostBoard(std::uint64_t seed)
    : storage(clock),
      radio(clock),
      random(seed),
      usb(clock, device::LinkKind::usb),
      network(clock, device::LinkKind::network),
      watchdog(clock),
      waiter(clock),
      sensor_io(clock),
      siren_io(clock),
      gateway_io(clock),
      hal_{storage, retained, radio, random, power, &usb, &network, cipher, device::BuildInfo{}} {
  hal_.build.version = protocol::FirmwareVersion{0, 1, 0};
  hal_.build.development = true;
  hal_.build.chip_id = {0x10, 0x20, 0x30, 0x40, 0x50, 0x60};
  storage.set_meter(&calls);
  retained.set_meter(&calls);
  radio.set_meter(&calls);
  random.set_meter(&calls);
  power.set_meter(&calls);
  usb.set_meter(&calls);
  network.set_meter(&calls);
  sensor_io.set_meter(&calls);
  siren_io.set_meter(&calls);
  gateway_io.set_meter(&calls);
}

void HostBoard::set_key(const protocol::DeviceKey& key) {
  static_cast<void>(cipher.set_key(key));
}

device::Event HostBoard::boot_event(device::BootKind kind, device::WakeMask woke_by) const {
  device::BootInfo info;
  info.kind = kind;
  info.woke_by = woke_by;
  info.reset_cause = kind == device::BootKind::deep_sleep_wake ? 8 : 1;
  return device::Event::booted(clock.now(), info);
}

void HostBoard::power_loss(std::uint32_t seed) {
  retained.lose(seed);
  watchdog.reset();
}

}  // namespace hsn::host
