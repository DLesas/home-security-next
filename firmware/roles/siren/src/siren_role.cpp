// The siren's event loop: dispatch by event kind, the radio port's deadline, the timers, then the
// LoRa outbox, continuous receive and the Wi-Fi log, in that order on every event (design §2).

#include "hsn/roles/siren/siren_role.hpp"

#include "hsn/protocol/units.hpp"
#include "hsn/roles/siren/siren_constants.hpp"

namespace hsn::roles::siren {

SirenRole::SirenRole(device::Services& services, device::SirenIo& io)
    : services_(services),
      io_(io),
      settings_record_(services.hal.storage, kSettingsKey, kSettingsRecordVersion,
                       SirenSettingsHeld{}) {}

std::uint8_t SirenRole::role_id() const {
  return protocol::Role::siren;
}

void SirenRole::handle(const device::Event& event) {
  const device::Instant now = event.now;
  telemetry_read_ = false;
  switch (event.kind) {
    case device::EventKind::boot:
      on_boot(event.boot, now);
      break;
    case device::EventKind::link:
      on_link(event.link, now);
      break;
    case device::EventKind::radio:
      on_radio(event.radio, now);
      break;
    case device::EventKind::input:
      on_input(event.input, now);
      break;
    case device::EventKind::timer:
      break;
  }
  if (services_.radio_port.next_deadline() <= now) {
    on_port(services_.radio_port.on_timer(now), now);
  }
  run_timers(now);
  pump_lora(now);
  keep_listening(now);
  flush_logs_wifi(now);
  state_.last_seen = now;
}

void SirenRole::rearm(SirenTimer timer, device::Instant due, device::Duration interval,
                      device::Instant now) {
  const device::Instant next = due + interval;
  state_.timers.arm(timer, next > now ? next : now + interval);
}

void SirenRole::arm_at_random_phase(SirenTimer timer, device::Duration interval,
                                    device::Instant now) {
  // The first firing falls in (now, now + interval]; rearm() keeps the rhythm after it.
  state_.timers.arm(timer, now + services_.random.between(device::microseconds(1), interval));
}

device::Duration SirenRole::wifi_report_interval() const {
  return device::seconds(state_.settings.wifi_report_interval_seconds);
}

device::Duration SirenRole::lora_check_interval() const {
  return device::seconds(
      protocol::seconds_from_fifteen_second_units(state_.settings.lora_check_interval_units));
}

void SirenRole::run_timers(device::Instant now) {
  device::TimerSet<SirenTimer, kSirenTimerCount>& timers = state_.timers;
  if (timers.take_if_due(SirenTimer::auto_stop, now)) {
    // SR5: it stops by itself, and says so at once.
    stop_sounding();
    report(now, true);
  }
  const device::Instant report_due = timers.at(SirenTimer::wifi_report);
  if (timers.take_if_due(SirenTimer::wifi_report, now)) {
    rearm(SirenTimer::wifi_report, report_due, wifi_report_interval(), now);
    report(now, false);
  }
  const device::Instant check_due = timers.at(SirenTimer::lora_check);
  if (timers.take_if_due(SirenTimer::lora_check, now)) {
    rearm(SirenTimer::lora_check, check_due, lora_check_interval(), now);
    state_.lora.check = true;
  }
  if (timers.take_if_due(SirenTimer::reconnect, now)) {
    connect(now);
  }
  if (timers.take_if_due(SirenTimer::started_lora, now) && state_.started_pending) {
    state_.lora.started = true;
  }
  // These only hold back the outbox and the receive; once due they are simply over.
  static_cast<void>(timers.take_if_due(SirenTimer::lora_wait, now));
  static_cast<void>(timers.take_if_due(SirenTimer::listen_retry, now));
  static_cast<void>(timers.take_if_due(SirenTimer::receiving, now));
  static_cast<void>(timers.take_if_due(SirenTimer::report_pace, now));
}

device::Wake SirenRole::next_wake() const {
  device::Wake wake;
  wake.at = device::earliest(state_.timers.earliest(), services_.radio_port.next_deadline());
  // Mains-powered and always listening: never deeper than awake (design section 7).
  wake.deepest = device::SleepDepth::awake;
  return wake;
}

protocol::MutableByteView SirenRole::state_bytes() {
  return protocol::MutableByteView(reinterpret_cast<std::uint8_t*>(&state_), sizeof(state_));
}

std::uint8_t SirenRole::state_layout() const {
  return kSirenStateLayout;
}

/** Bits 0–1: the output state; bits 2–3: the Wi-Fi path. */
std::uint8_t SirenRole::state_id() const {
  constexpr unsigned kWifiShift = 2;
  return static_cast<std::uint8_t>(state_.output_state |
                                   (static_cast<unsigned>(state_.wifi_path) << kWifiShift));
}

device::Duration SirenRole::longest_awake() const {
  return device::Duration{};  // always powered: no bound (design section 6)
}

}  // namespace hsn::roles::siren
