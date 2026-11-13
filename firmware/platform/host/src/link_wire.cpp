#include "hsn/host/link_wire.hpp"

#include <algorithm>
#include <utility>

namespace hsn::host {

LinkWire::LinkWire(Scheduler& scheduler, Timeline& timeline, const PacketLabels& labels,
                   ActorId device, FakeLink& link, Deliver deliver)
    : scheduler_(scheduler),
      timeline_(timeline),
      labels_(labels),
      device_(device),
      link_(link),
      deliver_(std::move(deliver)),
      kind_(link.kind()) {
  link_.set_observer(this);
}

LinkWire::~LinkWire() {
  link_.set_observer(nullptr);
}

void LinkWire::attach(LinkPeer& peer, device::Duration latency) {
  peer_ = &peer;
  latency_ = latency;
}

void LinkWire::detach() {
  if (connected_) {
    drop();
  }
  peer_ = nullptr;
}

bool LinkWire::carries() const {
  return peer_ != nullptr && (kind_ == device::LinkKind::usb || connected_);
}

void LinkWire::record(RecordKind kind, const Bytes* packet) {
  Record entry;
  entry.at = scheduler_.now();
  entry.actor = device_;
  entry.kind = kind;
  entry.value = kind_ == device::LinkKind::usb ? 0u : 1u;
  if (packet != nullptr) {
    entry.length = static_cast<std::uint16_t>(packet->size());
    entry.label = labels_.label(protocol::ByteView(packet->data(), packet->size()));
  }
  timeline_.add(entry);
}

void LinkWire::close_hub_side() {
  if (connected_) {
    connected_ = false;
    if (peer_ != nullptr) {
      peer_->link_down(*this);
    }
  }
}

void LinkWire::packet_sent(FakeLink&, protocol::ByteView packet) {
  Bytes bytes(packet.begin(), packet.end());
  record(RecordKind::link_sent, &bytes);
  if (!carries()) {
    return;
  }
  const std::uint64_t sending = sending_;
  scheduler_.schedule(scheduler_.now() + latency_, [this, sending, bytes]() {
    if (sending == sending_ && peer_ != nullptr) {
      peer_->link_packet(*this, bytes);
    }
  });
}

void LinkWire::connect_requested(FakeLink&) {
  // A new connection replaces any old one.
  close_hub_side();
  lose_in_flight();
  const std::uint64_t generation = generation_;
  if (peer_ == nullptr) {
    scheduler_.schedule(scheduler_.now() + device::kLinkDeadAfter, [this, generation]() {
      if (generation == generation_ && deliver_([this]() { return link_.down_event(); })) {
        record(RecordKind::link_down, nullptr);
      }
    });
    return;
  }
  scheduler_.schedule(scheduler_.now() + latency_, [this, generation]() {
    if (generation != generation_ || peer_ == nullptr) {
      return;
    }
    connected_ = true;
    peer_->link_up(*this);
    scheduler_.schedule(scheduler_.now() + latency_, [this, generation]() {
      if (generation == generation_ && deliver_([this]() { return link_.up_event(); })) {
        record(RecordKind::link_up, nullptr);
      }
    });
  });
}

void LinkWire::disconnected(FakeLink&) {
  lose_in_flight();
  close_hub_side();
}

void LinkWire::send_to_device(const Bytes& packet) {
  const std::uint64_t generation = generation_;
  scheduler_.schedule(scheduler_.now() + latency_, [this, generation, packet]() {
    if (generation != generation_ || !carries()) {
      return;
    }
    if (deliver_([this, &packet]() { return link_.packet_event(packet); })) {
      record(RecordKind::link_received, &packet);
    }
  });
}

void LinkWire::drop(device::Duration noticed_after) {
  lose_in_flight();
  close_hub_side();
  const std::uint64_t generation = generation_;
  scheduler_.schedule(scheduler_.now() + noticed_after, [this, generation]() {
    // Only a link the device holds up can go down on its side.
    if (generation == generation_ && link_.up() &&
        deliver_([this]() { return link_.down_event(); })) {
      record(RecordKind::link_down, nullptr);
    }
  });
}

void LinkWire::lose_in_flight() {
  generation_ += 1;
  sending_ += 1;
}

void LinkWire::device_reset(bool finish_sending) {
  // What travels towards the device is lost at any reset.
  generation_ += 1;
  static_cast<void>(link_.down_event());
  if (!finish_sending) {
    sending_ += 1;
    close_hub_side();
    return;
  }
  // A restart the device asked for: what it already sent still arrives, within the grace (design
  // section 4, Waiter). Packets in flight arrive by now + latency, scheduled before this cut-off,
  // so they run first at a tie; any due after the grace are lost.
  const std::uint64_t sending = sending_;
  scheduler_.schedule(scheduler_.now() + std::min(latency_, kRestartGrace), [this, sending]() {
    if (sending == sending_) {
      sending_ += 1;
      close_hub_side();
    }
  });
}

}  // namespace hsn::host
