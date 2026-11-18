#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <map>
#include <utility>
#include <vector>

#include "hsn/device/hal/radio.hpp"
#include "hsn/device/time.hpp"
#include "hsn/host/lora_physics.hpp"
#include "hsn/host/packet_labels.hpp"
#include "hsn/host/scheduler.hpp"
#include "hsn/host/timeline.hpp"

namespace hsn::host {

using Bytes = std::vector<std::uint8_t>;

/** A radio on the medium. */
using StationId = std::size_t;

/**
 * What a station's radio reports, each call made at its true instant. A FakeRadio's bridge turns
 * these into the fake's events; the test hub's ideal radio uses them directly.
 */
class StationListener {
public:
  /** The packet being sent has been sent; the radio is in standby. */
  virtual void tx_done(device::Instant at) = 0;

  /** A packet arrived whole, at this strength; a timed receive is over, a continuous goes on. */
  virtual void rx_done(device::Instant at, const Bytes& packet, std::int16_t rssi_dbm,
                       std::int8_t snr_quarter_db, std::uint8_t data_rate) = 0;

  /** A packet the radio locked onto did not survive (a collision, noise, an aborted send). */
  virtual void rx_crc_error(device::Instant at) = 0;

  /** A timed receive ended with no preamble (or header, by its stop rule) in time. */
  virtual void rx_timeout(device::Instant at) = 0;

  /** The explicit header of a packet being received has arrived (the gateway must not send). */
  virtual void header_seen(device::Instant at) = 0;

  /** A channel activity detection ended; `busy` when a matching packet was on air. */
  virtual void cad_done(device::Instant at, bool busy) = 0;

protected:
  ~StationListener() = default;
};

/** One receive, as the medium sees it. */
struct Listening {
  std::uint32_t frequency_hz = 0;
  /** One bit per data rate heard; a chip hears one, the hub's ideal radio may hear several. */
  std::uint8_t data_rates = 0;
  /** Zero: continuous. */
  device::Duration timeout;
  device::RxStop stop = device::RxStop::preamble;
  std::uint8_t symbol_timeout = 0;
};

/** The medium's physics. */
struct MediumOptions {
  double capture_margin_db = kDefaultCaptureMarginDb;
  /** Path loss between stations with no entry in the table: everyone hears everyone. */
  double default_path_loss_db = 100.0;
  double noise_floor_dbm = kThermalNoiseDbm;
};

/**
 * The shared radio channel (design section 8). Transmissions occupy true time for exactly their
 * protocol time on air. A receiver hears a packet only when it was listening on the same frequency
 * and data rate from the start of the preamble to the end and did not transmit meanwhile (a
 * gateway is deaf while it sends). Two overlapping packets on the same frequency and data rate are
 * both lost at a receiver unless one arrives stronger by the capture margin; different data rates
 * never collide. RSSI comes from a path-loss table per pair, SNR from the noise floor and any
 * scripted noise on that frequency; a packet below the demodulation SNR of its spreading factor is
 * not heard, and does not make a channel activity detection busy.
 *
 * The chip's contract (core Radio): every operation cancels the current one without an event; a
 * timed receive times out unless a preamble (or a header, by its stop rule) was detected before
 * its timeout, and a detected packet is received to its end however long it takes; a timed receive
 * ends after one packet, a continuous one goes on; header_seen comes 20.25 symbols into a packet;
 * a locked packet that does not survive ends in rx_crc_error.
 */
class Medium {
public:
  /** A medium on the simulation's scheduler, recording on its timeline. */
  Medium(Scheduler& scheduler, Timeline& timeline, const PacketLabels& labels,
         MediumOptions options = {});
  Medium(const Medium&) = delete;
  Medium& operator=(const Medium&) = delete;

  /** Adds a radio, asleep, recorded on the timeline as `actor`. */
  StationId add_station(ActorId actor, StationListener& listener);

  /** Sets the path loss between two stations, both ways. */
  void set_path_loss(StationId a, StationId b, double loss_db);

  /** Sets the path loss from one station to another only. */
  void set_path_loss_one_way(StationId from, StationId to, double loss_db);

  /** Makes two stations unable to hear each other at all. */
  void cut(StationId a, StationId b);

  /** Adds noise of `dbm` on one frequency during [from, until); overlapping scripts take the max.
   */
  void script_noise(std::uint32_t frequency_hz, device::Instant from, device::Instant until,
                    double dbm);

  /** Returns the noise level on a frequency at an instant. */
  double noise_dbm(std::uint32_t frequency_hz, device::Instant at) const;

  /** Returns the weakest signal a data rate hears over the plain noise floor. */
  double sensitivity_dbm(std::uint8_t data_rate) const;

  /** Returns the signal strength `to` receives `from` at, sending at `power_dbm`. */
  double received_dbm(StationId from, StationId to, double power_dbm) const;

  /**
   * Starts sending `packet`: on air from now for its time on air; tx_done at the end. Returns the
   * transmission's number. Throws SimulationError for an unlisted data rate or over 255 bytes.
   */
  std::uint64_t transmit(StationId station, const device::RadioChannel& channel,
                         std::int8_t power_dbm, const Bytes& packet);

