#include "hsn/esp/basics.hpp"

#include <array>

#include "driver/gpio.h"
#include "esp_app_desc.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_sleep.h"
#include "esp_system.h"
#include "hsn/esp/board.hpp"
#include "hsn/esp/firmware_slots.hpp"
#include "sdkconfig.h"

namespace hsn::esp {

void EspRandom::fill(protocol::MutableByteView out) {
  esp_fill_random(out.data(), out.size());
}

bool EspPower::external_power() {
  if (kBoard.external_power == kNoPin) {
    return false;
  }
  const int level = gpio_get_level(static_cast<gpio_num_t>(kBoard.external_power));
  return static_cast<std::uint8_t>(level) == kBoard.external_power_level;
}

device::BuildInfo build_info() {
  device::BuildInfo build;
  const esp_app_desc_t* app = esp_app_get_description();
  // CMakeLists.txt refuses a PROJECT_VER this cannot parse, so zeros mean a broken image.
  if (!parse_version(app->version, sizeof(app->version), build.version)) {
    build.version = protocol::FirmwareVersion{};
  }
#if CONFIG_HSN_DEVELOPMENT_BUILD
  build.development = true;
#else
  build.development = false;
#endif
  // The chip identifier of protocol section 10: the factory base MAC, unique per chip.
  if (esp_efuse_mac_get_default(build.chip_id.data()) != ESP_OK) {
    build.chip_id = {};
  }
  return build;
}

device::BootInfo boot_info() {
  device::BootInfo boot;
  const esp_reset_reason_t reason = esp_reset_reason();
  boot.reset_cause = static_cast<std::uint8_t>(reason);
  boot.watchdog_reset = reason == ESP_RST_TASK_WDT || reason == ESP_RST_INT_WDT ||
                        reason == ESP_RST_WDT || reason == ESP_RST_PANIC;
  // events.hpp: a brown-out is "any other reset", as a watchdog or a panic is.
  if (reason == ESP_RST_POWERON) {
    boot.kind = device::BootKind::power_on;
  } else if (reason == ESP_RST_DEEPSLEEP) {
    boot.kind = device::BootKind::deep_sleep_wake;
  } else {
    boot.kind = device::BootKind::other_reset;
  }
  if (boot.kind != device::BootKind::deep_sleep_wake) {
    return boot;
  }
  const std::uint32_t causes = esp_sleep_get_wakeup_causes();
  if ((causes & BIT(ESP_SLEEP_WAKEUP_TIMER)) != 0) {
    boot.woke_by = boot.woke_by.with_timer();
  }
  if ((causes & BIT(ESP_SLEEP_WAKEUP_GPIO)) != 0) {
    const std::uint64_t status = esp_sleep_get_gpio_wakeup_status();
    const std::array<std::pair<Pin, device::Input>, 4> inputs{{
        {kBoard.door, device::Input::door},
        {kBoard.cover, device::Input::cover},
        {kBoard.button, device::Input::button},
        {kBoard.external_power, device::Input::external_power},
    }};
    for (std::uint32_t bit = 0; bit < 64; ++bit) {
      if ((status & (std::uint64_t{1} << bit)) == 0) {
        continue;
      }
      const gpio_num_t gpio = esp_sleep_wakeup_io_bit2num(bit);
      for (const auto& [pin, input] : inputs) {
        if (pin != kNoPin && static_cast<int>(gpio) == pin) {
          boot.woke_by = boot.woke_by.with(input);
        }
      }
    }
  }
  return boot;
}

}  // namespace hsn::esp
