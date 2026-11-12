#pragma once

#include <cstdint>

#include "hsn/protocol/error.hpp"

namespace hsn::protocol {

/** How often a device saves its resume point (section 4). */
enum class CounterStep : std::uint16_t {
  sensor = 64,
  siren_or_gateway = 1024,
};

/** One counter handed out by SendCounter::take. */
struct CounterTake {
  /** The counter to send with. */
  std::uint32_t counter = 0;
  /** True when `resume_point` must be written to flash before sending. */
  bool save_resume_point = false;
  /** The resume point to save, when `save_resume_point` is set. */
  std::uint32_t resume_point = 0;
};

/**
 * A device's sending counter with the resume-point rule of section 4: before using a counter that
 * is a multiple of the step, save counter + step; after a power loss continue from the saved
 * value, so a counter is skipped, never repeated. The hub's restore jump is not part of it.
 */
class SendCounter {
public:
  /**
   * The state at pairing: next counter 1, saved resume point one step.
   */
  static constexpr SendCounter paired(CounterStep step) {
    return SendCounter(step, 1, static_cast<std::uint32_t>(step));
  }

  /**
   * The state after a power loss: continue from the resume point read from flash, rounded up to a
   * multiple of the step and to at least one step, so a corrupted or foreign value can neither
   * repeat a counter nor stop the device from sending. A value past the last multiple that fits
   * in 32 bits resumes there, where take() reports Error::counter_exhausted.
   */
  static SendCounter resumed(CounterStep step, std::uint32_t saved_resume_point);

  /**
   * An explicit state, for example kept in sleep-retained memory between wakes.
   */
  constexpr SendCounter(CounterStep step, std::uint32_t next, std::uint32_t resume_point)
      : step_(static_cast<std::uint32_t>(step)), next_(next), resume_point_(resume_point) {}

  /**
   * Hands out the next counter. Fails with Error::counter_exhausted when the next resume point
   * would pass 2^32 − 1 (the device must be paired again), or Error::bad_counter when the state
   * could repeat a counter after a power loss (next is 0, or at or past the saved resume point
   * without being a step). The state is unchanged on failure.
   */
  Result<CounterTake> take();

  /**
   * Returns the counter the next take() would use.
   */
  constexpr std::uint32_t next() const {
    return next_;
  }

  /**
   * Returns the resume point last saved to flash.
   */
  constexpr std::uint32_t resume_point() const {
    return resume_point_;
  }

private:
  std::uint32_t step_;
  std::uint32_t next_;
  std::uint32_t resume_point_;
};

/** Outcome of a receive counter check (counter rejection names of the vectors' README). */
enum class [[nodiscard]] CounterVerdict : std::uint8_t {
  accepted,
  duplicate,
  too_old,
};

/**
 * The strictly-higher receive rule of section 4, used by sirens for commands and by both ends of a
 * gateway connection. The hub's 64-packet window is not part of the firmware.
 */
class StrictlyHigherCounter {
public:
  /**
   * Starts from the last accepted counter; 0 for a new connection or a new pairing.
   */
  explicit constexpr StrictlyHigherCounter(std::uint32_t last_accepted = 0)
      : last_accepted_(last_accepted) {}

  /**
   * Judges `counter` without recording it.
   */
  constexpr CounterVerdict check(std::uint32_t counter) const {
    if (counter == last_accepted_) {
      return CounterVerdict::duplicate;
    }
    return counter > last_accepted_ ? CounterVerdict::accepted : CounterVerdict::too_old;
  }

  /**
   * Judges `counter` and records it when accepted.
   */
  constexpr CounterVerdict accept(std::uint32_t counter) {
    const CounterVerdict verdict = check(counter);
    if (verdict == CounterVerdict::accepted) {
      last_accepted_ = counter;
    }
    return verdict;
  }

  /**
   * Returns the last accepted counter, the value a siren saves to flash.
   */
  constexpr std::uint32_t last_accepted() const {
    return last_accepted_;
  }

private:
  std::uint32_t last_accepted_;
};

}  // namespace hsn::protocol
