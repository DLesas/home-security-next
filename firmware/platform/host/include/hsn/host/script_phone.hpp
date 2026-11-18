#pragma once

#include <cstdint>
#include <optional>
#include <vector>

#include "hsn/device/time.hpp"
#include "hsn/host/fake_update.hpp"
#include "hsn/host/link_wire.hpp"
#include "hsn/host/scheduler.hpp"
#include "hsn/host/sim_device.hpp"
#include "hsn/host/simulation.hpp"
#include "hsn/host/test_hub.hpp"
#include "hsn/protocol/transfer.hpp"

namespace hsn::host {

/** How a ScriptPhone behaves. */
struct ScriptPhoneOptions {
  /** The phone is near the board from this true instant: it connects while the board advertises. */
  device::Instant arrives;
  /** One-way latency of each write and notification. */
  device::Duration latency = device::milliseconds(15);
  /** The MTU agreed: a frame longer than MTU − 3 bytes is counted in `oversize`. */
  std::uint16_t mtu = 185;
  /** The first this many Opens carry a wrong tag (a byte flipped). */
  std::uint32_t wrong_tags = 0;
  /**
   * After serving this many Data frames (0: never), the phone drops the connection, once, as soon
   * as the last of them has reached the board; Gets meanwhile go unanswered.
   */
  std::uint32_t drop_after_data = 0;
  /** After a drop, or after the board closed the connection while it still advertises. */
  device::Duration reconnect_after = device::seconds(2);
  /** The Nth Data frame (counting from 1; 0 none) carries a wrong CRC-32. */
  std::uint32_t corrupt_data = 0;
};

/**
 * The phone's part of a Bluetooth update (m3-updates-design.md section 5, "Over Bluetooth"; the
 * phone design's FirmwareTransfer): from the session the hub gave it (TestHub::open_bluetooth) it
 * connects to the board's Bluetooth link while the board advertises, answers Hello with Open and
 * the tag, answers each Get with exactly the bytes asked from the file and their CRC-32 (a Get
 * outside the file with Gone out of range), reconnects after a drop while the board still
 * advertises, and keeps what it saw. It sends nothing unasked.
 */
class ScriptPhone final : public LinkPeer {
public:
  /** A phone for the board's Bluetooth wire. */
  ScriptPhone(Scheduler& scheduler, LinkWire& wire, BluetoothSession session,
              ScriptPhoneOptions options = {});
  /** A phone for a simulated device's Bluetooth link. */
  ScriptPhone(Simulation& sim, SimDevice& device, BluetoothSession session,
              ScriptPhoneOptions options = {});
  ScriptPhone(const ScriptPhone&) = delete;
  ScriptPhone& operator=(const ScriptPhone&) = delete;
  ~ScriptPhone();

  /** Hellos the board sent, in order. */
  std::vector<protocol::transfer::Hello> hellos;
  /** Opens sent, and how many of them with a wrong tag. */
  std::uint32_t opens = 0;
  std::uint32_t wrong_opens = 0;
  /** Connections made and lost (either end). */
  std::uint32_t connections = 0;
  std::uint32_t disconnections = 0;
  /** Gets answered: with Data, with Gone. */
  std::uint32_t data_frames = 0;
  std::uint32_t gone_frames = 0;
  /** The end of the highest piece served: the progress the phone shows. */
  std::uint32_t served_to = 0;
  /** Frames either way longer than the MTU allows. */
  std::uint32_t oversize = 0;
  /** Frames from the board that did not decode, or that a phone never receives. */
  std::uint32_t unexpected = 0;
  /** The board's Done, when it came. */
  std::optional<protocol::transfer::Done> done;

  // LinkPeer
  void link_up(LinkWire& wire) override;
  void link_down(LinkWire& wire) override;
  void link_packet(LinkWire& wire, const Bytes& packet) override;

private:
  void send(const Bytes& frame);
  void reconnect_later();
  void on_get(const protocol::transfer::Get& get);

  Scheduler& scheduler_;
  LinkWire& wire_;
  BluetoothSession session_;
  ScriptPhoneOptions options_;
  bool dropped_once_ = false;
  bool dropping_ = false;
  bool attached_ = false;
};

}  // namespace hsn::host
