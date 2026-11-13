#pragma once

// The sensor role's scenario bench: the real SensorRole on simulated boards, a TestHub in direct
// radio mode standing in for the gateway, and short ways to ask the timeline about one sensor.

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "hsn/host/role_box.hpp"
#include "hsn/roles/sensor/data_rates.hpp"
#include "hsn/roles/sensor/sensor_role.hpp"
#include "sim_support.hpp"

namespace hsn::test::sensor {

using device::Input;
using device::Instant;
using device::Sound;
using host::HubAction;
using host::Record;
using roles::sensor::SensorRole;
namespace type = protocol::message_type;

/** A simulation, a hub with its own radio, and the sensors added to it. */
struct Bench {
  explicit Bench(host::HubOptions options = {}, host::SimulationOptions simulation = {})
      : sim(simulation), hub(sim, options) {}

  /** Adds a sensor running the real role, paired with the hub before its first boot. */
  host::SimDevice& add(const std::string& name = "door", const host::SensorConfig& settings = {},
                       std::int32_t drift_ppm = 0, Instant power_on = Instant{}) {
    host::DeviceSpec spec;
    spec.name = name;
    spec.role = host::make_role<SensorRole>(&host::HostBoard::sensor_io);
    spec.drift_ppm = drift_ppm;
    spec.power_on = power_on;
    host::SimDevice& device = sim.add_device(spec);
    hub.add_sensor(device, settings);
    return device;
  }

  /** Adds a sensor built by `factory` (a wrapped I/O, for instance), paired with the hub. */
  host::SimDevice& add_with(const std::string& name, host::RoleFactory factory,
                            const host::SensorConfig& settings = {}) {
    host::DeviceSpec spec;
    spec.name = name;
    spec.role = std::move(factory);
    host::SimDevice& device = sim.add_device(spec);
    hub.add_sensor(device, settings);
    return device;
  }

  /** Runs to a true instant given in seconds. */
  void run_to(double seconds_since_start) {
    sim.run_until(at(device::microseconds(static_cast<std::int64_t>(seconds_since_start * 1e6))));
  }

