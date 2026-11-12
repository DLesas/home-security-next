#include "hsn/host/fake_waiter.hpp"

namespace hsn::host {

device::WaitResult FakeWaiter::wait(const device::WaitRequest& request) {
  requests.push_back(request);
  device::WaitResult result;
  if (request.restart) {
    restarted = true;
    return result;
  }
  if (!scripted.empty() && scripted.front().now <= request.until) {
    result.has_event = true;
    result.event = scripted.front();
    scripted.pop_front();
    if (result.event.now > clock_.now()) {
      clock_.set(result.event.now);
    }
    result.event.now = clock_.now();
    return result;
  }
  if (request.depth == device::SleepDepth::deep) {
    slept = true;
    return result;
  }
  if (!request.until.is_never() && request.until > clock_.now()) {
    clock_.set(request.until);
  }
  return result;
}

}  // namespace hsn::host
