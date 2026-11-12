#pragma once

#include <cstdint>

#include "hsn/device/hal/link.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/bytes.hpp"

namespace hsn::device {

/** Inputs that change, wake the chip, or both. */
enum class Input : std::uint8_t {
  door,
  cover,
  button,
  /** External power arriving or going: USB on a sensor, the supply on a siren or gateway. */
  external_power,
};

/** A set of wake sources: the timer and inputs. */
class WakeMask {
public:
  constexpr WakeMask() = default;

  /** Just the timer. */
  static constexpr WakeMask timer() {
    return WakeMask(kTimerBit);
  }

  /** Just one input. */
  static constexpr WakeMask of(Input input) {
    return WakeMask(bit(input));
  }

  /** This set plus one input. */
  constexpr WakeMask with(Input input) const {
    return WakeMask(static_cast<std::uint8_t>(bits_ | bit(input)));
  }

  /** This set plus the timer. */
  constexpr WakeMask with_timer() const {
    return WakeMask(static_cast<std::uint8_t>(bits_ | kTimerBit));
  }

  constexpr bool has(Input input) const {
    return (bits_ & bit(input)) != 0;
  }
  constexpr bool has_timer() const {
    return (bits_ & kTimerBit) != 0;
  }
  constexpr bool empty() const {
    return bits_ == 0;
  }
  constexpr std::uint8_t bits() const {
    return bits_;
  }
  friend constexpr bool operator==(WakeMask a, WakeMask b) {
    return a.bits_ == b.bits_;
  }

private:
  static constexpr std::uint8_t kTimerBit = 0x80;

  explicit constexpr WakeMask(std::uint8_t bits) : bits_(bits) {}

  static constexpr std::uint8_t bit(Input input) {
    return static_cast<std::uint8_t>(1u << static_cast<std::uint8_t>(input));
  }

  std::uint8_t bits_ = 0;
};

/** Kinds of event the platform delivers (design section 2). */
enum class EventKind : std::uint8_t {
  boot,
  timer,
  radio,
  link,
  input,
};

/** How the chip came to start. */
enum class BootKind : std::uint8_t {
  power_on,
  deep_sleep_wake,
  /** Watchdog, panic, software restart, brown-out: any other reset. */
  other_reset,
};

/** What the core found in retained memory at boot; Device fills it in. */
enum class RetainedStatus : std::uint8_t {
  /** Nothing usable: a cold start. */
  none,
  /** Intact, with a clock that did not go backwards. */
  intact,
  /** Intact, but the clock restarted: deadlines in it mean nothing. */
  clock_reset,
};

/** Facts about this start, from the platform. */
struct BootInfo {
  BootKind kind = BootKind::power_on;
  /** For a deep-sleep wake: what woke the chip. */
  WakeMask woke_by;
  /** The raw ESP-IDF reset reason, reported in Started as is (protocol section 6). */
  std::uint8_t reset_cause = 0;
  /** The platform's reading of reset_cause: a watchdog, interrupt watchdog or panic reset. */
  bool watchdog_reset = false;
  /** Filled in by Device before the role sees the event. */
  RetainedStatus retained = RetainedStatus::none;
};

/**
 * True when this boot is a start-up in the sense of protocol section 6, Started: every start
 * except a deep-sleep wake with retained memory intact.
 */
constexpr bool is_start_up(const BootInfo& boot) {
  return !(boot.kind == BootKind::deep_sleep_wake && boot.retained == RetainedStatus::intact);
}

/** What the radio reported. */
enum class RadioEventKind : std::uint8_t {
  tx_done,
  rx_done,
  rx_timeout,
  rx_crc_error,
  /** A LoRa header was detected: a packet is arriving (the gateway must not send now). */
  header_seen,
  cad_done,
  /** The radio failed: no BUSY release, SPI error. */
  fault,
};

/** A radio interrupt. */
struct RadioEvent {
  RadioEventKind kind = RadioEventKind::tx_done;
  /** When the interrupt fired, captured in the ISR. */
  Instant at;
  /** rx_done: the packet, in the platform's buffer, valid only during handle(). */
  protocol::ByteView packet;
  std::int16_t rssi_dbm = 0;
  std::int8_t snr_quarter_db = 0;
  /** cad_done: activity was detected. */
  bool busy = false;
};

/** What a link reported. */
enum class LinkEventKind : std::uint8_t {
  up,
  down,
  packet,
};

/** A link event. */
struct LinkEvent {
  LinkKind link = LinkKind::usb;
  LinkEventKind kind = LinkEventKind::up;
  /** packet: one whole, de-framed packet, in the platform's buffer, valid only during handle(). */
  protocol::ByteView packet;
};

/** A debounced input level after a change. */
struct InputEvent {
  Input input = Input::door;
  bool active = false;
  Instant at;
};

/**
 * One event, stamped with the time it is delivered. Only the member matching `kind` is
 * meaningful.
 */
struct Event {
  Instant now;
  EventKind kind = EventKind::timer;
  BootInfo boot;
  RadioEvent radio;
  LinkEvent link;
  InputEvent input;

  static constexpr Event booted(Instant now, const BootInfo& boot) {
    Event event;
    event.now = now;
    event.kind = EventKind::boot;
    event.boot = boot;
    return event;
  }
  static constexpr Event timer_at(Instant now) {
    Event event;
    event.now = now;
    event.kind = EventKind::timer;
    return event;
  }
  static constexpr Event from_radio(Instant now, const RadioEvent& radio) {
    Event event;
    event.now = now;
    event.kind = EventKind::radio;
    event.radio = radio;
    return event;
  }
  static constexpr Event from_link(Instant now, const LinkEvent& link) {
    Event event;
    event.now = now;
    event.kind = EventKind::link;
    event.link = link;
    return event;
  }
  static constexpr Event from_input(Instant now, const InputEvent& input) {
    Event event;
    event.now = now;
    event.kind = EventKind::input;
    event.input = input;
    return event;
  }
};

}  // namespace hsn::device
