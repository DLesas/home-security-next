#pragma once

#include <cstdint>
#include <deque>
#include <functional>

#include "hsn/device/time.hpp"
#include "hsn/host/medium.hpp"
#include "hsn/host/scheduler.hpp"

namespace hsn::host {

/**
 * The test hub's own radio in direct radio mode, standing in for a gateway before any gateway role
 * exists. Ideal in what it hears: every data rate it is set to, on the site channel, at once. Real
 * in what matters to the devices: it sends on 869.525 MHz for exactly the time on air and is deaf
 * meanwhile, a packet for a fixed moment is skipped when the radio is busy then, and packets for
 * as soon as possible wait for the radio, siren commands first, unless their latest moment passes
 * (protocol section 7, "Reply timing and a busy gateway").
 */
class HubRadio final : public StationListener {
public:
  /** One packet to send. */
  struct Send {
    /** The packet, sent on 869.525 MHz. */
    Bytes packet;
    std::uint8_t data_rate = 5;
    std::int8_t power_dbm = 22;
    /** At `moment` exactly, or as soon as possible no later than `latest`. */
    bool at_moment = false;
    device::Instant moment;
    device::Instant latest = device::Instant::never();
    /** Siren commands go before everything else waiting. */
    bool siren_command = false;
    /** The caller's number for the result. */
    std::uint64_t tag = 0;
  };

  enum class Outcome : std::uint8_t { sent, skipped_busy, too_late };

  /** Told how each send went, at the instant it did. */
  using Result = std::function<void(std::uint64_t tag, Outcome outcome, std::uint8_t data_rate)>;

  /** Told of every packet heard. */
  using Heard = std::function<void(const Bytes& packet, std::int16_t rssi_dbm,
                                   std::int8_t snr_quarter_db, std::uint8_t data_rate)>;

  /** Adds the radio to the medium, listening on the site channel at `data_rates` (one bit each). */
  HubRadio(Scheduler& scheduler, Medium& medium, ActorId actor, std::uint32_t site_frequency_hz,
           std::uint8_t data_rates, Heard heard, Result result);
  HubRadio(const HubRadio&) = delete;
  HubRadio& operator=(const HubRadio&) = delete;

  /** Queues or schedules a packet. */
  void send(Send send);

  /** The radio on the medium. */
  StationId station() const {
    return station_;
  }

  /** True while sending. */
  bool busy() const;

  // StationListener
  void tx_done(device::Instant at) override;
  void rx_done(device::Instant at, const Bytes& packet, std::int16_t rssi_dbm,
               std::int8_t snr_quarter_db, std::uint8_t data_rate) override;
  void rx_crc_error(device::Instant at) override;
  void rx_timeout(device::Instant at) override;
  void header_seen(device::Instant at) override;
  void cad_done(device::Instant at, bool busy) override;

private:
  void listen();
  void transmit(const Send& send);
  void next_waiting();

  Scheduler& scheduler_;
  Medium& medium_;
  StationId station_;
  std::uint32_t site_frequency_hz_;
  std::uint8_t data_rates_;
  Heard heard_;
  Result result_;
  std::deque<Send> waiting_;
};

}  // namespace hsn::host
