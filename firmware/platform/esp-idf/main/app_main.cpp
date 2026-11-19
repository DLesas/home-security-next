// The firmware's entry point on the ESP32-S3 (firmware-design.md section 2, "The loop"). One image
// holds all three roles; the role stored in flash (D103) chooses which one is built. Function-local
// statics mean the other two are never constructed, and nothing here is ever destroyed.

#include <cstdint>

#include "hsn/device/device.hpp"
#include "hsn/device/runner.hpp"
#include "hsn/device/services.hpp"
#include "hsn/esp/platform.hpp"
#include "hsn/roles/gateway/gateway_role.hpp"
#include "hsn/roles/sensor/sensor_role.hpp"
#include "hsn/roles/siren/siren_role.hpp"

namespace {

/** Role numbers (protocol section 10; role.hpp). */
constexpr std::uint8_t kSensor = 1;
constexpr std::uint8_t kSiren = 2;
constexpr std::uint8_t kGateway = 3;

/**
 * Runs the core for ever. The wait is the only blocking call; a deep sleep or a restart inside it
 * ends the program (the chip resets), so this loop sleeps deeply at most once per boot.
 */
[[noreturn]] void run(hsn::esp::EspPlatform& platform, hsn::device::Services& services,
                      hsn::device::Role* role, std::uint8_t role_id) {
  static hsn::device::Device device(services, role);
  static hsn::device::Runner runner(device, platform.watchdog());
  platform.waiter().attach_log(&services.log);
  const hsn::device::Event boot = platform.boot_event();
  platform.log_boot(role_id, boot);
  runner.start(boot);
  for (;;) {
    const hsn::device::WaitResult result =
        platform.waiter().wait(runner.plan(platform.clock().now()));
    if (result.has_event) {
      runner.deliver(result.event);
    } else {
      runner.timed_out(platform.clock().now());
    }
  }
}

}  // namespace

extern "C" void app_main(void) {
  static hsn::esp::EspPlatform platform;
  platform.start_early();
  const std::uint8_t role = platform.start_storage();
  static_cast<void>(platform.start(role));
  static hsn::device::Services services(platform.hal());
  // Bluetooth (pairing, updates) and the e-paper display join here when they exist: F1's
  // bluetooth/ component already gives Hal::bluetooth (null today), and the display takes the
  // pins board.hpp names. Nothing else in this file changes for them.
  switch (role) {
    case kSensor: {
      static hsn::roles::sensor::SensorRole sensor(services, platform.sensor_io());
      run(platform, services, &sensor, role);
    }
    case kSiren: {
      static hsn::roles::siren::SirenRole siren(services, platform.siren_io());
      run(platform, services, &siren, role);
    }
    case kGateway: {
      static hsn::roles::gateway::GatewayRole gateway(services, platform.gateway_io());
      run(platform, services, &gateway, role);
    }
    default:
      // No role stored: setup-only mode, which answers USB setup messages (Set role first).
      run(platform, services, nullptr, role);
  }
}
