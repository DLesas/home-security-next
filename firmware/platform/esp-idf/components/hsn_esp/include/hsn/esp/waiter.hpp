#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "hsn/device/hal/power.hpp"
#include "hsn/device/hal/waiter.hpp"
#include "hsn/device/services/log_buffer.hpp"
#include "hsn/esp/bluetooth.hpp"
#include "hsn/esp/clock.hpp"
#include "hsn/esp/display_label.hpp"
#include "hsn/esp/event_queue.hpp"
#include "hsn/esp/indicators.hpp"
#include "hsn/esp/inputs.hpp"
#include "hsn/esp/network_link.hpp"
#include "hsn/esp/radio.hpp"
#include "hsn/esp/usb_link.hpp"

namespace hsn::esp {

/** Log codes of the platform's own range (log_buffer.hpp: 0x4xxx). */
namespace platform_log {
/** A link received more packets than its slots hold; the newest was dropped (design section 3). */
constexpr std::uint16_t link_overflow = 0x4001;
/** The platform's queue was full and a message was lost. */
constexpr std::uint16_t queue_overflow = 0x4002;
}  // namespace platform_log

/**
 * The platform's wait (design section 2, "The loop"): the only blocking call, made by app_main's
 * loop and never by the core. It returns one event, or nothing when `until` comes.
 *
 * - Awake (siren, gateway, a sensor on USB power): blocks on the event queue with an esp_timer
 *   alarm at the deadline, so a deadline is met to the timer, not to a tick. Before it blocks, a
 *   DIO1 already high during an operation, with nothing queued or deferred to service it, is
 *   serviced (check_radio_level), at most once in 10 ms; while it stays high the wait is awake.
 * - Light sleep (a sensor on its cell): esp_light_sleep_start with the timer at the deadline and a
 *   level wake on DIO1 (high) and on each input (the level it does not have). Not taken while
 *   external power is present (the USB serial port stops in light sleep), while the network link
 *   is in use, or while the buzzer or LED plays; the wait is then awake. Hardware events in a light
 *   sleep are stamped at the wake, the interrupt being off while the chip sleeps ‡ (the wake
 *   latency is unmeasured).
 * - Deep sleep (hardware notes (a) 27 and 34): the network link closed and Wi-Fi stopped, the
 *   radio in cold sleep before its pins are released (held), the buzzer and LED off, the timer and
 *   each wake input armed at the level the pin does not have, the inputs read again, and an input
 *   event returned instead of sleeping when one changed. Otherwise esp_deep_sleep_start(), which
 *   never returns: the chip resets on wake, so this iteration of the loop is the last, and no
 *   second sleep can follow it (the old firmware's double sleep, design section 6).
 * - Restart: the links finish sending what they were given, for at most 200 ms (design section 3,
 *   "Waiter"), then esp_restart().
 *
 * Every event's `now` is the clock at the moment it is returned; hardware events keep the `at`
 * their interrupt took. A link packet's bytes stay in their slot until the next wait.
 */
class EspWaiter final : public device::Waiter {
public:
  EspWaiter(const EspClock& clock, EventQueue& queue, EspRadio& radio, Inputs& inputs,
            Indicators& indicators, device::Power& power, UsbLink& usb, NetworkLink* network,
            Bluetooth& bluetooth, DisplayLabel& display)
      : clock_(clock),
        queue_(queue),
        radio_(radio),
        inputs_(inputs),
        indicators_(indicators),
        power_(power),
        usb_(usb),
        network_(network),
        bluetooth_(bluetooth),
        display_(display) {}

  /** Creates the deadline alarm. */
  bool begin();

  /** Where the platform's own log entries go: the core's log, once the services exist. */
  void attach_log(device::LogBuffer* log) {
    log_ = log;
  }

  /** Seeds the hold timer if an unpaired board woke with the button already down. */
  void start_button(const device::BootInfo& boot, std::uint8_t role, bool unpaired);

  device::WaitResult wait(const device::WaitRequest& request) override;

private:
  /** A pending event, and the link slot its packet is in (kind 0xFF: none). */
  struct Pending {
    device::Event event;
    std::uint8_t link = 0xFF;
    std::uint8_t slot = 0;
    std::uint32_t generation = 0;
  };
  static constexpr std::size_t kPending = 8;

  bool push(const device::Event& event, std::uint8_t link = 0xFF, std::uint8_t slot = 0,
            std::uint32_t generation = 0);
  /** Services the panel and Bluetooth, including setup-only button thresholds. */
  void service_setup(device::Instant now);
  /** Reads the debounced button edge without changing events forwarded to paired roles. */
  void setup_button(const device::InputEvent& event);
  /** Earliest platform deadline while serving pairing, the button or the panel. */
  device::Instant setup_due() const;
  bool pop(Pending& out);
  bool radio_event_pending() const;
  void absorb(const Message& message);
  void drain();
  void service_radio(device::Instant at);
  /** True while an operation is under way and DIO1 reads high. */
  bool radio_level_high() const;
  /**
   * The level check: services the radio when DIO1 is high and nothing queued or deferred will. True
   * when it did.
   */
  bool check_radio_level();
  void settle_inputs(device::Instant now);
  void release_delivered();
  void log_losses(device::Instant now);
  bool light_sleep_allowed() const;
  void block_until(device::Instant deadline);
  void light_sleep(device::Instant deadline);
  void deep_sleep(const device::WaitRequest& request);
  /** Flushes USB and network and restarts after the caller's Bluetooth stop attempt. */
  [[noreturn]] void restart();
  LinkSlots* slots_of(std::uint8_t link);

  const EspClock& clock_;
  EventQueue& queue_;
  EspRadio& radio_;
  Inputs& inputs_;
  Indicators& indicators_;
  device::Power& power_;
  UsbLink& usb_;
  NetworkLink* network_;
  Bluetooth& bluetooth_;
  DisplayLabel& display_;
  PairButton button_;
  bool unpaired_ = false;
  bool pairing_led_ = false;
  bool paired_sensor_ = false;
  bool clear_legacy_blink_ = false;
  device::Instant paired_press_ = device::Instant::never();
  device::LogBuffer* log_ = nullptr;
  void* alarm_ = nullptr;

  std::array<Pending, kPending> pending_{};
  std::size_t head_ = 0;
  std::size_t count_ = 0;
  /** The slot of the packet last returned, freed at the next wait. */
  std::uint8_t delivered_link_ = 0xFF;
  std::uint8_t delivered_slot_ = 0;
  /** A DIO1 rise not yet serviced, kept while an earlier radio event waits to be returned. */
  bool radio_deferred_ = false;
  device::Instant radio_deferred_at_;
  /** The earliest the next level check may service the radio (kRadioLevelRetry after the last). */
  device::Instant radio_level_due_;
  std::uint32_t usb_dropped_ = 0;
  std::uint32_t network_dropped_ = 0;
  std::uint32_t bluetooth_dropped_ = 0;
  std::uint32_t queue_dropped_ = 0;
};

}  // namespace hsn::esp
