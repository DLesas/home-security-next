#pragma once

#include <cstdint>

namespace hsn::host {

/**
 * Counts the hardware calls a device makes. Every fake that implements a core hardware interface
 * ticks it on each call, so the Simulation can hold every handle() to the design's budget of 32
 * calls (design section 6), a cheap guard against hidden loops. The clock and the watchdog are
 * not counted: only the platform's loop and the Runner use them.
 */
class CallMeter {
public:
  /** Counts one call. */
  void tick() {
    calls_ += 1;
  }

  /** Starts counting again from zero. */
  void reset() {
    calls_ = 0;
  }

  /** Returns the calls counted since the last reset. */
  std::uint64_t calls() const {
    return calls_;
  }

private:
  std::uint64_t calls_ = 0;
};

/**
 * The part of a fake that ticks a meter. A fake without a meter (a unit test's) counts nothing.
 */
class Metered {
public:
  /** Attaches the meter every later call ticks; null detaches it. */
  void set_meter(CallMeter* meter) {
    meter_ = meter;
  }

protected:
  /** Ticks the meter, if any. Const, because reading an input is a call too. */
  void tick() const {
    if (meter_ != nullptr) {
      meter_->tick();
    }
  }

private:
  CallMeter* meter_ = nullptr;
};

}  // namespace hsn::host
