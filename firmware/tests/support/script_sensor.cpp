#include "script_sensor.hpp"

#include "hsn/device/services/radio_plan.hpp"
#include "hsn/protocol/units.hpp"

namespace hsn::test {
namespace {

/** The heartbeat reply moment and the listening margin before it (protocol section 8). */
constexpr device::Duration kReplyMoment = device::seconds(1);
constexpr device::Duration kEarly = device::milliseconds(20);
constexpr device::Duration kReplyWindow = device::milliseconds(150);

}  // namespace

std::size_t ScriptSensorLog::count(std::uint8_t type) const {
  std::size_t total = 0;
  for (const Heard& entry : heard) {
    total += entry.type == type ? 1u : 0u;
  }
  return total;
}

ScriptSensor::ScriptSensor(device::Services& services, device::SensorIo& io,
                           const ScriptSensorConfig& config, ScriptSensorLog& log)
    : services_(services), io_(io), config_(config), log_(log), logger_(config.log_entries) {}

std::uint8_t ScriptSensor::role_id() const {
  return protocol::Role::sensor;
}

std::uint32_t ScriptSensor::site_frequency() const {
  return device::site_channel_frequency(services_.setup.pairing().site_channel)
      .value_or(868300000u);
}

std::uint8_t ScriptSensor::reply_rate() const {
  // Until a reply gives it a reply rate, it listens at its own sending rate (protocol section 2).
  return holds_settings_ && !at_send_rate_ ? held_.reply_data_rate : config_.send_data_rate;
}

bool ScriptSensor::port_busy() const {
  const device::PortState state = services_.radio_port.state();
  return state == device::PortState::checking || state == device::PortState::backing_off ||
         state == device::PortState::sending;
}

protocol::SensorStatus ScriptSensor::status(bool reply_wanted) {
  protocol::SensorStatus status;
  status.settings_version = holds_settings_ ? held_.settings_version : 0;
  status.flags.door_open = door_open_;
  status.flags.reply_wanted = reply_wanted;
  status.flags.listening_at_send_rate = at_send_rate_;
  status.battery_code = protocol::battery_code_from_millivolts(io_.battery_millivolts());
  status.temperature_celsius = io_.chip_temperature_c();
  status.door_change_count = change_count_;
  return status;
}

bool ScriptSensor::send_sealed(std::size_t size, device::Instant now) {
  device::Transmission transmission;
  transmission.channel.frequency_hz = site_frequency();
  transmission.channel.data_rate = config_.send_data_rate;
  transmission.power_dbm = config_.power_dbm;
  // Heartbeats and log entries are routine traffic (protocol section 6).
  transmission.tx_class = last_sent_ == Sent::heartbeat || last_sent_ == Sent::log
                              ? device::TxClass::routine
                              : device::TxClass::essential;
  return services_.radio_port.send(protocol::ByteView(packet_).first(size), transmission, now) ==
         device::Status::ok;
}

void ScriptSensor::send_event(std::uint8_t type, device::Instant now) {
  if (port_busy()) {
    // One report at a time; the newest state goes when the port is free.
    waiting_event_ = type;
    return;
  }
  waiting_event_ = 0;
  device::Outcome<device::Sealed> sealed(device::Status::not_ready);
  const protocol::MutableByteView out(packet_);
  if (type == protocol::message_type::started) {
    protocol::Started started;
    started.role = protocol::Role::sensor;
    started.firmware_version = services_.hal.build.version;
    started.settings_version = holds_settings_ ? held_.settings_version : 0;
    sealed = services_.channel.seal(started, protocol::Binding::none(),
                                    protocol::PacketLimit::radio, out);
  } else {
    protocol::DoorChanged report;
    static_cast<protocol::SensorStatus&>(report) = status(true);
    const std::int64_t age = (now - door_changed_at_).us / 1000000 + config_.extra_age_seconds;
    report.event_age_seconds = static_cast<std::uint16_t>(age > 0xFFFF ? 0xFFFF : age);
    sealed = services_.channel.seal(report, protocol::Binding::none(), protocol::PacketLimit::radio,
                                    out);
  }
  if (!sealed.ok()) {
    return;
  }
  last_sent_ = Sent::event;
  if (send_sealed(sealed.value().size, now)) {
    // A new event: its tries are the candidates for what the hub sends back.
    exchange_[0] = sealed.value().counter;
    exchange_size_ = 1;
    log_.sent.push_back(sealed.value().counter);
  }
}

void ScriptSensor::send_heartbeat(device::Instant now) {
  if (port_busy()) {
    return;
  }
  heartbeats_ += 1;
  if (config_.fall_back_at_heartbeat != 0 && heartbeats_ == config_.fall_back_at_heartbeat) {
    at_send_rate_ = true;
  }
  const bool link_check =
      config_.link_check_every != 0 && heartbeats_ % config_.link_check_every == 0;
  protocol::Heartbeat heartbeat;
  static_cast<protocol::SensorStatus&>(heartbeat) = status(link_check);
  const auto sealed =
      services_.channel.seal(heartbeat, protocol::Binding::none(), protocol::PacketLimit::radio,
                             protocol::MutableByteView(packet_));
  if (!sealed.ok()) {
    return;
  }
  last_sent_ = Sent::heartbeat;
  if (send_sealed(sealed.value().size, now)) {
    heartbeat_counter_ = sealed.value().counter;
    log_.sent.push_back(sealed.value().counter);
  }
}

void ScriptSensor::send_log(device::Instant now) {
  log_waiting_ = false;
  protocol::LogEntries entries;
  if (services_.log.prepare(now, entries, device::LogLevel::warning, 1) == 0) {
    return;
  }
  protocol::LogEntry first;
  protocol::LogEntryReader reader(entries.entries);
  static_cast<void>(reader.next(first));
  const auto sealed =
      services_.channel.seal(entries, protocol::Binding::none(), protocol::PacketLimit::radio,
                             protocol::MutableByteView(packet_));
  if (!sealed.ok()) {
    return;
  }
  last_sent_ = Sent::log;
  if (send_sealed(sealed.value().size, now)) {
    log_counter_ = sealed.value().counter;
    log_.sent.push_back(sealed.value().counter);
    log_.log_sends.push_back(ScriptSensorLog::LogSend{log_counter_, first.code, false});
  }
}

void ScriptSensor::listen(device::Duration timeout, device::Instant now) {
  device::RxParams params;
  params.channel.frequency_hz = device::kReplyFrequencyHz;
  params.channel.data_rate = reply_rate();
  params.timeout = timeout;
  params.stop = device::RxStop::preamble;
  window_end_ = timeout.us == 0 ? device::Instant::never() : now + timeout;
  static_cast<void>(services_.radio_port.listen(params, now));
}

void ScriptSensor::on_packet(protocol::ByteView packet, device::Instant now) {
  std::array<std::uint32_t, device::kMaxBoundCandidates> candidates{};
  std::size_t count = 0;
  for (std::size_t i = 0; i < exchange_size_ && count < candidates.size(); ++i) {
    candidates[count++] = exchange_[i];
  }
  if (heartbeat_counter_ != 0 && count < candidates.size()) {
    candidates[count++] = heartbeat_counter_;
  }
  if (log_counter_ != 0 && count < candidates.size()) {
    candidates[count++] = log_counter_;
  }
  const auto opened = services_.channel.open_bound(
      packet, protocol::Span<const std::uint32_t>(candidates.data(), count));
  if (!opened.ok()) {
    log_.rejected += 1;
    // Someone else's packet ended a timed receive: listen on for the rest of the window.
    if (services_.radio_port.state() == device::PortState::idle && window_end_ > now &&
        !window_end_.is_never()) {
      listen(window_end_ - now, now);
    }
    return;
  }
  ScriptSensorLog::Heard heard;
  heard.at = now;
  heard.type = opened.value().packet.type;
  heard.answered = opened.value().answered;
  if (log_counter_ != 0 && heard.answered == log_counter_) {
    // The hub has the entry: only now does it leave the log.
    services_.log.release();
    log_counter_ = 0;
    log_.log_sends.back().answered = true;
  }
  if (heard.type == protocol::message_type::reply &&
      protocol::decode_body(opened.value().packet.body, heard.reply) == protocol::Error::none) {
    held_ = heard.reply;
    holds_settings_ = true;
    // A reply tells it its reply rate again: it stops listening at its sending rate.
    at_send_rate_ = false;
    if (heard.reply.flags.countdown_started && heard.reply.countdown_remaining_seconds > 0) {
      // Buzzing: listen on until the countdown ends, for the disarmed notice.
      listen(device::Duration{}, now);
      listen_until_ = now + device::seconds(heard.reply.countdown_remaining_seconds + 1);
    }
  } else if (heard.type == protocol::message_type::disarmed_notice) {
    listen_until_ = device::Instant::never();
    services_.radio_port.sleep(now);
  }
  log_.heard.push_back(heard);
}

void ScriptSensor::on_radio(const device::RadioEvent& radio, device::Instant now) {
  const device::PortReport report = services_.radio_port.on_radio(radio, now);
  switch (report.result) {
    case device::PortResult::sent:
      if (last_sent_ == Sent::heartbeat) {
        // Listen briefly at the reply moment, counted from the end of the heartbeat.
        reply_at_ = report.at + (kReplyMoment - kEarly);
        if (config_.send_logs) {
          log_at_ = report.at + kReplyMoment + kReplyWindow;
        }
        services_.radio_port.sleep(now);
      } else {
        listen(config_.listen_time, now);
      }
      break;
    case device::PortResult::received:
      on_packet(radio.packet, now);
      break;
    default:
      break;
  }
}

void ScriptSensor::run_timers(device::Instant now) {
  if (services_.radio_port.next_deadline() <= now) {
    static_cast<void>(services_.radio_port.on_timer(now));
  }
  if (heartbeat_at_ <= now) {
    heartbeat_at_ = heartbeat_at_ + config_.heartbeat_every;
    send_heartbeat(now);
  }
  if (reply_at_ <= now) {
    reply_at_ = device::Instant::never();
    listen(kReplyWindow, now);
  }
  if (listen_until_ <= now) {
    listen_until_ = device::Instant::never();
    services_.radio_port.sleep(now);
  }
  if (waiting_event_ != 0 && !port_busy()) {
    send_event(waiting_event_, now);
  }
  logger_.run(services_.log, now);
  if (log_at_ <= now) {
    log_at_ = device::Instant::never();
    log_waiting_ = true;
  }
  // Not while it sends or still receives a packet; the next event tries again.
  if (log_waiting_ && !port_busy() &&
      services_.radio_port.state() != device::PortState::receiving) {
    send_log(now);
  }
}

void ScriptSensor::handle(const device::Event& event) {
  const device::Instant now = event.now;
  switch (event.kind) {
    case device::EventKind::boot:
      if (config_.heartbeat_every.us > 0) {
        heartbeat_at_ = now + config_.heartbeat_every;
      }
      if (config_.send_started) {
        send_event(protocol::message_type::started, now);
      }
      break;
    case device::EventKind::input:
      if (event.input.input == device::Input::door) {
        door_open_ = event.input.active;
        change_count_ = static_cast<std::uint8_t>(change_count_ + 1);
        door_changed_at_ = event.input.at;
        send_event(protocol::message_type::door_changed, now);
      }
      break;
    case device::EventKind::radio:
      on_radio(event.radio, now);
      break;
    default:
      break;
  }
  run_timers(now);
}

device::Wake ScriptSensor::next_wake() const {
  device::Wake wake;
  wake.at = device::earliest(device::earliest(heartbeat_at_, reply_at_),
                             device::earliest(listen_until_, services_.radio_port.next_deadline()));
  wake.at = device::earliest(wake.at, device::earliest(log_at_, logger_.next()));
  wake.deepest = device::SleepDepth::light;
  return wake;
}

protocol::MutableByteView ScriptSensor::state_bytes() {
  return protocol::MutableByteView(state_);
}

std::uint8_t ScriptSensor::state_layout() const {
  return 1;
}

std::uint8_t ScriptSensor::state_id() const {
  return 0;
}

device::Duration ScriptSensor::longest_awake() const {
  return device::Duration{};
}

}  // namespace hsn::test
