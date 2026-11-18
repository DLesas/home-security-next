#pragma once

#include <cstdint>
#include <functional>
#include <vector>

#include "hsn/device/events.hpp"
#include "hsn/device/time.hpp"
#include "hsn/host/fake_link.hpp"
#include "hsn/host/packet_labels.hpp"
#include "hsn/host/scheduler.hpp"
#include "hsn/host/timeline.hpp"

namespace hsn::host {

class LinkWire;

/**
 * The far end of a device's link: the test hub (or, later, the bridge to the real hub). Each call
 * happens at the true instant the hub side learns of it.
 */
class LinkPeer {
public:
  /** The device's connect reached the hub: the link is up at both ends. */
  virtual void link_up(LinkWire& wire) = 0;

  /** The link closed: the device disconnected or reset, or the hub dropped it. */
  virtual void link_down(LinkWire& wire) = 0;

  /** A whole packet from the device. */
  virtual void link_packet(LinkWire& wire, const Bytes& packet) = 0;

protected:
  ~LinkPeer() = default;
};

/**
 * One device link (USB, WebSocket or Bluetooth) and the wire to whatever is at the other end, with
 * a fixed one-way latency. A USB or network connect reaches an attached peer and comes back `up`;
 * with no peer, `down` comes after kLinkDeadAfter, as the platform's ping would report. A
 * Bluetooth connect starts advertising: a phone (the peer) attached then, or attached later while
 * it advertises, connects and the link comes `up`; with none, nothing comes back. A network or
 * Bluetooth link carries packets only while up; a USB link carries them whenever a peer is
 * attached, as a serial port does. A Bluetooth session the device closes still delivers what the
 * device sent before closing (its Done), then the phone learns of the close.
 * Packets and state changes reach the device only while it runs: a device in deep sleep or
 * rebooting loses them. Every packet either way, and every up and down, goes on the timeline.
 */
class LinkWire final : public LinkObserver {
public:
  /** Builds a link event at the moment of delivery. */
  using Build = std::function<device::LinkEvent()>;

  /** Hands an event to the device if it runs; returns false when it was lost. */
  using Deliver = std::function<bool(const Build& build)>;

  /** Watches `link` (as its observer) and hands its events to the device through `deliver`. */
  LinkWire(Scheduler& scheduler, Timeline& timeline, const PacketLabels& labels, ActorId device,
           FakeLink& link, Deliver deliver);
  LinkWire(const LinkWire&) = delete;
  LinkWire& operator=(const LinkWire&) = delete;
  ~LinkWire();

  /** Puts a peer at the other end, `latency` away each way. */
  void attach(LinkPeer& peer, device::Duration latency);

  /** Removes the peer; an open connection drops on the device's side at once. */
  void detach();

  /** True while the hub side holds an open connection. */
  bool connected() const {
    return connected_;
  }

  /** True while a Bluetooth link advertises: from its connect to its disconnect or a reset. */
  bool advertising() const {
    return advertising_;
  }

  /**
   * The phone connects again to a Bluetooth link that still advertises (after a drop); false when
   * it cannot: not Bluetooth, not advertising, already connected, or no peer.
   */
  bool peer_connect();

  /** True when a peer is attached. */
  bool attached() const {
    return peer_ != nullptr;
  }

  /** The device's link. */
  FakeLink& link() {
    return link_;
  }

  /** The device this wire belongs to. */
  ActorId device() const {
    return device_;
  }

  /** The peer sends a packet; it arrives after the latency if the link still carries it. */
  void send_to_device(const Bytes& packet);

  /**
   * The peer or the network ends the connection: the peer is told at once, the device after
   * `noticed_after` (a network link notices by its ping, design section 3).
   */
  void drop(device::Duration noticed_after = device::Duration{});

  /**
   * The device reset or slept deep: its link is gone, without an event on its side, and what
   * travels towards it is lost. With `finish_sending` (a restart the device asked for through the
   * waiter), what it had already sent still reaches the peer, for at most kRestartGrace, and the
   * hub side closes after it; otherwise (power loss, deep sleep, a scripted restart) that is lost
   * too and the hub side closes at once.
   */
  void device_reset(bool finish_sending = false);

  /** How long a restart lets the links finish sending (firmware-design.md, Waiter). */
  static constexpr device::Duration kRestartGrace = device::milliseconds(200);

  // LinkObserver
  void packet_sent(FakeLink& link, protocol::ByteView packet) override;
  void connect_requested(FakeLink& link) override;
  void disconnected(FakeLink& link) override;

private:
  void record(RecordKind kind, const Bytes* packet);
  bool carries() const;
  void close_hub_side();
  void lose_in_flight();
  void start_connection();

  Scheduler& scheduler_;
  Timeline& timeline_;
  const PacketLabels& labels_;
  ActorId device_;
  FakeLink& link_;
  Deliver deliver_;
  device::LinkKind kind_;
  LinkPeer* peer_ = nullptr;
  device::Duration latency_;
  bool connected_ = false;
  bool advertising_ = false;
  /** A connection is on its way (its `up` scheduled); bumping the generation cancels it. */
  bool connecting_ = false;
  /** Bumped when the connection changes; packets in flight on an older one are lost. */
  std::uint64_t generation_ = 0;
  /** The same for packets from the device, which a restart lets finish. */
  std::uint64_t sending_ = 0;
};

}  // namespace hsn::host
