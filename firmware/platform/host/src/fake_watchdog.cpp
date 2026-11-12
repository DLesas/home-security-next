#include "hsn/host/fake_watchdog.hpp"

namespace hsn::host {

void FakeWatchdog::start(std::uint32_t timeout) {
  timeout_ms = timeout;
  starts += 1;
  last_ = clock_.now();
}

void FakeWatchdog::feed() {
  const device::Instant now = clock_.now();
  const device::Duration gap = now - last_;
  if (gap > longest_) {
    longest_ = gap;
  }
  last_ = now;
  feeds.push_back(now);
}

device::Duration FakeWatchdog::longest_gap(device::Instant now) const {
  const device::Duration tail = now - last_;
  return tail > longest_ ? tail : longest_;
}

bool FakeWatchdog::would_have_fired(device::Instant now) const {
  return starts > 0 && longest_gap(now) > device::milliseconds(timeout_ms);
}

void FakeWatchdog::reset() {
  timeout_ms = 0;
  starts = 0;
  feeds.clear();
  last_ = device::Instant{};
  longest_ = device::Duration{};
}

}  // namespace hsn::host
