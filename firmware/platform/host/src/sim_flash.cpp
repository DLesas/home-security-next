#include "hsn/host/sim_flash.hpp"

#include <algorithm>

namespace hsn::host {
namespace {

/** One step of xorshift64*, for the garbage an interrupted erase leaves. */
std::uint8_t next_garbage(std::uint64_t& state) {
  state ^= state >> 12;
  state ^= state << 25;
  state ^= state >> 27;
  return static_cast<std::uint8_t>((state * 0x2545F4914F6CDD1DULL) >> 56);
}

}  // namespace

SimFlash::SimFlash(std::size_t size, std::uint64_t seed)
    : bytes_(size, 0xFF), seed_(seed == 0 ? 0x5EED : seed) {}

bool SimFlash::fault(bool always) {
  if (always) {
    return true;
  }
  if (fail_next > 0) {
    fail_next -= 1;
    return true;
  }
  return false;
}

void SimFlash::mess_erase(std::uint32_t address) {
  std::uint64_t state = seed_ ^ (0x9E3779B97F4A7C15ULL * (messes_ + 1));
  messes_ += 1;
  const std::size_t half = kSectorSize / 2;
  for (std::size_t i = 0; i < kSectorSize; ++i) {
    std::uint8_t& byte = bytes_[address + i];
    byte = i < half ? std::uint8_t{0xFF} : static_cast<std::uint8_t>(byte | next_garbage(state));
  }
}

void SimFlash::apply_program(std::uint32_t address, protocol::ByteView bytes, std::size_t whole,
                             bool half_next) {
  for (std::size_t i = 0; i < whole; ++i) {
    std::uint8_t& byte = bytes_[address + i];
    if ((bytes[i] & ~byte) != 0) {
      unerased_programs += 1;
    }
    byte = static_cast<std::uint8_t>(byte & bytes[i]);
  }
  if (half_next && whole < bytes.size()) {
    // Only the bits the high nibble clears have been cleared.
    std::uint8_t& byte = bytes_[address + whole];
    byte = static_cast<std::uint8_t>(byte & (bytes[whole] | 0x0F));
  }
}

device::HalError SimFlash::erase(std::uint32_t address, FlashOp op) {
  if (address % kSectorSize != 0 || static_cast<std::size_t>(address) + kSectorSize > size()) {
    return device::HalError::invalid;
  }
  const FlashFate fate = flash_operation(op);
  if (fate == FlashFate::lost) {
    return device::HalError::io;
  }
  generation_ += 1;
  if (fate == FlashFate::interrupted) {
    mess_erase(address);
    return device::HalError::io;
  }
  if (fault(fail_erases)) {
    return device::HalError::io;
  }
  std::fill_n(bytes_.data() + address, kSectorSize, std::uint8_t{0xFF});
  return device::HalError::none;
}

device::HalError SimFlash::program(std::uint32_t address, protocol::ByteView bytes, FlashOp op) {
  if (static_cast<std::size_t>(address) + bytes.size() > size()) {
    return device::HalError::invalid;
  }
  const FlashFate fate = flash_operation(op);
  if (fate == FlashFate::lost) {
    return device::HalError::io;
  }
  generation_ += 1;
  if (fate == FlashFate::interrupted) {
    apply_program(address, bytes, bytes.size() / 2, true);
    return device::HalError::io;
  }
  if (fault(fail_programs)) {
    return device::HalError::io;
  }
  apply_program(address, bytes, bytes.size(), false);
  return device::HalError::none;
}

device::HalError SimFlash::rewrite(std::uint32_t address, protocol::ByteView bytes, FlashOp op) {
  if (address % kSectorSize != 0 || static_cast<std::size_t>(address) + kSectorSize > size() ||
      bytes.size() > kSectorSize) {
    return device::HalError::invalid;
  }
  const FlashFate fate = flash_operation(op);
  if (fate == FlashFate::lost) {
    return device::HalError::io;
  }
  generation_ += 1;
  if (fate != FlashFate::interrupted && fault(fail_erases || fail_programs)) {
    return device::HalError::io;
  }
  std::fill_n(bytes_.data() + address, kSectorSize, std::uint8_t{0xFF});
  if (fate == FlashFate::interrupted) {
    apply_program(address, bytes, bytes.size() / 2, true);
    return device::HalError::io;
  }
  apply_program(address, bytes, bytes.size(), false);
  return device::HalError::none;
}

void SimFlash::read(std::uint32_t address, protocol::MutableByteView out) const {
  for (std::size_t i = 0; i < out.size(); ++i) {
    const std::size_t at = static_cast<std::size_t>(address) + i;
    out[i] = at < bytes_.size() ? bytes_[at] : std::uint8_t{0xFF};
  }
}

void SimFlash::blank(std::uint32_t address, std::size_t size) {
  const std::size_t first = address / kSectorSize * kSectorSize;
  const std::size_t end = std::min(bytes_.size(), static_cast<std::size_t>(address) + size);
  for (std::size_t at = first; at < end; at += kSectorSize) {
    std::fill_n(bytes_.data() + at, std::min(kSectorSize, bytes_.size() - at), std::uint8_t{0xFF});
  }
  generation_ += 1;
}

void SimFlash::load(std::uint32_t address, protocol::ByteView bytes) {
  blank(address, bytes.size());
  const std::size_t count =
      std::min(bytes.size(), bytes_.size() - std::min<std::size_t>(address, bytes_.size()));
  std::copy_n(bytes.begin(), count, bytes_.data() + address);
  generation_ += 1;
}

}  // namespace hsn::host
