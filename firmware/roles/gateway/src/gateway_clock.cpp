#include "hsn/roles/gateway/gateway_clock.hpp"

#include "hsn/roles/gateway/constants.hpp"

namespace hsn::roles::gateway {

std::uint32_t clock_value(device::Instant at) {
  return static_cast<std::uint32_t>(at.us & (kClockSpan - 1));
}

device::Instant nearest_instant(device::Instant now, std::uint32_t value) {
  const std::uint64_t base = now.us & ~(kClockSpan - 1);
  std::uint64_t candidate = base | value;
  if (candidate > now.us && candidate - now.us > kClockHalfSpan && candidate >= kClockSpan) {
    // More than half a span ahead: the same value one span earlier is nearer.
    candidate -= kClockSpan;
  } else if (candidate < now.us && now.us - candidate > kClockHalfSpan) {
    // More than half a span behind: the same value one span later is nearer.
    candidate += kClockSpan;
  }
  return device::Instant{candidate};
}

}  // namespace hsn::roles::gateway
