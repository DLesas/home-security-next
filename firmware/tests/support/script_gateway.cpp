#include "script_gateway.hpp"

#include "hsn/device/services/radio_plan.hpp"

namespace hsn::test {
namespace {

constexpr std::uint64_t kClockSpan = std::uint64_t{1} << 32;

/** The gateway's microsecond clock: the low 32 bits of the instant (protocol section 6). */
std::uint32_t low32(device::Instant at) {
  return static_cast<std::uint32_t>(at.us & 0xFFFFFFFFu);
}

/** The instant nearest `now` whose low 32 bits are `low` (design section 7, gateway). */
device::Instant nearest(device::Instant now, std::uint32_t low) {
  std::uint64_t candidate = (now.us & ~(kClockSpan - 1)) | low;
  if (candidate + kClockSpan / 2 < now.us) {
    candidate += kClockSpan;
  } else if (candidate > now.us + kClockSpan / 2 && candidate >= kClockSpan) {
    candidate -= kClockSpan;
  }
  return device::Instant{candidate};
}

}  // namespace

ScriptGateway::ScriptGateway(device::Services& services, device::GatewayIo& io,
                             const ScriptGatewayConfig& config, ScriptGatewayLog& log)
    : services_(services), io_(io), config_(config), log_(log), logger_(config.log_entries) {
  // The scripted gateway reads no inputs and shows no LED.
  static_cast<void>(io_);
}

std::uint8_t ScriptGateway::role_id() const {
  return protocol::Role::gateway;
}

device::Link* ScriptGateway::link() const {
  return config_.use_usb ? services_.hal.usb : services_.hal.network;
}

void ScriptGateway::send_to_hub(std::size_t size) {
  if (link() != nullptr) {
    static_cast<void>(link()->send(protocol::ByteView(out_).first(size)));
  }
}

void ScriptGateway::listen() {
  device::RxParams params;
  params.channel.frequency_hz = device::site_channel_frequency(site_channel_).value_or(868300000u);
  params.channel.data_rate = config_.listen_data_rate;
  params.stop = device::RxStop::header;
  static_cast<void>(services_.hal.radio.receive(params));
}

void ScriptGateway::result(std::uint32_t counter, std::uint8_t outcome, device::Instant now) {
  protocol::TransmitResult body;
  body.request_counter = counter;
  body.result = outcome;
  body.sent_at_micros = low32(now);
  log_.results.push_back(ScriptGatewayLog::Result{counter, outcome});
  const auto sealed = services_.channel.seal(body, session_.binding(), protocol::PacketLimit::link,
                                             protocol::MutableByteView(out_));
  if (sealed.ok()) {
    send_to_hub(sealed.value().size);
  }
}

void ScriptGateway::transmit(const Request& request, device::Instant now) {
  const device::HalError error = services_.hal.radio.transmit(
      device::RadioChannel{device::kReplyFrequencyHz, request.data_rate}, request.power_dbm,
      protocol::ByteView(request.packet.data(), request.packet.size()));
  if (error != device::HalError::none) {
    result(request.counter, protocol::TransmitOutcome::radio_busy, now);
    return;
  }
  transmitting_ = true;
  result(request.counter, protocol::TransmitOutcome::sent, now);
}

void ScriptGateway::serve_queue(device::Instant now) {
  while (!queue_.empty() && !transmitting_ && !receiving_) {
    const Request request = queue_.front();
    queue_.pop_front();
    if (now > request.when) {
      result(request.counter, protocol::TransmitOutcome::too_late, now);
      continue;
    }
    transmit(request, now);
  }
}

void ScriptGateway::on_request(const protocol::TransmitRequest& body, std::uint32_t counter,
                               device::Instant now) {
  log_.requests += 1;
  if (!device::time_on_air(body.data_rate, body.packet.bytes.size()).has_value()) {
    result(counter, protocol::TransmitOutcome::not_valid, now);
    return;
  }
  Request request;
  request.counter = counter;
  request.data_rate = body.data_rate;
  request.power_dbm = body.power_dbm;
  request.siren_command = body.priority == protocol::TransmitPriority::siren_command;
  log_.siren_requests += request.siren_command ? 1u : 0u;
  log_.timed_requests += body.when == protocol::TransmitWhen::at_time ? 1u : 0u;
  request.packet.assign(body.packet.bytes.begin(), body.packet.bytes.end());
  if (body.when == protocol::TransmitWhen::at_time) {
    request.when = nearest(now, body.gateway_time_micros);
    if (request.when < now) {
      result(counter, protocol::TransmitOutcome::too_late, now);
    } else if (scheduled_) {
      result(counter, protocol::TransmitOutcome::radio_busy, now);
    } else {
      scheduled_ = true;
      at_time_ = request;
    }
    return;
  }
  request.when = body.gateway_time_micros == 0 ? device::Instant::never()
                                               : nearest(now, body.gateway_time_micros);
  // Siren commands go before everything else waiting.
  auto place = queue_.end();
  if (request.siren_command) {
    place = queue_.begin();
    while (place != queue_.end() && place->siren_command) {
      ++place;
    }
  }
  queue_.insert(place, request);
  serve_queue(now);
}

void ScriptGateway::on_link(const device::LinkEvent& event, device::Instant now) {
  switch (event.kind) {
    case device::LinkEventKind::up: {
      protocol::RandomValue random{};
      services_.random.fill(protocol::MutableByteView(random));
      session_.begin(random);
      protocol::Hello hello;
      hello.gateway_random = random;
      hello.firmware_version = services_.hal.build.version;
      hello.settings_version = log_.settings_version;
      const auto sealed =
          services_.channel.seal(hello, protocol::Binding::none(), protocol::PacketLimit::link,
                                 protocol::MutableByteView(out_));
      if (sealed.ok()) {
        send_to_hub(sealed.value().size);
        log_.hellos += 1;
      }
      break;
    }
    case device::LinkEventKind::down:
      session_ = device::SessionState{};
      break;
    case device::LinkEventKind::packet: {
      const auto opened = services_.channel.open_session(event.packet, session_);
      if (!opened.ok()) {
        log_.rejected += 1;
        return;
      }
      const protocol::ByteView body = opened.value().body;
      switch (opened.value().type) {
        case protocol::message_type::welcome:
          log_.welcomes += 1;
          break;
        case protocol::message_type::gateway_settings: {
          protocol::GatewaySettings settings;
          if (protocol::decode_body(body, settings) == protocol::Error::none) {
            log_.settings += 1;
            log_.settings_version = settings.settings_version;
            site_channel_ = settings.site_channel;
            if (!transmitting_) {
              listen();
            }
          }
          break;
        }
        case protocol::message_type::transmit_request: {
          protocol::TransmitRequest request;
          if (protocol::decode_body(body, request) == protocol::Error::none) {
            on_request(request, opened.value().header.counter, now);
          } else {
            result(opened.value().header.counter, protocol::TransmitOutcome::not_valid, now);
          }
          break;
        }
        default:
          break;
      }
      break;
    }
  }
}

void ScriptGateway::on_radio(const device::RadioEvent& radio, device::Instant now) {
  switch (radio.kind) {
    case device::RadioEventKind::header_seen:
      receiving_ = true;
      break;
    case device::RadioEventKind::rx_done: {
      receiving_ = false;
      if (radio.packet.size() >= protocol::kMinCarriedPacketSize && session_.welcomed) {
        protocol::ForwardedPacket forwarded;
        forwarded.received_at_micros = low32(radio.at);
        forwarded.rssi_dbm = radio.rssi_dbm;
        forwarded.snr_quarter_db = radio.snr_quarter_db;
        forwarded.data_rate = config_.listen_data_rate;
        forwarded.site_channel = site_channel_;
        forwarded.packet.bytes = radio.packet;
        const auto sealed =
            services_.channel.seal(forwarded, session_.binding(), protocol::PacketLimit::link,
                                   protocol::MutableByteView(out_));
        if (sealed.ok()) {
          send_to_hub(sealed.value().size);
          log_.forwarded += 1;
        }
      }
      serve_queue(now);
      break;
    }
    case device::RadioEventKind::rx_crc_error:
      receiving_ = false;
      serve_queue(now);
      break;
    case device::RadioEventKind::tx_done:
      transmitting_ = false;
      listen();
      serve_queue(now);
      break;
    default:
      break;
  }
}

void ScriptGateway::send_logs(device::Instant now) {
  protocol::LogEntries entries;
  if (!session_.welcomed || link() == nullptr || services_.log.prepare(now, entries) == 0) {
    return;
  }
  const auto sealed = services_.channel.seal(
      entries, session_.binding(), protocol::PacketLimit::link, protocol::MutableByteView(out_));
  // Over its link the entries leave once the link takes the packet (protocol section 6).
  if (sealed.ok() &&
      link()->send(protocol::ByteView(out_).first(sealed.value().size)) == device::HalError::none) {
    services_.log.release();
    log_.log_packets += 1;
  }
}

void ScriptGateway::handle(const device::Event& event) {
  const device::Instant now = event.now;
  switch (event.kind) {
    case device::EventKind::boot:
      site_channel_ = services_.setup.pairing().site_channel;
      if (link() != nullptr) {
        static_cast<void>(link()->connect(services_.setup.pairing().link_target()));
      }
      listen();
      break;
    case device::EventKind::link:
      on_link(event.link, now);
      break;
    case device::EventKind::radio:
      on_radio(event.radio, now);
      break;
    default:
      break;
  }
  if (scheduled_ && at_time_.when <= now) {
    scheduled_ = false;
    // Receiving comes first: a fixed-moment packet is skipped when the radio is busy then.
    if (transmitting_ || receiving_) {
      result(at_time_.counter, protocol::TransmitOutcome::radio_busy, now);
    } else {
      transmit(at_time_, now);
    }
  }
  logger_.run(services_.log, now);
  send_logs(now);
}

device::Wake ScriptGateway::next_wake() const {
  device::Wake wake;
  wake.at = device::earliest(scheduled_ ? at_time_.when : device::Instant::never(), logger_.next());
  wake.deepest = device::SleepDepth::awake;
  return wake;
}

protocol::MutableByteView ScriptGateway::state_bytes() {
  return protocol::MutableByteView(state_);
}

std::uint8_t ScriptGateway::state_layout() const {
  return 1;
}

std::uint8_t ScriptGateway::state_id() const {
  return 0;
}

device::Duration ScriptGateway::longest_awake() const {
  return device::Duration{};
}

}  // namespace hsn::test
