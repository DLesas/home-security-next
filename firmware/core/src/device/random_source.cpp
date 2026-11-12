#include "hsn/device/services/random_source.hpp"

namespace hsn::device {

std::uint32_t RandomSource::next_u32() {
  if (used_ + 4 > pool_.size()) {
    random_.fill(protocol::MutableByteView(pool_));
    used_ = 0;
  }
  std::uint32_t value = 0;
  for (std::size_t i = 0; i < 4; ++i) {
    value |= static_cast<std::uint32_t>(pool_[used_ + i]) << (8 * i);
  }
  used_ += 4;
  return value;
}

std::uint32_t RandomSource::below(std::uint32_t bound) {
  const std::uint64_t product = static_cast<std::uint64_t>(next_u32()) * bound;
  return static_cast<std::uint32_t>(product >> 32);
}

Duration RandomSource::between(Duration lo, Duration hi) {
  if (hi.us <= lo.us) {
    return lo;
  }
  const auto span = static_cast<std::uint64_t>(hi.us - lo.us) + 1;
  const std::uint64_t wide = (static_cast<std::uint64_t>(next_u32()) << 32) | next_u32();
  // The bias of a 64-bit modulo is below 2^-32 for any span a device uses.
  return Duration{lo.us + static_cast<std::int64_t>(wide % span)};
}

}  // namespace hsn::device