  host::Simulation sim;
  host::TestHub hub;
};

/** A true instant `s` seconds (with fractions) after the start. */
inline Instant at_s(double s) {
  return at(device::microseconds(static_cast<std::int64_t>(s * 1e6)));
}

/**
 * How long a listening window's receive lasts: the window, plus the symbols the radio takes to
 * confirm a preamble that starts at its very end (hardware notes section 3).
 */
inline device::Duration heard_until(device::Duration window, std::uint8_t listen_rate) {
  return window + device::Duration{roles::sensor::symbol_time(listen_rate).us *
                                   roles::sensor::kPreambleConfirmSymbols};
}

/** The device's transmissions, optionally of one type. */
inline std::vector<Record> sent(host::SimDevice& device, std::uint8_t of_type = 0) {
  host::Selection selection = device.records().kind(RecordKind::transmission);
  return of_type == 0 ? selection.records() : selection.type(of_type).records();
}

/** The device's transmissions' types, "started, door_changed". */
inline std::string sent_names(host::SimDevice& device) {
  return device.records().kind(RecordKind::transmission).type_names();
}

/** The hub's transmissions to anyone, of one type. */
inline std::vector<Record> hub_sent(Bench& bench, std::uint8_t of_type) {
  return bench.sim.timeline()
      .of(bench.hub.actor())
      .kind(RecordKind::transmission)
      .type(of_type)
      .records();
}

/** The buzzer's changes, in order, from the timeline. */
inline std::vector<Sound> sounds(host::SimDevice& device) {
  std::vector<Sound> out;
  for (const Record& record : device.records().kind(RecordKind::buzzer).records()) {
    out.push_back(static_cast<Sound>(record.value));
  }
  return out;
}

/** The true instants of the buzzer's changes to one sound. */
inline std::vector<Instant> sound_times(host::SimDevice& device, Sound sound) {
  std::vector<Instant> out;
  for (const Record& record : device.records().kind(RecordKind::buzzer).records()) {
    if (static_cast<Sound>(record.value) == sound) {
      out.push_back(record.at);
    }
  }
  return out;
}

/** The hub's accepted packets from a sensor, of one type, decoded as M. */
template <typename M>
std::vector<M> received(Bench& bench, const std::string& name) {
  std::vector<M> out;
  for (const host::HubPacket& packet : bench.hub.received_from(name, M::type)) {
    out.push_back(packet.as<M>());
  }
  return out;
}

/** Every packet the hub got from a sensor, whatever its verdict. */
inline std::vector<host::HubPacket> all_received(Bench& bench, const std::string& name) {
  std::vector<host::HubPacket> out;
  for (const host::HubPacket& packet : bench.hub.received()) {
    if (packet.from == name) {
      out.push_back(packet);
    }
  }
  return out;
}

/** The running role; throws when the device is asleep. */
inline SensorRole& role(host::SimDevice& device) {
  return device.role<SensorRole>();
}

/** The retained state as last sealed, read from the board's retained block (any time). */
roles::sensor::SensorState retained_state(host::SimDevice& device);

/** True when the sensor's own log buffer (in the retained block) holds an entry with `code`. */
bool logged(host::SimDevice& device, std::uint16_t code);

/** Log entries with a code in the sensor's range, as the hub received them. */
std::vector<host::HubLogEntry> sensor_logs(Bench& bench, const std::string& name,
                                           std::uint16_t code);

/**
 * Opens a packet the hub sent the sensor, trying each of `answered` as its binding, with the
 * key the board holds; returns the reply and the counter it answers, or nothing.
 */
struct OpenedReply {
  protocol::Reply reply;
  std::uint32_t answered = 0;
};
std::optional<OpenedReply> open_reply(host::SimDevice& device, const host::Bytes& packet,
                                      const std::vector<std::uint32_t>& answered);

/** The sensor's address, from the pairing record in its flash. */
std::uint32_t sensor_address(host::SimDevice& device);

/** The next send counter, from the retained block (read while the sensor sleeps). */
std::uint32_t next_counter(host::SimDevice& device);

/** Seals a hub packet for the sensor with the key its board holds, bound to `answered`. */
template <typename M>
host::Bytes forge(host::SimDevice& device, const M& message, std::uint32_t answered,
                  std::uint32_t hub_counter = 900) {
  std::vector<std::uint8_t> plain(protocol::kMaxLinkPacketSize);
  const auto size =
      protocol::encode_plaintext(message, protocol::MutableByteView(plain.data(), plain.size()));
  REQUIRE(size.ok());
  host::Bytes packet(protocol::kMaxRadioPacketSize);
  const auto sealed = protocol::seal_packet(
      device.board().cipher, {protocol::Direction::from_hub, sensor_address(device), hub_counter},
      protocol::Binding::sensor_packet(answered), protocol::ByteView(plain.data(), size.value()),
      protocol::PacketLimit::radio, protocol::MutableByteView(packet.data(), packet.size()));
  REQUIRE(sealed.ok());
  packet.resize(sealed.value());
  return packet;
}

/** The counters of the packets of one type the hub accepted from a sensor. */
std::vector<std::uint32_t> counters_of(Bench& bench, const std::string& name, std::uint8_t of_type);

/** Number of deep sleeps and boots: one deep sleep per wake at most (design section 6). */
struct SleepCount {
  std::size_t boots = 0;
  std::size_t deep_sleeps = 0;
};
SleepCount sleep_count(host::SimDevice& device);

/** Asserts no boot ended in more than one deep sleep and nothing ended in a fatal restart. */
void check_sleep_discipline(host::SimDevice& device);

/**
 * A SensorIo that passes every call to the board's fake, and records the radio's mode at every
 * battery reading, to show the voltage is read before the radio sends (D109).
 */
class WatchedIo final : public device::SensorIo {
public:
  explicit WatchedIo(host::HostBoard& board) : board_(board) {}
  bool door_open() override {
    return board_.sensor_io.door_open();
  }
  bool cover_open() override {
    return board_.sensor_io.cover_open();
  }
  bool button_pressed() override {
    return board_.sensor_io.button_pressed();
  }
  bool charging() override {
    return board_.sensor_io.charging();
  }
  std::uint16_t battery_millivolts() override {
    modes_at_battery_read.push_back(board_.radio.mode());
    return board_.sensor_io.battery_millivolts();
  }
  std::int8_t chip_temperature_c() override {
    return board_.sensor_io.chip_temperature_c();
  }
  void buzzer(device::Sound sound) override {
    board_.sensor_io.buzzer(sound);
  }
  void led(device::Blink blink) override {
    board_.sensor_io.led(blink);
  }
  std::vector<host::RadioMode> modes_at_battery_read;

private:
  host::HostBoard& board_;
};

}  // namespace hsn::test::sensor
