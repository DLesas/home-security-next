#include "hsn/host/replay_radio.hpp"

namespace hsn::host {

ReplayRadio::ReplayRadio(Simulation& sim, const std::string& name)
    : sim_(sim), actor_(sim.add_actor(name)), station_(sim.medium().add_station(actor_, *this)) {}

std::uint64_t ReplayRadio::replay(std::uint64_t transmission, std::int8_t power_dbm) {
  return sim_.medium().replay(transmission, station_, power_dbm);
}

std::uint64_t ReplayRadio::send(const Bytes& packet, const device::RadioChannel& channel,
                                std::int8_t power_dbm) {
  return sim_.medium().transmit(station_, channel, power_dbm, packet);
}

void ReplayRadio::tx_done(device::Instant) {
  sent_ += 1;
}

}  // namespace hsn::host
