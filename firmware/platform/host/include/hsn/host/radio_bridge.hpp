#pragma once

#include <functional>

#include "hsn/device/events.hpp"
#include "hsn/device/time.hpp"
#include "hsn/host/fake_radio.hpp"
#include "hsn/host/medium.hpp"
#include "hsn/host/timeline.hpp"

namespace hsn::host {

/**
 * Connects one board's FakeRadio to the Medium: every operation the device starts becomes the
 * station's operation, and every result comes back as the fake's own event, built by its event
 * builders at the true instant it happens (so the fake's mode moves as the chip's would) and
 * handed to the device. A noise reading returns what the medium has on air at that moment.
 */
class RadioBridge final : public RadioObserver, public StationListener {
public:
  /** Builds a radio event at a local instant. */
  using Build = std::function<device::RadioEvent(device::Instant local_at)>;

  /** Hands an event to the device, which turns the true instant into its own clock. */
  using Deliver = std::function<void(const Build& build)>;

  /** Adds the board's radio to the medium and watches it; `deliver` runs synchronously. */
  RadioBridge(FakeRadio& radio, Medium& medium, ActorId actor, Deliver deliver);
  RadioBridge(const RadioBridge&) = delete;
  RadioBridge& operator=(const RadioBridge&) = delete;
  ~RadioBridge();

  /** The board's station on the medium. */
  StationId station() const {
    return station_;
  }

  /** Puts the radio to sleep for a reset or a deep sleep, as the platform does. */
  void quiesce();

  // RadioObserver
  void operation_started(FakeRadio& radio, const RadioCall& call) override;

  // StationListener
  void tx_done(device::Instant at) override;
  void rx_done(device::Instant at, const Bytes& packet, std::int16_t rssi_dbm,
               std::int8_t snr_quarter_db, std::uint8_t data_rate) override;
  void rx_crc_error(device::Instant at) override;
  void rx_timeout(device::Instant at) override;
  void header_seen(device::Instant at) override;
  void cad_done(device::Instant at, bool busy) override;

private:
  FakeRadio& radio_;
  Medium& medium_;
  StationId station_;
  Deliver deliver_;
};

}  // namespace hsn::host
