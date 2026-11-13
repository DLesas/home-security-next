#include "test_transmitter.hpp"

#include "hsn/host/role_box.hpp"
#include "hsn/protocol/messages.hpp"

namespace hsn::test::sensor {

TestTransmitter::TestTransmitter(device::Services& services, const TransmitterConfig& config)
    : services_(services), config_(config) {}

std::uint8_t TestTransmitter::role_id() const {
  return protocol::Role::sensor;
}

void TestTransmitter::send_next(device::Instant now) {
  if (done_ || config_.packets.empty() || now < config_.start) {
    return;
  }
  if (config_.repeat ? now >= config_.stop : next_ >= config_.packets.size()) {
    done_ = true;
    static_cast<void>(services_.hal.radio.sleep(true));
    return;
  }
  const auto& packet = config_.packets[next_ % config_.packets.size()];
  next_ += 1;
  sending_ = services_.hal.radio.transmit(config_.channel, config_.power_dbm,
                                          protocol::ByteView(packet.data(), packet.size())) ==
             device::HalError::none;
}

void TestTransmitter::handle(const device::Event& event) {
  if (event.kind == device::EventKind::radio &&
      event.radio.kind == device::RadioEventKind::tx_done) {
    sending_ = false;
  }
  if (!sending_) {
    send_next(event.now);
  }
}

device::Wake TestTransmitter::next_wake() const {
  device::Wake wake;
  wake.at = sending_ || done_ ? device::Instant::never() : config_.start;
  wake.deepest = device::SleepDepth::light;
  return wake;
}

protocol::MutableByteView TestTransmitter::state_bytes() {
  return protocol::MutableByteView(state_);
}

std::uint8_t TestTransmitter::state_layout() const {
  return 1;
}

std::uint8_t TestTransmitter::state_id() const {
  return 0;
}

device::Duration TestTransmitter::longest_awake() const {
  return device::Duration{};
}

host::SimDevice& add_transmitter(host::Simulation& sim, const std::string& name,
                                 const TransmitterConfig& config, std::uint32_t address) {
  // The board's clock reads zero at its power-on, which is now.
  TransmitterConfig local = config;
  const device::Duration since_start = sim.now() - device::Instant{};
  local.start = device::Instant{} + (config.start - device::Instant{} - since_start);
  local.stop = device::Instant{} + (config.stop - device::Instant{} - since_start);
  host::DeviceSpec spec;
  spec.name = name;
  spec.power_on = sim.now();
  spec.role = [local](device::Services& services, host::HostBoard&) {
    return host::box_role<TestTransmitter>(services, local);
  };
  host::SimDevice& device = sim.add_device(spec);
  host::Provisioning pairing;
  pairing.role = protocol::Role::sensor;
  pairing.address = address;
  pairing.key = {9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9};
  host::provision(device.board(), pairing);
  return device;
}

}  // namespace hsn::test::sensor
