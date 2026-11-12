#include "hsn/protocol/counters.hpp"

namespace hsn::protocol {

SendCounter SendCounter::resumed(CounterStep step, std::uint32_t saved_resume_point) {
  const auto step_size = static_cast<std::uint64_t>(step);
  if (step_size == 0) {
    // take() refuses a zero step; there is nothing to round to.
    return SendCounter(step, saved_resume_point, saved_resume_point);
  }
  std::uint64_t point = (saved_resume_point + step_size - 1) / step_size * step_size;
  if (point < step_size) {
    point = step_size;
  }
  const std::uint64_t last_multiple = 0xFFFFFFFFu / step_size * step_size;
  if (point > last_multiple) {
    point = last_multiple;
  }
  const auto next = static_cast<std::uint32_t>(point);
  return SendCounter(step, next, next);
}

Result<CounterTake> SendCounter::take() {
  // A step of 0 can only come from casting an unlisted value into CounterStep.
  if (step_ == 0) {
    return Error::bad_counter;
  }
  const bool at_step = next_ % step_ == 0;
  // Counter 0 is never sent; a counter at or past the saved resume point that does not save a
  // new one would be reused after a power loss. This guards the class's own invariant; it is not
  // a protocol rule.
  if (next_ == 0 || (next_ >= resume_point_ && !at_step)) {
    return Error::bad_counter;
  }
  CounterTake taken;
  taken.counter = next_;
  if (at_step) {
    // 64-bit, so the comparison sees a resume point past 2^32 − 1 instead of a wrapped one.
    const std::uint64_t resume_point = static_cast<std::uint64_t>(next_) + step_;
    if (resume_point > 0xFFFFFFFFu) {
      return Error::counter_exhausted;
    }
    taken.save_resume_point = true;
    taken.resume_point = static_cast<std::uint32_t>(resume_point);
    resume_point_ = taken.resume_point;
  }
  // Cannot wrap: next_ is below resume_point_, itself at most 2^32 − 1.
  next_ += 1;
  return taken;
}

}  // namespace hsn::protocol
