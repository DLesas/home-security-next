#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

#include "hsn/device/events.hpp"
#include "hsn/device/hal/clock.hpp"
#include "hsn/device/hal/link.hpp"
#include "hsn/device/time.hpp"
#include "hsn/host/call_meter.hpp"
#include "hsn/host/power_cut.hpp"

namespace hsn::host {

using Bytes = std::vector<std::uint8_t>;

class FakeLink;

/**
 * Told about every packet the device sends, and every connect and disconnect it starts. The seam
 * for the test hub's link wires and for the bridge to the real hub: they watch a board's link
 * here, and answer through FakeLink's event builders.
 */
class LinkObserver {
public:
  /** The device queued one packet; `packet` is valid during the call only. */
  virtual void packet_sent(FakeLink& link, protocol::ByteView packet) = 0;

  /** The device started connecting and connect() returned none; `up` or `down` must follow. */
  virtual void connect_requested(FakeLink& link) {
    static_cast<void>(link);
  }

  /** The device closed the link; no `down` event follows on the device's side. */
  virtual void disconnected(FakeLink& link) {
    static_cast<void>(link);
  }

protected:
  ~LinkObserver() = default;
};

/**
 * A USB, WebSocket or Bluetooth link, recording connects and every packet sent. A network or
 * Bluetooth link sends only while up; a USB link whenever asked, as a serial port does. While the
 * board's power is cut, a call does nothing: nothing is recorded or sent.
 */
class FakeLink final : public device::Link, public Metered, public Powered {
public:
  /** One packet the device sent. */
  struct Sent {
    device::Instant at;
    Bytes packet;
  };

  FakeLink(const device::Clock& clock, device::LinkKind kind) : clock_(clock), kind_(kind) {}

  device::LinkKind kind() const override {
    tick();
    return kind_;
  }
  device::HalError connect(const device::LinkTarget& target) override;
  void disconnect() override;
  device::HalError send(protocol::ByteView packet) override;
  bool up() const override {
    tick();
    return up_;
  }
  std::int8_t signal_dbm() const override {
    tick();
    return kind_ == device::LinkKind::network ? wifi_signal_dbm : std::int8_t{0};
  }
  std::uint16_t largest_packet() const override {
    tick();
    return largest_packet_bytes;
  }

  /** Builders for the events a platform would deliver; they also move the link's state. */
  device::LinkEvent up_event();
  device::LinkEvent down_event();
  device::LinkEvent packet_event(const Bytes& packet);

  void set_observer(LinkObserver* observer) {
    observer_ = observer;
  }

  std::vector<Sent> sent;
  std::size_t connects = 0;
  std::size_t disconnects = 0;
  device::LinkTarget last_target;
  /** Fault switches: sends are refused as by a full queue; connect fails. */
  bool refuse_sends = false;
  bool fail_connect = false;
  /**
   * The Wi-Fi signal strength a network link reports; 0 means not known. USB and Bluetooth always
   * say 0.
   */
  std::int8_t wifi_signal_dbm = 0;
  /** What largest_packet() reports: on Bluetooth the agreed MTU less 3; 0, not known. */
  std::uint16_t largest_packet_bytes = 0;

private:
  const device::Clock& clock_;
  device::LinkKind kind_;
  LinkObserver* observer_ = nullptr;
  bool up_ = false;
  Bytes rx_buffer_;
};

}  // namespace hsn::host
