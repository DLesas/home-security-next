#include "hsn/esp/platform.hpp"

#include "driver/gpio.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hsn/device/runner.hpp"
#include "hsn/device/services/record.hpp"
#include "hsn/device/services/setup.hpp"
#include "hsn/esp/bluetooth.hpp"
#include "hsn/esp/board.hpp"
#include "sdkconfig.h"

// Every algorithm and key type hsn_psa calls is compiled into ESP-IDF's PSA Crypto (its defaults,
// psa/crypto_config.h, less what mbedtls/esp_config.h takes out): one left out would fail only at
// run time, with PSA_ERROR_NOT_SUPPORTED, so it fails the build here instead.
#if !defined(PSA_WANT_ALG_CCM) || !defined(PSA_WANT_ALG_SHA_256) ||          \
    !defined(PSA_WANT_ALG_ECDSA) || !defined(PSA_WANT_ECC_SECP_R1_256) ||    \
    !defined(PSA_WANT_ALG_HKDF) || !defined(PSA_WANT_ALG_HMAC) ||            \
    !defined(PSA_WANT_KEY_TYPE_AES) || !defined(PSA_WANT_KEY_TYPE_DERIVE) || \
    !defined(PSA_WANT_KEY_TYPE_HMAC) || !defined(PSA_WANT_KEY_TYPE_ECC_PUBLIC_KEY)
#error "ESP-IDF's PSA Crypto lacks an algorithm or key type that hsn_psa uses"
#endif

namespace hsn::esp {
namespace {

constexpr const char* kTag = "hsn";

}  // namespace

EspPlatform::EspPlatform()
    : key_import_(cipher_, update_crypto_),
      radio_(clock_, queue_),
      inputs_(clock_, queue_),
      usb_(queue_),
      network_(queue_),
      sensor_io_(clock_, inputs_, analog_, indicators_),
      siren_io_(clock_, inputs_, analog_, indicators_),
      gateway_io_(clock_, analog_, indicators_),
      bluetooth_(queue_, storage_, retained_, build_),
      display_(storage_, build_),
      waiter_(clock_, queue_, radio_, inputs_, indicators_, power_, usb_, &network_, bluetooth_,
              display_),
      hal_{storage_,
           retained_,
           radio_,
           random_,
           power_,
           slots_,
           update_crypto_,
           key_import_,
           &usb_,
           &network_,
           bluetooth_link(bluetooth_),
           cipher_,
           device::BuildInfo{}} {}

void EspPlatform::start_early() {
  clock_.begin();
  watchdog_.start(device::kWatchdogTimeoutMs);
}

std::uint8_t EspPlatform::start_storage() {
  if (storage_.begin() != device::HalError::none) {
    return 0;
  }
  return device::stored_role(storage_);
}

bool EspPlatform::start(std::uint8_t role) {
  build_ = build_info();
  hal_.build = build_;
#if CONFIG_HSN_LOG_EVENTS
  esp_log_level_set("hsn.waiter", ESP_LOG_DEBUG);
#endif
  // Every piece is started even when one before it failed, so a board with a fault still answers
  // on USB; each failure is named on the console.
  bool ok = true;
  auto check = [&ok](bool started, const char* what) {
    if (!started) {
      ESP_LOGE(kTag, "%s did not start", what);
      ok = false;
    }
  };
  check(queue_.begin(), "the event queue");
  // One interrupt service for DIO1 and the inputs, its dispatcher in IRAM, so an edge is stamped
  // even while flash is busy.
  const esp_err_t service = gpio_install_isr_service(ESP_INTR_FLAG_IRAM);
  check(service == ESP_OK || service == ESP_ERR_INVALID_STATE, "the GPIO interrupt service");
  check(inputs_.begin(InputSet::for_role(role)), "the inputs");
  check(indicators_.begin(), "the buzzer and LED");
  const bool unpaired = bluetooth_.unpaired();
  if (unpaired) {
    check(display_.prepare(role, random_), "the display label storage");
  }
  check(analog_.begin(), "the analogue readings");
  if (role == 2) {
    check(siren_io_.begin(), "the siren output");
  }
  check(usb_.begin(), "the USB link");
  check(network_.begin(), "the network link");
  check(waiter_.begin(), "the waiter");
  check(bluetooth_.begin(), "the Bluetooth control events");
  waiter_.start_button(boot_info(), role, unpaired);
  check(slots_.begin(), "the firmware slots");
  // A radio that does not answer is not fatal here: its calls fail, the core's guard calls
  // recover(), and the fault is logged and reported. The board still answers on USB.
  radio_ready_ = radio_.begin();
  if (unpaired) {
    check(display_.begin(kBoard.epaper_cs, kBoard.epaper_dc, kBoard.epaper_reset,
                         kBoard.epaper_busy, clock_.now()),
          "the e-paper display");
  }
  // The paired key into the cipher and the update crypto together (key_import.hpp).
  device::Record<device::PairingRecord> pairing(storage_, device::StoreKey::pairing,
                                                device::kPairingRecordVersion, {});
  key_loaded_ = pairing.load() == device::HalError::none &&
                key_import_.import_key(pairing.get().key) == device::HalError::none;
  return ok;
}

device::Event EspPlatform::boot_event() const {
  return device::Event::booted(clock_.now(), boot_info());
}

void EspPlatform::log_boot(std::uint8_t role, const device::Event& boot) const {
  const device::BuildInfo& build = hal_.build;
  ESP_LOGI(kTag, "board %s, firmware %u.%u.%u%s, chip %02x%02x%02x%02x%02x%02x", kBoard.name,
           build.version.major, build.version.minor, build.version.patch,
           build.development ? " (development)" : "", build.chip_id[0], build.chip_id[1],
           build.chip_id[2], build.chip_id[3], build.chip_id[4], build.chip_id[5]);
  ESP_LOGI(kTag, "role %u, reset cause %u%s, woken by 0x%02x, radio %s, key %s", role,
           boot.boot.reset_cause, boot.boot.watchdog_reset ? " (watchdog)" : "",
           boot.boot.woke_by.bits(), radio_ready_ ? "ready" : "NOT ANSWERING",
           key_loaded_ ? "loaded" : "none (not paired)");
  ESP_LOGI(kTag, "main task stack left %u bytes, free heap %u bytes (least %u)",
           static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)),
           static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_DEFAULT)),
           static_cast<unsigned>(heap_caps_get_minimum_free_size(MALLOC_CAP_DEFAULT)));
}

}  // namespace hsn::esp
