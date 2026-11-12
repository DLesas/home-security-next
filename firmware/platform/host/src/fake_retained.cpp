#include "hsn/host/fake_retained.hpp"

namespace hsn::host {

void FakeRetainedMemory::lose(std::uint32_t seed) {
  std::uint32_t state = seed == 0 ? 1 : seed;
  for (std::uint8_t& byte : block_) {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    byte = static_cast<std::uint8_t>(state);
  }
  for (std::uint8_t& byte : breadcrumb_) {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    byte = static_cast<std::uint8_t>(state);
  }
}

}  // namespace hsn::host
