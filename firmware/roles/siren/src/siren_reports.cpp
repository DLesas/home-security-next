// Reports (§6, §7): every interval over Wi-Fi; over LoRa at once when a Wi-Fi report fails (the
// link is down or will not take the packet); answers on the path the command came by. Cover and
// mains changes are reported at once. The LoRa side of every report is in siren_lora.cpp.

#include "hsn/protocol/units.hpp"
#include "hsn/roles/siren/siren_constants.hpp"
#include "hsn/roles/siren/siren_log_codes.hpp"
#include "hsn/roles/siren/siren_role.hpp"

namespace hsn::roles::siren {

const Telemetry& SirenRole::telemetry() {
  if (!telemetry_read_) {
    telemetry_.on_mains = services_.hal.power.external_power();
    telemetry_.cell_fitted = io_.cell_fitted();
    telemetry_.charging = io_.charging();
    telemetry_.cover_open = io_.cover_open();
    telemetry_.cell_millivolts = telemetry_.cell_fitted ? io_.cell_millivolts() : 0;
    telemetry_.temperature_c = io_.chip_temperature_c();
    telemetry_read_ = true;
  }
  return telemetry_;
}

protocol::SirenReport SirenRole::build_report(std::uint8_t reason, device::Instant now) {
  const Telemetry& read = telemetry();
  protocol::SirenReport report;
  report.settings_version = state_.settings.settings_version;
  report.state = state_.output_state;
  report.sounding_seconds_left = seconds_left(now);
  report.last_command_counter_low =
      static_cast<std::uint16_t>(services_.channel.last_command() & kCounterLowMask);
  report.flags.on_mains = read.on_mains;
  report.flags.cell_fitted = read.cell_fitted;
  report.flags.charging = read.charging;
  report.flags.cover_open = read.cover_open;
  report.flags.wifi_connected = state_.wifi_path == WifiPath::up;
  // §3: encoded as a sensor's battery; 0 when no cell is fitted.
  report.cell_battery_code =
      read.cell_fitted ? protocol::battery_code_from_millivolts(read.cell_millivolts) : 0;
  report.temperature_celsius = read.temperature_c;
  report.reason = reason;
  return report;
}

device::HalError SirenRole::send_sealed_wifi(const device::Outcome<device::Sealed>& sealed,
                                             device::Instant now) {
  if (!sealed.ok()) {
    services_.log.add(now, device::LogLevel::error, siren_log::seal_failed, "seal failed",
                      static_cast<std::int32_t>(sealed.status()));
    return device::HalError::io;
  }
  return services_.hal.network->send(protocol::ByteView(link_packet_).first(sealed.value().size));
}

device::HalError SirenRole::send_report_wifi(std::uint8_t reason, device::Instant now) {
  if (services_.hal.network == nullptr) {
    return device::HalError::unsupported;
  }
  if (state_.wifi_path != WifiPath::up) {
    return device::HalError::io;  // §7: the connection is down
  }
  const protocol::SirenReport body = build_report(reason, now);
  return send_sealed_wifi(
      services_.channel.seal(body, protocol::Binding::none(), protocol::PacketLimit::link,
                             protocol::MutableByteView(link_packet_)),
      now);
}

void SirenRole::report(device::Instant now, bool change) {
  const bool was_up = state_.wifi_path == WifiPath::up;
  const device::HalError sent = send_report_wifi(protocol::SirenReportReason::regular, now);
  if (sent == device::HalError::none) {
    return;
  }
  // A link known to be down is logged once, as it went down; an up link refusing is logged here.
  if (was_up) {
    services_.log.add(now, device::LogLevel::warning, siren_log::wifi_report_failed,
                      "wifi report failed", static_cast<std::int32_t>(sent));
  }
  if (change) {
    state_.lora.change = true;
  } else {
    state_.lora.wifi_failed = true;
  }
}

void SirenRole::answer(Path path, device::Instant now) {
  if (path == Path::wifi) {
    const bool was_up = state_.wifi_path == WifiPath::up;
    const device::HalError sent =
        send_report_wifi(protocol::SirenReportReason::command_answer, now);
    if (sent == device::HalError::none) {
      return;
    }
    // The answer still matters: it goes on LoRa, as an answer.
    if (was_up) {
      services_.log.add(now, device::LogLevel::warning, siren_log::wifi_report_failed,
                        "wifi answer failed", static_cast<std::int32_t>(sent));
    }
  }
  state_.lora.answer = true;
}

void SirenRole::on_input(const device::InputEvent& input, device::Instant now) {
  if (input.input == device::Input::cover) {
    if (input.active) {
      services_.log.add(now, device::LogLevel::warning, siren_log::cover_opened, "cover opened");
    }
  } else if (input.input == device::Input::external_power) {
    if (!input.active) {
      services_.log.add(now, device::LogLevel::warning, siren_log::mains_lost, "mains lost");
    }
  } else {
    return;  // the siren has no door or button
  }
  report(now, true);
}

}  // namespace hsn::roles::siren
