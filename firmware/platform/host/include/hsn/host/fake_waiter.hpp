#pragma once

#include <deque>
#include <vector>

#include "hsn/device/hal/waiter.hpp"
#include "hsn/host/fake_clock.hpp"

namespace hsn::host {

/**
 * The platform's wait, for driving one device with the real loop shape in a test. It records each
 * request. A scripted event due before `until` is returned with the clock moved to it; otherwise
 * the clock moves to `until` and the wait times out. Deep sleep and restart move nothing and
 * return at once with `slept` or `restarted` set: the test then rebuilds the device, as the chip's
 * reset would. Step B's Simulation does not use this: it drives Runner directly from its queue.
 */
class FakeWaiter final : public device::Waiter {
public:
  explicit FakeWaiter(FakeClock& clock) : clock_(clock) {}

  device::WaitResult wait(const device::WaitRequest& request) override;

  /** Queues a hardware event; `event.now` is when it happens. */
  void script(const device::Event& event) {
    scripted.push_back(event);
  }

  std::vector<device::WaitRequest> requests;
  std::deque<device::Event> scripted;
  bool slept = false;
  bool restarted = false;

private:
  FakeClock& clock_;
};

}  // namespace hsn::host
