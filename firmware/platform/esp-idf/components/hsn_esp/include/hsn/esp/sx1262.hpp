#pragma once

#include <cstddef>
#include <cstdint>

#include "hsn/device/status.hpp"
#include "hsn/protocol/bytes.hpp"

namespace hsn::esp {

// The SX1262's command set and registers, as this driver uses them. Values marked (P) were read
// from the SX1261/2 datasheet Rev 2.2 by docs/hardware-notes.md section 3, which names the section;
// values marked ‡ are from memory of the same datasheet and Semtech's sx126x driver, and are to be
// checked against the datasheet before the first board run (docs/spikes/M1b-platform-layer.md).
namespace sx1262 {

namespace op {
constexpr std::uint8_t set_sleep = 0x84;                   // (P) 13.1.1
constexpr std::uint8_t set_standby = 0x80;                 // ‡
constexpr std::uint8_t set_tx = 0x83;                      // ‡
constexpr std::uint8_t set_rx = 0x82;                      // (P) 13.1.5
constexpr std::uint8_t stop_timer_on_preamble = 0x9F;      // (P) 13.1.6
constexpr std::uint8_t set_cad = 0xC5;                     // (P) 13.1.8
constexpr std::uint8_t set_cad_params = 0x88;              // (P) 13.4.7
constexpr std::uint8_t set_lora_symb_num_timeout = 0xA0;   // (P) 13.4.9
constexpr std::uint8_t set_dio3_as_tcxo_ctrl = 0x97;       // (P) 13.3.6
constexpr std::uint8_t set_dio2_as_rf_switch_ctrl = 0x9D;  // (P) 13.3.5
constexpr std::uint8_t get_rssi_inst = 0x15;               // (P) 13.5.4
constexpr std::uint8_t get_packet_status = 0x14;           // (P) 13.5.3
constexpr std::uint8_t set_packet_type = 0x8A;             // ‡
constexpr std::uint8_t set_rf_frequency = 0x86;            // ‡
constexpr std::uint8_t set_modulation_params = 0x8B;       // ‡
constexpr std::uint8_t set_packet_params = 0x8C;           // ‡
constexpr std::uint8_t set_dio_irq_params = 0x08;          // ‡
constexpr std::uint8_t get_irq_status = 0x12;              // ‡
constexpr std::uint8_t clear_irq_status = 0x02;            // ‡
constexpr std::uint8_t get_rx_buffer_status = 0x13;        // ‡
constexpr std::uint8_t set_buffer_base_address = 0x8F;     // ‡
constexpr std::uint8_t write_buffer = 0x0E;                // ‡
constexpr std::uint8_t read_buffer = 0x1E;                 // ‡
constexpr std::uint8_t write_register = 0x0D;              // ‡
constexpr std::uint8_t read_register = 0x1D;               // ‡
constexpr std::uint8_t calibrate = 0x89;                   // ‡
constexpr std::uint8_t calibrate_image = 0x98;             // ‡ (its arguments are (P), below)
constexpr std::uint8_t set_regulator_mode = 0x96;          // ‡
constexpr std::uint8_t set_pa_config = 0x95;               // ‡
constexpr std::uint8_t set_tx_params = 0x8E;               // ‡
constexpr std::uint8_t clear_device_errors = 0x07;         // ‡
}  // namespace op

namespace reg {
constexpr std::uint16_t sync_word_msb = 0x0740;    // (P) Table 12-1: 0x14 for a private network
constexpr std::uint16_t sync_word_lsb = 0x0741;    // (P) 0x24
constexpr std::uint16_t tx_modulation = 0x0889;    // (P) 15.1: bit 2 set below 500 kHz
constexpr std::uint16_t tx_clamp_config = 0x08D8;  // (P) 15.2: bits 4–1 set
constexpr std::uint16_t rtc_control = 0x0902;      // (P) 15.3: 0x00 after a receive with timeout
constexpr std::uint16_t event_mask = 0x0944;       // (P) 15.3: bit 1 set after it
constexpr std::uint16_t iq_polarity = 0x0736;      // (P) 15.4: bit 2 set for normal IQ
}  // namespace reg

/** IRQ bits (P, Table 8-4). */
namespace irq {
constexpr std::uint16_t tx_done = 1u << 0;
constexpr std::uint16_t rx_done = 1u << 1;
constexpr std::uint16_t preamble_detected = 1u << 2;
constexpr std::uint16_t header_valid = 1u << 4;
constexpr std::uint16_t header_error = 1u << 5;
constexpr std::uint16_t crc_error = 1u << 6;
constexpr std::uint16_t cad_done = 1u << 7;
constexpr std::uint16_t cad_detected = 1u << 8;
constexpr std::uint16_t timeout = 1u << 9;
/** Every IRQ this driver acts on, routed to DIO1. */
constexpr std::uint16_t used =
    tx_done | rx_done | header_valid | header_error | crc_error | cad_done | cad_detected | timeout;
}  // namespace irq

constexpr std::uint8_t kStandbyRc = 0x00;       // ‡
constexpr std::uint8_t kPacketTypeLora = 0x01;  // ‡
constexpr std::uint8_t kBandwidth125k = 0x04;   // ‡
constexpr std::uint8_t kCodingRate45 = 0x01;    // ‡
constexpr std::uint8_t kHeaderExplicit = 0x00;  // (P) Table 13-67
constexpr std::uint8_t kCrcOn = 0x01;           // (P) Table 13-69
constexpr std::uint8_t kIqNormal = 0x00;        // (P) Table 13-70
constexpr std::uint8_t kSleepWarm = 0x04;       // (P) 13.1.1: bit 2 chooses a warm start
constexpr std::uint8_t kSleepCold = 0x00;
constexpr std::uint8_t kCalibrateAll = 0x7F;  // ‡
constexpr std::uint8_t kImage863Low = 0xD7;   // (P) Table 9-2: 863–870 MHz
constexpr std::uint8_t kImage863High = 0xDB;
constexpr std::uint8_t kRegulatorDcdc = 0x01;      // ‡
constexpr std::uint8_t kRegulatorLdo = 0x00;       // ‡
constexpr std::uint8_t kDeviceSx1262 = 0x00;       // ‡ SetPaConfig's deviceSel
constexpr std::uint8_t kPaLut = 0x01;              // ‡
constexpr std::uint8_t kRamp200us = 0x04;          // ‡
constexpr std::uint32_t kRxContinuous = 0xFFFFFF;  // (P) 13.1.5
/** Preamble symbols (protocol section 2). */
constexpr std::uint16_t kPreambleSymbols = 8;
/** The chip ignores SPI for about 500 µs after SetSleep (P, 13.1.1). */
constexpr std::int64_t kAfterSleepUs = 600;

/** The cadSymbolNum code for a count of symbols (P, Table 13-72); 0xFF for a count not listed. */
constexpr std::uint8_t cad_symbol_code(std::uint8_t symbols) {
  switch (symbols) {
    case 1:
      return 0x00;
    case 2:
      return 0x01;
    case 4:
      return 0x02;
    case 8:
      return 0x03;
    case 16:
      return 0x04;
    default:
      return 0xFF;
  }
}

/** SetRfFrequency's argument: frequency × 2^25 / 32 MHz (the crystal) ‡. */
constexpr std::uint32_t frequency_steps(std::uint32_t hz) {
  return static_cast<std::uint32_t>((static_cast<std::uint64_t>(hz) << 25) / 32000000u);
}

/** A duration in the radio's timer steps of 15.625 µs (P, 13.1.5), clamped below continuous. */
constexpr std::uint32_t timer_steps(std::int64_t us) {
  if (us <= 0) {
    return 0;
  }
  const std::int64_t steps = (us * 64 + 999) / 1000;
  return steps >= static_cast<std::int64_t>(kRxContinuous) ? kRxContinuous - 1
                                                           : static_cast<std::uint32_t>(steps);
}

// The conversions at their edges, against values worked out separately (frequency × 2^25 / 32e6,
// rounded down; 64 steps a millisecond, rounded up). Wrong arithmetic fails the build.
static_assert(frequency_steps(868100000) == 910268825, "site channel 868.1 MHz");
static_assert(frequency_steps(868300000) == 910478540, "site channel 868.3 MHz");
static_assert(frequency_steps(868500000) == 910688256, "site channel 868.5 MHz");
static_assert(frequency_steps(869525000) == 911763046, "reply channel 869.525 MHz");
static_assert(timer_steps(0) == 0 && timer_steps(-5) == 0, "no timeout");
static_assert(timer_steps(1) == 1 && timer_steps(15) == 1 && timer_steps(16) == 2, "rounded up");
static_assert(timer_steps(1000) == 64 && timer_steps(2000000) == 128000, "64 steps a millisecond");
static_assert(timer_steps(262000000) == 16768000, "the longest timed receive");
static_assert(timer_steps(263000000) == kRxContinuous - 1, "never continuous by accident");
static_assert(cad_symbol_code(1) == 0x00 && cad_symbol_code(2) == 0x01 &&
                  cad_symbol_code(4) == 0x02 && cad_symbol_code(8) == 0x03 &&
                  cad_symbol_code(16) == 0x04 && cad_symbol_code(3) == 0xFF &&
                  cad_symbol_code(0) == 0xFF,
              "cadSymbolNum codes");

}  // namespace sx1262

/**
 * The SX1262 on the SPI bus: commands, registers and the buffer, with BUSY waited for before each
 * transfer. NSS is driven by hand (not by the SPI driver) so that a command longer than the S3's
 * 64-byte non-DMA transfer stays under one NSS low, and so the chip can be woken from sleep by an
 * NSS pulse; the bus is held for the whole command (spi_device_acquire_bus), so another device on
 * the same bus (the e-paper, later) is never interleaved. Every call returns HalError::io when
 * BUSY does not fall within its bound or SPI fails.
 */
class Sx1262Bus {
public:
  /** Configures the pins and the SPI bus; false on failure. */
  bool begin();

