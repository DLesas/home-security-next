#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "hsn/device/events.hpp"
#include "hsn/esp/board.hpp"
#include "hsn/esp/clock.hpp"
#include "hsn/esp/event_queue.hpp"

namespace hsn::esp {

/** Which inputs a board running a role has wired (protocol roles: 1 sensor, 2 siren, 3 gateway). */
struct InputSet {
  bool door = false;
  bool cover = false;
  bool button = true;
  bool external_power = true;

  /** The button and external power always (setup-only mode wakes on them); the rest by role. */
  static InputSet for_role(std::uint8_t role);
};

/**
 * The door, cover, button and external-power inputs (design section 3, "Role I/O"): each pin
 * interrupts on either edge, the interrupt posts the time, and the main task reports the level once
 * it has held for kDebounce, as one InputEvent stamped with the first edge. A level that bounces
 * back to the one reported raises nothing. The interrupt posts one message per input until the
 * main task has taken it, so a bouncing contact cannot fill the event queue (and push out a DIO1
 * message): at most four input messages wait at once.
 *
 * Every input is level-triggered for waking (hardware notes 6), so each wait arms the opposite of
 * the level the pin has now: in light sleep with gpio_wakeup_enable, in deep sleep with
 * esp_sleep_enable_gpio_wakeup_on_hp_periph_powerdown, whose level is kept per pin on the S3 in
 * ESP-IDF v6.1 (sleep_modes.c). The pins' own edge interrupts are disabled while a light-sleep
 * level wake is armed, and restored after it, so the level never interrupts in a storm.
 */
class Inputs {
public:
  /** How long a level must hold to count ‡ (the platform's choice; no design names one). */
  static constexpr std::int64_t kDebounceUs = 20000;

  Inputs(const EspClock& clock, EventQueue& queue) : clock_(clock), queue_(queue) {}

  /** Configures the pins of `set` and reads their levels as the levels already reported. */
  bool begin(InputSet set);

  /** True when the input's pin is at its active level now (false for an input not wired). */
  bool active(device::Input input) const;

  /** An edge message from the interrupt. */
  void edge(device::Input input, device::Instant at);

  /** The earliest instant a pending edge settles; never when none is pending. */
  device::Instant next_deadline() const;

  /** Reports every input whose debounced level differs from the one last reported. */
  std::size_t settle(device::Instant now, std::array<device::InputEvent, 4>& out);

  /** Light sleep: arms each wired input's wake at the level it does not have now. */
  void arm_light_sleep();
  /** After light sleep: disarms, restores the edge interrupts, and notes any change as an edge. */
  void disarm_light_sleep(device::Instant now);

  /**
   * Deep sleep: arms the inputs in `mask` at the level they do not have now, then reads them again;
   * true when one has already changed (the sleep must not happen: hardware notes (a) 27).
   */
  bool arm_deep_sleep(device::WakeMask mask);

  /** Notes, as an edge at `now`, every input whose level differs from the one reported. */
  void note_changes(device::Instant now);

private:
  struct Line {
    Pin pin = kNoPin;
    std::uint8_t active_level = 1;
    bool wired = false;
    /** The level last reported to the core (or read at start). */
    std::uint8_t reported = 0;
    bool pending = false;
    device::Instant first_edge;
  };
  struct IsrContext {
    Inputs* inputs = nullptr;
    std::uint8_t index = 0;
  };

  static void on_edge(void* context);
  std::uint8_t level(const Line& line) const;

  const EspClock& clock_;
  EventQueue& queue_;
  std::array<Line, 4> lines_{};
  std::array<IsrContext, 4> contexts_{};
  /** Set by the interrupt when it posts, cleared by edge(): an input's message is in the queue. */
  std::array<volatile bool, 4> posted_{};
};

}  // namespace hsn::esp
