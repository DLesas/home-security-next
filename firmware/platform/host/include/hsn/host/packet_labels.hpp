#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/packet.hpp"

namespace hsn::host {

/** What the bench can tell about a packet on the air or on a link. */
struct PacketLabel {
  /** The clear part read: direction, address and counter are meaningful. */
  bool has_header = false;
  protocol::Direction direction = protocol::Direction::to_hub;
  std::uint32_t address = 0;
  std::uint32_t counter = 0;
  /** The message type, when a labeller holding the key could tell; 0 when unknown. */
  std::uint8_t type = 0;
};

/**
 * Tells the type of a packet it can open. The type byte is encrypted, so only whoever holds the
 * keys can name it: the test hub does, for every device it knows and every packet it sealed.
 */
class PacketLabeler {
public:
  /** Returns the message type of `packet`, whose clear part is `header`, or nothing. */
  virtual std::optional<std::uint8_t> message_type(protocol::ByteView packet,
                                                   const protocol::PacketHeader& header) = 0;

protected:
  ~PacketLabeler() = default;
};

/**
 * The labellers known to the simulation. The Medium and the link wires label every packet as it
 * goes, so the timeline can say "door changed" rather than "25 bytes".
 */
class PacketLabels {
public:
  /** Adds a labeller; it must outlive its registration. */
  void add(PacketLabeler& labeler);

  /** Removes a labeller. */
  void remove(PacketLabeler& labeler);

  /** Reads the clear part, then asks each labeller in turn for the type. */
  PacketLabel label(protocol::ByteView packet) const;

private:
  std::vector<PacketLabeler*> labelers_;
};

/** Returns the snake-case name of a message type ("door_changed"), or "type_0x42". */
std::string message_type_name(std::uint8_t type);

}  // namespace hsn::host