  /** Pulls NRESET low, then waits for BUSY: the chip starts again cold. */
  device::HalError reset();

  /** Wakes the chip from sleep with an NSS pulse and waits for BUSY to fall. */
  device::HalError wake();

  /** Sends `opcode` and `params`. */
  device::HalError command(std::uint8_t opcode, protocol::ByteView params);

  /** Sends `opcode`, skips the status byte, and reads `out` (GetIrqStatus, GetPacketStatus). */
  device::HalError read(std::uint8_t opcode, protocol::MutableByteView out);

  device::HalError write_register(std::uint16_t address, protocol::ByteView bytes);
  device::HalError read_register(std::uint16_t address, protocol::MutableByteView out);
  device::HalError write_buffer(std::uint8_t offset, protocol::ByteView bytes);
  device::HalError read_buffer(std::uint8_t offset, protocol::MutableByteView out);

  /** Waits for BUSY low at most `timeout_us`. */
  device::HalError wait_busy(std::int64_t timeout_us);

  /** Notes that SetSleep was just sent: the next wake waits out the chip's deaf 500 µs. */
  void slept();

  /** The RF switch line (the Wio module's RF_SW), driven high while the radio is awake. */
  void rf_switch(bool on);

  /** Releases the bus's pins before deep sleep: NSS held high, the switch held low. */
  void hold_for_deep_sleep();

  /** Undoes hold_for_deep_sleep when the sleep did not happen after all. */
  void release_hold();

private:
  device::HalError transfer(protocol::ByteView head, protocol::ByteView out_bytes,
                            protocol::MutableByteView in_bytes, std::size_t skip);
  device::HalError chunk(const std::uint8_t* tx, std::uint8_t* rx, std::size_t size);

  void* device_ = nullptr;
  std::int64_t slept_at_us_ = -1;
};

}  // namespace hsn::esp
