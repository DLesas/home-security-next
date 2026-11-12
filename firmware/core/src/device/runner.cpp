#include "hsn/device/runner.hpp"

#include "hsn/device/services/health.hpp"

namespace hsn::device {

void Runner::start(const Event& boot) {
  watchdog_.start(kWatchdogTimeoutMs);
  immediate_ = 0;
  deliver(boot);
}

void Runner::deliver(const Event& event) {
  device_.handle(event);
  watchdog_.feed();
}

WaitRequest Runner::plan(Instant now) {
  const Wake wake = device_.next_wake();
  WaitRequest request;
  if (wake.restart) {
    request.restart = true;
    return request;
  }
  if (wake.at <= now) {
    immediate_ = static_cast<std::uint8_t>(immediate_ < 0xFF ? immediate_ + 1 : immediate_);
    if (immediate_ > kBusyLoopLimit) {
      device_.raise_fatal(fatal_code::busy_loop, now);
      request.restart = true;
      return request;
    }
    request.until = now;
    request.depth = SleepDepth::awake;
    return request;
  }
  immediate_ = 0;
  if (wake.deepest == SleepDepth::deep) {
    // The chip resets on wake, and nothing runs meanwhile: no slices.
    request.until = wake.at;
    request.depth = SleepDepth::deep;
    request.deep_wake_inputs = wake.deep_wake_inputs;
    return request;
  }
  request.until = earliest(wake.at, now + kFeedSlice);
  request.depth = wake.deepest;
  return request;
}

void Runner::timed_out(Instant now) {
  if (now >= device_.next_wake().at) {
    deliver(Event::timer_at(now));
    return;
  }
  watchdog_.feed();
}

}  // namespace hsn::device
