#pragma once

#include <cstdint>

#include "hsn/device/status.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/setup.hpp"

namespace hsn::device {

/** Which link: the USB serial port, or the WebSocket over Wi-Fi. */
enum class LinkKind : std::uint8_t {
  usb,
  network,
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
 * A stream link to the hub, USB or WebSocket, carrying one whole packet at a time (D101).
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

protected:
  Link() = default;
  Link(const Link&) = default;
  Link& operator=(const Link&) = default;
  ~Link() = default;
};

}  // namespace hsn::device
