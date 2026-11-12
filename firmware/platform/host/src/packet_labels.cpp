#include "hsn/host/packet_labels.hpp"

#include <algorithm>
#include <cstdio>

#include "hsn/protocol/messages.hpp"

namespace hsn::host {

void PacketLabels::add(PacketLabeler& labeler) {
  labelers_.push_back(&labeler);
}

void PacketLabels::remove(PacketLabeler& labeler) {
  labelers_.erase(std::remove(labelers_.begin(), labelers_.end(), &labeler), labelers_.end());
}

PacketLabel PacketLabels::label(protocol::ByteView packet) const {
  PacketLabel label;
  for (const protocol::Direction direction :
       {protocol::Direction::to_hub, protocol::Direction::from_hub}) {
    const auto header = protocol::read_header(packet, direction, protocol::PacketLimit::link);
    if (!header.ok()) {
      continue;
    }
    label.has_header = true;
    label.direction = direction;
    label.address = header.value().address;
    label.counter = header.value().counter;
    for (PacketLabeler* labeler : labelers_) {
      const auto type = labeler->message_type(packet, header.value());
      if (type.has_value()) {
        label.type = *type;
        break;
      }
    }
    break;
  }
  return label;
}

std::string message_type_name(std::uint8_t type) {
  namespace t = protocol::message_type;
  switch (type) {
    case t::heartbeat:
      return "heartbeat";
    case t::door_changed:
      return "door_changed";
    case t::cover_changed:
      return "cover_changed";
    case t::button:
      return "button";
    case t::started:
      return "started";
    case t::siren_report:
      return "siren_report";
    case t::hello:
      return "hello";
    case t::forwarded_packet:
      return "forwarded_packet";
    case t::gateway_status:
      return "gateway_status";
    case t::transmit_result:
      return "transmit_result";
    case t::interference:
      return "interference";
    case t::log_entries:
      return "log_entries";
    case t::reply:
      return "reply";
    case t::disarmed_notice:
      return "disarmed_notice";
    case t::siren_command:
      return "siren_command";
    case t::siren_settings:
      return "siren_settings";
    case t::welcome:
      return "welcome";
    case t::transmit_request:
      return "transmit_request";
    case t::gateway_settings:
      return "gateway_settings";
    default:
      break;
  }
  char text[16];
  std::snprintf(text, sizeof(text), "type_0x%02x", static_cast<unsigned>(type));
  return text;
}

}  // namespace hsn::host
