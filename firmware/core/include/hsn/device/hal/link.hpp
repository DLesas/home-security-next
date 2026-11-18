#pragma once

#include <cstdint>

#include "hsn/device/status.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/setup.hpp"

namespace hsn::device {

/**
 * Which link: the USB serial port, the WebSocket over Wi-Fi, or a Bluetooth connection from a
 * phone. Bluetooth carries transfer frames only (m3-updates-design.md section 5): Device hands its
 * events to UpdateService, and the role never sees them.
 */
enum class LinkKind : std::uint8_t {
  usb,
  network,
  bluetooth,
};

/** Where a network link connects: the paired hub, found by mDNS, over this Wi-Fi network. */
struct LinkTarget {
  protocol::HubIdentity hub{};
  protocol::ByteView wifi_name;
  protocol::ByteView wifi_password;
};

/** How often a network link pings the hub over the WebSocket (protocol section 7). */
constexpr Duration kLinkPingInterval = seconds(15);

/** How long without an answer to a ping before a network link reports `down`. */
constexpr Duration kLinkDeadAfter = seconds(15);

/** How many received packets the platform queues before it drops the newest. */
constexpr std::uint8_t kLinkReceiveQueue = 4;

/**
 * A stream link to the hub, USB or WebSocket, carrying one whole packet at a time (D101), or a
 * transfer frame (0xF2). A Bluetooth link has the same shape: it is up while a phone is connected
 * and subscribed, `connect` opens the update window (advertising), `disconnect` ends it, and one
 * packet is one write or notification of at most the agreed MTU less 3 bytes.
 *
 * The platform does the framing (COBS with the core's FrameDecoder and encode_frame on USB, one
 * binary message on WebSocket), the Wi-Fi join, the mDNS lookup with its identity check, and the
 * WebSocket itself with its own reconnect turned off: the core times reconnects. A network link
 * pings every kLinkPingInterval and reports `down` after kLinkDeadAfter without an answer, which
 * is how a siren knows a Wi-Fi report has failed (protocol section 7). Received packets arrive as
 * LinkEvents; up to kLinkReceiveQueue are queued, and overflow drops the newest. On a UART link
 * the console is silenced.
 */
class Link {
public:
  /**
   * Returns which link this is.
   */
  virtual LinkKind kind() const = 0;

  /**
   * Starts connecting and returns at once; `up` or `down` follows as an event. A USB link
   * ignores the target.
   */
  virtual HalError connect(const LinkTarget& target) = 0;

  /**
   * Closes the link; no `down` event follows.
   */
  virtual void disconnect() = 0;

  /**
   * Queues one whole packet, at most 1,024 bytes, copying it. HalError::busy when the send queue
   * is full, HalError::io when the link is down.
   */
  virtual HalError send(protocol::ByteView packet) = 0;

  /**
   * Returns true while the link is up. A UART link without host sensing is always up.
   */
  virtual bool up() const = 0;

  /**
   * Returns the Wi-Fi signal strength in dBm, signed, as the gateway status carries it (protocol
   * section 6): 0 for a USB link, or when it is not known (no association yet).
   */
  virtual std::int8_t signal_dbm() const = 0;

  /**
   * Returns the most bytes one packet may hold on this link as it is now. On Bluetooth, the
   * payload of one write or notification on the connection that is up: the MTU agreed with the
   * phone less 3 (182 at an MTU of 185, 514 at 517). 0 when not known (no connection yet, or a
   * link that does not say); a USB or network link may always answer 0, since the core never
   * sends more than 1,024 bytes there.
   */
  virtual std::uint16_t largest_packet() const = 0;

protected:
  Link() = default;
  Link(const Link&) = default;
  Link& operator=(const Link&) = default;
  ~Link() = default;
};

}  // namespace hsn::device
