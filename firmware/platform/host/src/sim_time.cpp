#include "hsn/host/sim_time.hpp"

#include <cstdint>
#include <cstdio>
#include <ostream>

namespace hsn::host {

std::string format_instant(device::Instant instant) {
  if (instant.is_never()) {
    return "never";
  }
  char text[32];
  std::snprintf(text, sizeof(text), "%llu.%06llu",
                static_cast<unsigned long long>(instant.us / 1000000),
                static_cast<unsigned long long>(instant.us % 1000000));
  return text;
}

std::string format_duration(device::Duration duration) {
  const bool negative = duration.us < 0;
  const std::uint64_t magnitude = negative ? static_cast<std::uint64_t>(-(duration.us + 1)) + 1
                                           : static_cast<std::uint64_t>(duration.us);
  char text[40];
  std::snprintf(text, sizeof(text), "%s%llu.%06llu s", negative ? "-" : "",
                static_cast<unsigned long long>(magnitude / 1000000),
                static_cast<unsigned long long>(magnitude % 1000000));
  return text;
}

}  // namespace hsn::host

namespace hsn::device {

std::ostream& operator<<(std::ostream& out, Instant instant) {
  return out << host::format_instant(instant);
}

std::ostream& operator<<(std::ostream& out, Duration duration) {
  return out << host::format_duration(duration);
}

}  // namespace hsn::device
