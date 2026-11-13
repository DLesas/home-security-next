// The test hub's gateway rules (protocol section 7, "Gateway connection"): a hello opens a
// connection and is answered with a welcome bound to it, then the settings; every later packet is
// bound to the session and strictly higher; forwarded packets are opened as radio arrivals; radio
// packets go out as transmit requests and come back as transmit results.

#include "hsn/host/test_hub.hpp"

namespace hsn::host {

void TestHub::on_gateway_packet(std::size_t index, LinkWire& wire, const Bytes& packet) {
  Known& gateway = known_[index];
  Arrival meta;
  meta.packet = packet;
  meta.path = HubPath::link;
  meta.ended_at = sim_.now();
  const protocol::ByteView view(packet.data(), packet.size());
  const auto header =
      protocol::read_header(view, protocol::Direction::to_hub, protocol::PacketLimit::link);
  if (!header.ok()) {
    record_received(&gateway, meta, HubVerdict::malformed, nullptr);
    return;
  }
  if (header.value().address != gateway.address) {
    record_received(nullptr, meta, HubVerdict::unknown_address, nullptr);
    return;
  }

  // A hello, which carries no binding, opens a new connection whatever came before.
  const auto plain = open(gateway, view, protocol::Binding::none(), protocol::PacketLimit::link);
  if (plain.has_value() && plain->type == protocol::message_type::hello) {
    protocol::Hello hello;
    if (protocol::decode_body(protocol::ByteView(plain->body.data(), plain->body.size()), hello) !=
        protocol::Error::none) {
      record_received(&gateway, meta, HubVerdict::malformed, &*plain);
      return;
    }
    Session& session = gateway.session;
    session = Session{};
    session.open = true;
    session.gateway_random = hello.gateway_random;
    random_bytes(session.hub_random);
    // The first packet on a new connection may carry any counter (protocol section 4).
    session.last_accepted = plain->counter;
    session.wire = &wire;
    record_received(&gateway, meta, HubVerdict::accepted, &*plain);
    decide(HubAction::gateway_welcomed, gateway.name);
    protocol::Welcome welcome;
    welcome.hub_random = session.hub_random;
    send_link(gateway, wire,
              seal(gateway, welcome, protocol::Binding::hello(session.gateway_random),
                   protocol::PacketLimit::link),
              protocol::message_type::welcome);
    send_gateway_settings(index);
    return;
  }

  Session& session = gateway.session;
  if (!session.open || session.wire != &wire) {
    record_received(&gateway, meta, HubVerdict::no_session, nullptr);
    return;
  }
  const auto opened =
      open(gateway, view, protocol::Binding::session(session.gateway_random, session.hub_random),
           protocol::PacketLimit::link);
  if (!opened.has_value()) {
    record_received(&gateway, meta, HubVerdict::bad_tag, nullptr);
    return;
  }
  const protocol::CounterVerdict verdict =
      protocol::StrictlyHigherCounter(session.last_accepted).check(opened->counter);
  if (verdict != protocol::CounterVerdict::accepted) {
    record_received(&gateway, meta,
                    verdict == protocol::CounterVerdict::duplicate ? HubVerdict::duplicate
                                                                   : HubVerdict::too_old,
                    &*opened);
    return;
  }
  const protocol::ByteView body(opened->body.data(), opened->body.size());
  const protocol::Error error = protocol::decode_message(opened->type, body, [](const auto&) {});
  if (error != protocol::Error::none) {
    record_received(&gateway, meta, HubVerdict::malformed, &*opened);
    return;
  }
  session.last_accepted = opened->counter;
  record_received(&gateway, meta, HubVerdict::accepted, &*opened);

  switch (opened->type) {
    case protocol::message_type::forwarded_packet: {
      protocol::ForwardedPacket forwarded;
      static_cast<void>(protocol::decode_body(body, forwarded));
      Arrival arrival;
      arrival.packet.assign(forwarded.packet.bytes.begin(), forwarded.packet.bytes.end());
      arrival.path = HubPath::gateway;
      arrival.gateway = index;
      // The hub learns of the packet now; the gateway's clock says when it really ended.
      arrival.ended_at = sim_.now();
      arrival.gateway_time = forwarded.received_at_micros;
      arrival.rssi_dbm = forwarded.rssi_dbm;
      arrival.snr_quarter_db = forwarded.snr_quarter_db;
      arrival.data_rate = forwarded.data_rate;
      arrival.site_channel = forwarded.site_channel;
      on_arrival(arrival);
      break;
    }
    case protocol::message_type::gateway_status: {
      protocol::GatewayStatus status;
      static_cast<void>(protocol::decode_body(body, status));
      if (status.settings_version != gateway.version) {
        send_gateway_settings(index);
      }
      break;
    }
    case protocol::message_type::transmit_result: {
      protocol::TransmitResult result;
      static_cast<void>(protocol::decode_body(body, result));
      const auto found =
          outstanding_.find((static_cast<std::uint64_t>(index) << 32) | result.request_counter);
      if (found != outstanding_.end()) {
        decide(HubAction::transmit_result, known_[found->second.to].name, result.result);
        outstanding_.erase(found);
      }
      break;
    }
    case protocol::message_type::log_entries:
      on_log_entries(index, *opened, meta);
      break;
    default:
      break;
  }
}

void TestHub::send_gateway_settings(std::size_t index) {
  Known& gateway = known_[index];
  const Session& session = gateway.session;
  if (!session.open || session.wire == nullptr) {
    return;
  }
  protocol::GatewaySettings settings;
  settings.settings_version = gateway.version;
  settings.site_channel = options_.site_channel;
  settings.listen_data_rate_mask = gateway.gateway.listen_data_rate_mask;
  settings.status_interval_seconds = gateway.gateway.status_interval_seconds;
  settings.interference_threshold_db = gateway.gateway.interference_threshold_db;
  settings.interference_seconds = gateway.gateway.interference_seconds;
  settings.default_tx_power_dbm = gateway.gateway.default_tx_power_dbm;
  settings.siren_tx_power_dbm = gateway.gateway.siren_tx_power_dbm;
  send_link(gateway, *session.wire,
            seal(gateway, settings,
                 protocol::Binding::session(session.gateway_random, session.hub_random),
                 protocol::PacketLimit::link),
            protocol::message_type::gateway_settings);
  decide(HubAction::gateway_settings, gateway.name, gateway.version);
}

void TestHub::request_transmit(const Downlink& downlink) {
  // Replies go back through the gateway that heard the packet (GW9); otherwise any connected one.
  const std::size_t index = connected_gateway(downlink.gateway);
  if (index == kNone) {
    decide(HubAction::no_path, known_[downlink.to].name, downlink.type);
    return;
  }
  Known& gateway = known_[index];
  protocol::TransmitRequest request;
  // Times on a gateway's clock make sense only on the gateway that heard the packet.
  const bool own_clock = index == downlink.gateway;
  if (downlink.fixed_moment && own_clock) {
    request.when = protocol::TransmitWhen::at_time;
    request.gateway_time_micros =
        downlink.gateway_time + static_cast<std::uint32_t>(downlink.offset.us & 0xFFFFFFFF);
  } else {
    request.when = protocol::TransmitWhen::as_soon_as_possible;
    if (downlink.limited && own_clock) {
      const std::uint32_t latest =
          downlink.gateway_time + static_cast<std::uint32_t>(downlink.offset.us & 0xFFFFFFFF);
      // 0 means no limit; one microsecond later is the same moment for every purpose.
      request.gateway_time_micros = latest == 0 ? 1 : latest;
    }
  }
  request.data_rate = downlink.data_rate;
  request.power_dbm = downlink.siren_command ? gateway.gateway.siren_tx_power_dbm
                                             : gateway.gateway.default_tx_power_dbm;
  request.priority = downlink.siren_command ? protocol::TransmitPriority::siren_command
                                            : protocol::TransmitPriority::normal;
  request.packet.bytes = protocol::ByteView(downlink.packet.data(), downlink.packet.size());
  const Session& session = gateway.session;
  const Bytes sealed =
      seal(gateway, request, protocol::Binding::session(session.gateway_random, session.hub_random),
           protocol::PacketLimit::link);
  outstanding_[(static_cast<std::uint64_t>(index) << 32) | (gateway.next_counter - 1)] =
      Outstanding{downlink.to, downlink.type, downlink.counter, downlink.data_rate,
                  downlink.packet};
  send_link(gateway, *session.wire, sealed, protocol::message_type::transmit_request);
  sent_.push_back(HubSent{sim_.now(), known_[downlink.to].name, HubPath::gateway, gateway.name,
                          downlink.counter, downlink.type, downlink.data_rate, downlink.packet});
}

}  // namespace hsn::host
