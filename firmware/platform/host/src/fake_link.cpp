#include "hsn/host/fake_link.hpp"

#include "hsn/protocol/packet.hpp"

namespace hsn::host {

device::HalError FakeLink::connect(const device::LinkTarget& target) {
  tick();
  if (unpowered()) {
    return device::HalError::none;
  }
  connects += 1;
  last_target = target;
  if (fail_connect) {
    return device::HalError::io;
  }
  if (observer_ != nullptr) {
    observer_->connect_requested(*this);
  }
  return device::HalError::none;
}

void FakeLink::disconnect() {
  tick();
  if (unpowered()) {
    return;
  }
  disconnects += 1;
  up_ = false;
  if (observer_ != nullptr) {
    observer_->disconnected(*this);
  }
}

device::HalError FakeLink::send(protocol::ByteView packet) {
  tick();
  if (unpowered()) {
    return device::HalError::none;
  }
  // A WebSocket or a Bluetooth connection carries packets only while up; a serial port always.
  if (!up_ && kind_ != device::LinkKind::usb) {
    return device::HalError::io;
  }
  if (refuse_sends) {
    return device::HalError::busy;
  }
  if (packet.size() > protocol::kMaxLinkPacketSize) {
    return device::HalError::invalid;
  }
  sent.push_back(Sent{clock_.now(), Bytes(packet.begin(), packet.end())});
  if (observer_ != nullptr) {
    observer_->packet_sent(*this, packet);
  }
  return device::HalError::none;
}

device::LinkEvent FakeLink::up_event() {
  up_ = true;
  device::LinkEvent event;
  event.link = kind_;
  event.kind = device::LinkEventKind::up;
  return event;
}

device::LinkEvent FakeLink::down_event() {
  up_ = false;
  device::LinkEvent event;
  event.link = kind_;
  event.kind = device::LinkEventKind::down;
  return event;
}

device::LinkEvent FakeLink::packet_event(const Bytes& packet) {
  rx_buffer_ = packet;
  device::LinkEvent event;
  event.link = kind_;
  event.kind = device::LinkEventKind::packet;
  event.packet = protocol::ByteView(rx_buffer_.data(), rx_buffer_.size());
  return event;
}

}  // namespace hsn::host
