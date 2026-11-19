// Commands and settings on either path, under the secure channel's command rule (§4, §7): a new
// counter is saved, then acted on, then answered on the path it came by; an exact repeat of the
// latest is answered the same way and nothing else happens; an older counter gets no answer.
// Update offers and Key changes come under the same rule; they go to the update service and the
// key change before anything else, and are never read as settings.

#include "hsn/protocol/layout.hpp"
#include "hsn/protocol/radio.hpp"
#include "hsn/roles/siren/siren_log_codes.hpp"
#include "hsn/roles/siren/siren_role.hpp"

namespace hsn::roles::siren {

void SirenRole::on_hub_packet(protocol::ByteView packet, Path path, device::Instant now) {
  const protocol::PacketLimit limit =
      path == Path::wifi ? protocol::PacketLimit::link : protocol::PacketLimit::radio;
  const device::Outcome<device::CommandOpen> opened = services_.channel.open_command(packet, limit);
  if (!opened.ok()) {
    log_refused(packet, limit, opened, now);
    return;
  }
  const device::CommandOpen& command = opened.value();
  if (command.verdict == device::CommandVerdict::too_old) {
    return;  // §7: an older counter gets no answer at all
  }
  const bool fresh = command.verdict == device::CommandVerdict::new_command;
  if (fresh && !command.saved) {
    // Sounding matters more than the flash write (design section 7).
    services_.log.add(now, device::LogLevel::error, siren_log::counter_not_saved,
                      "counter not saved");
  }
  const std::uint8_t type = command.packet.type;
  if (type == protocol::message_type::key_change || type == protocol::message_type::update_offer) {
    // Neither is a command or settings, and neither is answered with a report here: a Key change
    // by report_again() under the new key, an offer by the update service's packets. A repeat of
    // either does nothing more.
    if (!fresh) {
      return;
    }
    if (type == protocol::message_type::key_change) {
      on_key_change(command.packet.body, path, now);
      return;
    }
    protocol::UpdateOffer offer;
    if (protocol::decode_body(command.packet.body, offer) != protocol::Error::none) {
      services_.log.add(now, device::LogLevel::error, siren_log::body_dropped, "body dropped",
                        type);
      return;
    }
    on_offer(offer, path, now);
    return;
  }
  // A command or settings packet from its own hub, new or the latest again: half of a new
  // image's health (m3-updates-design.md section 2).
  hub_packet_opened_ = true;
  if (fresh) {
    // open_command has already dropped a body shorter than its fields (§3); a decode failure here
    // would be a codec fault, and nothing is acted on or answered.
    const bool is_command = type == protocol::message_type::siren_command;
    protocol::SirenCommand decoded_command;
    protocol::SirenSettings decoded_settings;
    const protocol::Error error =
        is_command ? protocol::decode_body(command.packet.body, decoded_command)
                   : protocol::decode_body(command.packet.body, decoded_settings);
    if (error != protocol::Error::none) {
      services_.log.add(now, device::LogLevel::error, siren_log::body_dropped, "body dropped",
                        command.packet.type);
      return;
    }
    if (is_command) {
      act_on_command(decoded_command, now);
    } else {
      apply_settings(decoded_settings, now);
    }
  }
  // A new counter, or an exact repeat of the latest (the hub's retry): answered the same way.
  answer(path, now);
}

void SirenRole::log_refused(protocol::ByteView packet, protocol::PacketLimit limit,
                            const device::Outcome<device::CommandOpen>& opened,
                            device::Instant now) {
  // Other devices' replies share 869.525 MHz: only a packet addressed to this siren is a fault.
  const auto header = protocol::read_header(packet, protocol::Direction::from_hub, limit);
  if (!header.ok() || header.value().address != services_.channel.address()) {
    return;
  }
  if (opened.status() == device::Status::refused) {
    services_.log.add(now, device::LogLevel::warning, siren_log::unexpected_type,
                      "unexpected type");
    return;
  }
  services_.log.add(now, device::LogLevel::warning, siren_log::packet_dropped, "packet dropped",
                    static_cast<std::int32_t>(opened.detail()));
}

void SirenRole::act_on_command(const protocol::SirenCommand& command, device::Instant now) {
  switch (command.action) {
    case protocol::SirenAction::off:
      stop_sounding();
      break;
    case protocol::SirenAction::sound_alarm:
      start_sounding(protocol::SirenState::sounding_alarm, command.sound_seconds, now);
      break;
    case protocol::SirenAction::test:
      start_sounding(protocol::SirenState::testing, command.sound_seconds, now);
      break;
    case protocol::SirenAction::report_now:
      break;  // the answer is the report
    default:
      // §3: an action it does not know does nothing, and is still answered.
      services_.log.add(now, device::LogLevel::info, siren_log::unknown_action, "unknown action",
                        command.action);
      break;
  }
}

void SirenRole::apply_settings(const protocol::SirenSettings& settings, device::Instant now) {
  SirenSettingsHeld held = state_.settings;
  held.settings_version = settings.settings_version;
  // An interval of 0 is not valid (§6), and a rate this version does not know is ignored (§3):
  // either keeps the value held.
  if (settings.wifi_report_interval_seconds != 0) {
    held.wifi_report_interval_seconds = settings.wifi_report_interval_seconds;
  }
  if (settings.lora_check_interval_units != 0) {
    held.lora_check_interval_units = settings.lora_check_interval_units;
  }
  if (settings.max_sound_seconds != 0) {
    held.max_sound_seconds = settings.max_sound_seconds;
  } else {
    // §6: a longest time of 0 is not valid; keeping the value held keeps the siren able to sound.
    services_.log.add(now, device::LogLevel::warning, siren_log::invalid_setting,
                      "max sound 0 ignored");
  }
  if (protocol::is_known<protocol::DataRate>(settings.send_data_rate)) {
    held.send_data_rate = settings.send_data_rate;
  }
  if (protocol::is_known<protocol::DataRate>(settings.command_data_rate)) {
    held.command_data_rate = settings.command_data_rate;
  }
  // §7, D115: a new site channel or sending rate is used from the next transmission on; a
  // channel this version does not know keeps the one held (§3).
  if (protocol::is_known<protocol::SiteChannel>(settings.site_channel)) {
    held.site_channel = settings.site_channel;
  }
  const SirenSettingsHeld before = state_.settings;
  state_.settings = held;
  // Record writes only when the stored bytes differ (design section 5).
  const device::HalError stored = settings_record_.update(held);
  if (stored != device::HalError::none) {
    services_.log.add(now, device::LogLevel::error, siren_log::settings_not_saved,
                      "settings not saved", static_cast<std::int32_t>(stored));
  }
  if (held.wifi_report_interval_seconds != before.wifi_report_interval_seconds) {
    arm_at_random_phase(SirenTimer::wifi_report, wifi_report_interval(), now);
  }
  if (held.lora_check_interval_units != before.lora_check_interval_units) {
    arm_at_random_phase(SirenTimer::lora_check, lora_check_interval(), now);
  }
  // A new command rate takes effect in keep_listening at the end of this event.
}

}  // namespace hsn::roles::siren
