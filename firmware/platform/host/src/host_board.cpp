#include "hsn/host/host_board.hpp"

#include <map>
#include <tuple>

#include "hsn/host/test_image.hpp"

namespace hsn::host {
namespace {

/** The image a board is made with, per version: made once, since each one is hashed. */
const Bytes& factory_image(const protocol::FirmwareVersion& version) {
  static std::map<std::tuple<std::uint8_t, std::uint8_t, std::uint8_t>, Bytes> images;
  const auto key = std::make_tuple(version.major, version.minor, version.patch);
  auto found = images.find(key);
  if (found == images.end()) {
    found = images.emplace(key, make_test_image(version, 2048)).first;
  }
  return found->second;
}

}  // namespace

HostBoard::HostBoard(std::uint64_t seed, std::size_t slot_size)
    : storage(clock),
      radio(clock),
      random(seed),
      slots(clock, slot_size, seed),
      update_crypto(key_import),
      key_import(cipher),
      usb(clock, device::LinkKind::usb),
      network(clock, device::LinkKind::network),
      bluetooth(clock, device::LinkKind::bluetooth),
      watchdog(clock),
      waiter(clock),
      sensor_io(clock),
      siren_io(clock),
      gateway_io(clock),
      hal_{storage,
           retained,
           radio,
           random,
           power,
           slots,
           update_crypto,
           key_import,
           &usb,
           &network,
           &bluetooth,
           cipher,
           device::BuildInfo{}} {
  hal_.build.version = protocol::FirmwareVersion{0, 1, 0};
  hal_.build.development = true;
  hal_.build.chip_id = {0x10, 0x20, 0x30, 0x40, 0x50, 0x60};
  // Made as the first serial flash leaves a board: its image in slot 0, otadata blank.
  slots.install(0, protocol::ByteView(factory_image(hal_.build.version).data(),
                                      factory_image(hal_.build.version).size()));
  static_cast<void>(slots.boot());
  slots.as_made = true;
  storage.set_meter(&calls);
  retained.set_meter(&calls);
  radio.set_meter(&calls);
  random.set_meter(&calls);
  power.set_meter(&calls);
  slots.set_meter(&calls);
  update_crypto.set_meter(&calls);
  key_import.set_meter(&calls);
  usb.set_meter(&calls);
  network.set_meter(&calls);
  bluetooth.set_meter(&calls);
  sensor_io.set_meter(&calls);
  siren_io.set_meter(&calls);
  gateway_io.set_meter(&calls);
  storage.set_power(&power_cut);
  slots.flash.set_power(&power_cut);
  radio.set_power(&power_cut);
  usb.set_power(&power_cut);
  network.set_power(&power_cut);
  bluetooth.set_power(&power_cut);
}

BootChoice HostBoard::run_bootloader() {
  const protocol::FirmwareVersion& version = hal_.build.version;
  if (slots.as_made) {
    const protocol::FirmwareVersion made = slots.check(0).version;
    if (made.major != version.major || made.minor != version.minor || made.patch != version.patch) {
      const Bytes& image = factory_image(version);
      slots.install(0, protocol::ByteView(image.data(), image.size()));
      slots.as_made = true;
    }
  }
  const BootChoice choice = slots.boot();
  if (choice.bootable) {
    hal_.build.version = choice.image.version;
  }
  return choice;
}

void HostBoard::set_key(const protocol::DeviceKey& key) {
  static_cast<void>(key_import.load(key));
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
