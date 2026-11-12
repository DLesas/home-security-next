#include "hsn/host/radio_bridge.hpp"

#include <utility>

namespace hsn::host {

RadioBridge::RadioBridge(FakeRadio& radio, Medium& medium, ActorId actor, Deliver deliver)
    : radio_(radio),
      medium_(medium),
      station_(medium.add_station(actor, *this)),
      deliver_(std::move(deliver)) {
  radio_.set_observer(this);
}

RadioBridge::~RadioBridge() {
  radio_.set_observer(nullptr);
}

void RadioBridge::quiesce() {
  if (radio_.mode() != RadioMode::sleeping) {
    static_cast<void>(radio_.sleep(true));
  }
  medium_.standby(station_);
}

void RadioBridge::operation_started(FakeRadio& radio, const RadioCall& call) {
  switch (call.kind) {
    case RadioCall::Kind::transmit:
      medium_.transmit(station_, call.channel, call.power_dbm, call.packet);
      break;
    case RadioCall::Kind::receive: {
      Listening listening;
      listening.frequency_hz = call.rx.channel.frequency_hz;
      listening.data_rates = static_cast<std::uint8_t>(1u << (call.rx.channel.data_rate & 7u));
      listening.timeout = call.rx.timeout;
      listening.stop = call.rx.stop;
      listening.symbol_timeout = call.rx.symbol_timeout;
      medium_.receive(station_, listening);
      break;
    }
    case RadioCall::Kind::detect_activity:
      medium_.detect(station_, call.cad);
      break;
    case RadioCall::Kind::noise:
      radio.noise = medium_.instant_rssi_dbm(station_);
      break;
    case RadioCall::Kind::sleep:
    case RadioCall::Kind::recover:
      medium_.standby(station_);
      break;
  }
}

void RadioBridge::tx_done(device::Instant) {
  deliver_([this](device::Instant local_at) { return radio_.tx_done(local_at); });
}

void RadioBridge::rx_done(device::Instant, const Bytes& packet, std::int16_t rssi_dbm,
                          std::int8_t snr_quarter_db, std::uint8_t) {
  deliver_([this, &packet, rssi_dbm, snr_quarter_db](device::Instant local_at) {
    return radio_.rx_done(local_at, packet, rssi_dbm, snr_quarter_db);
  });
}

void RadioBridge::rx_crc_error(device::Instant) {
  deliver_([this](device::Instant local_at) { return radio_.rx_crc_error(local_at); });
}

void RadioBridge::rx_timeout(device::Instant) {
  deliver_([this](device::Instant local_at) { return radio_.rx_timeout(local_at); });
}

void RadioBridge::header_seen(device::Instant) {
  deliver_([this](device::Instant local_at) { return radio_.header_seen(local_at); });
}

void RadioBridge::cad_done(device::Instant, bool busy) {
  deliver_([this, busy](device::Instant local_at) { return radio_.cad_done(local_at, busy); });
}

}  // namespace hsn::host
