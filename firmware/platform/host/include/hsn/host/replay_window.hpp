#pragma once

#include <array>
#include <cstdint>

#include "hsn/protocol/counters.hpp"

namespace hsn::host {

/**
 * The hub's receiving rule for packets from a sensor or siren (protocol section 4): a counter is
 * accepted when it is higher than any accepted, or one of the 64 below the highest that has not
 * been seen. The firmware does not contain it (the core keeps only device rules); the test hub
 * does, checked against counters.json's replayWindow section.
 */
class ReplayWindow {
public:
  /** Judges a counter without recording it. Counter 0 is never valid: too_old. */
  protocol::CounterVerdict check(std::uint32_t counter) const;

  /** Judges a counter and records it when accepted. */
  protocol::CounterVerdict accept(std::uint32_t counter);

  /** The highest accepted counter; 0 for the empty window. */
  std::uint32_t highest() const {
    return highest_;
  }

  /** Bit i set: counter highest − 1 − i was accepted. */
  std::uint64_t mask() const {
    return mask_;
  }

  /** The window as the vectors store it: highest (u32 LE), then the mask (u64 LE). */
  std::array<std::uint8_t, 12> state_bytes() const;

private:
  std::uint32_t highest_ = 0;
  std::uint64_t mask_ = 0;
};

}  // namespace hsn::host
