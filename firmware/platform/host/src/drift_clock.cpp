#include "hsn/host/drift_clock.hpp"

#include <string>

#include "hsn/host/simulation_error.hpp"

namespace hsn::host {
namespace {

constexpr std::uint64_t kMillion = 1000000;

}  // namespace

DriftClock::DriftClock(std::int32_t ppm)
    : ppm_(ppm), rate_(static_cast<std::uint64_t>(static_cast<std::int64_t>(kMillion) + ppm)) {
  if (ppm > kMaxPpm || ppm < -kMaxPpm) {
    throw SimulationError("clock drift of " + std::to_string(ppm) + " ppm is out of range");
  }
}

void DriftClock::start(device::Instant true_now, device::Instant local_now) {
  true_origin_ = true_now;
  local_origin_ = local_now;
}

device::Instant DriftClock::local(device::Instant true_time) const {
  if (true_time.is_never()) {
    return true_time;
  }
  if (true_time <= true_origin_) {
    return local_origin_;
  }
  // elapsed × rate ÷ 10^6, split so that neither product can overflow.
  const std::uint64_t elapsed = true_time.us - true_origin_.us;
  const std::uint64_t whole = elapsed / kMillion;
  const std::uint64_t part = elapsed % kMillion;
  return device::Instant{local_origin_.us + whole * rate_ + part * rate_ / kMillion};
}

device::Instant DriftClock::true_time(device::Instant local_time) const {
  if (local_time.is_never()) {
    return local_time;
  }
  if (local_time <= local_origin_) {
    return true_origin_;
  }
  // The least t with t × rate ÷ 10^6 (rounded down) ≥ elapsed: ceil(elapsed × 10^6 ÷ rate).
  const std::uint64_t elapsed = local_time.us - local_origin_.us;
  const std::uint64_t whole = elapsed / rate_;
  const std::uint64_t part = elapsed % rate_;
  return device::Instant{true_origin_.us + whole * kMillion +
                         (part * kMillion + rate_ - 1) / rate_};
}

}  // namespace hsn::host
