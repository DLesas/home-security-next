#pragma once

// A paired siren board driven by hand, event by event, without a simulation: for boot kinds,
// radio events and packets the bench's world does not produce on its own.

#include <cstring>
#include <optional>

#include "device_support.hpp"
#include "hsn/host/host_board.hpp"
#include "siren_support.hpp"

namespace hsn::test::siren {

using device::BootKind;
using device::Event;

/** One paired board, its instance for the current boot, and ways to feed it events. */
struct Bench {
  /** A board whose random source is seeded with `seed`. */
  explicit Bench(std::uint64_t seed = 1) : board(seed) {
    pair_board(board, protocol::Role::siren);
  }

  /**
   * Resets the board (RAM is lost, the sounder goes low), builds a fresh instance and delivers a
   * boot of `kind` at `when`.
   */
  void boot(BootKind kind, Instant when) {
    // A reset stops the chip: the sounder output goes low, as the hardware drives it.
    board.siren_io.drive_low_on_reset();
    instance.reset();
    instance.emplace(board, board.siren_io);
    board.clock.set(when);
    instance->runner.start(board.boot_event(kind));
  }

  /** Delivers an event at `when`. */
  void deliver(Event event, Instant when) {
    board.clock.set(when);
    event.now = when;
    instance->runner.deliver(event);
  }

  /** Brings the network link up at `when`. */
  void link_up(Instant when) {
    deliver(Event::from_link(when, board.network.up_event()), when);
  }

  /** Delivers a hub packet on the network link at `when`. */
  void wifi_packet(const Bytes& packet, Instant when) {
    deliver(Event::from_link(when, board.network.packet_event(packet)), when);
  }

  /** Delivers a timer event at `when`. */
  void timer(Instant when) {
    deliver(Event::timer_at(when), when);
  }

  /** Delivers a hub packet received by the radio at `when`. */
  void radio_packet(const Bytes& packet, Instant when) {
    deliver(Event::from_radio(when, board.radio.rx_done(when, packet)), when);
  }

  /** Delivers a radio event built by the fake radio at `when`. */
  void radio_event(const device::RadioEvent& radio, Instant when) {
    deliver(Event::from_radio(when, radio), when);
  }

  /** Lets the Runner wait until `when`: a timer event if the role is due, a feed otherwise. */
  void wait_until(Instant when) {
    board.clock.set(when);
    instance->runner.timed_out(when);
  }

  /** The role's next wake. */
  device::Wake wake() const {
    return instance->role.next_wake();
  }

  /**
   * Moves the periodic timers (reports, checks, Started on LoRa) out of a test's way, as a
   * retained copy that passed its CRC would carry them, so their random phase cannot interleave
   * with what the test scripts by hand.
   */
  void quiet_timers() {
    const Instant far = at_seconds(100000);
    set_timer(roles::siren::SirenTimer::wifi_report, far);
    set_timer(roles::siren::SirenTimer::lora_check, far);
    set_timer(roles::siren::SirenTimer::started_lora, far);
  }

  /** Arms one of the role's timers by hand, through its state bytes. */
  void set_timer(roles::siren::SirenTimer timer, Instant when) {
    roles::siren::SirenState edited = state();
    edited.timers.arm(timer, when);
    const protocol::MutableByteView bytes = instance->role.state_bytes();
    REQUIRE(bytes.size() == sizeof(edited));
    std::memcpy(bytes.data(), &edited, sizeof(edited));
  }

  /** A sound command of `seconds` with the hub's counter `counter`. */
  static Bytes sound(std::uint16_t secs, std::uint32_t counter) {
    protocol::SirenCommand command;
    command.action = action::sound_alarm;
    command.sound_seconds = secs;
    return hub_packet(command, counter, protocol::Binding::none(), kAddress,
                      protocol::PacketLimit::link);
  }

  const roles::siren::SirenState& state() const {
    return instance->role.state();
  }

  host::HostBoard board;
  std::optional<host::HostInstance<SirenRole>> instance;
};

}  // namespace hsn::test::siren
