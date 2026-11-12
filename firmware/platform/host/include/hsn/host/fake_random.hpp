#pragma once

#include <cstdint>

#include "hsn/device/hal/random.hpp"
#include "hsn/host/call_meter.hpp"

namespace hsn::host {

/** A seeded random source (xorshift64*), so every run repeats exactly. */
class FakeRandom final : public device::Random, public Metered {
public:
  explicit FakeRandom(std::uint64_t seed = 1) : state_(seed == 0 ? 1 : seed) {}

  void fill(protocol::MutableByteView out) override;

  /** How many bytes the device has drawn. */
  std::uint64_t bytes_drawn = 0;

private:
  std::uint64_t state_;
};

}  // namespace hsn::host
