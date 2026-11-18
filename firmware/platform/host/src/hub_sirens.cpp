// The test hub's siren rules (protocol section 7, "Siren command" and "Siren reports"): the same
// packet on Wi-Fi and LoRa, repeated every 2 s and every 5 s until a report confirms it, for up
// to a minute; settings the same way; reports never answered.

#include "hsn/host/test_hub.hpp"

namespace hsn::host {

void TestHub::issue_to_siren(std::size_t index, Bytes packet, std::uint8_t type) {
  Known& siren = known_[index];
  Pending& pending = siren.pending;
  // A newer packet replaces the one waiting and its repeats stop. Callers send settings only when
  // no command is waiting, so only a newer command replaces a command (step 5).
  pending.active = true;
  pending.packet = std::move(packet);
  pending.counter = siren.next_counter - 1;
  pending.type = type;
  pending.issued = sim_.now();
  pending.generation += 1;
  const std::uint64_t generation = pending.generation;
  repeat_on_wifi(index, generation);
  repeat_on_lora(index, generation);
  sim_.schedule(sim_.now() + options_.siren_give_up, [this, index, generation]() {
    Pending& waiting = known_[index].pending;
    if (waiting.active && waiting.generation == generation) {
      waiting.active = false;
      decide(HubAction::siren_unreachable, known_[index].name);
      if (known_[index].settings_waiting) {
        send_siren_settings(index);
      }
    }
  });
}

void TestHub::repeat_on_wifi(std::size_t index, std::uint64_t generation) {
  Known& siren = known_[index];
  if (!siren.pending.active || siren.pending.generation != generation || !siren.siren.wifi) {
    return;
  }
  LinkWire& wire = siren.device->wire(device::LinkKind::network);
  if (wire.connected()) {
    send_link(siren, wire, siren.pending.packet, siren.pending.type);
  }
  sim_.schedule(sim_.now() + options_.siren_wifi_repeat,
                [this, index, generation]() { repeat_on_wifi(index, generation); });
}

void TestHub::repeat_on_lora(std::size_t index, std::uint64_t generation) {
  Known& siren = known_[index];
  if (!siren.pending.active || siren.pending.generation != generation) {
    return;
  }
  Downlink downlink;
  downlink.packet = siren.pending.packet;
  downlink.type = siren.pending.type;
  downlink.counter = siren.pending.counter;
  downlink.to = index;
  downlink.data_rate = command_rate(siren);
  downlink.siren_command = true;
  downlink.gateway = siren.best_gateway;
  send_radio(downlink);
  sim_.schedule(sim_.now() + options_.siren_lora_repeat,
                [this, index, generation]() { repeat_on_lora(index, generation); });
}

std::uint8_t TestHub::command_rate(const Known& siren) const {
  // The siren listens at the rate of the settings it holds; before it has said, at the rate it
  // was paired with (the first version's).
  const auto held = siren.reply_rate_of_version.find(siren.held_version);
  if (held != siren.reply_rate_of_version.end()) {
    return held->second;
  }
  return siren.reply_rate_of_version.begin()->second;
}

void TestHub::send_siren_settings(std::size_t index) {
  Known& siren = known_[index];
  protocol::SirenSettings settings;
  settings.settings_version = siren.version;
  settings.wifi_report_interval_seconds = siren.siren.wifi_report_interval_seconds;
  settings.lora_check_interval_units = siren.siren.lora_check_interval_units;
  settings.max_sound_seconds = siren.siren.max_sound_seconds;
  settings.send_data_rate = siren.siren.send_data_rate;
  settings.command_data_rate = siren.siren.command_data_rate;
  settings.site_channel = options_.site_channel;
  siren.settings_waiting = false;
  decide(HubAction::siren_settings, siren.name, siren.version);
  issue_to_siren(index,
                 seal(siren, settings, protocol::Binding::none(), protocol::PacketLimit::radio),
                 protocol::message_type::siren_settings);
}

void TestHub::on_siren_packet(std::size_t index, const Opened& opened, const Arrival& arrival) {
  Known& siren = known_[index];
  const protocol::ByteView body(opened.body.data(), opened.body.size());
  std::uint8_t held_version = siren.version;
  if (opened.type == protocol::message_type::siren_report) {
    protocol::SirenReport report;
    static_cast<void>(protocol::decode_body(body, report));
    held_version = report.settings_version;
    if (siren.pending.active && static_cast<std::uint32_t>(report.last_command_counter_low) ==
                                    (siren.pending.counter & 0xFFFFu)) {
      siren.pending.active = false;
      decide(HubAction::siren_confirmed, siren.name, static_cast<std::int64_t>(arrival.path));
    }
  } else if (opened.type == protocol::message_type::started) {
    protocol::Started started;
    static_cast<void>(protocol::decode_body(body, started));
    held_version = started.settings_version;
    on_update_started(index, started);
  } else if (opened.type == protocol::message_type::update_query ||
             opened.type == protocol::message_type::update_status) {
    static_cast<void>(on_update_packet(index, opened, arrival, arrival.wire));
    return;
  } else {
    return;
  }
  siren.held_version = held_version;
  if (held_version == siren.version) {
    // A siren has followed a move when a report shows its new settings (protocol section 7).
    note_followed(siren);
  }
  // Settings go out when the siren holds others or new ones wait, unless a command is still being
  // confirmed (protocol section 7, siren command, step 5).
  if ((held_version != siren.version || siren.settings_waiting) && !siren.pending.active) {
    send_siren_settings(index);
  }
}

}  // namespace hsn::host
