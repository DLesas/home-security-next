#include "hsn/host/hub_radio.hpp"

#include <utility>

#include "hsn/device/services/radio_plan.hpp"

namespace hsn::host {

HubRadio::HubRadio(Scheduler& scheduler, Medium& medium, ActorId actor,
                   std::uint32_t site_frequency_hz, std::uint8_t data_rates, Heard heard,
                   Result result)
    : scheduler_(scheduler),
      medium_(medium),
      station_(medium.add_station(actor, *this)),
      site_frequency_hz_(site_frequency_hz),
      data_rates_(data_rates),
      heard_(std::move(heard)),
      result_(std::move(result)) {
  listen();
}

void HubRadio::listen() {
  Listening listening;
  listening.frequency_hz = site_frequency_hz_;
  listening.data_rates = data_rates_;
  medium_.receive(station_, listening);
}

bool HubRadio::busy() const {
  return medium_.transmitting(station_);
}

void HubRadio::transmit(const Send& send) {
  medium_.transmit(station_, device::RadioChannel{device::kReplyFrequencyHz, send.data_rate},
                   send.power_dbm, send.packet);
  result_(send.tag, Outcome::sent, send.data_rate);
}

void HubRadio::send(Send send) {
  if (send.at_moment) {
    scheduler_.schedule(send.moment, [this, send]() {
      if (busy()) {
        result_(send.tag, Outcome::skipped_busy, send.data_rate);
        return;
      }
      transmit(send);
    });
    return;
  }
  if (send.siren_command) {
    // Siren commands go first, after any other waiting siren command.
    auto it = waiting_.begin();
    while (it != waiting_.end() && it->siren_command) {
      ++it;
    }
    waiting_.insert(it, std::move(send));
  } else {
    waiting_.push_back(std::move(send));
  }
  if (!busy()) {
    next_waiting();
  }
}

void HubRadio::next_waiting() {
  while (!waiting_.empty()) {
    const Send send = std::move(waiting_.front());
    waiting_.pop_front();
    if (scheduler_.now() > send.latest) {
      result_(send.tag, Outcome::too_late, send.data_rate);
      continue;
    }
    transmit(send);
    return;
  }
}

void HubRadio::tx_done(device::Instant) {
  listen();
  next_waiting();
}

void HubRadio::rx_done(device::Instant, const Bytes& packet, std::int16_t rssi_dbm,
                       std::int8_t snr_quarter_db, std::uint8_t data_rate) {
  heard_(packet, rssi_dbm, snr_quarter_db, data_rate);
}

void HubRadio::rx_crc_error(device::Instant) {}

void HubRadio::rx_timeout(device::Instant) {}

void HubRadio::header_seen(device::Instant) {}

void HubRadio::cad_done(device::Instant, bool) {}

}  // namespace hsn::host
