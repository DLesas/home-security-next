// Every boot is a start-up for the siren, which never sleeps deep (§6, Started). Only the output
// and its stop time outlive a reset, and only when D80 allows: a reset that is not a power-on, with
// the retained block intact. Everything else starts afresh: settings from flash, a new connect,
// continuous receive, and Started once.

#include "hsn/device/services/radio_plan.hpp"
#include "hsn/protocol/layout.hpp"
#include "hsn/protocol/radio.hpp"
#include "hsn/roles/siren/siren_constants.hpp"
#include "hsn/roles/siren/siren_log_codes.hpp"
#include "hsn/roles/siren/siren_role.hpp"

namespace hsn::roles::siren {

void SirenRole::on_boot(const device::BootInfo& boot, device::Instant now) {
  const SirenState kept = state_;
  state_ = SirenState{};
  resume_output(kept, boot, now);
  // The sounder is low during a reset (siren_io.hpp); set it to what the state says.
  const bool on = state_.output_state != protocol::SirenState::off;
  if (io_.output_on() != on) {
    io_.output(on);
  }
  load_settings(now);
  const std::optional<std::uint32_t> site =
      device::site_channel_frequency(services_.setup.pairing().site_channel);
  if (!site.has_value()) {
    services_.log.add(now, device::LogLevel::error, siren_log::no_site_channel, "no site channel",
                      services_.setup.pairing().site_channel);
  }
  state_.started_pending = true;
  state_.timers.arm(SirenTimer::started_lora, now + kStartedLoraAfter);
  // §7: each at a random point in its interval, so sirens powered up together do not report
  // and check the channel at the same moments.
  arm_at_random_phase(SirenTimer::wifi_report, wifi_report_interval(), now);
  arm_at_random_phase(SirenTimer::lora_check, lora_check_interval(), now);
  connect(now);
}

void SirenRole::resume_output(const SirenState& kept, const device::BootInfo& boot,
                              device::Instant now) {
  if (boot.kind == device::BootKind::power_on) {
    return;  // D80: after a power-on it is off, whatever the block holds
  }
  if (boot.retained == device::RetainedStatus::none) {
    services_.log.add(now, device::LogLevel::warning, siren_log::retained_lost, "retained lost");
    return;
  }
  if (kept.output_state != protocol::SirenState::sounding_alarm &&
      kept.output_state != protocol::SirenState::testing) {
    return;
  }
  // An intact clock keeps the stop time. After a clock reset the time left is what remained at
  // the last event before the reset, counted again from now: never shorter than what was left.
  const device::Duration left = boot.retained == device::RetainedStatus::intact
                                    ? kept.stop_at - now
                                    : kept.stop_at - kept.last_seen;
  if (left <= device::Duration{}) {
    return;
  }
  const std::int64_t whole = (left.us + kMicrosecondsPerSecond - 1) / kMicrosecondsPerSecond;
  const std::uint16_t seconds =
      static_cast<std::uint16_t>(whole > kMaxReportSeconds ? kMaxReportSeconds : whole);
  state_.output_state = kept.output_state;
  state_.stop_at = boot.retained == device::RetainedStatus::intact ? kept.stop_at
                                                                   : now + device::seconds(seconds);
  if (state_.stop_at > now + device::seconds(kMaxReportSeconds)) {
    state_.stop_at = now + device::seconds(kMaxReportSeconds);
  }
  state_.timers.arm(SirenTimer::auto_stop, state_.stop_at);
  services_.log.add(now, device::LogLevel::info, siren_log::resumed, "resumed", seconds);
}

std::uint8_t SirenRole::fastest_allowed_rate() const {
  const std::uint8_t mask = services_.setup.pairing().allowed_data_rate_mask;
  std::uint8_t fastest = kNoDataRate;
  for (const std::uint8_t rate : protocol::DataRate::known) {
    if ((mask & (1u << rate)) != 0 && (fastest == kNoDataRate || rate > fastest)) {
      fastest = rate;
    }
  }
  return fastest == kNoDataRate ? kFallbackDataRate : fastest;
}

SirenSettingsHeld SirenRole::default_settings() const {
  SirenSettingsHeld held;
  held.settings_version = 0;
  held.wifi_report_interval_seconds = kDefaultWifiReportSeconds;
  held.lora_check_interval_units = kDefaultLoraCheckUnits;
  // §2: until it has a reply rate, a device listens at its own sending rate.
  held.send_data_rate = fastest_allowed_rate();
  held.command_data_rate = held.send_data_rate;
  held.max_sound_seconds = kDefaultMaxSoundSeconds;
  return held;
}

void SirenRole::load_settings(device::Instant now) {
  const device::HalError loaded = settings_record_.load();
  if (loaded == device::HalError::none) {
    state_.settings = settings_record_.get();
    // A stored record came from the hub, but guard what a timer or the radio would choke on.
    const SirenSettingsHeld fallback = default_settings();
    SirenSettingsHeld& held = state_.settings;
    if (held.wifi_report_interval_seconds == 0) {
      held.wifi_report_interval_seconds = fallback.wifi_report_interval_seconds;
    }
    if (held.lora_check_interval_units == 0) {
      held.lora_check_interval_units = fallback.lora_check_interval_units;
    }
    if (held.max_sound_seconds == 0) {
      // §6: a longest time of 0 is not valid; it must never silence the siren.
      held.max_sound_seconds = fallback.max_sound_seconds;
      services_.log.add(now, device::LogLevel::warning, siren_log::invalid_setting,
                        "stored max sound 0");
    }
    if (!protocol::is_known<protocol::DataRate>(held.send_data_rate)) {
      held.send_data_rate = fallback.send_data_rate;
    }
    if (!protocol::is_known<protocol::DataRate>(held.command_data_rate)) {
      held.command_data_rate = fallback.command_data_rate;
    }
    return;
  }
  state_.settings = default_settings();
  if (loaded != device::HalError::not_found) {
    services_.log.add(now, device::LogLevel::error, siren_log::settings_not_loaded,
                      "settings not loaded", static_cast<std::int32_t>(loaded));
  }
}

}  // namespace hsn::roles::siren
