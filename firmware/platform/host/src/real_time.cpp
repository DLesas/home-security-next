#include "hsn/host/real_time.hpp"

namespace hsn::host {

RealTimeDriver::RealTimeDriver(Simulation& sim, const HostClock& clock,
                               device::Duration report_over)
    : sim_(sim),
      clock_(clock),
      report_over_(report_over),
      true_origin_(sim.now()),
      host_origin_(clock.elapsed()) {}

device::Instant RealTimeDriver::host_now() const {
  return true_origin_ + (clock_.elapsed() - host_origin_);
}

void RealTimeDriver::catch_up() {
  const device::Instant now = host_now();
  if (now < sim_.now()) {
    return;
  }
  const device::Instant due = sim_.scheduler().next_at();
  if (due <= now && now - due > report_over_) {
    const Lag lag{due, now - due};
    lags_ += 1;
    worst_ = lag.by > worst_ ? lag.by : worst_;
    if (on_lag_) {
      on_lag_(lag);
    }
  }
  sim_.run_until(now);
}

void RealTimeDriver::deliver(const std::function<void()>& input) {
  catch_up();
  input();
  // What the input made due now runs now; nothing later than the host clock.
  sim_.run_until(sim_.now());
}

device::Duration RealTimeDriver::time_to_next(device::Duration cap) const {
  const device::Instant due = sim_.scheduler().next_at();
  if (due.is_never()) {
    return cap;
  }
  const device::Duration left = due - host_now();
  if (left.us <= 0) {
    return device::Duration{};
  }
  return left < cap ? left : cap;
}

}  // namespace hsn::host
