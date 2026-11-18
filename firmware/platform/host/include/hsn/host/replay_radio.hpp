#pragma once

#include <cstdint>
#include <string>

#include "hsn/device/hal/radio.hpp"
#include "hsn/host/medium.hpp"
#include "hsn/host/simulation.hpp"

namespace hsn::host {

/**
 * Someone with a radio and a recorder near the home (m3-updates-design.md section 7): a station on
 * the Medium, its own actor on the timeline, that sends again a transmission the Medium kept, or
 * any bytes a test made. It hears nothing. Call Medium::keep_transmissions(true) before the packets
 * to replay are sent.
 */
class ReplayRadio final : public StationListener {
public:
  /** A station named `name` on `sim`'s Medium. */
  explicit ReplayRadio(Simulation& sim, const std::string& name = "replayer");
  ReplayRadio(const ReplayRadio&) = delete;
  ReplayRadio& operator=(const ReplayRadio&) = delete;

  /** Its station, for path losses. */
  StationId station() const {
    return station_;
  }

  /** Its actor on the timeline. */
  ActorId actor() const {
    return actor_;
  }

  /** Sends a kept transmission again now; returns the replay's transmission number. */
  std::uint64_t replay(std::uint64_t transmission, std::int8_t power_dbm = 14);

  /** Sends `packet` now on `channel`; returns its transmission number. */
  std::uint64_t send(const Bytes& packet, const device::RadioChannel& channel,
                     std::int8_t power_dbm = 14);

  /** Transmissions it finished. */
  std::uint32_t sent() const {
    return sent_;
  }

  // StationListener
  void tx_done(device::Instant at) override;
  void rx_done(device::Instant, const Bytes&, std::int16_t, std::int8_t, std::uint8_t) override {}
  void rx_crc_error(device::Instant) override {}
  void rx_timeout(device::Instant) override {}
  void header_seen(device::Instant) override {}
  void cad_done(device::Instant, bool) override {}

private:
  Simulation& sim_;
  ActorId actor_;
  StationId station_;
  std::uint32_t sent_ = 0;
};

}  // namespace hsn::host
