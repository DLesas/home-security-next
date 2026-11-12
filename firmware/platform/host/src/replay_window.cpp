#include "hsn/host/replay_window.hpp"

namespace hsn::host {

protocol::CounterVerdict ReplayWindow::check(std::uint32_t counter) const {
  if (counter == 0) {
    return protocol::CounterVerdict::too_old;
  }
  if (highest_ == 0 || counter > highest_) {
    return protocol::CounterVerdict::accepted;
  }
  if (counter == highest_) {
    return protocol::CounterVerdict::duplicate;
  }
  const std::uint32_t below = highest_ - 1 - counter;
  if (below >= 64) {
    return protocol::CounterVerdict::too_old;
  }
  return (mask_ >> below) & 1u ? protocol::CounterVerdict::duplicate
                               : protocol::CounterVerdict::accepted;
}

protocol::CounterVerdict ReplayWindow::accept(std::uint32_t counter) {
  const protocol::CounterVerdict verdict = check(counter);
  if (verdict != protocol::CounterVerdict::accepted) {
    return verdict;
  }
  if (highest_ == 0) {
    highest_ = counter;
    return verdict;
  }
  if (counter > highest_) {
    // Slide up: the old highest becomes bit (shift − 1), older bits move with it.
    const std::uint32_t shift = counter - highest_;
    const std::uint64_t moved = shift >= 64 ? 0 : mask_ << shift;
    const std::uint64_t old_highest = shift - 1 < 64 ? std::uint64_t{1} << (shift - 1) : 0;
    mask_ = moved | old_highest;
    highest_ = counter;
    return verdict;
  }
  mask_ |= std::uint64_t{1} << (highest_ - 1 - counter);
  return verdict;
}

std::array<std::uint8_t, 12> ReplayWindow::state_bytes() const {
  std::array<std::uint8_t, 12> bytes{};
  for (std::size_t i = 0; i < 4; ++i) {
    bytes[i] = static_cast<std::uint8_t>((highest_ >> (8 * i)) & 0xFFu);
  }
  for (std::size_t i = 0; i < 8; ++i) {
    bytes[4 + i] = static_cast<std::uint8_t>((mask_ >> (8 * i)) & 0xFFu);
  }
  return bytes;
}

}  // namespace hsn::host
