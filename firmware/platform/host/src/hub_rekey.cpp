// The test hub's key change after a restore (m3-updates-design.md section 7): what a backup holds,
// the restore that marks every device, opening under the old and the new key, answering an
// old-key packet with a Key change (at most one per device every key_change_gap), and the switch
// at the first packet under the new key.

#include "hsn/host/test_hub.hpp"

namespace hsn::host {

HubSnapshot TestHub::snapshot() const {
  HubSnapshot backup;
  for (const Known& device : known_) {
    HubSnapshot::Device kept;
    kept.name = device.name;
    kept.key = device.key;
    kept.next_key = device.next_key;
    kept.rekey = device.rekey;
    kept.window = device.window;
    kept.next_counter = device.next_counter;
    kept.version = device.version;
    backup.devices.push_back(kept);
  }
  return backup;
}

void TestHub::restore(const HubSnapshot& backup) {
  for (const HubSnapshot::Device& kept : backup.devices) {
    Known& device = known(kept.name);
    device.key = kept.key;
    if (device.cipher->set_key(device.key) != protocol::Error::none) {
      throw SimulationError("the hub could not import " + device.name + "'s key");
    }
    device.next_key = kept.next_key;
    device.next_cipher.reset();
    if (device.next_key.has_value()) {
      device.next_cipher = std::make_unique<psa::PsaPacketCipher>();
      if (device.next_cipher->set_key(*device.next_key) != protocol::Error::none) {
        throw SimulationError("the hub could not import " + device.name + "'s next key");
      }
    }
    // The restore marks every device, and moves the hub's counters past anything it sent since
    // the backup (M2 9).
    device.rekey = true;
    device.window = kept.window;
    device.next_counter = kept.next_counter + (1u << 24);
    device.version = kept.version;
    device.last_key_change = device::Instant::never();
    if (device.role == protocol::Role::gateway) {
      // The restored hub starts again: every connection closes, and each gateway says hello.
      device.session = Session{};
      for (const device::LinkKind kind : {device::LinkKind::usb, device::LinkKind::network}) {
        LinkWire& wire = device.device->wire(kind);
        if (wire.connected()) {
          wire.drop();
        }
      }
    }
  }
  // Every siren gets its Key change at the restored hub's first start, on both paths, in place of
  // "report now" (protocol section 7, "Hub restart").
  for (std::size_t index = 0; index < known_.size(); ++index) {
    if (known_[index].role == protocol::Role::siren && known_[index].rekey) {
      answer_old_key(index, Opened{}, Arrival{}, nullptr, nullptr);
    }
  }
}

bool TestHub::rekey_pending(const std::string& name) const {
  return known(name).rekey;
}

const protocol::DeviceKey& TestHub::key_of(const std::string& name) const {
  return known(name).key;
}

std::optional<protocol::DeviceKey> TestHub::next_key_of(const std::string& name) const {
  return known(name).next_key;
}

TestHub::KeyUsed TestHub::open_any(Known& device, protocol::ByteView packet,
                                   const protocol::Binding& binding, protocol::PacketLimit limit,
                                   std::optional<Opened>& opened) {
  // Under a key change the new key is tried first (section 7, "Opening").
  if (device.next_cipher != nullptr) {
    Bytes plaintext(protocol::kMaxLinkPacketSize);
    const auto result =
        protocol::open_packet(*device.next_cipher, packet, protocol::Direction::to_hub, binding,
                              limit, protocol::MutableByteView(plaintext.data(), plaintext.size()));
    if (result.ok()) {
      Opened plain;
      plain.counter = result.value().header.counter;
      plain.type = result.value().type;
      plain.body.assign(result.value().body.begin(), result.value().body.end());
      opened = plain;
      return KeyUsed::next;
    }
  }
  opened = open(device, packet, binding, limit);
  return opened.has_value() ? KeyUsed::current : KeyUsed::none;
}

const protocol::DeviceKey& TestHub::make_next_key(Known& device) {
  protocol::DeviceKey key{};
  protocol::RandomValue half{};
  random_bytes(half);
  std::copy(half.begin(), half.end(), key.begin());
  random_bytes(half);
  std::copy(half.begin(), half.end(), key.begin() + static_cast<std::ptrdiff_t>(half.size()));
  device.next_key = key;
  device.next_cipher = std::make_unique<psa::PsaPacketCipher>();
  if (device.next_cipher->set_key(key) != protocol::Error::none) {
    throw SimulationError("the hub could not import " + device.name + "'s new key");
  }
  return *device.next_key;
}

void TestHub::switch_key(Known& device) {
  device.key = *device.next_key;
  if (device.cipher->set_key(device.key) != protocol::Error::none) {
    throw SimulationError("the hub could not import " + device.name + "'s new key");
  }
  device.next_key.reset();
  device.next_cipher.reset();
  device.rekey = false;
  // Counters start again under a new key (protocol section 4): a fresh window, the hub's from 1.
  device.window = ReplayWindow{};
  device.next_counter = 1;
  decide(HubAction::key_changed, device.name);
}

void TestHub::answer_old_key(std::size_t index, const Opened& opened, const Arrival& arrival,
                             LinkWire* wire, const protocol::RandomValue* hello_random) {
  Known& device = known_[index];
  const device::Instant now = sim_.now();
  if (!device.last_key_change.is_never() &&
      now - device.last_key_change < options_.key_change_gap) {
    return;  // a flood of replays costs at most one Key change per gap
  }
  device.last_key_change = now;
  protocol::KeyChange change;
  change.new_key = device.next_key.has_value() ? *device.next_key : make_next_key(device);
  if (device.role == protocol::Role::sensor) {
    // Bound to the packet it answers, as a reply (section 4).
    const Bytes packet = seal(device, change, protocol::Binding::sensor_packet(opened.counter),
                              protocol::PacketLimit::radio);
    decide(HubAction::key_change_sent, device.name);
    answer_sensor(index, arrival, packet, protocol::message_type::key_change);
    return;
  }
  if (device.role == protocol::Role::gateway) {
    // Bound to its hello's random, in place of the welcome.
    if (wire == nullptr || hello_random == nullptr) {
      return;
    }
    const Bytes packet =
        seal(device, change, protocol::Binding::hello(*hello_random), protocol::PacketLimit::link);
    decide(HubAction::key_change_sent, device.name);
    send_link(device, *wire, packet, protocol::message_type::key_change);
    return;
  }
  // A siren: no binding, strictly higher, on both paths (section 7).
  const Bytes packet =
      seal(device, change, protocol::Binding::none(), protocol::PacketLimit::radio);
  decide(HubAction::key_change_sent, device.name);
  LinkWire& network = device.device->wire(device::LinkKind::network);
  if (device.siren.wifi && network.connected()) {
    send_link(device, network, packet, protocol::message_type::key_change);
  }
  Downlink downlink;
  downlink.packet = packet;
  downlink.type = protocol::message_type::key_change;
  downlink.counter = device.next_counter - 1;
  downlink.to = index;
  downlink.data_rate = command_rate(device);
  downlink.siren_command = true;
  downlink.gateway = device.best_gateway;
  send_radio(downlink);
}

}  // namespace hsn::host
