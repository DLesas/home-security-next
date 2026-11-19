#include "hsn/esp/watchdog.hpp"

#include "esp_err.h"
#include "esp_log.h"
#include "esp_task_wdt.h"

namespace hsn::esp {
namespace {

constexpr const char* kTag = "hsn.watchdog";

}  // namespace

void EspWatchdog::start(std::uint32_t timeout_ms) {
  esp_task_wdt_config_t config{};
  config.timeout_ms = timeout_ms;
  config.idle_core_mask = 0;
  config.trigger_panic = true;
  esp_err_t result = esp_task_wdt_reconfigure(&config);
  if (result == ESP_ERR_INVALID_STATE) {
    // Not started by ESP-IDF (CONFIG_ESP_TASK_WDT_INIT off): start it here.
    result = esp_task_wdt_init(&config);
  }
  if (result != ESP_OK) {
    ESP_LOGE(kTag, "task watchdog not configured: %s", esp_err_to_name(result));
  }
  // Subscribe the calling task once; a second start() finds it subscribed.
  if (esp_task_wdt_status(nullptr) != ESP_OK) {
    result = esp_task_wdt_add(nullptr);
    if (result != ESP_OK) {
      ESP_LOGE(kTag, "main task not subscribed: %s", esp_err_to_name(result));
    }
  }
}

void EspWatchdog::feed() {
  // The only feed in the platform; the core's Runner is its only caller.
  static_cast<void>(esp_task_wdt_reset());
}

}  // namespace hsn::esp
