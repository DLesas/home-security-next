#pragma once

#include <cstdint>

#include "hsn/device/hal/indicators.hpp"
#include "hsn/device/time.hpp"

namespace hsn::esp {

/**
 * The buzzer and the LED, each playing a pattern by itself (design section 3: "the platform plays
 * the pattern"). The buzzer is the PS1240 piezo driven with a square wave by LEDC; the LED a plain
 * output. Patterns are stepped by the main task, in the waiter, at the instants next_step() gives,
 * so nothing here runs on another task. While a pattern plays the waiter does not light-sleep: the
 * tone and the timing both need the chip awake (a countdown's 30 s at about 30 mA ‡; S8 measures).
 *
 * The patterns are the platform's own choice; no design gives their timing:
 *   countdown      100 ms on, 900 ms off, until changed
 *   alarm          400 ms on, 100 ms off, until changed
 *   chirp          50 ms once
 *   low_battery    three of 60 ms on, 120 ms off, once
 *   reset_warning  200 ms on, 300 ms off, until changed
 *   LED short_once 100 ms once; pairing 500 ms on, 500 ms off; fault 100 ms on, 100 ms off
 */
class Indicators {
public:
  /** Sets up LEDC for the buzzer and the LED pin; either may be absent on a board. */
  bool begin();

  void sound(device::Sound sound, device::Instant now);
  void blink(device::Blink blink, device::Instant now);

  /** Moves both patterns on to `now`. */
  void step(device::Instant now);

  /** The next instant step() has work; never when nothing plays. */
  device::Instant next_step() const;

  /** True while either pattern plays. */
  bool playing() const;

  /** Both off, before deep sleep. */
  void off();

private:
  struct Pattern {
    std::int64_t on_us = 0;
    std::int64_t off_us = 0;
    /** 0: until changed. */
    std::uint8_t repeats = 0;
  };
  struct Player {
    Pattern pattern;
    bool playing = false;
    bool on = false;
    std::uint8_t played = 0;
    device::Instant next = device::Instant::never();
  };

  static Pattern pattern_of(device::Sound sound);
  static Pattern pattern_of(device::Blink blink);
  void start(Player& player, const Pattern& pattern, device::Instant now, bool buzzer);
  void advance(Player& player, device::Instant now, bool buzzer);
  void output(bool buzzer, bool on);

  Player buzzer_;
  Player led_;
  bool buzzer_ready_ = false;
  bool led_ready_ = false;
};

}  // namespace hsn::esp
