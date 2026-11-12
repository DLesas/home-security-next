#pragma once

#include <array>
#include <cstdint>

#include "hsn/device/hal/retained.hpp"
#include "hsn/host/call_meter.hpp"

namespace hsn::host {

/**
 * RTC memory. It belongs to the board, not to the device objects, so it survives a simulated deep
 * sleep (which rebuilds the device) and is lost only on a simulated power loss.
 */
class FakeRetainedMemory final : public device::RetainedMemory, public Metered {
public:
  protocol::MutableByteView block() override {
    tick();
    return protocol::MutableByteView(block_);
  }
  protocol::MutableByteView breadcrumb() override {
    tick();
    return protocol::MutableByteView(breadcrumb_);
  }

  /** A power loss: both regions hold garbage derived from `seed`. */
  void lose(std::uint32_t seed = 0x9E3779B9u);

  /** The block's bytes, for the Simulation to see what a handle() wrote; not a device call. */
  const std::array<std::uint8_t, device::kRetainedBlockSize>& contents() const {
    return block_;
  }

  /** Flips one bit of the block. */
  void corrupt(std::size_t index) {
    block_[index % block_.size()] ^= 0x01;
  }

private:
  std::array<std::uint8_t, device::kRetainedBlockSize> block_{};
  std::array<std::uint8_t, device::kBreadcrumbSize> breadcrumb_{};
};

}  // namespace hsn::host
