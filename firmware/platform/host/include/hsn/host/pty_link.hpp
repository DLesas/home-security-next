#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "hsn/device/time.hpp"
#include "hsn/host/link_wire.hpp"
#include "hsn/host/sim_device.hpp"
#include "hsn/protocol/framing.hpp"

namespace hsn::host {

/**
 * Joins one of a device's links to a pseudo-terminal (hub-design.md section 11, "What the bench
 * must provide", item 2): every packet crosses as a COBS frame ending in a zero byte, as on USB
 * (protocol section 10), for USB and network links alike, so the real hub opens a USB link with
 * `--serial <path>` and its bench bridge carries a network link to a WebSocket.
 *
 * The link is attached to the device's wire while the far end holds the terminal open: a USB
 * link then carries frames (and a gateway's usb_host() reads true), a network link accepts the
 * device's connect. When the far end closes, or the script cuts the link, the wire is detached
 * and the device's side drops at once. A far end that has just opened gets kSettle to put the
 * terminal into raw mode before anything is written to it; what it sends meanwhile is kept and
 * delivered then. If the far end still has output processing on when the link attaches, which
 * turns each 0x0A it writes into 0x0D 0x0A and so corrupts frames, the link says so once through
 * `error` and changes nothing: a real board cannot repair the host's terminal either.
 *
 * Nothing here blocks: the bench's loop calls service() inside RealTimeDriver::deliver whenever
 * the terminal may have something, and at least every kFarEndCheck.
 */
class PtyLink final : public LinkPeer {
public:
  /** Time a newly opened far end gets to set raw mode before the link carries anything. */
  static constexpr device::Duration kSettle = device::milliseconds(100);

  /** How often the loop must service a link whose far end is closed (it cannot be polled). */
  static constexpr device::Duration kFarEndCheck = device::milliseconds(50);

  /** Told of anything a reader of the run should know, as one line of text. */
  using Note = std::function<void(const std::string& text)>;

  /**
   * Opens a pseudo-terminal for `device`'s link of `kind`; its far end starts closed. `note` hears
   * the link's state changes, `error` what the far end does wrong.
   */
  PtyLink(SimDevice& device, device::LinkKind kind, Note note = {}, Note error = {});
  PtyLink(const PtyLink&) = delete;
  PtyLink& operator=(const PtyLink&) = delete;
  ~PtyLink();

  /** The terminal's path, for the manifest. */
  const std::string& path() const {
    return path_;
  }

  device::LinkKind kind() const {
    return kind_;
  }

  SimDevice& device() {
    return device_;
  }

  /** The bench's end of the terminal, for the loop's poll(). */
  int fd() const {
    return master_;
  }

  /** True while the far end holds the terminal open (as last serviced). */
  bool far_open() const {
    return far_open_;
  }

  /** True while the link carries frames. */
  bool attached() const {
    return attached_;
  }

  /** True while the bench has bytes waiting to be written: poll for POLLOUT. */
  bool has_output() const {
    return !out_.empty();
  }

  /**
   * Checks the far end, writes what waits, and reads what the far end wrote, handing each whole
   * frame to the device. `now` is the true time (the driver's).
   */
  void service(device::Instant now);

  /** When service() must run next at the latest: the end of a settle, or the next check. */
  device::Instant next_service(device::Instant now) const;

  /** Cuts the link (a cable pulled, Wi-Fi lost) until restore(): nothing crosses either way. */
  void cut();

  /** Ends a cut: the link carries again while the far end holds the terminal open. */
  void restore();

  bool is_cut() const {
    return cut_;
  }

  /** Frames that could not be decoded, and frames dropped with nobody at the far end. */
  std::uint64_t bad_frames() const {
    return bad_frames_;
  }
  std::uint64_t dropped_frames() const {
    return dropped_frames_;
  }

  // LinkPeer
  void link_up(LinkWire& wire) override;
  void link_down(LinkWire& wire) override;
  void link_packet(LinkWire& wire, const Bytes& packet) override;

private:
  bool poll_far_open() const;
  void attach();
  void detach();
  void read_frames();
  void flush();
  bool far_end_processes_output() const;
  void say(const std::string& text) const;

  SimDevice& device_;
  device::LinkKind kind_;
  Note note_;
  Note error_;
  int master_ = -1;
  std::string path_;
  bool far_open_ = false;
  bool attached_ = false;
  bool cut_ = false;
  /** While settling: when the link attaches, and the frames that came meanwhile. */
  device::Instant attach_at_ = device::Instant::never();
  std::vector<Bytes> held_;
  std::array<std::uint8_t, protocol::kMaxFrameDataSize> frame_storage_{};
  protocol::FrameDecoder decoder_;
  std::vector<std::uint8_t> out_;
  std::uint64_t bad_frames_ = 0;
  std::uint64_t dropped_frames_ = 0;
};

}  // namespace hsn::host
