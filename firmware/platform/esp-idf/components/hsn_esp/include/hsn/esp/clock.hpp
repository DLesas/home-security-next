#pragma once

#include <cstdint>

#include "hsn/device/hal/clock.hpp"
#include "hsn/device/time.hpp"

namespace hsn::esp {

/**
 * The monotonic clock of design section 2: the RTC timer, which counts through deep sleep.
 *
 * Reading the RTC timer takes up to one slow-clock cycle (esp_rtc_time.h: about 7 µs on the RC
 * clock), too slow and too coarse for an interrupt's timestamp. So the RTC time is read once at
 * start-up and the high-resolution esp_timer (40 MHz crystal, in IRAM) is added to it from then
 * on. ESP-IDF moves esp_timer forward by the RTC time slept after each light sleep
 * (sleep_modes.c, esp_timer_private_set), so the sum stays on the RTC's time across light sleep,
 * and deep sleep restarts the sum from the RTC. esp_rtc_get_time_us() keeps its count in RTC
 * memory across resets and calibration changes (esp_clk.c), so the instant is continuous through
 * deep sleep; whether the RTC counter itself survives a watchdog or software reset is unverified
 * (design section 10) ‡, and a clock that went back is the core's case
 * (RetainedStatus::clock_reset).
 */
class EspClock final : public device::Clock {
public:
  /** Reads the RTC once; call first in app_main, before anything stamps an event. */
  void begin();

  device::Instant now() const override;

  /** The same reading, safe in an interrupt and while flash is busy (in IRAM). */
  device::Instant now_from_isr() const;

  /** esp_timer's microseconds for an instant: what esp_timer alarms are set in. */
  std::int64_t timer_us(device::Instant at) const;

private:
  /** RTC microseconds at start-up less esp_timer microseconds then. */
  std::int64_t offset_us_ = 0;
};

}  // namespace hsn::esp
