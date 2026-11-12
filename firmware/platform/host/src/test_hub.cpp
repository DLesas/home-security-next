// The test hub's registry, sealing and opening, paths to the radio, link handling and records.
// The rules for each role are in hub_sensors.cpp, hub_sirens.cpp and hub_gateways.cpp.

#include "hsn/host/test_hub.hpp"

#include <algorithm>
#include <sstream>
#include <utility>

#include "hsn/device/services/radio_plan.hpp"
#include "hsn/host/provisioning.hpp"
#include "hsn/host/sim_time.hpp"

namespace hsn::host {
namespace {

/** The counter in a packet's clear part (bytes 5 to 8, little-endian). */
std::uint32_t counter_of(const Bytes& packet) {
  if (packet.size() < protocol::kClearSize) {
    return 0;
  }
  return static_cast<std::uint32_t>(packet[5]) | (static_cast<std::uint32_t>(packet[6]) << 8) |
         (static_cast<std::uint32_t>(packet[7]) << 16) |
         (static_cast<std::uint32_t>(packet[8]) << 24);
}

/** A key derived from the address and the hub's seed: distinct per device, repeatable. */
protocol::DeviceKey key_for(std::uint32_t address, std::uint64_t seed) {
  protocol::DeviceKey key{};
  for (std::size_t i = 0; i < key.size(); ++i) {
    key[i] = static_cast<std::uint8_t>(((address >> (8 * (i % 4))) & 0xFFu) ^
                                       ((seed >> (8 * (i % 8))) & 0xFFu) ^ (i * 37u));
  }
  return key;
}

const char* path_name(HubPath path) {
  switch (path) {
    case HubPath::radio:
      return "radio";
    case HubPath::gateway:
      return "gateway";
    case HubPath::link:
      return "link";
  }
  return "?";
}

}  // namespace

const char* hub_action_name(HubAction action) {
  switch (action) {
    case HubAction::armed:
      return "armed";
    case HubAction::disarmed:
      return "disarmed";
    case HubAction::reply:
      return "reply";
    case HubAction::reply_skipped:
      return "reply_skipped";
    case HubAction::too_late:
      return "too_late";
    case HubAction::countdown_started:
      return "countdown_started";
    case HubAction::countdown_continued:
      return "countdown_continued";
    case HubAction::late_report_sirens:
      return "late_report_sirens";
    case HubAction::late_report_notification:
      return "late_report_notification";
    case HubAction::report_while_disarmed:
      return "report_while_disarmed";
    case HubAction::alarm:
      return "alarm";
    case HubAction::disarmed_notice:
      return "disarmed_notice";
    case HubAction::local_alarm_reported:
      return "local_alarm_reported";
    case HubAction::siren_command:
      return "siren_command";
    case HubAction::siren_settings:
      return "siren_settings";
    case HubAction::siren_confirmed:
      return "siren_confirmed";
    case HubAction::siren_unreachable:
      return "siren_unreachable";
    case HubAction::gateway_welcomed:
      return "gateway_welcomed";
    case HubAction::gateway_settings:
      return "gateway_settings";
    case HubAction::transmit_result:
      return "transmit_result";
    case HubAction::no_path:
      return "no_path";
  }
  return "?";
}

const char* hub_verdict_name(HubVerdict verdict) {
  switch (verdict) {
    case HubVerdict::accepted:
      return "accepted";
    case HubVerdict::duplicate:
      return "duplicate";
    case HubVerdict::too_old:
      return "too_old";
    case HubVerdict::bad_tag:
      return "bad_tag";
    case HubVerdict::unknown_address:
      return "unknown_address";
    case HubVerdict::malformed:
      return "malformed";
    case HubVerdict::no_session:
      return "no_session";
  }
  return "?";
}

TestHub::TestHub(Simulation& sim, HubOptions options)
    : sim_(sim),
      options_(options),
      actor_(sim.add_actor("hub")),
      site_frequency_hz_(device::site_channel_frequency(options.site_channel).value_or(868300000u)),
      random_state_(options.seed == 0 ? 1 : options.seed) {
  sim_.labels().add(*this);
  if (options_.mode == HubMode::direct_radio) {
    radio_ = std::make_unique<HubRadio>(
        sim_.scheduler(), sim_.medium(), actor_, site_frequency_hz_, options_.listen_data_rates,
        [this](const Bytes& packet, std::int16_t rssi_dbm, std::int8_t snr_quarter_db,
               std::uint8_t data_rate) {
          Arrival arrival;
          arrival.packet = packet;
          arrival.path = HubPath::radio;
          arrival.ended_at = sim_.now();
          arrival.rssi_dbm = rssi_dbm;
          arrival.snr_quarter_db = snr_quarter_db;
          arrival.data_rate = data_rate;
          sim_.schedule(sim_.now() + options_.processing,
                        [this, arrival]() { on_arrival(arrival); });
        },
        [this](std::uint64_t tag, HubRadio::Outcome outcome, std::uint8_t data_rate) {
          on_radio_result(tag, outcome, data_rate);
        });
  }
}

TestHub::~TestHub() {
  for (Known& device : known_) {
    device.device->wire(device::LinkKind::usb).detach();
    device.device->wire(device::LinkKind::network).detach();
  }
  sim_.labels().remove(*this);
}

TestHub::Known& TestHub::add_known(SimDevice& device, std::uint8_t role, std::uint32_t address) {
  if (address == 0) {
    address = 0x5E000001u + static_cast<std::uint32_t>(known_.size()) * 0x101u;
  }
  for (const Known& other : known_) {
    if (other.name == device.name() || other.address == address) {
      throw SimulationError("the hub knows " + device.name() + " or its address already");
    }
  }
  Known added;
  added.name = device.name();
  added.role = role;
  added.address = address;
  added.key = key_for(address, options_.seed);
  added.device = &device;
  added.cipher = std::make_unique<psa::PsaPacketCipher>();
  if (added.cipher->set_key(added.key) != protocol::Error::none) {
    throw SimulationError("the hub could not import " + device.name() + "'s key");
  }
  Provisioning provisioning;
  provisioning.role = role;
  provisioning.address = address;
  provisioning.key = added.key;
  provisioning.site_channel = options_.site_channel;
  provisioning.allowed_data_rate_mask = options_.allowed_data_rate_mask;
  provision(device.board(), provisioning);
  known_.push_back(std::move(added));
  return known_.back();
}

void TestHub::add_sensor(SimDevice& device, const SensorConfig& config) {
  Known& sensor = add_known(device, protocol::Role::sensor, config.address);
  sensor.sensor = config;
  sensor.sensor.address = sensor.address;
  sensor.reply_rate_of_version[sensor.version] = config.reply_data_rate;
}

void TestHub::add_siren(SimDevice& device, const SirenConfig& config) {
  Known& siren = add_known(device, protocol::Role::siren, config.address);
  siren.siren = config;
  siren.siren.address = siren.address;
  siren.reply_rate_of_version[siren.version] = config.command_data_rate;
  if (config.wifi) {
    device.wire(device::LinkKind::network).attach(*this, options_.link_latency);
  }
}

void TestHub::add_gateway(SimDevice& device, const GatewayConfig& config) {
  if (options_.mode != HubMode::gateway_link) {
    throw SimulationError("gateways need a hub in gateway link mode");
  }
  Known& gateway = add_known(device, protocol::Role::gateway, config.address);
  gateway.gateway = config;
  gateway.gateway.address = gateway.address;
  if (config.usb) {
    device.wire(device::LinkKind::usb).attach(*this, options_.link_latency);
    device.board().gateway_io.host = true;
  }
  if (config.network) {
    device.wire(device::LinkKind::network).attach(*this, options_.link_latency);
  }
}

TestHub::Known& TestHub::known(const std::string& name) {
  for (Known& device : known_) {
    if (device.name == name) {
      return device;
    }
  }
  throw SimulationError("the hub does not know " + name);
}

const TestHub::Known& TestHub::known(const std::string& name) const {
  return const_cast<TestHub*>(this)->known(name);
}

std::size_t TestHub::index_of_address(std::uint32_t address) const {
  for (std::size_t i = 0; i < known_.size(); ++i) {
    if (known_[i].address == address) {
      return i;
    }
  }
  return kNone;
}

std::size_t TestHub::index_of_wire(const LinkWire& wire) const {
  for (std::size_t i = 0; i < known_.size(); ++i) {
    SimDevice& device = *known_[i].device;
    if (&device.wire(device::LinkKind::usb) == &wire ||
        &device.wire(device::LinkKind::network) == &wire) {
      return i;
    }
  }
  return kNone;
}

void TestHub::bump(std::uint8_t& version) {
  version = version == 255 ? 1 : static_cast<std::uint8_t>(version + 1);
}

void TestHub::random_bytes(protocol::RandomValue& out) {
  for (std::uint8_t& byte : out) {
    random_state_ ^= random_state_ >> 12;
    random_state_ ^= random_state_ << 25;
    random_state_ ^= random_state_ >> 27;
    byte = static_cast<std::uint8_t>((random_state_ * 0x2545F4914F6CDD1DULL) >> 56);
  }
}

Bytes TestHub::seal_plaintext(Known& device, protocol::ByteView plaintext, std::uint8_t type,
                              const protocol::Binding& binding, protocol::PacketLimit limit) {
  Bytes out(protocol::kMaxLinkPacketSize);
  const protocol::PacketHeader header{protocol::Direction::from_hub, device.address,
                                      device.next_counter};
  const auto sealed = protocol::seal_packet(*device.cipher, header, binding, plaintext, limit,
                                            protocol::MutableByteView(out.data(), out.size()));
  if (!sealed.ok()) {
    throw SimulationError("the test hub could not seal a packet for " + device.name);
  }
  device.next_counter += 1;
  out.resize(sealed.value());
  sealed_types_[out] = type;
  return out;
}

std::optional<TestHub::Opened> TestHub::open(Known& device, protocol::ByteView packet,
                                             const protocol::Binding& binding,
                                             protocol::PacketLimit limit) {
  Bytes plaintext(protocol::kMaxLinkPacketSize);
  const auto opened =
      protocol::open_packet(*device.cipher, packet, protocol::Direction::to_hub, binding, limit,
                            protocol::MutableByteView(plaintext.data(), plaintext.size()));
  if (!opened.ok()) {
    return std::nullopt;
  }
  Opened result;
  result.counter = opened.value().header.counter;
  result.type = opened.value().type;
  result.body.assign(opened.value().body.begin(), opened.value().body.end());
  return result;
}

void TestHub::decide(HubAction action, const std::string& device, std::int64_t value) {
  decisions_.push_back(HubDecision{sim_.now(), action, device, value});
}

void TestHub::record_received(const Known* device, const Arrival& arrival, HubVerdict verdict,
                              const Opened* opened) {
  HubPacket packet;
  packet.at = sim_.now();
  packet.from = device != nullptr ? device->name : std::string();
  packet.path = arrival.path;
  packet.via = arrival.gateway != kNone ? known_[arrival.gateway].name : std::string();
  packet.verdict = verdict;
  packet.counter = counter_of(arrival.packet);
  if (opened != nullptr) {
    packet.type = opened->type;
    packet.body = opened->body;
  }
  packet.rssi_dbm = arrival.rssi_dbm;
  packet.snr_quarter_db = arrival.snr_quarter_db;
  packet.data_rate = arrival.data_rate;
  received_.push_back(std::move(packet));
}

void TestHub::on_arrival(const Arrival& arrival) {
  const protocol::ByteView view(arrival.packet.data(), arrival.packet.size());
  const protocol::PacketLimit limit =
      arrival.path == HubPath::link ? protocol::PacketLimit::link : protocol::PacketLimit::radio;
  const auto header = protocol::read_header(view, protocol::Direction::to_hub, limit);
  if (!header.ok()) {
    record_received(nullptr, arrival, HubVerdict::malformed, nullptr);
    return;
  }
  const std::size_t index = index_of_address(header.value().address);
  if (index == kNone || known_[index].role == protocol::Role::gateway) {
    record_received(nullptr, arrival, HubVerdict::unknown_address, nullptr);
    return;
  }
  Known& device = known_[index];
  const auto opened = open(device, view, protocol::Binding::none(), limit);
  if (!opened.has_value()) {
    record_received(&device, arrival, HubVerdict::bad_tag, nullptr);
    return;
  }
  // Any authentic copy tells which gateway hears a siren best (protocol section 7).
  if (device.role == protocol::Role::siren && arrival.gateway != kNone &&
      (device.best_gateway == kNone || device.best_gateway == arrival.gateway ||
       arrival.rssi_dbm >= device.best_rssi)) {
    device.best_gateway = arrival.gateway;
    device.best_rssi = arrival.rssi_dbm;
  }
  const protocol::CounterVerdict verdict = device.window.check(opened->counter);
  if (verdict != protocol::CounterVerdict::accepted) {
    record_received(&device, arrival,
                    verdict == protocol::CounterVerdict::duplicate ? HubVerdict::duplicate
                                                                   : HubVerdict::too_old,
                    &*opened);
    return;
  }
  const protocol::Error error = protocol::decode_message(
      opened->type, protocol::ByteView(opened->body.data(), opened->body.size()),
      [](const auto&) {});
  if (error != protocol::Error::none) {
    record_received(&device, arrival, HubVerdict::malformed, &*opened);
    return;
  }
  static_cast<void>(device.window.accept(opened->counter));
  record_received(&device, arrival, HubVerdict::accepted, &*opened);
  if (device.role == protocol::Role::sensor) {
    on_sensor_packet(index, *opened, arrival);
  } else if (device.role == protocol::Role::siren) {
    on_siren_packet(index, *opened, arrival);
  }
}

void TestHub::send_radio(const Downlink& downlink) {
  if (options_.mode == HubMode::gateway_link) {
    request_transmit(downlink);
    return;
  }
  HubRadio::Send send;
  send.packet = downlink.packet;
  send.data_rate = downlink.data_rate;
  send.power_dbm = downlink.siren_command ? options_.siren_power_dbm : options_.reply_power_dbm;
  send.siren_command = downlink.siren_command;
  if (downlink.fixed_moment) {
    send.at_moment = true;
    send.moment = downlink.ended_at + downlink.offset;
  } else if (downlink.limited) {
    send.latest = downlink.ended_at + downlink.offset;
  }
  send.tag = next_tag_++;
  outstanding_[send.tag] = Outstanding{downlink.to, downlink.type, downlink.counter,
                                       downlink.data_rate, downlink.packet};
  radio_->send(std::move(send));
}

void TestHub::on_radio_result(std::uint64_t tag, HubRadio::Outcome outcome,
                              std::uint8_t data_rate) {
  const auto found = outstanding_.find(tag);
  if (found == outstanding_.end()) {
    return;
  }
  const Outstanding sent = found->second;
  outstanding_.erase(found);
  const std::string& to = known_[sent.to].name;
  switch (outcome) {
    case HubRadio::Outcome::sent:
      sent_.push_back(HubSent{sim_.now(), to, HubPath::radio, "", sent.counter, sent.type,
                              data_rate, sent.packet});
      break;
    case HubRadio::Outcome::skipped_busy:
      decide(HubAction::reply_skipped, to, sent.counter);
      break;
    case HubRadio::Outcome::too_late:
      decide(HubAction::too_late, to, sent.counter);
      break;
  }
}

void TestHub::send_link(Known& device, LinkWire& wire, const Bytes& packet, std::uint8_t type) {
  wire.send_to_device(packet);
  sent_.push_back(
      HubSent{sim_.now(), device.name, HubPath::link, "", counter_of(packet), type, 0, packet});
}

std::size_t TestHub::connected_gateway(std::size_t preferred) const {
  if (preferred != kNone && known_[preferred].session.open) {
    return preferred;
  }
  for (std::size_t i = 0; i < known_.size(); ++i) {
    if (known_[i].role == protocol::Role::gateway && known_[i].session.open) {
      return i;
    }
  }
  return kNone;
}

void TestHub::change_sensor(const std::string& name, const SensorConfig& config) {
  Known& sensor = known(name);
  const std::uint32_t address = sensor.address;
  sensor.sensor = config;
  sensor.sensor.address = address;
  bump(sensor.version);
  sensor.reply_rate_of_version[sensor.version] = config.reply_data_rate;
}

void TestHub::change_siren(const std::string& name, const SirenConfig& config) {
  Known& siren = known(name);
  const std::uint32_t address = siren.address;
  const bool wifi = siren.siren.wifi;
  siren.siren = config;
  siren.siren.address = address;
  siren.siren.wifi = wifi;
  bump(siren.version);
  siren.reply_rate_of_version[siren.version] = config.command_data_rate;
  if (siren.pending.active && siren.pending.type == protocol::message_type::siren_command) {
    // One at a time: settings wait for the unconfirmed command (protocol section 7).
    siren.settings_waiting = true;
    return;
  }
  send_siren_settings(static_cast<std::size_t>(&siren - known_.data()));
}

void TestHub::change_gateway(const std::string& name, const GatewayConfig& config) {
  Known& gateway = known(name);
  const GatewayConfig attached = gateway.gateway;
  gateway.gateway = config;
  gateway.gateway.address = attached.address;
  gateway.gateway.usb = attached.usb;
  gateway.gateway.network = attached.network;
  bump(gateway.version);
  send_gateway_settings(static_cast<std::size_t>(&gateway - known_.data()));
}

void TestHub::command_siren(const std::string& name, std::uint8_t action, std::uint16_t seconds) {
  Known& siren = known(name);
  protocol::SirenCommand command;
  command.action = action;
  command.sound_seconds = seconds;
  decide(HubAction::siren_command, name, std::int64_t{action} * 65536 + seconds);
  issue_to_siren(static_cast<std::size_t>(&siren - known_.data()),
                 seal(siren, command, protocol::Binding::none(), protocol::PacketLimit::radio),
                 protocol::message_type::siren_command);
}

void TestHub::drop_link(const std::string& name, device::LinkKind kind,
                        device::Duration noticed_after) {
  known(name).device->wire(kind).drop(noticed_after);
}

std::vector<HubPacket> TestHub::received_from(const std::string& name, std::uint8_t type) const {
  std::vector<HubPacket> found;
  for (const HubPacket& packet : received_) {
    if (packet.verdict == HubVerdict::accepted && packet.from == name &&
        (type == 0 || packet.type == type)) {
      found.push_back(packet);
    }
  }
  return found;
}

std::vector<HubSent> TestHub::sent_to(const std::string& name, std::uint8_t type) const {
  std::vector<HubSent> found;
  for (const HubSent& packet : sent_) {
    if (packet.to == name && (type == 0 || packet.type == type)) {
      found.push_back(packet);
    }
  }
  return found;
}

std::vector<HubDecision> TestHub::decisions(HubAction action, const std::string& device) const {
  std::vector<HubDecision> found;
  for (const HubDecision& decision : decisions_) {
    if (decision.action == action && (device.empty() || decision.device == device)) {
      found.push_back(decision);
    }
  }
  return found;
}

std::uint8_t TestHub::settings_version(const std::string& name) const {
  return known(name).version;
}

const ReplayWindow& TestHub::window(const std::string& name) const {
  return known(name).window;
}

bool TestHub::countdown_running(const std::string& name) const {
  return known(name).countdown.active;
}

StationId TestHub::station() const {
  if (radio_ == nullptr) {
    throw SimulationError("the hub has its own radio only in direct radio mode");
  }
  return radio_->station();
}

std::string TestHub::dump() const {
  std::vector<std::pair<device::Instant, std::string>> lines;
  for (const HubPacket& packet : received_) {
    std::ostringstream line;
    line << "received " << (packet.from.empty() ? "?" : packet.from) << " "
         << message_type_name(packet.type) << " #" << packet.counter << " "
         << hub_verdict_name(packet.verdict) << " by " << path_name(packet.path)
         << (packet.via.empty() ? "" : " via " + packet.via);
    lines.emplace_back(packet.at, line.str());
  }
  for (const HubSent& packet : sent_) {
    std::ostringstream line;
    line << "sent " << packet.to << " " << message_type_name(packet.type) << " #" << packet.counter
         << " by " << path_name(packet.path) << (packet.via.empty() ? "" : " via " + packet.via);
    lines.emplace_back(packet.at, line.str());
  }
  for (const HubDecision& decision : decisions_) {
    std::ostringstream line;
    line << "decided " << hub_action_name(decision.action) << " "
         << (decision.device.empty() ? "-" : decision.device) << " " << decision.value;
    lines.emplace_back(decision.at, line.str());
  }
  std::stable_sort(lines.begin(), lines.end(),
                   [](const auto& a, const auto& b) { return a.first < b.first; });
  std::string text;
  for (const auto& line : lines) {
    text += format_instant(line.first) + "  " + line.second + "\n";
  }
  return text;
}

void TestHub::link_up(LinkWire& wire) {
  const std::size_t index = index_of_wire(wire);
  if (index != kNone && known_[index].role == protocol::Role::gateway) {
    // A new connection: nothing is accepted until its hello.
    known_[index].session = Session{};
    known_[index].session.wire = &wire;
  }
}

void TestHub::link_down(LinkWire& wire) {
  const std::size_t index = index_of_wire(wire);
  if (index != kNone && known_[index].role == protocol::Role::gateway &&
      known_[index].session.wire == &wire) {
    known_[index].session = Session{};
  }
}

void TestHub::link_packet(LinkWire& wire, const Bytes& packet) {
  const std::size_t index = index_of_wire(wire);
  if (index == kNone) {
    return;
  }
  if (known_[index].role == protocol::Role::gateway) {
    on_gateway_packet(index, wire, packet);
    return;
  }
  Arrival arrival;
  arrival.packet = packet;
  arrival.path = HubPath::link;
  arrival.ended_at = sim_.now();
  on_arrival(arrival);
}

std::optional<std::uint8_t> TestHub::message_type(protocol::ByteView packet,
                                                  const protocol::PacketHeader& header) {
  if (header.direction == protocol::Direction::from_hub) {
    const auto found = sealed_types_.find(Bytes(packet.begin(), packet.end()));
    if (found == sealed_types_.end()) {
      return std::nullopt;
    }
    return found->second;
  }
  const std::size_t index = index_of_address(header.address);
  if (index == kNone) {
    return std::nullopt;
  }
  Known& device = known_[index];
  const auto plain = open(device, packet, protocol::Binding::none(), protocol::PacketLimit::link);
  if (plain.has_value()) {
    return plain->type;
  }
  if (device.role == protocol::Role::gateway && device.session.open) {
    const auto bound =
        open(device, packet,
             protocol::Binding::session(device.session.gateway_random, device.session.hub_random),
             protocol::PacketLimit::link);
    if (bound.has_value()) {
      return bound->type;
    }
  }
  return std::nullopt;
}

}  // namespace hsn::host
