#include "hsn/esp/clock.hpp"

#include "esp_attr.h"
#include "esp_rtc_time.h"
#include "esp_timer.h"

namespace hsn::esp {

void EspClock::begin() {
  const std::int64_t before = esp_timer_get_time();
  const std::uint64_t rtc = esp_rtc_get_time_us();
  const std::int64_t after = esp_timer_get_time();
  offset_us_ = static_cast<std::int64_t>(rtc) - (before + (after - before) / 2);
}

device::Instant EspClock::now() const {
  return now_from_isr();
}

// esp_timer_get_time is in IRAM (CONFIG_ESP_TIMER_IN_IRAM, on by default).
IRAM_ATTR device::Instant EspClock::now_from_isr() const {
  const std::int64_t us = esp_timer_get_time() + offset_us_;
  return device::Instant{us < 0 ? 0 : static_cast<std::uint64_t>(us)};
}

std::int64_t EspClock::timer_us(device::Instant at) const {
  return static_cast<std::int64_t>(at.us) - offset_us_;
}

}  // namespace hsn::esp
