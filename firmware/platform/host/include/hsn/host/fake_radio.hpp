#pragma once

#include <cstdint>
#include <vector>

#include "hsn/device/events.hpp"
#include "hsn/device/hal/clock.hpp"
#include "hsn/device/hal/radio.hpp"
#include "hsn/device/time.hpp"
#include "hsn/host/call_meter.hpp"
#include "hsn/host/power_cut.hpp"

namespace hsn::host {

using Bytes = std::vector<std::uint8_t>;

/** What the fake radio is doing, for a test or step B's Medium to see. */
enum class RadioMode {
  sleeping,
  standby,
  transmitting,
  receiving,
  detecting,
};

/** One call the device made. */
struct RadioCall {
  enum class Kind { transmit, receive, detect_activity, noise, sleep, recover };
  device::Instant at;
  Kind kind = Kind::transmit;
  device::RadioChannel channel;
  std::int8_t power_dbm = 0;
  Bytes packet;
  device::RxParams rx;
  device::CadParams cad;
  bool warm = false;
  device::HalError result = device::HalError::none;
};

class FakeRadio;

/**
 * Told about every operation the device starts, and every noise reading just before it is
 * returned. The seam for the shared Medium: it watches each board's radio here, and answers
 * through FakeRadio's event builders.
 */
class RadioObserver {
public:
  virtual void operation_started(FakeRadio& radio, const RadioCall& call) = 0;

protected:
  ~RadioObserver() = default;
};

/**
 * The SX1262. Records every call and keeps the mode; delivers nothing by itself. A test or the
 * Medium builds the events with the builders below, which also move the mode as the chip would
 * (a timed receive ends in standby, a continuous one keeps receiving) and keep a received
 * packet in the radio's own buffer, as the platform does. While the board's power is cut, a call
 * does nothing: it is not recorded and nothing goes on the air.
 */
class FakeRadio final : public device::Radio, public Metered, public Powered {
public:
  explicit FakeRadio(const device::Clock& clock) : clock_(clock) {}

  device::HalError transmit(const device::RadioChannel& channel, std::int8_t power_dbm,
                            protocol::ByteView packet) override;
  device::HalError receive(const device::RxParams& params) override;
  device::HalError detect_activity(const device::CadParams& params) override;
  device::HalResult<std::int16_t> noise_dbm() override;
  device::HalError sleep(bool warm) override;
  device::HalError recover() override;

  RadioMode mode() const {
    return mode_;
  }
  const device::RadioChannel& channel() const {
    return channel_;
  }
  const device::RxParams& rx_params() const {
    return rx_;
  }

  /** Calls of one kind. */
  std::vector<RadioCall> calls_of(RadioCall::Kind kind) const;

  device::RadioEvent tx_done(device::Instant at);
  device::RadioEvent rx_done(device::Instant at, const Bytes& packet, std::int16_t rssi_dbm = -80,
                             std::int8_t snr_quarter_db = 20);
  device::RadioEvent rx_timeout(device::Instant at);
  device::RadioEvent rx_crc_error(device::Instant at);
  device::RadioEvent header_seen(device::Instant at);
  device::RadioEvent cad_done(device::Instant at, bool busy);
  device::RadioEvent fault(device::Instant at);

  void set_observer(RadioObserver* observer) {
    observer_ = observer;
  }

  std::vector<RadioCall> calls;
  /** Fault switches: the next call fails with this; every call fails. */
  device::HalError fail_next = device::HalError::none;
  bool refuse_all = false;
  /** What noise_dbm() reads while receiving. */
  std::int16_t noise = -115;

private:
  device::HalError record(RadioCall call);

  const device::Clock& clock_;
  RadioObserver* observer_ = nullptr;
  RadioMode mode_ = RadioMode::sleeping;
  device::RadioChannel channel_;
  device::RxParams rx_;
  Bytes rx_buffer_;
};

}  // namespace hsn::host
