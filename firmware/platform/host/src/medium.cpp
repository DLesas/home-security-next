#include "hsn/host/medium.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <string>

#include "hsn/device/services/radio_plan.hpp"
#include "hsn/host/simulation_error.hpp"
#include "hsn/protocol/radio.hpp"

namespace hsn::host {
namespace {

/** How long a finished transmission is kept for overlap checks: longer than any packet. */
constexpr device::Duration kKeepTransmissions = device::seconds(30);

/** Data rates are indexes 0 to 5; a lock per rate. */
constexpr std::uint8_t kDataRates = 6;

bool hears_rate(const Listening& listening, std::uint8_t data_rate) {
  return data_rate < kDataRates && (listening.data_rates & (1u << data_rate)) != 0;
}

std::int16_t rounded_dbm(double dbm) {
  const double clamped = std::max(-32768.0, std::min(32767.0, dbm));
  return static_cast<std::int16_t>(std::lround(clamped));
}

std::int8_t snr_quarters(double snr_db) {
  const double clamped = std::max(-128.0, std::min(127.0, std::round(snr_db * 4.0)));
  return static_cast<std::int8_t>(clamped);
}

std::uint8_t lowest_rate(std::uint8_t mask) {
  for (std::uint8_t rate = 0; rate < kDataRates; ++rate) {
    if ((mask & (1u << rate)) != 0) {
      return rate;
    }
  }
  return 0;
}

}  // namespace

Medium::Medium(Scheduler& scheduler, Timeline& timeline, const PacketLabels& labels,
               MediumOptions options)
    : scheduler_(scheduler), timeline_(timeline), labels_(labels), options_(options) {}

StationId Medium::add_station(ActorId actor, StationListener& listener) {
  Station added;
  added.actor = actor;
  added.listener = &listener;
  stations_.push_back(added);
  return stations_.size() - 1;
}

Medium::Station& Medium::station(StationId id) {
  if (id >= stations_.size()) {
    throw SimulationError("no station " + std::to_string(id));
  }
  return stations_[id];
}

const Medium::Station& Medium::station(StationId id) const {
  if (id >= stations_.size()) {
    throw SimulationError("no station " + std::to_string(id));
  }
  return stations_[id];
}

void Medium::set_path_loss(StationId a, StationId b, double loss_db) {
  set_path_loss_one_way(a, b, loss_db);
  set_path_loss_one_way(b, a, loss_db);
}

void Medium::set_path_loss_one_way(StationId from, StationId to, double loss_db) {
  path_loss_[{from, to}] = loss_db;
}

void Medium::cut(StationId a, StationId b) {
  set_path_loss(a, b, std::numeric_limits<double>::infinity());
}

void Medium::script_noise(std::uint32_t frequency_hz, device::Instant from, device::Instant until,
                          double dbm) {
  noise_.push_back(NoiseScript{frequency_hz, from, until, dbm});
}

double Medium::noise_dbm(std::uint32_t frequency_hz, device::Instant at) const {
  double level = options_.noise_floor_dbm;
  for (const NoiseScript& script : noise_) {
    if (script.frequency_hz == frequency_hz && script.from <= at && at < script.until) {
      level = std::max(level, script.dbm);
    }
  }
  return level;
}

double Medium::noise_max(std::uint32_t frequency_hz, device::Instant from,
                         device::Instant until) const {
  double level = options_.noise_floor_dbm;
  for (const NoiseScript& script : noise_) {
    if (script.frequency_hz == frequency_hz && script.from < until && from < script.until) {
      level = std::max(level, script.dbm);
    }
  }
  return level;
}

double Medium::sensitivity_dbm(std::uint8_t data_rate) const {
  return options_.noise_floor_dbm + demodulation_snr_db(data_rate);
}

double Medium::loss(StationId from, StationId to) const {
  const auto found = path_loss_.find({from, to});
  return found == path_loss_.end() ? options_.default_path_loss_db : found->second;
}

double Medium::received_dbm(StationId from, StationId to, double power_dbm) const {
  return power_dbm - loss(from, to);
}

bool Medium::audible(const Transmission& tx, StationId at, device::Instant when) const {
  const double signal = received_dbm(tx.from, at, tx.power_dbm);
  return std::isfinite(signal) && signal - noise_dbm(tx.channel.frequency_hz, when) >=
                                      demodulation_snr_db(tx.channel.data_rate);
}

const Medium::Transmission* Medium::find(std::uint64_t id) const {
  if (recent_.empty() || id < recent_.front().id || id - recent_.front().id >= recent_.size()) {
    return nullptr;
  }
  return &recent_[static_cast<std::size_t>(id - recent_.front().id)];
}

Medium::Transmission* Medium::find(std::uint64_t id) {
  const Medium& self = *this;
  return const_cast<Transmission*>(self.find(id));
}

void Medium::forget_old() {
  const device::Instant now = scheduler_.now();
  while (!recent_.empty() && recent_.front().end + kKeepTransmissions < now) {
    recent_.pop_front();
  }
}

Record Medium::record_for(StationId id, RecordKind kind) const {
  Record record;
  record.at = scheduler_.now();
  record.actor = station(id).actor;
  record.kind = kind;
  return record;
}

void Medium::record_about(RecordKind kind, StationId receiver, const Transmission& tx) {
  Record record = record_for(receiver, kind);
  const double signal = received_dbm(tx.from, receiver, tx.power_dbm);
  record.from = tx.start;
  record.until = tx.end;
  record.frequency_hz = tx.channel.frequency_hz;
  record.data_rate = tx.channel.data_rate;
  record.rssi_dbm = rounded_dbm(signal);
  record.snr_quarter_db =
      snr_quarters(signal - noise_max(tx.channel.frequency_hz, tx.start, tx.end));
  record.length = static_cast<std::uint16_t>(tx.packet.size());
  record.label = tx.label;
  record.peer = station(tx.from).actor;
  record.transmission = tx.id;
  timeline_.add(record);
}

void Medium::cancel(StationId id) {
  Station& self = station(id);
  if (self.mode == Mode::transmitting) {
    Transmission* tx = find(self.sending);
    if (tx != nullptr && tx->end > scheduler_.now()) {
      // The packet stops going out: it ends here and no receiver can decode it.
      tx->aborted = true;
      tx->end = scheduler_.now();
    }
  }
  self.mode = Mode::standby;
  self.operation += 1;
  self.locks = {};
  self.finishing.clear();
  self.window_end = device::Instant::never();
}

std::uint64_t Medium::transmit(StationId id, const device::RadioChannel& channel,
                               std::int8_t power_dbm, const Bytes& packet) {
  const auto airtime = device::time_on_air(channel.data_rate, packet.size());
  if (!airtime.has_value()) {
    throw SimulationError("transmit at unlisted data rate " + std::to_string(channel.data_rate) +
                          " or of " + std::to_string(packet.size()) + " bytes");
  }
  cancel(id);
  forget_old();
  const device::Instant now = scheduler_.now();
  Transmission tx;
  tx.id = next_id_++;
  tx.from = id;
  tx.channel = channel;
  tx.power_dbm = power_dbm;
  tx.packet = packet;
  tx.start = now;
  tx.end = now + *airtime;
  tx.label = labels_.label(protocol::ByteView(packet.data(), packet.size()));
  recent_.push_back(tx);
  if (keep_) {
    archive_[tx.id] = Kept{channel, packet};
  }

  Station& self = station(id);
  self.mode = Mode::transmitting;
  self.frequency_hz = channel.frequency_hz;
  self.sending = tx.id;
  const std::uint64_t operation = self.operation;

  Record record = record_for(id, RecordKind::transmission);
  record.from = tx.start;
  record.until = tx.end;
  record.frequency_hz = channel.frequency_hz;
  record.data_rate = channel.data_rate;
  record.rssi_dbm = power_dbm;
  record.length = static_cast<std::uint16_t>(packet.size());
  record.label = tx.label;
  record.transmission = tx.id;
  timeline_.add(record);

  for (StationId other = 0; other < stations_.size(); ++other) {
    if (other != id && stations_[other].mode == Mode::receiving) {
      offer(recent_.back(), other);
    }
  }
  // Scheduled after the receivers' ends, so at the packet's last instant every receiver has it
  // before the sender is told and can send again.
  scheduler_.schedule(tx.end, [this, id, operation]() {
    Station& sender = station(id);
    if (sender.operation != operation) {
      return;
    }
    sender.mode = Mode::standby;
    sender.operation += 1;
    sender.listener->tx_done(scheduler_.now());
  });
  return tx.id;
}

const Bytes& Medium::kept_packet(std::uint64_t transmission) const {
  const auto found = archive_.find(transmission);
  if (found == archive_.end()) {
    throw SimulationError("transmission " + std::to_string(transmission) +
                          " was not kept (Medium::keep_transmissions)");
  }
  return found->second.packet;
}

std::uint64_t Medium::replay(std::uint64_t transmission, StationId station, std::int8_t power_dbm) {
  const auto found = archive_.find(transmission);
  if (found == archive_.end()) {
    throw SimulationError("transmission " + std::to_string(transmission) +
                          " was not kept (Medium::keep_transmissions)");
  }
  // Copied: transmit() may archive the replay itself, which can move the map's nodes' contents.
  const Kept kept = found->second;
  return transmit(station, kept.channel, power_dbm, kept.packet);
}

void Medium::offer(const Transmission& tx, StationId receiver) {
  Station& self = station(receiver);
  const std::uint8_t rate = tx.channel.data_rate;
  if (self.listening.frequency_hz != tx.channel.frequency_hz || !hears_rate(self.listening, rate) ||
      !audible(tx, receiver, tx.start)) {
    return;
  }
  Lock& current = self.locks[rate];
  if (!current.active) {
    lock(receiver, tx);
    return;
  }
  const Transmission* held = find(current.transmission);
  if (held != nullptr && held->end <= tx.start) {
    // The held packet ends the instant this one starts: no overlap. It is still delivered.
    self.finishing.push_back(held->id);
    lock(receiver, tx);
    return;
  }
  const double arriving = received_dbm(tx.from, receiver, tx.power_dbm);
  if (held != nullptr && arriving >= received_dbm(held->from, receiver, held->power_dbm) +
                                         options_.capture_margin_db) {
    // Captured: the stronger newcomer takes the receiver; the one it held is lost.
    record_about(RecordKind::collision, receiver, *held);
    lock(receiver, tx);
    return;
  }
  // The receiver is busy with another packet on this rate: this one is lost here.
  record_about(RecordKind::collision, receiver, tx);
}

void Medium::lock(StationId receiver, const Transmission& tx) {
  Station& self = station(receiver);
  const std::uint8_t rate = tx.channel.data_rate;
  Lock& held = self.locks[rate];
  held.active = true;
  held.transmission = tx.id;
  held.stops_timer_at =
      tx.start + (self.listening.stop == device::RxStop::header
                      ? header_time(rate)
                      : preamble_detect_time(rate, self.listening.symbol_timeout));
  const std::uint64_t operation = self.operation;
  const std::uint64_t id = tx.id;
  scheduler_.schedule(tx.start + header_time(rate), [this, receiver, operation, id, rate]() {
    Station& listener = station(receiver);
    if (listener.operation != operation || !listener.locks[rate].active ||
        listener.locks[rate].transmission != id) {
      return;
    }
    listener.listener->header_seen(scheduler_.now());
  });
  scheduler_.schedule(tx.end,
                      [this, receiver, operation, id]() { resolve(receiver, operation, id); });
}

void Medium::resolve(StationId receiver, std::uint64_t operation, std::uint64_t id) {
  Station& self = station(receiver);
  const Transmission* tx = find(id);
  if (self.operation != operation || tx == nullptr) {
    return;
  }
  Lock& held = self.locks[tx->channel.data_rate];
  const auto finishing = std::find(self.finishing.begin(), self.finishing.end(), id);
  if (finishing != self.finishing.end()) {
    self.finishing.erase(finishing);
  } else if (held.active && held.transmission == id) {
    held.active = false;
  } else {
    return;
  }
  const double signal = received_dbm(tx->from, receiver, tx->power_dbm);
  bool collided = false;
  for (const Transmission& other : recent_) {
    if (other.id == id || other.from == receiver || other.start >= tx->end ||
        other.end <= tx->start || other.channel.frequency_hz != tx->channel.frequency_hz ||
        other.channel.data_rate != tx->channel.data_rate) {
      continue;
    }
    if (signal < received_dbm(other.from, receiver, other.power_dbm) + options_.capture_margin_db) {
      collided = true;
    }
  }
  const double noise = noise_max(tx->channel.frequency_hz, tx->start, tx->end);
  const bool decoded =
      !tx->aborted && !collided && signal - noise >= demodulation_snr_db(tx->channel.data_rate);
  const bool timed = self.listening.timeout.us != 0;
  if (timed) {
    self.mode = Mode::standby;
    self.operation += 1;
  }
  if (decoded) {
    record_about(RecordKind::reception, receiver, *tx);
    self.listener->rx_done(scheduler_.now(), tx->packet, rounded_dbm(signal),
                           snr_quarters(signal - noise), tx->channel.data_rate);
  } else {
    record_about(collided ? RecordKind::collision : RecordKind::crc_error, receiver, *tx);
    self.listener->rx_crc_error(scheduler_.now());
  }
}

void Medium::receive(StationId id, const Listening& listening) {
  cancel(id);
  Station& self = station(id);
  self.mode = Mode::receiving;
  self.listening = listening;
  self.frequency_hz = listening.frequency_hz;
  const device::Instant now = scheduler_.now();
  const bool timed = listening.timeout.us != 0;
  self.window_end = timed ? now + listening.timeout : device::Instant::never();
  const std::uint64_t operation = self.operation;

  Record record = record_for(id, RecordKind::rx_window);
  record.from = now;
  record.until = self.window_end;
  record.frequency_hz = listening.frequency_hz;
  record.data_rate = lowest_rate(listening.data_rates);
  record.value = listening.data_rates;
  timeline_.add(record);

  if (timed) {
    scheduler_.schedule(self.window_end, [this, id, operation]() { time_out(id, operation); });
  }
  // A packet starting at this very instant is heard from its preamble, whichever came first.
  for (const Transmission& tx : recent_) {
    if (tx.start == now && tx.from != id && !tx.aborted) {
      offer(tx, id);
    }
  }
}

void Medium::time_out(StationId id, std::uint64_t operation) {
  Station& self = station(id);
  if (self.operation != operation || self.mode != Mode::receiving) {
    return;
  }
  const device::Instant now = scheduler_.now();
  for (const Lock& held : self.locks) {
    if (held.active && held.stops_timer_at <= now) {
      // A preamble (or header) came in time: the timer stopped, the packet is received to its end.
      return;
    }
  }
  self.mode = Mode::standby;
  self.operation += 1;
  self.locks = {};
  timeline_.add(record_for(id, RecordKind::rx_timeout));
  self.listener->rx_timeout(now);
}

void Medium::detect(StationId id, const device::CadParams& params) {
  const auto duration = device::cad_duration(params.channel.data_rate);
  if (!duration.has_value()) {
    throw SimulationError("channel check at unlisted data rate " +
                          std::to_string(params.channel.data_rate));
  }
  cancel(id);
  Station& self = station(id);
  self.mode = Mode::detecting;
  self.frequency_hz = params.channel.frequency_hz;
  const std::uint64_t operation = self.operation;
  const device::Instant started = scheduler_.now();
  scheduler_.schedule(started + *duration, [this, id, operation, params, started]() {
    finish_detection(id, operation, params, started);
  });
}

void Medium::finish_detection(StationId id, std::uint64_t operation, device::CadParams params,
                              device::Instant started) {
  Station& self = station(id);
  if (self.operation != operation) {
    return;
  }
  const device::Instant now = scheduler_.now();
  bool busy = false;
  for (const Transmission& tx : recent_) {
    if (tx.from != id && tx.start < now && tx.end > started &&
        tx.channel.frequency_hz == params.channel.frequency_hz &&
        tx.channel.data_rate == params.channel.data_rate &&
        audible(tx, id, std::max(tx.start, started))) {
      busy = true;
      break;
    }
  }
  self.mode = Mode::standby;
  self.operation += 1;
  Record record = record_for(id, RecordKind::channel_check);
  record.from = started;
  record.until = now;
  record.frequency_hz = params.channel.frequency_hz;
  record.data_rate = params.channel.data_rate;
  record.flag = busy;
  timeline_.add(record);
  self.listener->cad_done(now, busy);
}

void Medium::standby(StationId id) {
  cancel(id);
}

std::int16_t Medium::instant_rssi_dbm(StationId id) const {
  const Station& self = station(id);
  const device::Instant now = scheduler_.now();
  double milliwatts = std::pow(10.0, noise_dbm(self.frequency_hz, now) / 10.0);
  for (const Transmission& tx : recent_) {
    if (tx.from != id && tx.start <= now && now < tx.end &&
        tx.channel.frequency_hz == self.frequency_hz) {
      const double signal = received_dbm(tx.from, id, tx.power_dbm);
      if (std::isfinite(signal)) {
        milliwatts += std::pow(10.0, signal / 10.0);
      }
    }
  }
  return rounded_dbm(10.0 * std::log10(milliwatts));
}

bool Medium::transmitting(StationId id) const {
  return station(id).mode == Mode::transmitting;
}

bool Medium::receiving_packet(StationId id) const {
  const Station& self = station(id);
  if (self.mode != Mode::receiving) {
    return false;
  }
  for (const Lock& held : self.locks) {
    if (held.active) {
      return true;
    }
  }
  return false;
}

}  // namespace hsn::host
