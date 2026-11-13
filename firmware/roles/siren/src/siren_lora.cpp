// LoRa (§2, §7): continuous receive on 869.525 MHz at the command rate of the settings held, and
// sending on the site channel at the sending rate through the radio port, which checks the channel
// first and keeps the airtime budget. One item goes at a time, most urgent first: answers, then
// Started, then reports of a change, then LoRa checks, then regular failed Wi-Fi reports, then one
// log entry (§2, D110). The first three are urgent (essential, D111); the rest is routine. Checks
// and regular failed reports are also paced, so they spread over the hour (§7); nothing else is.

#include "hsn/device/services/radio_plan.hpp"
#include "hsn/roles/siren/siren_constants.hpp"
#include "hsn/roles/siren/siren_log_codes.hpp"
#include "hsn/roles/siren/siren_role.hpp"

namespace hsn::roles::siren {
namespace {

/** The outbox in order of priority (§2, "Airtime budgets"). */
constexpr LoraItem kLoraOrder[kLoraItemCount] = {LoraItem::answer,      LoraItem::started,
                                                 LoraItem::change,      LoraItem::check,
                                                 LoraItem::wifi_failed, LoraItem::log};

/**
 * The class of an item's traffic (§2, "Airtime budgets"; D111). Urgent, so never held back and
 * past the legal hour only by the gap: answers, Started and reports of a change. Regular, inside
 * the limit always: checks, regular failed reports and log entries.
 */
device::TxClass class_of(LoraItem item) {
  return item == LoraItem::answer || item == LoraItem::started || item == LoraItem::change
             ? device::TxClass::essential
             : device::TxClass::routine;
}

/** An upper bound of an item's packet size, for the airtime check before sealing. */
std::size_t size_bound(LoraItem item) {
  switch (item) {
    case LoraItem::started:
      return kStartedPacketSize;
    case LoraItem::log:
      return kLoraLogPacketBound;
    default:
      return kReportPacketSize;
  }
}

/** The report reason an item carries (§6, siren report). */
std::uint8_t reason_of(LoraItem item) {
  switch (item) {
    case LoraItem::answer:
      return protocol::SirenReportReason::command_answer;
    case LoraItem::check:
      return protocol::SirenReportReason::lora_check;
    default:
      return protocol::SirenReportReason::wifi_report_failed;
  }
}

}  // namespace

void SirenRole::on_radio(const device::RadioEvent& radio, device::Instant now) {
  const device::PortReport report = services_.radio_port.on_radio(radio, now);
  if (radio.kind == device::RadioEventKind::header_seen &&
      services_.radio_port.state() == device::PortState::receiving) {
    // Hold sending for the longest packet at this rate; its end cancels the hold.
    const std::optional<device::Duration> longest =
        device::time_on_air(state_.listen_rate, protocol::kMaxRadioPacketSize);
    state_.timers.arm(SirenTimer::receiving, now + longest.value_or(kRadioRetry));
  } else if (radio.kind == device::RadioEventKind::rx_done ||
             radio.kind == device::RadioEventKind::rx_crc_error ||
             radio.kind == device::RadioEventKind::fault) {
    state_.timers.cancel(SirenTimer::receiving);
  }
  if (report.result == device::PortResult::received) {
    on_hub_packet(radio.packet, Path::lora, now);
    return;
  }
  on_port(report, now);
}

void SirenRole::on_port(const device::PortReport& report, device::Instant now) {
  const LoraItem item = state_.lora.in_flight;
  switch (report.result) {
    case device::PortResult::sent:
      state_.lora.in_flight = LoraItem::none;
      if (item == LoraItem::log) {
        // A siren gets no reply to its log entries: the entry leaves once sent (D110).
        services_.log.release();
      } else if (item == LoraItem::started) {
        started_sent(now);
      } else if (item == LoraItem::check || item == LoraItem::wifi_failed) {
        state_.lora.last_routine_report = now;
        if (item == LoraItem::check && state_.wifi_path != WifiPath::up) {
          state_.lora.log = true;  // §6: one entry after each LoRa check while Wi-Fi is down
        }
      }
      break;
    case device::PortResult::rx_error:
      services_.log.add(now, device::LogLevel::debug, siren_log::crc_error, "crc error");
      break;
    case device::PortResult::recovered:
    case device::PortResult::not_sent:
      // The radio was reset or refused: the port is idle, so keep_listening starts receive again.
      if (item != LoraItem::none) {
        state_.lora.in_flight = LoraItem::none;
        requeue(item, now);
      }
      break;
    case device::PortResult::none:
    case device::PortResult::received:
    case device::PortResult::rx_timeout:
      break;
  }
}

void SirenRole::requeue(LoraItem item, device::Instant now) {
  services_.log.add(now, device::LogLevel::error, siren_log::lora_not_sent, "lora not sent",
                    static_cast<std::int32_t>(item));
  switch (item) {
    case LoraItem::answer:
      state_.lora.answer = true;
      break;
    case LoraItem::started:
      // Wi-Fi may have come up meanwhile.
      if (!send_started_wifi(now)) {
        state_.lora.started = true;
      }
      break;
    case LoraItem::check:
      state_.lora.check = true;
      break;
    case LoraItem::change:
      state_.lora.change = true;
      break;
    case LoraItem::wifi_failed:
      state_.lora.wifi_failed = true;
      break;
    case LoraItem::log:
      state_.lora.log = true;
      break;
    case LoraItem::none:
      break;
  }
  hold_lora(now + kRadioRetry, true);
}

void SirenRole::hold_lora(device::Instant until, bool all) {
  state_.timers.arm(SirenTimer::lora_wait, until);
  state_.lora.wait_holds_all = all;
}

bool SirenRole::lora_pending(LoraItem item) const {
  const LoraOutbox& box = state_.lora;
  switch (item) {
    case LoraItem::answer:
      return box.answer;
    case LoraItem::started:
      return box.started;
    case LoraItem::change:
      return box.change;
    case LoraItem::check:
      return box.check;
    case LoraItem::wifi_failed:
      return box.wifi_failed;
    case LoraItem::log:
      return box.log;
    case LoraItem::none:
      break;
  }
  return false;
}

bool SirenRole::lora_held(LoraItem item, device::Instant now) {
  if (state_.timers.armed(SirenTimer::lora_wait) &&
      (state_.lora.wait_holds_all || class_of(item) == device::TxClass::routine)) {
    return true;  // airtime, or a fault: a change report respects these too
  }
  if (item != LoraItem::check && item != LoraItem::wifi_failed) {
    return false;
  }
  const device::Instant ready = state_.lora.last_routine_report + routine_report_pace();
  if (now < ready) {
    state_.timers.arm(SirenTimer::report_pace, ready);  // goes then, with the state of then
    return true;
  }
  return false;
}

void SirenRole::take_lora_item(LoraItem item) {
  LoraOutbox& box = state_.lora;
  switch (item) {
    case LoraItem::answer:
      box.answer = false;
      break;
    case LoraItem::started:
      box.started = false;
      break;
    case LoraItem::check:
      // A check carries the same state as a waiting failed report, and proves the path too.
      box.check = false;
      box.wifi_failed = false;
      break;
    case LoraItem::change:
      box.change = false;
      break;
    case LoraItem::wifi_failed:
      box.wifi_failed = false;
      break;
    case LoraItem::log:
      box.log = false;
      break;
    case LoraItem::none:
      break;
  }
}

std::optional<device::Transmission> SirenRole::transmission(LoraItem item) const {
  const std::optional<std::uint32_t> site =
      device::site_channel_frequency(state_.settings.site_channel);
  if (!site.has_value()) {
    return std::nullopt;
  }
  device::Transmission transmission;
  transmission.channel.frequency_hz = *site;
  transmission.channel.data_rate = state_.settings.send_data_rate;
  transmission.power_dbm = kSendPowerDbm;
  transmission.tx_class = class_of(item);
  transmission.listen_first = true;  // §2: sirens check the channel before they send
  return transmission;
}

device::Outcome<device::Sealed> SirenRole::seal_lora_item(LoraItem item, device::Instant now) {
  const protocol::MutableByteView out(radio_packet_);
  if (item == LoraItem::started) {
    return services_.channel.seal(
        services_.health.started(protocol::Role::siren, state_.settings.settings_version),
        protocol::Binding::none(), protocol::PacketLimit::radio, out);
  }
  if (item == LoraItem::log) {
    protocol::LogEntries entries;
    if (services_.log.prepare(now, entries, device::LogLevel::warning, 1) == 0) {
      return device::Sealed{};
    }
    return services_.channel.seal(entries, protocol::Binding::none(), protocol::PacketLimit::radio,
                                  out);
  }
  return services_.channel.seal(build_report(reason_of(item), now), protocol::Binding::none(),
                                protocol::PacketLimit::radio, out);
}

bool SirenRole::send_lora_item(LoraItem item, device::Instant now) {
  const std::optional<device::Transmission> transmission_of = transmission(item);
  if (!transmission_of.has_value()) {
    take_lora_item(item);  // no site channel: logged at boot, nothing can go
    return false;
  }
  const device::Transmission& tx = *transmission_of;
  // Judge the airtime before sealing, so a packet that must wait does not use up a counter.
  const device::Admission admission = services_.radio_port.check(tx, size_bound(item), now);
  if (!admission.allowed) {
    if (admission.earliest.is_never()) {
      services_.log.add(now, device::LogLevel::error, siren_log::lora_dropped, "lora dropped",
                        static_cast<std::int32_t>(item));
      take_lora_item(item);
      return false;
    }
    // Routine traffic waiting is the budget working; an urgent packet waits only for the D111
    // gap, and the port logs it as a warning if it then goes past the legal hour.
    hold_lora(admission.earliest, tx.tx_class == device::TxClass::essential);
    services_.log.add(now, device::LogLevel::info, siren_log::lora_deferred, "lora deferred",
                      static_cast<std::int32_t>(item));
    return true;
  }
  const device::Outcome<device::Sealed> sealed = seal_lora_item(item, now);
  if (!sealed.ok()) {
    services_.log.add(now, device::LogLevel::error, siren_log::seal_failed, "seal failed",
                      static_cast<std::int32_t>(sealed.status()));
    hold_lora(now + kRadioRetry, true);
    return true;
  }
  if (sealed.value().size == 0) {
    take_lora_item(item);  // a log item with nothing at warning or above left
    return false;
  }
  const device::Status status = services_.radio_port.send(
      protocol::ByteView(radio_packet_).first(sealed.value().size), tx, now);
  switch (status) {
    case device::Status::ok:
      take_lora_item(item);
      state_.lora.in_flight = item;
      return true;
    case device::Status::deferred:
      hold_lora(services_.radio_port.check(tx, sealed.value().size, now).earliest,
                tx.tx_class == device::TxClass::essential);
      return true;
    case device::Status::radio_error:
      // The port has logged the radio's refusal; the siren notes what did not go.
      services_.log.add(now, device::LogLevel::error, siren_log::lora_not_sent, "lora not sent",
                        static_cast<std::int32_t>(item));
      hold_lora(now + kRadioRetry, true);
      return true;
    default:
      services_.log.add(now, device::LogLevel::error, siren_log::lora_not_sent, "lora refused",
                        static_cast<std::int32_t>(item));
      take_lora_item(item);
      return false;
  }
}

device::Duration SirenRole::routine_report_pace() const {
  const std::optional<device::Duration> airtime =
      device::time_on_air(state_.settings.send_data_rate, kReportPacketSize);
  if (!airtime.has_value()) {
    return device::Duration{};
  }
  const device::Duration share{device::hourly_limit(device::Band::g1).us *
                               kRoutineReportShareNumerator / kRoutineReportShareDenominator};
  // airtime × hour ÷ share in microseconds: about 10^17 at most, far below 2^63.
  return device::Duration{airtime->us * kAirtimeHour.us / share.us};
}

void SirenRole::pump_lora(device::Instant now) {
  if (state_.lora.in_flight != LoraItem::none || state_.timers.armed(SirenTimer::receiving)) {
    return;
  }
  const device::PortState port = services_.radio_port.state();
  if (port != device::PortState::idle && port != device::PortState::receiving) {
    return;
  }
  // Most urgent first; a held item lets the next one try, so a change report never waits behind
  // a paced check. Bounded by the five items.
  for (const LoraItem item : kLoraOrder) {
    if (!lora_pending(item) || lora_held(item, now)) {
      continue;
    }
    if (send_lora_item(item, now)) {
      return;  // handed to the port, or waiting for airtime
    }
  }
}

void SirenRole::keep_listening(device::Instant now) {
  if (state_.timers.armed(SirenTimer::listen_retry)) {
    return;
  }
  const std::uint8_t rate = state_.settings.command_data_rate;
  const device::PortState port = services_.radio_port.state();
  const bool listening = port == device::PortState::receiving && state_.listen_rate == rate;
  if (listening || (port != device::PortState::idle && port != device::PortState::receiving)) {
    return;
  }
  device::RxParams params;
  params.channel.frequency_hz = device::kReplyFrequencyHz;
  params.channel.data_rate = rate;
  params.timeout = device::Duration{};  // continuous (SR1)
  if (services_.radio_port.listen(params, now) == device::Status::ok) {
    state_.listen_rate = rate;
    return;
  }
  services_.log.add(now, device::LogLevel::error, siren_log::listen_failed, "listen failed");
  state_.timers.arm(SirenTimer::listen_retry, now + kRadioRetry);
}

}  // namespace hsn::roles::siren
