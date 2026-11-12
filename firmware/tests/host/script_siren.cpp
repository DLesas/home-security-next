#include "host/script_siren.hpp"

#include "hsn/device/services/radio_plan.hpp"

namespace hsn::test {

std::size_t ScriptSirenLog::count(device::CommandVerdict verdict) const {
  std::size_t total = 0;
  for (const Command& command : commands) {
    total += command.verdict == verdict ? 1u : 0u;
  }
  return total;
}

ScriptSiren::ScriptSiren(device::Services& services, device::SirenIo& io,
                         const ScriptSirenConfig& config, ScriptSirenLog& log)
    : services_(services),
      io_(io),
      config_(config),
      log_(log),
      command_rate_(config.command_data_rate) {}

std::uint8_t ScriptSiren::role_id() const {
  return protocol::Role::siren;
}

void ScriptSiren::listen(device::Instant now) {
  device::RxParams params;
  params.channel.frequency_hz = device::kReplyFrequencyHz;
  params.channel.data_rate = command_rate_;
  static_cast<void>(services_.radio_port.listen(params, now));
}

void ScriptSiren::on_command(protocol::ByteView packet, bool by_wifi, protocol::PacketLimit limit,
                             device::Instant now) {
  const auto opened = services_.channel.open_command(packet, limit);
  if (!opened.ok()) {
    return;
  }
  ScriptSirenLog::Command command;
  command.at = now;
  command.counter = opened.value().packet.header.counter;
  command.type = opened.value().packet.type;
  command.verdict = opened.value().verdict;
  command.by_wifi = by_wifi;
  if (command.verdict == device::CommandVerdict::new_command) {
    if (command.type == protocol::message_type::siren_command) {
      protocol::SirenCommand body;
      if (protocol::decode_body(opened.value().packet.body, body) == protocol::Error::none) {
        command.action = body.action;
        command.seconds = body.sound_seconds;
        if (body.action == protocol::SirenAction::sound_alarm ||
            body.action == protocol::SirenAction::test) {
          io_.output(true);
          output_until_ = now + device::seconds(body.sound_seconds);
        } else if (body.action == protocol::SirenAction::off) {
          io_.output(false);
          output_until_ = device::Instant::never();
        }
      }
    } else {
      protocol::SirenSettings settings;
      if (protocol::decode_body(opened.value().packet.body, settings) == protocol::Error::none) {
        log_.settings_version = settings.settings_version;
        command_rate_ = settings.command_data_rate;
      }
    }
  }
  log_.commands.push_back(command);
  if (command.verdict != device::CommandVerdict::too_old) {
    report(by_wifi, now);
  }
}

void ScriptSiren::report(bool by_wifi, device::Instant now) {
  protocol::SirenReport body;
  body.settings_version = log_.settings_version;
  body.state =
      output_until_.is_never() ? protocol::SirenState::off : protocol::SirenState::sounding_alarm;
  body.sounding_seconds_left =
      static_cast<std::uint16_t>(output_until_.is_never() ? 0 : (output_until_ - now).us / 1000000);
  body.last_command_counter_low =
      static_cast<std::uint16_t>(services_.channel.last_command() & 0xFFFFu);
  body.reason = protocol::SirenReportReason::command_answer;
  if (by_wifi) {
    device::Link* network = services_.hal.network;
    const auto sealed =
        services_.channel.seal(body, protocol::Binding::none(), protocol::PacketLimit::link,
                               protocol::MutableByteView(wifi_packet_));
    if (network != nullptr && sealed.ok() &&
        network->send(protocol::ByteView(wifi_packet_).first(sealed.value().size)) ==
            device::HalError::none) {
      log_.reports_by_wifi += 1;
    }
    return;
  }
  const auto sealed =
      services_.channel.seal(body, protocol::Binding::none(), protocol::PacketLimit::radio,
                             protocol::MutableByteView(lora_packet_));
  if (sealed.ok()) {
    lora_size_ = sealed.value().size;
    lora_waiting_ = true;
    send_lora(now);
  }
}

void ScriptSiren::send_lora(device::Instant now) {
  const device::PortState state = services_.radio_port.state();
  if (state == device::PortState::checking || state == device::PortState::backing_off ||
      state == device::PortState::sending) {
    return;
  }
  device::Transmission transmission;
  transmission.channel.frequency_hz =
      device::site_channel_frequency(services_.setup.pairing().site_channel).value_or(868300000u);
  transmission.channel.data_rate = config_.send_data_rate;
  transmission.power_dbm = config_.power_dbm;
  transmission.tx_class = device::TxClass::essential;
  if (services_.radio_port.send(protocol::ByteView(lora_packet_).first(lora_size_), transmission,
                                now) == device::Status::ok) {
    lora_waiting_ = false;
    log_.reports_by_lora += 1;
  }
}

void ScriptSiren::handle(const device::Event& event) {
  const device::Instant now = event.now;
  switch (event.kind) {
    case device::EventKind::boot:
      if (config_.wifi && services_.hal.network != nullptr) {
        static_cast<void>(services_.hal.network->connect(services_.setup.pairing().link_target()));
      }
      listen(now);
      break;
    case device::EventKind::link:
      if (event.link.kind == device::LinkEventKind::packet) {
        on_command(event.link.packet, true, protocol::PacketLimit::link, now);
      }
      break;
    case device::EventKind::radio: {
      const device::PortReport result = services_.radio_port.on_radio(event.radio, now);
      if (result.result == device::PortResult::received) {
        on_command(event.radio.packet, false, protocol::PacketLimit::radio, now);
      } else if (result.result == device::PortResult::sent) {
        listen(now);
      }
      break;
    }
    default:
      break;
  }
  if (services_.radio_port.next_deadline() <= now) {
    static_cast<void>(services_.radio_port.on_timer(now));
  }
  if (output_until_ <= now) {
    output_until_ = device::Instant::never();
    io_.output(false);
  }
  if (lora_waiting_) {
    send_lora(now);
  }
}

device::Wake ScriptSiren::next_wake() const {
  device::Wake wake;
  wake.at = device::earliest(output_until_, services_.radio_port.next_deadline());
  // A siren never sleeps deeper than awake (design section 7).
  wake.deepest = device::SleepDepth::awake;
  return wake;
}

protocol::MutableByteView ScriptSiren::state_bytes() {
  return protocol::MutableByteView(state_);
}

std::uint8_t ScriptSiren::state_layout() const {
  return 1;
}

std::uint8_t ScriptSiren::state_id() const {
  return 0;
}

device::Duration ScriptSiren::longest_awake() const {
  return device::Duration{};
}

}  // namespace hsn::test
