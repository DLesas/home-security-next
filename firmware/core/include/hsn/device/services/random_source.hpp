#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "hsn/device/hal/random.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/bytes.hpp"

namespace hsn::device {

/**
 * Random numbers for jitter and back-off, drawn from the hardware in 32-byte batches. Every
 * method runs in bounded time: no rejection loops.
 */
class RandomSource {
public:
  explicit RandomSource(Random& random) : random_(random) {}

  /**
   * Returns 32 random bits.
   */
  std::uint32_t next_u32();

  /**
   * Returns a value in [0, bound) by multiply-and-shift; 0 when bound is 0.
   */
  std::uint32_t below(std::uint32_t bound);

  /**
   * Returns a duration in [lo, hi]; lo when hi ≤ lo.
   */
  Duration between(Duration lo, Duration hi);

  /**
   * Fills `out` straight from the hardware, for values that must not come from the pool's
   * leftovers (a gateway's hello).
   */
  void fill(protocol::MutableByteView out) {
    random_.fill(out);
  }

private:
  Random& random_;
  std::array<std::uint8_t, 32> pool_{};
  std::size_t used_ = 32;
};

}  // namespace hsn::device
