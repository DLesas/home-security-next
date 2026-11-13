#include "probe_role.hpp"

#include "hsn/device/services/radio_plan.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/radio.hpp"

namespace hsn::test {

ProbeRole::ProbeRole(device::Services& services, device::SensorIo& io, const ProbeConfig& config,
                     ProbeLog& log)
    : services_(services),
      io_(io),
      config_(config),
      log_(log),
      count_(services.hal.storage, device::StoreKey::sensor_first, 1, ProbeCount{}) {}

std::uint8_t ProbeRole::role_id() const {
  return protocol::Role::sensor;
}

void ProbeRole::wake(device::Instant now) {
  state_.wakes += 1;
  // A steady rhythm: the next wake counts from the planned one, not from when the boot ran.
  const device::Instant planned = state_.next == device::Instant{} ? now : state_.next;
  state_.next = planned + config_.period;
  if (state_.next <= now) {
    state_.next = now + config_.period;
  }
  log_.wakes.push_back(now);
  if (config_.flash_every != 0 && state_.wakes % config_.flash_every == 0) {
    static_cast<void>(count_.update(ProbeCount{state_.wakes}));
  }
  if (config_.transmit) {
    send(now);
  }
  if (config_.listen_before_sleep) {
    device::RxParams params;
    params.channel.frequency_hz =
        device::site_channel_frequency(services_.setup.pairing().site_channel).value_or(868300000u);
    params.channel.data_rate = protocol::DataRate::dr5;
    static_cast<void>(services_.hal.radio.receive(params));
  }
}

void ProbeRole::send(device::Instant now) {
  protocol::Heartbeat heartbeat;
  heartbeat.door_change_count = static_cast<std::uint8_t>(state_.wakes);
  const auto sealed =
      services_.channel.seal(heartbeat, protocol::Binding::none(), protocol::PacketLimit::radio,
                             protocol::MutableByteView(packet_));
  if (!sealed.ok()) {
    return;
  }
  device::Transmission transmission;
  transmission.channel.frequency_hz =
      device::site_channel_frequency(services_.setup.pairing().site_channel).value_or(868300000u);
  transmission.channel.data_rate = protocol::DataRate::dr5;
  static_cast<void>(services_.radio_port.send(
      protocol::ByteView(packet_).first(sealed.value().size), transmission, now));
}

void ProbeRole::handle(const device::Event& event) {
  ram_events_ += 1;
  for (std::uint32_t i = 0; i < config_.extra_calls; ++i) {
    static_cast<void>(io_.door_open());
  }
  const device::Instant now = event.now;
  switch (event.kind) {
    case device::EventKind::boot:
      if (event.boot.retained == device::RetainedStatus::none) {
        state_ = ProbeState{};
      }
      if (config_.deep || state_.next == device::Instant{}) {
        wake(now);
      }
      break;
    case device::EventKind::radio:
      static_cast<void>(services_.radio_port.on_radio(event.radio, now));
      break;
    default:
      break;
  }
  if (services_.radio_port.next_deadline() <= now) {
    static_cast<void>(services_.radio_port.on_timer(now));
  }
  if (!config_.deep && state_.next <= now) {
    wake(now);
  }
  ProbeLog::Entry entry;
  entry.local = now;
  entry.kind = event.kind;
  entry.boot = event.boot;
  entry.input = event.input;
  entry.wakes = state_.wakes;
  entry.ram_events = ram_events_;
  log_.entries.push_back(entry);
}

device::Wake ProbeRole::next_wake() const {
  device::Wake wake;
  if (services_.radio_port.state() != device::PortState::idle) {
    // A send is in progress: wait for it awake.
    wake.at = services_.radio_port.next_deadline();
    wake.deepest = device::SleepDepth::light;
    return wake;
  }
  wake.at = state_.next;
  wake.deepest = config_.deep ? device::SleepDepth::deep : device::SleepDepth::light;
  wake.deep_wake_inputs = config_.deep ? config_.deep_wake_inputs.with_timer() : device::WakeMask();
  return wake;
}

protocol::MutableByteView ProbeRole::state_bytes() {
  return protocol::MutableByteView(reinterpret_cast<std::uint8_t*>(&state_), sizeof(state_));
}

std::uint8_t ProbeRole::state_layout() const {
  return 1;
}

std::uint8_t ProbeRole::state_id() const {
  return 1;
}

device::Duration ProbeRole::longest_awake() const {
  return device::Duration{};
}

}  // namespace hsn::test
