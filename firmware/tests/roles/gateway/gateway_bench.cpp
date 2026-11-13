#include "gateway_bench.hpp"

#include "hsn/protocol/setup.hpp"

namespace hsn::test {

host::SimDevice& add_gateway(Site& site, const std::string& name, const host::GatewayConfig& config,
                             std::int32_t drift_ppm) {
  host::DeviceSpec spec;
  spec.name = name;
  spec.role = gateway_role();
  spec.drift_ppm = drift_ppm;
  host::SimDevice& device = site.sim.add_device(spec);
  // Gateways are on mains.
  device.board().power.external = true;
  site.hub.add_gateway(device, config);
  return device;
}

Forwarded decode_forwarded(device::Instant at, const Bytes& body) {
  Forwarded out;
  out.at = at;
  REQUIRE(protocol::decode_body(protocol::ByteView(body.data(), body.size()), out.meta) ==
          protocol::Error::none);
  out.packet.assign(out.meta.packet.bytes.begin(), out.meta.packet.bytes.end());
  out.meta.packet.bytes = protocol::ByteView();
  return out;
}

std::vector<Forwarded> forwarded_by(const host::TestHub& hub, const std::string& gateway) {
  std::vector<Forwarded> found;
  for (const host::HubPacket& packet : hub.received_from(gateway, type::forwarded_packet)) {
    found.push_back(decode_forwarded(packet.at, packet.body));
  }
  return found;
}

std::uint32_t counter_in(const Bytes& packet) {
  REQUIRE(packet.size() >= protocol::kClearSize);
  return static_cast<std::uint32_t>(packet[5] | (packet[6] << 8) | (packet[7] << 16)) |
         (static_cast<std::uint32_t>(packet[8]) << 24);
}

std::vector<std::int64_t> decision_values(const host::TestHub& hub, host::HubAction action,
                                          const std::string& device) {
  std::vector<std::int64_t> values;
  for (const host::HubDecision& decision : hub.decisions(action, device)) {
    values.push_back(decision.value);
  }
  return values;
}

std::vector<Bytes> transmitted(host::SimDevice& device) {
  std::vector<Bytes> packets;
  for (const host::RadioCall& call :
       device.board().radio.calls_of(host::RadioCall::Kind::transmit)) {
    if (call.result == device::HalError::none) {
      packets.push_back(call.packet);
    }
  }
  return packets;
}

Bytes opaque_packet(std::uint32_t address, std::uint32_t counter, std::size_t size) {
  Bytes packet(size, 0xA5);
  packet[0] = 0x18;
  for (std::size_t i = 0; i < 4; ++i) {
    packet[1 + i] = static_cast<std::uint8_t>((address >> (8 * i)) & 0xFF);
    packet[5 + i] = static_cast<std::uint8_t>((counter >> (8 * i)) & 0xFF);
  }
  return packet;
}

void Talker::handle(const device::Event& event) {
  while (next_ < bursts_.size() && bursts_[next_].at <= event.now) {
    const Burst& burst = bursts_[next_++];
    static_cast<void>(services_.hal.radio.transmit(
        device::RadioChannel{burst.frequency_hz, burst.data_rate}, burst.power_dbm,
        protocol::ByteView(burst.packet.data(), burst.packet.size())));
  }
}

device::Wake Talker::next_wake() const {
  device::Wake wake;
  wake.at = next_ < bursts_.size() ? bursts_[next_].at : device::Instant::never();
  return wake;
}

host::SimDevice& add_talker(host::Simulation& sim, const std::string& name,
                            std::vector<Burst> bursts) {
  host::DeviceSpec spec;
  spec.name = name;
  spec.role = [bursts](device::Services& services, host::HostBoard&) {
    return host::box_role<Talker>(services, bursts);
  };
  host::SimDevice& device = sim.add_device(spec);
  device.board().power.external = true;
  host::provision(device.board(),
                  sensor_on_site(0x7A1C0000u + static_cast<std::uint32_t>(sim.devices().size())));
  return device;
}

host::Provisioning gateway_pairing(std::uint32_t address) {
  host::Provisioning pairing;
  pairing.role = protocol::Role::gateway;
  pairing.address = address;
  pairing.key = {0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87,
                 0x98, 0xA9, 0xBA, 0xCB, 0xDC, 0xED, 0xFE, 0x0F};
  return pairing;
}

host::Provisioning sensor_on_site(std::uint32_t address) {
  host::Provisioning pairing = sensor_pairing(address);
  pairing.key[0] = static_cast<std::uint8_t>(address & 0xFF);
  return pairing;
}

LinkHub::LinkHub(host::Simulation& sim, host::SimDevice& gateway, const host::Provisioning& pairing)
    : sim_(sim), gateway_(gateway), address_(pairing.address) {
  REQUIRE(cipher_.set_key(pairing.key) == protocol::Error::none);
  settings.settings_version = 1;
  settings.site_channel = pairing.site_channel;
  settings.listen_data_rate_mask = 0x20;
  settings.status_interval_seconds = 30;
  settings.interference_threshold_db = 10;
  settings.interference_seconds = 30;
  settings.default_tx_power_dbm = 14;
  settings.siren_tx_power_dbm = 22;
}

void LinkHub::attach(device::LinkKind kind, device::Duration latency) {
  gateway_.wire(kind).attach(*this, latency);
  // A serial port carries bytes as soon as both ends are there; a network link once it is up.
  wire_ = &gateway_.wire(kind);
  if (kind == device::LinkKind::usb) {
    gateway_.board().gateway_io.host = true;
  }
}

void LinkHub::link_up(host::LinkWire& wire) {
  link_ups += 1;
  wire_ = &wire;
}

void LinkHub::link_down(host::LinkWire& wire) {
  if (wire_ == &wire) {
    wire_ = nullptr;
  }
}

void LinkHub::link_packet(host::LinkWire& wire, const Bytes& packet) {
  if (packet.size() == 3 && packet[0] == protocol::kSetupMarker &&
      packet[1] == protocol::setup_type::provision_result) {
    provision_results.push_back(packet[2]);
    return;
  }
  Got got;
  got.at = sim_.now();
  got.link = wire.link().kind();
  got.packet = packet;
  Bytes plaintext(protocol::kMaxLinkPacketSize);
  const protocol::ByteView view(packet.data(), packet.size());
  const auto header =
      protocol::read_header(view, protocol::Direction::to_hub, protocol::PacketLimit::link);
  if (header.ok()) {
    got.counter = header.value().counter;
  }
  const auto try_open = [&](const protocol::Binding& binding) {
    return protocol::open_packet(cipher_, view, protocol::Direction::to_hub, binding,
                                 protocol::PacketLimit::link,
                                 protocol::MutableByteView(plaintext.data(), plaintext.size()));
  };
  const auto plain = try_open(protocol::Binding::none());
  if (plain.ok() && plain.value().type == type::hello) {
    protocol::Hello hello;
    REQUIRE(protocol::decode_body(plain.value().body, hello) == protocol::Error::none);
    got.type = type::hello;
    got.body.assign(plain.value().body.begin(), plain.value().body.end());
    received.push_back(got);
    hellos += 1;
    gateway_random = hello.gateway_random;
    wire_ = &wire;
    if (auto_welcome) {
      welcome();
    }
    return;
  }
  const auto bound = try_open(session_binding());
  if (!bound.ok()) {
    unopened += 1;
    received.push_back(got);
    return;
  }
  got.type = bound.value().type;
  got.body.assign(bound.value().body.begin(), bound.value().body.end());
  received.push_back(got);
}

void LinkHub::welcome(const std::optional<protocol::Binding>& binding) {
  for (auto& byte : hub_random) {
    hub_seed_ = hub_seed_ * 6364136223846793005ULL + 1442695040888963407ULL;
    byte = static_cast<std::uint8_t>(hub_seed_ >> 56);
  }
  protocol::Welcome message;
  message.hub_random = hub_random;
  last_welcome = seal(message, binding.value_or(protocol::Binding::hello(gateway_random)));
  send_raw(last_welcome);
  if (auto_welcome) {
    send(settings);
  }
}

Bytes LinkHub::seal_bytes(const Bytes& plaintext, const protocol::Binding& binding) {
  Bytes out(protocol::kMaxLinkPacketSize);
  const auto sealed = protocol::seal_packet(
      cipher_, {protocol::Direction::from_hub, address_, next_counter++}, binding,
      protocol::ByteView(plaintext.data(), plaintext.size()), protocol::PacketLimit::link,
      protocol::MutableByteView(out.data(), out.size()));
  REQUIRE(sealed.ok());
  out.resize(sealed.value());
  return out;
}

Bytes LinkHub::seal_plaintext(const Bytes& plaintext) {
  return seal_bytes(plaintext, session_binding());
}

void LinkHub::send_raw(const Bytes& packet) {
  REQUIRE(wire_ != nullptr);
  wire_->send_to_device(packet);
}

protocol::TransmitRequest LinkHub::request(std::uint8_t when, std::uint32_t gateway_time,
                                           const Bytes& packet, std::uint8_t data_rate,
                                           std::uint8_t priority, std::int8_t power_dbm) const {
  protocol::TransmitRequest request;
  request.when = when;
  request.gateway_time_micros = gateway_time;
  request.data_rate = data_rate;
  request.power_dbm = power_dbm;
  request.priority = priority;
  request.packet.bytes = protocol::ByteView(packet.data(), packet.size());
  return request;
}

std::uint32_t LinkHub::send_request(const protocol::TransmitRequest& request) {
  const std::uint32_t counter = next_counter;
  send(request);
  return counter;
}

std::vector<LinkHub::Got> LinkHub::got(std::uint8_t message_type) const {
  std::vector<Got> found;
  for (const Got& entry : received) {
    if (entry.type == message_type) {
      found.push_back(entry);
    }
  }
  return found;
}

std::vector<protocol::TransmitResult> LinkHub::results() const {
  std::vector<protocol::TransmitResult> found;
  for (const Got& entry : got(type::transmit_result)) {
    protocol::TransmitResult result;
    REQUIRE(protocol::decode_body(protocol::ByteView(entry.body.data(), entry.body.size()),
                                  result) == protocol::Error::none);
    found.push_back(result);
  }
  return found;
}

std::vector<Forwarded> LinkHub::forwarded() const {
  std::vector<Forwarded> found;
  for (const Got& entry : got(type::forwarded_packet)) {
    found.push_back(decode_forwarded(entry.at, entry.body));
  }
  return found;
}

std::vector<protocol::GatewayStatus> LinkHub::statuses() const {
  std::vector<protocol::GatewayStatus> found;
  for (const Got& entry : got(type::gateway_status)) {
    protocol::GatewayStatus status;
    REQUIRE(protocol::decode_body(protocol::ByteView(entry.body.data(), entry.body.size()),
                                  status) == protocol::Error::none);
    found.push_back(status);
  }
  return found;
}

std::vector<protocol::Interference> LinkHub::interference() const {
  std::vector<protocol::Interference> found;
  for (const Got& entry : got(type::interference)) {
    protocol::Interference message;
    REQUIRE(protocol::decode_body(protocol::ByteView(entry.body.data(), entry.body.size()),
                                  message) == protocol::Error::none);
    found.push_back(message);
  }
  return found;
}

std::vector<std::uint16_t> LinkHub::log_codes() const {
  std::vector<std::uint16_t> codes;
  for (const Got& entry : got(type::log_entries)) {
    protocol::LogEntries entries;
    REQUIRE(protocol::decode_body(protocol::ByteView(entry.body.data(), entry.body.size()),
                                  entries) == protocol::Error::none);
    protocol::LogEntryReader reader(entries.entries);
    protocol::LogEntry one;
    while (reader.next(one)) {
      codes.push_back(one.code);
    }
  }
  return codes;
}

std::optional<protocol::TransmitResult> LinkHub::result_for(std::uint32_t counter) const {
  std::optional<protocol::TransmitResult> found;
  for (const protocol::TransmitResult& result : results()) {
    if (result.request_counter == counter) {
      REQUIRE_FALSE(found.has_value());
      found = result;
    }
  }
  return found;
}

host::SimDevice& add_lone_sensor(host::Simulation& sim, const std::string& name,
                                 const ScriptSensorConfig& config, ScriptSensorLog& log,
                                 std::uint32_t address) {
  host::DeviceSpec spec;
  spec.name = name;
  spec.role = script_sensor(config, log);
  host::SimDevice& device = sim.add_device(spec);
  host::provision(device.board(), sensor_on_site(address));
  return device;
}

namespace {

host::SimDevice& lone_gateway(host::Simulation& sim) {
  host::DeviceSpec spec;
  spec.name = "gateway";
  spec.role = gateway_role();
  host::SimDevice& device = sim.add_device(spec);
  device.board().power.external = true;
  host::provision(device.board(), gateway_pairing());
  return device;
}

}  // namespace

LinkSite::LinkSite(std::uint8_t listen_mask, host::SimulationOptions options)
    : sim(options), gateway(lone_gateway(sim)), hub(sim, gateway, gateway_pairing()) {
  hub.settings.listen_data_rate_mask = listen_mask;
  hub.attach(device::LinkKind::network);
}

}  // namespace hsn::test
