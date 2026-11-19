#include "hsn/esp/radio.hpp"

#include <array>

#include "driver/gpio.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "hsn/esp/board.hpp"
#include "hsn/protocol/radio.hpp"

namespace hsn::esp {
namespace {

constexpr const char* kTag = "hsn.radio";
/** Calibrations take a few milliseconds ‡; this bounds them. */
constexpr std::int64_t kCalibrationUs = 20000;

using device::HalError;

std::array<std::uint8_t, 3> be24(std::uint32_t value) {
  return {static_cast<std::uint8_t>(value >> 16), static_cast<std::uint8_t>(value >> 8),
          static_cast<std::uint8_t>(value)};
}

PaSetting pa_for(std::int8_t power_dbm) {
  for (const PaSetting& setting : kBoard.pa) {
    if (setting.power_dbm == power_dbm) {
      return setting;
    }
  }
  return PaSetting{power_dbm, 0x04, 0x07, power_dbm};
}

}  // namespace

IRAM_ATTR void EspRadio::on_dio1(void* self) {
  EspRadio& radio = *static_cast<EspRadio*>(self);
  Message message;
  message.kind = MessageKind::radio_irq;
  message.at = radio.clock_.now_from_isr();
  int woken = 0;
  static_cast<void>(radio.queue_.post_from_isr(message, &woken));
  if (woken != 0) {
    portYIELD_FROM_ISR();
  }
}

bool EspRadio::begin() {
  if (!bus_.begin()) {
    return false;
  }
  gpio_config_t dio1{};
  dio1.pin_bit_mask = 1ull << kBoard.radio_dio1;
  dio1.mode = GPIO_MODE_INPUT;
  dio1.intr_type = GPIO_INTR_POSEDGE;
  if (gpio_config(&dio1) != ESP_OK ||
      gpio_isr_handler_add(static_cast<gpio_num_t>(kBoard.radio_dio1), &EspRadio::on_dio1, this) !=
          ESP_OK) {
    ESP_LOGE(kTag, "DIO1 interrupt not attached");
    return false;
  }
  return recover() == HalError::none;
}

HalError EspRadio::send(std::uint8_t opcode, std::initializer_list<std::uint8_t> params) {
  return bus_.command(opcode, protocol::ByteView(params.begin(), params.size()));
}

HalError EspRadio::set_register_bits(std::uint16_t address, std::uint8_t bits) {
  std::array<std::uint8_t, 1> value{};
  if (bus_.read_register(address, protocol::MutableByteView(value)) != HalError::none) {
    return HalError::io;
  }
  value[0] = static_cast<std::uint8_t>(value[0] | bits);
  return bus_.write_register(address, protocol::ByteView(value));
}

HalError EspRadio::init() {
  mode_ = Mode::off;
  bool ok = send(sx1262::op::set_standby, {sx1262::kStandbyRc}) == HalError::none;
  if (ok && kBoard.tcxo_voltage_code != 0xFF) {
    const auto delay = be24(sx1262::timer_steps(kBoard.tcxo_start_us));
    ok = send(sx1262::op::set_dio3_as_tcxo_ctrl,
              {kBoard.tcxo_voltage_code, delay[0], delay[1], delay[2]}) == HalError::none;
  }
  // With a TCXO the start-up calibration fails; a full one follows (P, 9.2.1). XOSC_START_ERR is
  // then expected and cleared (P, 13.3.6).
  ok = ok && send(sx1262::op::calibrate, {sx1262::kCalibrateAll}) == HalError::none &&
       bus_.wait_busy(kCalibrationUs) == HalError::none;
  ok = ok && send(sx1262::op::clear_device_errors, {0x00, 0x00}) == HalError::none;
  ok = ok &&
       send(sx1262::op::set_regulator_mode,
            {kBoard.radio_dcdc ? sx1262::kRegulatorDcdc : sx1262::kRegulatorLdo}) == HalError::none;
  ok = ok &&
       send(sx1262::op::calibrate_image, {sx1262::kImage863Low, sx1262::kImage863High}) ==
           HalError::none &&
       bus_.wait_busy(kCalibrationUs) == HalError::none;
  if (ok && kBoard.dio2_rf_switch) {
    ok = send(sx1262::op::set_dio2_as_rf_switch_ctrl, {0x01}) == HalError::none;
  }
  ok = ok && send(sx1262::op::set_packet_type, {sx1262::kPacketTypeLora}) == HalError::none;
  ok = ok && send(sx1262::op::set_buffer_base_address, {0x00, 0x00}) == HalError::none;
  // The private sync word 0x12 is 0x14, 0x24 in the registers (P, Table 12-1), read back as
  // hardware notes (a) 20 asks.
  const std::array<std::uint8_t, 2> sync{0x14, 0x24};
  ok = ok &&
       bus_.write_register(sx1262::reg::sync_word_msb, protocol::ByteView(sync)) == HalError::none;
  std::array<std::uint8_t, 2> read_back{};
  ok = ok && bus_.read_register(sx1262::reg::sync_word_msb, protocol::MutableByteView(read_back)) ==
                 HalError::none;
  if (ok && (read_back[0] != sync[0] || read_back[1] != sync[1])) {
    ESP_LOGE(kTag, "sync word reads back %02x %02x", read_back[0], read_back[1]);
    ok = false;
  }
  // The TX clamp fix (P, 15.2): bits 4 to 1 of TxClampConfig, after every cold start.
  ok = ok && set_register_bits(sx1262::reg::tx_clamp_config, 0x1E) == HalError::none;
  constexpr std::uint16_t used = sx1262::irq::used;
  ok = ok && send(sx1262::op::set_dio_irq_params,
                  {static_cast<std::uint8_t>(used >> 8), static_cast<std::uint8_t>(used & 0xFF),
                   static_cast<std::uint8_t>(used >> 8), static_cast<std::uint8_t>(used & 0xFF),
                   0x00, 0x00, 0x00, 0x00}) == HalError::none;
  if (!ok) {
    ESP_LOGE(kTag, "radio did not configure");
    return HalError::io;
  }
  mode_ = Mode::standby;
  return HalError::none;
}

HalError EspRadio::ready() {
  if (mode_ == Mode::off) {
    return HalError::io;
  }
  if (mode_ == Mode::sleeping_cold) {
    if (bus_.wake() != HalError::none || init() != HalError::none) {
      return HalError::io;
    }
  } else if (mode_ == Mode::sleeping_warm) {
    if (bus_.wake() != HalError::none) {
      return HalError::io;
    }
  }
  bus_.rf_switch(true);
  if (send(sx1262::op::set_standby, {sx1262::kStandbyRc}) != HalError::none ||
      send(sx1262::op::clear_irq_status, {0xFF, 0xFF}) != HalError::none) {
    return HalError::io;
  }
  mode_ = Mode::standby;
  return HalError::none;
}

HalError EspRadio::configure(const device::RadioChannel& channel, std::uint8_t payload_size) {
  const auto factor = protocol::spreading_factor(channel.data_rate);
  if (!factor.has_value()) {
    return HalError::invalid;
  }
  if (ready() != HalError::none) {
    return HalError::io;
  }
  const std::uint8_t sf = *factor;
  const std::uint32_t steps = sx1262::frequency_steps(channel.frequency_hz);
  const std::uint8_t ldro = sf >= 11 ? 0x01 : 0x00;
  const bool ok =
      send(sx1262::op::set_packet_type, {sx1262::kPacketTypeLora}) == HalError::none &&
      send(sx1262::op::set_rf_frequency,
           {static_cast<std::uint8_t>(steps >> 24), static_cast<std::uint8_t>(steps >> 16),
            static_cast<std::uint8_t>(steps >> 8), static_cast<std::uint8_t>(steps)}) ==
          HalError::none &&
      send(sx1262::op::set_modulation_params,
           {sf, sx1262::kBandwidth125k, sx1262::kCodingRate45, ldro}) == HalError::none &&
      send(sx1262::op::set_packet_params,
           {static_cast<std::uint8_t>(sx1262::kPreambleSymbols >> 8),
            static_cast<std::uint8_t>(sx1262::kPreambleSymbols & 0xFF), sx1262::kHeaderExplicit,
            payload_size, sx1262::kCrcOn, sx1262::kIqNormal}) == HalError::none &&
      set_register_bits(sx1262::reg::iq_polarity, 0x04) == HalError::none;
  return ok ? HalError::none : HalError::io;
}

HalError EspRadio::transmit(const device::RadioChannel& channel, std::int8_t power_dbm,
                            protocol::ByteView packet) {
  if (packet.size() < 18 || packet.size() > rx_buffer_.size()) {
    return HalError::invalid;
  }
  const HalError configured = configure(channel, static_cast<std::uint8_t>(packet.size()));
  if (configured != HalError::none) {
    return configured;
  }
  const PaSetting pa = pa_for(power_dbm);
  const bool ok =
      set_register_bits(sx1262::reg::tx_modulation, 0x04) == HalError::none &&
      send(sx1262::op::set_pa_config,
           {pa.duty_cycle, pa.hp_max, sx1262::kDeviceSx1262, sx1262::kPaLut}) == HalError::none &&
      send(sx1262::op::set_tx_params,
           {static_cast<std::uint8_t>(pa.tx_params_dbm), sx1262::kRamp200us}) == HalError::none &&
      bus_.write_buffer(0, packet) == HalError::none &&
      send(sx1262::op::set_tx, {0x00, 0x00, 0x00}) == HalError::none;
  if (!ok) {
    return HalError::io;
  }
  timed_out_last_ = false;
  mode_ = Mode::transmitting;
  return HalError::none;
}

HalError EspRadio::receive(const device::RxParams& params) {
  const HalError configured = configure(params.channel, 255);
  if (configured != HalError::none) {
    return configured;
  }
  const bool continuous = params.timeout.us <= 0;
  const auto timeout =
      be24(continuous ? sx1262::kRxContinuous : sx1262::timer_steps(params.timeout.us));
  const bool ok =
      send(sx1262::op::stop_timer_on_preamble,
           {static_cast<std::uint8_t>(params.stop == device::RxStop::preamble ? 1 : 0)}) ==
          HalError::none &&
      send(sx1262::op::set_lora_symb_num_timeout, {params.symbol_timeout}) == HalError::none &&
      send(sx1262::op::set_rx, {timeout[0], timeout[1], timeout[2]}) == HalError::none;
  if (!ok) {
    return HalError::io;
  }
  timed_out_last_ = false;
  mode_ = continuous ? Mode::receiving_continuous : Mode::receiving_timed;
  return HalError::none;
}

HalError EspRadio::detect_activity(const device::CadParams& params) {
  const std::uint8_t code = sx1262::cad_symbol_code(params.symbols);
  if (code == 0xFF) {
    return HalError::invalid;
  }
  if (timed_out_last_ && mode_ == Mode::standby) {
    // A receive timeout followed straight away by a channel check: sleep in between, about
    // 1.3 ms (AN1200.48 section 3.1, hardware notes 3).
    if (send(sx1262::op::set_sleep, {sx1262::kSleepWarm}) != HalError::none) {
      return HalError::io;
    }
    bus_.slept();
    mode_ = Mode::sleeping_warm;
  }
  const HalError configured = configure(params.channel, 255);
  if (configured != HalError::none) {
    return configured;
  }
  const bool ok = send(sx1262::op::set_cad_params, {code, params.detect_peak, params.detect_min,
                                                    0x00, 0x00, 0x00, 0x00}) == HalError::none &&
                  send(sx1262::op::set_cad, {}) == HalError::none;
  if (!ok) {
    return HalError::io;
  }
  timed_out_last_ = false;
  mode_ = Mode::channel_check;
  return HalError::none;
}

device::HalResult<std::int16_t> EspRadio::noise_dbm() {
  if (mode_ != Mode::receiving_continuous && mode_ != Mode::receiving_timed) {
    return HalError::busy;
  }
  std::array<std::uint8_t, 1> raw{};
  if (bus_.read(sx1262::op::get_rssi_inst, protocol::MutableByteView(raw)) != HalError::none) {
    return HalError::io;
  }
  // Power in dBm is −RssiInst / 2 (P, 13.5.4), plus the board's offset.
  return static_cast<std::int16_t>(-static_cast<std::int16_t>(raw[0]) / 2 + kBoard.rssi_offset_db);
}

HalError EspRadio::sleep(bool warm) {
  if (mode_ == Mode::off) {
    return HalError::io;
  }
  if ((warm && mode_ == Mode::sleeping_warm) || (!warm && mode_ == Mode::sleeping_cold)) {
    return HalError::none;
  }
  if (ready() != HalError::none ||
      send(sx1262::op::set_sleep, {warm ? sx1262::kSleepWarm : sx1262::kSleepCold}) !=
          HalError::none) {
    return HalError::io;
  }
  bus_.slept();
  bus_.rf_switch(false);
  timed_out_last_ = false;
  mode_ = warm ? Mode::sleeping_warm : Mode::sleeping_cold;
  return HalError::none;
}

HalError EspRadio::recover() {
  timed_out_last_ = false;
  mode_ = Mode::off;
  if (bus_.reset() != HalError::none) {
    ESP_LOGE(kTag, "radio did not come out of reset (BUSY stays high)");
    return HalError::io;
  }
  bus_.rf_switch(true);
  return init();
}

bool EspRadio::operation_under_way() const {
  return mode_ == Mode::transmitting || mode_ == Mode::receiving_timed ||
         mode_ == Mode::receiving_continuous || mode_ == Mode::channel_check;
}

void EspRadio::prepare_deep_sleep() {
  if (mode_ != Mode::off) {
    static_cast<void>(sleep(false));
  }
  bus_.hold_for_deep_sleep();
}

void EspRadio::cancel_deep_sleep() {
  // The chip stays in cold sleep; the next operation wakes and configures it again.
  bus_.release_hold();
}

HalError EspRadio::end_timed_receive() {
  // After any receive with a timeout (P, 15.3): RTC control to 0x00, bit 1 of the event mask.
  const std::array<std::uint8_t, 1> zero{0x00};
  if (bus_.write_register(sx1262::reg::rtc_control, protocol::ByteView(zero)) != HalError::none) {
    return HalError::io;
  }
  return set_register_bits(sx1262::reg::event_mask, 0x02);
}

std::size_t EspRadio::service(device::Instant at, std::array<device::RadioEvent, 2>& out) {
  if (!operation_under_way()) {
    return 0;
  }
  std::array<std::uint8_t, 2> raw{};
  if (bus_.read(sx1262::op::get_irq_status, protocol::MutableByteView(raw)) != HalError::none ||
      send(sx1262::op::clear_irq_status, {raw[0], raw[1]}) != HalError::none) {
    out[0] = device::RadioEvent{};
    out[0].kind = device::RadioEventKind::fault;
    out[0].at = at;
    mode_ = Mode::standby;
    return 1;
  }
  const std::uint16_t flags = static_cast<std::uint16_t>((raw[0] << 8) | raw[1]);
  std::size_t count = 0;
  auto event = [&](device::RadioEventKind kind) -> device::RadioEvent& {
    device::RadioEvent& made = out[count];
    made = device::RadioEvent{};
    made.kind = kind;
    made.at = at;
    count += 1;
    return made;
  };

  switch (mode_) {
    case Mode::transmitting:
      if ((flags & sx1262::irq::tx_done) != 0) {
        event(device::RadioEventKind::tx_done);
        mode_ = Mode::standby;
      }
      break;
    case Mode::channel_check:
      if ((flags & sx1262::irq::cad_done) != 0) {
        event(device::RadioEventKind::cad_done).busy = (flags & sx1262::irq::cad_detected) != 0;
        mode_ = Mode::standby;
      }
      break;
    case Mode::receiving_timed:
    case Mode::receiving_continuous: {
      const bool timed = mode_ == Mode::receiving_timed;
      if ((flags & sx1262::irq::header_valid) != 0) {
        event(device::RadioEventKind::header_seen);
      }
      bool ended = false;
      if ((flags & sx1262::irq::rx_done) != 0) {
        ended = true;
        if ((flags & (sx1262::irq::crc_error | sx1262::irq::header_error)) != 0) {
          event(device::RadioEventKind::rx_crc_error);
        } else {
          std::array<std::uint8_t, 2> buffer_status{};
          std::array<std::uint8_t, 3> packet_status{};
          bool ok = bus_.read(sx1262::op::get_rx_buffer_status,
                              protocol::MutableByteView(buffer_status)) == HalError::none;
          const std::uint8_t size = buffer_status[0];
          ok = ok && size >= 1 &&
               bus_.read_buffer(buffer_status[1], protocol::MutableByteView(
                                                      rx_buffer_.data(), size)) == HalError::none &&
               bus_.read(sx1262::op::get_packet_status, protocol::MutableByteView(packet_status)) ==
                   HalError::none;
          if (ok) {
            device::RadioEvent& done = event(device::RadioEventKind::rx_done);
            done.packet = protocol::ByteView(rx_buffer_.data(), size);
            // RssiPkt is −x/2 dBm, SnrPkt a signed count of quarter decibels (P, 13.5.3).
            done.rssi_dbm = static_cast<std::int16_t>(
                -static_cast<std::int16_t>(packet_status[0]) / 2 + kBoard.rssi_offset_db);
            done.snr_quarter_db = static_cast<std::int8_t>(packet_status[1]);
          } else {
            event(device::RadioEventKind::fault);
          }
        }
      } else if ((flags & sx1262::irq::header_error) != 0) {
        // A damaged header ends the packet without RxDone ‡: the core counts it as damaged.
        ended = true;
        event(device::RadioEventKind::rx_crc_error);
      } else if ((flags & sx1262::irq::timeout) != 0) {
        ended = true;
        event(device::RadioEventKind::rx_timeout);
        timed_out_last_ = true;
      }
      if (ended && timed) {
        mode_ = Mode::standby;
        if (end_timed_receive() != HalError::none && count < out.size()) {
          event(device::RadioEventKind::fault);
        }
      }
      break;
    }
    default:
      break;
  }
  return count;
}

}  // namespace hsn::esp
