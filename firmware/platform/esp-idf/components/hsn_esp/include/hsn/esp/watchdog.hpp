#pragma once

#include <cstdint>

#include "hsn/device/hal/watchdog.hpp"

namespace hsn::esp {

/**
 * The task watchdog on the main task only (design section 6, FW4). ESP-IDF starts the task
 * watchdog with no task subscribed (sdkconfig.defaults: the idle tasks are not watched, a timeout
 * panics and resets). start() sets the timeout and subscribes the calling task, which must be the
 * main task; feed() resets that task's timer.
 *
 * Why the old firmware's faults cannot happen here, by construction:
 * - feed() is the only call of esp_task_wdt_reset in the platform (watchdog.cpp), and the core's
 *   Runner is its only caller (runner.cpp: after each handle() and in timed_out). No interrupt,
 *   timer callback or other task feeds: the Wi-Fi, WebSocket, mDNS and link tasks are not
 *   subscribed, so they could not keep the main task's timer alive even if they tried.
 * - The waiter never waits longer than the Runner's slice (2 s) unless it deep-sleeps, and a hang
 *   in a driver call or in the wait itself never returns to the Runner, so it is not fed.
 */
class EspWatchdog final : public device::Watchdog {
public:
  void start(std::uint32_t timeout_ms) override;
  void feed() override;
};

}  // namespace hsn::esp
