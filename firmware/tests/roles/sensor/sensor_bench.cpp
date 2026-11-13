#include "sensor_bench.hpp"

#include <cstring>

namespace hsn::test::sensor {

roles::sensor::SensorState retained_state(host::SimDevice& device) {
  roles::sensor::SensorState state;
  const auto& block = device.board().retained.contents();
  std::memcpy(&state, block.data() + device::kRetainedHeaderSize + sizeof(device::CoreRetained),
              sizeof(state));
  return state;
}

bool logged(host::SimDevice& device, std::uint16_t code) {
  device::CoreRetained core;
  std::memcpy(&core, device.board().retained.contents().data() + device::kRetainedHeaderSize,
              sizeof(core));
  for (std::size_t i = 0; i < core.log.count && i < device::kLogCapacity; ++i) {
    if (core.log.records[(core.log.start + i) % device::kLogCapacity].code == code) {
      return true;
    }
  }
  return false;
}

std::vector<host::HubLogEntry> sensor_logs(Bench& bench, const std::string& name,
                                           std::uint16_t code) {
  std::vector<host::HubLogEntry> out;
  for (const host::HubLogEntry& entry : bench.hub.log_entries_from(name)) {
    if (entry.code == code) {
      out.push_back(entry);
    }
  }
  return out;
}

std::optional<OpenedReply> open_reply(host::SimDevice& device, const host::Bytes& packet,
                                      const std::vector<std::uint32_t>& answered) {
  host::Bytes plain(protocol::kMaxLinkPacketSize);
  for (const std::uint32_t counter : answered) {
    const auto opened = protocol::open_packet(
        device.board().cipher, protocol::ByteView(packet.data(), packet.size()),
        protocol::Direction::from_hub, protocol::Binding::sensor_packet(counter),
        protocol::PacketLimit::radio, protocol::MutableByteView(plain.data(), plain.size()));
    if (opened.ok() && opened.value().type == protocol::message_type::reply) {
      OpenedReply out;
      if (protocol::decode_body(opened.value().body, out.reply) != protocol::Error::none) {
        return std::nullopt;
      }
      out.answered = counter;
      return out;
    }
  }
  return std::nullopt;
}

std::uint32_t sensor_address(host::SimDevice& device) {
  const host::Bytes& pairing = device.board().storage.records[device::StoreKey::pairing];
  REQUIRE(pairing.size() > 5);
  return static_cast<std::uint32_t>(pairing[1]) | (static_cast<std::uint32_t>(pairing[2]) << 8) |
         (static_cast<std::uint32_t>(pairing[3]) << 16) |
         (static_cast<std::uint32_t>(pairing[4]) << 24);
}

std::uint32_t next_counter(host::SimDevice& device) {
  device::CoreRetained core;
  std::memcpy(&core, device.board().retained.contents().data() + device::kRetainedHeaderSize,
              sizeof(core));
  return core.counter.next;
}

std::vector<std::uint32_t> counters_of(Bench& bench, const std::string& name,
                                       std::uint8_t of_type) {
  std::vector<std::uint32_t> out;
  for (const host::HubPacket& packet : bench.hub.received_from(name, of_type)) {
    out.push_back(packet.counter);
  }
  return out;
}

SleepCount sleep_count(host::SimDevice& device) {
  SleepCount count;
  count.boots = device.records().kind(RecordKind::boot).count();
  count.deep_sleeps = device.records().kind(RecordKind::deep_sleep).count();
  return count;
}

void check_sleep_discipline(host::SimDevice& device) {
  // Between two boots there is at most one deep sleep, and a deep sleep is always followed by a
  // boot or the end of the run (design section 6, "Double sleep").
  std::size_t deep_since_boot = 0;
  for (const Record& record :
       device.records().kind(RecordKind::boot).kind(RecordKind::deep_sleep).records()) {
    if (record.kind == RecordKind::boot) {
      deep_since_boot = 0;
    } else {
      deep_since_boot += 1;
      CHECK(deep_since_boot == 1);
    }
  }
  // No fatal error was stored: no busy loop and never stuck awake (FW4).
  CHECK_FALSE(device.board().storage.has(device::StoreKey::fatal_error));
  CHECK(device.records().kind(RecordKind::restart).count() == 0);
}

}  // namespace hsn::test::sensor
