#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

#include "hsn/device/events.hpp"
#include "hsn/device/hal/clock.hpp"
#include "hsn/device/hal/link.hpp"
#include "hsn/device/time.hpp"
#include "hsn/host/call_meter.hpp"

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

/** A USB or WebSocket link, recording connects and every packet sent. */
class FakeLink final : public device::Link, public Metered {
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

private:
  const device::Clock& clock_;
  device::LinkKind kind_;
  LinkObserver* observer_ = nullptr;
  bool up_ = false;
  Bytes rx_buffer_;
};

}  // namespace hsn::host
