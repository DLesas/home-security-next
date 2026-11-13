#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <limits>
#include <string>
#include <vector>

#include "hsn/device/time.hpp"
#include "hsn/host/packet_labels.hpp"

namespace hsn::host {

/** A device or the test hub, as the timeline names it. */
using ActorId = std::size_t;

/** No actor. */
constexpr ActorId kNoActor = std::numeric_limits<ActorId>::max();

/** What happened. The fields of Record each kind fills are listed with it. */
enum class RecordKind : std::uint8_t {
  /** Power came: the RTC starts. */
  power_on,
  /** A boot event was delivered. value: BootKind; flag: woken by the timer; rssi_dbm: reset cause.
   */
  boot,
  /** The device waits awake or in light sleep (recorded when the depth changes). value: depth. */
  wait,
  /** The device sleeps deep: RAM is lost. until: the timer (or never); value: wake input bits. */
  deep_sleep,
  /** The device asked for a restart, or a test restarted it. */
  restart,
  /** Power was lost: retained memory is gone. */
  power_loss,
  /** An input changed. value: device::Input; flag: its new level. */
  input,
  /** A packet went on the air. from/until: on air; frequency, data rate, rssi_dbm: power; label. */
  transmission,
  /** A packet was received. peer: the sender; transmission; rssi and snr; label. */
  reception,
  /** A packet this receiver locked onto ended with a bad CRC (noise, an aborted send). */
  crc_error,
  /** A packet this receiver would have heard was lost to another on the air. peer: the sender. */
  collision,
  /** A receive started. until: its timeout (never: continuous); value: data-rate bits. */
  rx_window,
  /** A timed receive ended with nothing. */
  rx_timeout,
  /** A channel activity detection ended. from: its start; flag: busy. */
  channel_check,
  /** A flash record was written. value: StoreKey; length: bytes; flag: the write failed. */
  flash_write,
  /** A flash record, or all but the role, was erased. value: StoreKey, or 0xFF for all. */
  flash_erase,
  /** A handle() changed the retained block. value: bytes changed. */
  retained_write,
  /** The siren's sounder output changed. flag: on. */
  output,
  /** The sensor's buzzer changed. value: device::Sound. */
  buzzer,
  /** A status LED changed. value: device::Blink. */
  led,
  /** A link came up on the device's side. value: LinkKind. */
  link_up,
  /** A link went down on the device's side. value: LinkKind. */
  link_down,
  /** The device sent a packet on a link. value: LinkKind; label. */
  link_sent,
  /** The device received a packet on a link. value: LinkKind; label. */
  link_received,
};

/** Returns the snake-case name of a record kind. */
const char* record_kind_name(RecordKind kind);

/** One thing that happened, at a true instant, to one actor. Unused fields stay zero. */
struct Record {
  /** When it happened, in true time. */
  device::Instant at;
  /** Whom it happened to: the transmitter, the receiver, the device. */
  ActorId actor = kNoActor;
  RecordKind kind = RecordKind::boot;
  /** Spans: the start (a transmission's is `at`). */
  device::Instant from;
  /** Spans: the end, or a planned instant. */
  device::Instant until;
  std::uint32_t frequency_hz = 0;
  std::uint8_t data_rate = 0;
  std::int16_t rssi_dbm = 0;
  std::int8_t snr_quarter_db = 0;
  bool flag = false;
  std::uint32_t value = 0;
  std::uint16_t length = 0;
  PacketLabel label;
  /** The other actor: a reception's or collision's sender. */
  ActorId peer = kNoActor;
  /** The transmission a reception, crc error or collision is about (Medium's number). */
  std::uint64_t transmission = 0;
};

class Selection;

/**
 * Everything that happened in a simulation, in true-time order: the Medium, the link wires and the
 * devices append as things happen. Ask questions with select() and the Selection filters.
 */
class Timeline {
public:
  /** Names a new actor and returns its id. */
  ActorId add_actor(const std::string& name);

  /** Returns an actor's name. */
  const std::string& actor_name(ActorId actor) const;

  /** Appends a record; records must come in time order, which the scheduler guarantees. */
  void add(const Record& record);

  /** Every record, in time order. */
  const std::vector<Record>& records() const {
    return records_;
  }

  /** Returns every record, ready to be filtered. */
  Selection select() const;

  /** Returns one actor's records. */
  Selection of(ActorId actor) const;

  /** Returns one record as a line of text. */
  std::string describe(const Record& record) const;

  /** Forgets every record (long runs that only check the end state). */
  void clear() {
    records_.clear();
  }

  /** Is told of every record as it is added: the real-time bench streams them (hsn_bench). */
  void set_listener(std::function<void(const Record&)> listener) {
    listener_ = std::move(listener);
  }

private:
  std::vector<std::string> actors_;
  std::vector<Record> records_;
  std::function<void(const Record&)> listener_;
};

/**
 * A filtered view of the timeline, built by chaining: every filter returns a new selection, and
 * nothing is copied until a question is asked. Times are true times; `between` is half-open.
 *
 *   CHECK(sim.timeline().of(door.actor()).kind(RecordKind::transmission)
 *             .between(at(seconds(0)), at(seconds(10))).type_names() == "door_changed");
 */
class Selection {
public:
  /** Everything on the timeline. */
  explicit Selection(const Timeline& timeline) : timeline_(&timeline) {}

  /** Only this actor's records. */
  Selection of(ActorId actor) const;

  /** Only records of this kind; calling it again adds another kind. */
  Selection kind(RecordKind kind) const;

  /** Only records with from ≤ at < to. */
  Selection between(device::Instant from, device::Instant to) const;

  /** Only records labelled with this message type. */
  Selection type(std::uint8_t message_type) const;

  /** Only records the predicate accepts. */
  Selection where(std::function<bool(const Record&)> predicate) const;

  /** Returns how many records are selected. */
  std::size_t count() const;

  /** True when nothing is selected. */
  bool empty() const {
    return count() == 0;
  }

  /** Returns copies of the selected records. */
  std::vector<Record> records() const;

  /** Returns the message types, in order. */
  std::vector<std::uint8_t> message_types() const;

  /** Returns the message type names joined by ", " ("door_changed, reply"), "unknown" for 0. */
  std::string type_names() const;

  /** Returns the total airtime of the selected transmissions. */
  device::Duration airtime() const;

  /**
   * Returns the most airtime the selected transmissions use in any window of `window` (a window
   * that cuts a transmission counts the part inside it).
   */
  device::Duration busiest(device::Duration window) const;

  /** Returns busiest(one hour): compare with 36 s for 1% of the hour. */
  device::Duration busiest_hour() const {
    return busiest(device::seconds(3600));
  }

  /** Returns the selected records as text, one per line, for failure messages. */
  std::string dump() const;

private:
  template <typename Visit>
  void each(Visit visit) const;

  const Timeline* timeline_;
  ActorId actor_ = kNoActor;
  std::uint32_t kinds_ = 0;
  device::Instant from_;
  device::Instant to_ = device::Instant::never();
  bool typed_ = false;
  std::uint8_t type_ = 0;
  std::vector<std::function<bool(const Record&)>> predicates_;
};

}  // namespace hsn::host
