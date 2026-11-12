#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "hsn/device/events.hpp"
#include "hsn/device/hal/radio.hpp"
#include "hsn/device/services/airtime.hpp"
#include "hsn/device/services/log_buffer.hpp"
#include "hsn/device/services/random_source.hpp"
#include "hsn/device/status.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/packet.hpp"

namespace hsn::device {

/** How a packet goes out. */
struct Transmission {
  RadioChannel channel;
  std::int8_t power_dbm = 14;
  TxClass tx_class = TxClass::routine;
  /** Check the channel first (sensors and sirens, protocol section 2). */
  bool listen_first = true;
};

/** Busy checks before sending anyway (protocol section 2). */
constexpr std::uint8_t kMaxBusyChecks = 5;

/** The random wait after a busy check. */
constexpr Duration kBusyWaitMin = milliseconds(200);
constexpr Duration kBusyWaitMax = milliseconds(2000);

/** Extra time the port allows an operation beyond its expected length before recovering. */
constexpr Duration kRadioGuardMargin = milliseconds(100);

/** What the port is doing. */
enum class PortState : std::uint8_t {
  idle,
  checking,
  backing_off,
  sending,
  receiving,
};

/** What a radio event or a timer meant to the port. */
enum class PortResult : std::uint8_t {
  /** Nothing for the role. */
  none,
  /** The packet went out; PortReport::at is the end of the transmission. */
  sent,
  /** A packet arrived; the role reads it from the event. */
  received,
  /** A timed receive ended with nothing. */
  rx_timeout,
  /** A packet arrived with a bad CRC. */
  rx_error,
  /** An operation's event never came, or the radio failed: it was reset and is idle. */
  recovered,
  /** A send in progress ended without transmitting: the radio refused it. */
  not_sent,
};

/** The port's report on one event. */
struct PortReport {
  PortResult result = PortResult::none;
  Instant at;
};

/**
 * The sensor's and siren's use of the radio (design section 4): one outgoing packet at a time,
 * admitted against the airtime budget, sent after channel activity detection, recorded in the
 * budget; receives with a guard deadline. The port keeps nothing across deep sleep: a packet that
 * does not fit the budget is refused with the time it would fit, and the role sends a fresh one
 * then, with the newest state (protocol section 2).
 */
class RadioPort {
public:
  RadioPort(Radio& radio, AirtimeBudget& airtime, RandomSource& random, LogBuffer& log)
      : radio_(radio), airtime_(airtime), random_(random), log_(log) {}

  /**
   * Judges a packet of `length` bytes against the budget, without sending.
   */
  Admission check(const Transmission& transmission, std::size_t length, Instant now) const;

  /**
   * Starts sending a copy of `packet`. Status::deferred when it does not fit the budget (see
   * check() for when it will), Status::busy while another send is in progress, Status::refused
   * for an unlisted data rate or frequency, Status::radio_error when the radio refuses. A
   * receive in progress is cancelled.
   */
  Status send(protocol::ByteView packet, const Transmission& transmission, Instant now);

  /**
   * Starts a receive (timed or continuous). Status::busy while a send is in progress.
   */
  Status listen(const RxParams& params, Instant now);

  /**
   * Cancels whatever is going on and puts the radio to sleep.
   */
  void sleep(Instant now);

  /**
   * Interprets a radio event. The role passes every radio event here first.
   */
  PortReport on_radio(const RadioEvent& event, Instant now);

  /**
   * Runs the port's own deadline (busy wait over, or guard passed). Call when
   * `now >= next_deadline()`.
   */
  PortReport on_timer(Instant now);

  /**
   * Returns the port's next deadline, or never.
   */
  Instant next_deadline() const {
    return deadline_;
  }

  PortState state() const {
    return state_;
  }

  /**
   * Busy checks made for the packet being sent.
   */
  std::uint8_t busy_checks() const {
    return busy_checks_;
  }

private:
  Status start_check(Instant now);
  Status start_transmit(Instant now);
  PortReport recover(Instant now);

  Radio& radio_;
  AirtimeBudget& airtime_;
  RandomSource& random_;
  LogBuffer& log_;
  PortState state_ = PortState::idle;
  Instant deadline_ = Instant::never();
  Transmission transmission_;
  Band band_ = Band::g1;
  Duration airtime_needed_;
  std::uint8_t busy_checks_ = 0;
  bool continuous_ = false;
  std::uint8_t rx_data_rate_ = 0;
  Duration rx_timeout_;
  std::size_t size_ = 0;
  std::array<std::uint8_t, protocol::kMaxRadioPacketSize> packet_{};
};

}  // namespace hsn::device