  /**
   * Keeps every transmission's bytes from now on (off: from now on none), so replay() can send one
   * again. Off by default, since a year-long run would keep them all.
   */
  void keep_transmissions(bool keep) {
    keep_ = keep;
  }

  /** True when a transmission's bytes are kept (it was sent while keeping was on). */
  bool kept(std::uint64_t transmission) const {
    return archive_.count(transmission) != 0;
  }

  /** A kept transmission's bytes; throws SimulationError when it was not kept. */
  const Bytes& kept_packet(std::uint64_t transmission) const;

  /**
   * Sends a kept transmission again (m3-updates-design.md section 7, "How it is proven"): its
   * bytes, on its channel and data rate, from `station`, at `power_dbm`. The replay is a new
   * transmission, recorded as one on the timeline, and heard by whoever hears `station`. Returns
   * its number. Throws SimulationError when the transmission was not kept.
   */
  std::uint64_t replay(std::uint64_t transmission, StationId station, std::int8_t power_dbm);

  /** Starts a receive. */
  void receive(StationId station, const Listening& listening);

  /** Starts a channel activity detection; cad_done after its duration. */
  void detect(StationId station, const device::CadParams& params);

  /** Stops whatever the station is doing, without an event: sleep, standby, reset, power off. */
  void standby(StationId station);

  /**
   * Returns what the station's radio would read as instantaneous RSSI on its last frequency: the
   * noise there plus every packet on air there.
   */
  std::int16_t instant_rssi_dbm(StationId station) const;

  /** True while the station is sending. */
  bool transmitting(StationId station) const;

  /** True while the station is locked onto an arriving packet (after its preamble). */
  bool receiving_packet(StationId station) const;

  /** The physics in force. */
  const MediumOptions& options() const {
    return options_;
  }

  /** Changes the capture margin. */
  void set_capture_margin(double margin_db) {
    options_.capture_margin_db = margin_db;
  }

private:
  enum class Mode : std::uint8_t { standby, transmitting, receiving, detecting };

  struct Transmission {
    std::uint64_t id = 0;
    StationId from = 0;
    device::RadioChannel channel;
    std::int8_t power_dbm = 0;
    Bytes packet;
    device::Instant start;
    device::Instant end;
    bool aborted = false;
    PacketLabel label;
  };

  /** A receiver locked onto a packet on one data rate. */
  struct Lock {
    bool active = false;
    std::uint64_t transmission = 0;
    /** When the packet stops a timed receive's timer (preamble or header, by the stop rule). */
    device::Instant stops_timer_at;
  };

  struct Station {
    ActorId actor = kNoActor;
    StationListener* listener = nullptr;
    Mode mode = Mode::standby;
    /** Bumped by every operation; scheduled events of an older one do nothing. */
    std::uint64_t operation = 0;
    std::uint32_t frequency_hz = 0;
    Listening listening;
    device::Instant window_end = device::Instant::never();
    std::array<Lock, 6> locks{};
    /** Packets that ended the instant a new one took their lock: still to be delivered. */
    std::vector<std::uint64_t> finishing;
    std::uint64_t sending = 0;
  };

  Station& station(StationId id);
  const Station& station(StationId id) const;
  /** Ends the station's current operation without an event. */
  void cancel(StationId id);
  const Transmission* find(std::uint64_t id) const;
  Transmission* find(std::uint64_t id);
  void forget_old();
  double loss(StationId from, StationId to) const;
  double noise_max(std::uint32_t frequency_hz, device::Instant from, device::Instant until) const;
  bool audible(const Transmission& tx, StationId at, device::Instant when) const;
  void offer(const Transmission& tx, StationId receiver);
  void lock(StationId receiver, const Transmission& tx);
  void resolve(StationId receiver, std::uint64_t operation, std::uint64_t transmission);
  void time_out(StationId receiver, std::uint64_t operation);
  void finish_detection(StationId id, std::uint64_t operation, device::CadParams params,
                        device::Instant started);
  void record_about(RecordKind kind, StationId receiver, const Transmission& tx);
  Record record_for(StationId id, RecordKind kind) const;

  Scheduler& scheduler_;
  Timeline& timeline_;
  const PacketLabels& labels_;
  MediumOptions options_;
  std::vector<Station> stations_;
  std::map<std::pair<StationId, StationId>, double> path_loss_;
  struct NoiseScript {
    std::uint32_t frequency_hz;
    device::Instant from;
    device::Instant until;
    double dbm;
  };
  std::vector<NoiseScript> noise_;
  /** Recent transmissions, oldest first, numbered from 1. */
  std::deque<Transmission> recent_;
  std::uint64_t next_id_ = 1;
  /** Kept transmissions, for replay: their channel and bytes. */
  bool keep_ = false;
  struct Kept {
    device::RadioChannel channel;
    Bytes packet;
  };
  std::map<std::uint64_t, Kept> archive_;
};

}  // namespace hsn::host
