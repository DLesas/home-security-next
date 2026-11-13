#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "hsn/device/time.hpp"
#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/packet.hpp"
#include "hsn/roles/gateway/constants.hpp"

namespace hsn::roles::gateway {

/** When a transmit request goes out (protocol section 6, transmit request). */
enum class TransmitTiming : std::uint8_t {
  /** Exactly at a moment on the gateway's clock, or not at all. */
  at_time,
  /** As soon as the radio is free, starting no later than a latest moment. */
  as_soon_as_possible,
};

/** One transmit request waiting for the radio; its packet is kept beside it in the queue. */
struct TransmitEntry {
  bool used = false;
  /** The request's counter, which its result names. */
  std::uint32_t counter = 0;
  TransmitTiming timing = TransmitTiming::as_soon_as_possible;
  /** at_time: the moment; as_soon_as_possible: the latest start, or never for no limit. */
  device::Instant when = device::Instant::never();
  std::uint8_t data_rate = 0;
  std::int8_t power_dbm = 0;
  /** Priority 1: may use the kept-back airtime and goes before other requests. */
  bool siren_command = false;
  std::uint8_t size = 0;
  /** Arrival order, for first come first served within a priority. */
  std::uint32_t order = 0;
  /**
   * A siren command held back by D111's gap past the legal hour: not sent before `not_before`.
   */
  bool deferred = false;
  device::Instant not_before;
};

/**
 * The bounded queue of transmit requests (design section 7, gateway): kTransmitQueueSize entries,
 * each with room for a whole radio packet. Pure bookkeeping, no hardware: the role decides when
 * the radio is free. Every search is bounded by the queue's size.
 */
class TransmitQueue {
public:
  /** "No entry". */
  static constexpr std::size_t kNone = kTransmitQueueSize;

  /**
   * Returns how many requests wait.
   */
  std::size_t size() const;

  bool full() const {
    return size() == kTransmitQueueSize;
  }

  bool empty() const {
    return size() == 0;
  }

  /**
   * Copies a request and its packet (at most 255 bytes) into a free entry and returns it, or
   * kNone when the queue is full or the packet too long.
   */
  std::size_t add(const TransmitEntry& entry, protocol::ByteView packet);

  /**
   * Returns the newest request that is not a siren command, the one a siren command displaces
   * from a full queue, or kNone.
   */
  std::size_t newest_routine() const;

  /**
   * Returns the "at a given time" request whose moment has come (the earliest such), or kNone.
   */
  std::size_t due_at_time(device::Instant now) const;

  /**
   * The one rule of lateness (protocol section 6): "at a given time" more than kMomentTolerance
   * after its moment, "as soon as possible" after its latest moment.
   */
  static bool too_late(const TransmitEntry& entry, device::Instant now);

  /**
   * Returns a request that is too late by that rule, or kNone.
   */
  std::size_t expired(device::Instant now) const;

  /**
   * Returns the "as soon as possible" request to send next: siren commands first, then the
   * oldest, leaving out those deferred; or kNone.
   */
  std::size_t next_as_soon_as_possible() const;

  /**
   * Holds a request back until `until` (D111's gap).
   */
  void defer(std::size_t index, device::Instant until);

  /**
   * Lets every deferral that has run out go: call before choosing what to send.
   */
  void end_deferrals(device::Instant now);

  /**
   * Returns the next instant a request needs the role: the earliest moment of an "at a given
   * time" request, the first instant an "as soon as possible" one is too late, or the end of a
   * deferral; never when nothing waits for a time.
   */
  device::Instant next_deadline() const;

  const TransmitEntry& entry(std::size_t index) const {
    return entries_[index < kTransmitQueueSize ? index : 0];
  }

  /**
   * Returns the packet of an entry.
   */
  protocol::ByteView packet(std::size_t index) const;

  /**
   * Frees an entry.
   */
  void remove(std::size_t index);

  /**
   * Frees every entry and returns how many there were.
   */
  std::size_t clear();

private:
  std::array<TransmitEntry, kTransmitQueueSize> entries_{};
  std::array<std::array<std::uint8_t, protocol::kMaxRadioPacketSize>, kTransmitQueueSize>
      packets_{};
  std::uint32_t next_order_ = 0;
};

}  // namespace hsn::roles::gateway
