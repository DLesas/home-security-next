#include "hsn/host/fake_random.hpp"

namespace hsn::host {

void FakeRandom::fill(protocol::MutableByteView out) {
  tick();
  for (std::uint8_t& byte : out) {
    state_ ^= state_ >> 12;
    state_ ^= state_ << 25;
    state_ ^= state_ >> 27;
    byte = static_cast<std::uint8_t>((state_ * 0x2545F4914F6CDD1DULL) >> 56);
  }
  bytes_drawn += out.size();
}

}  // namespace hsn::host
