#pragma once

#include <cstddef>
#include <cstdint>

// The board: every pin and every board-specific value the platform uses, in one place (design
// section 3, "Types"; hardware notes (a) 35). Nothing else in the platform names a GPIO number.
//
// This is the development board on order (docs/spikes/dev-board-choice.md, "Wiring"): an Olimex
// ESP32-S3-DevKit-LiPo (ESP32-S3-WROOM-1-N8R8, schematic Rev B) with a Seeed "Wio-SX1262 for
// XIAO" radio board (part 113010003) on jumper wires, wired as that report's tables say. Our own
// board gets a table of its own beside this one; the platform reads only `kBoard`.
//
// Marks: (P) read in a primary source by the report or note named; ‡ stated from memory or a
// secondary source and to be checked on the bench (docs/spikes/M1b-platform-layer.md lists each).

namespace hsn::esp {

/** One GPIO; -1 for "not on this board". */
using Pin = std::int8_t;
constexpr Pin kNoPin = -1;

/** The SX1262's power amplifier setting for one output power (SX1261/2 datasheet 13.1.14). */
struct PaSetting {
  std::int8_t power_dbm;
  std::uint8_t duty_cycle;
  std::uint8_t hp_max;
  /** What SetTxParams is given. */
  std::int8_t tx_params_dbm;
};

struct Board {
  const char* name;

  // The radio's SPI bus and lines (dev-board-choice.md, "Radio board to development board", P).
  Pin radio_nss;
  Pin radio_mosi;
  Pin radio_sck;
  Pin radio_miso;
  Pin radio_reset;
  Pin radio_busy;
  Pin radio_dio1;
  /** The Wio module's RF_SW line: high while the radio is awake, low for sleep (the report). */
  Pin radio_rf_switch;
  /** SPI clock: 2 MHz on jumper wires (the report, "Are jumper wires good enough?"). */
  std::uint32_t radio_spi_hz;
  /**
   * SetDIO3AsTCXOCtrl's voltage code: 0x02 is 1.8 V (datasheet 13.3.6, hardware notes 3, P); 1.8 V
   * itself is what Meshtastic uses for this module ‡ (the report: Seeed gives only a range).
   * 0xFF for a module with a plain crystal.
   */
  std::uint8_t tcxo_voltage_code;
  /** How long the TCXO takes to start, in µs: 5 ms, Heltec's figure for its module ‡. */
  std::uint32_t tcxo_start_us;
  /** DIO2 drives the module's transmit/receive switch (Wio datasheet, P). */
  bool dio2_rf_switch;
  /** The DC-DC regulator rather than the LDO ‡ (whether the module fits the inductor is unread). */
  bool radio_dcdc;
  /** Added to every RSSI and noise reading: the board's matching network (hardware notes 3) ‡. */
  std::int8_t rssi_offset_db;

  // Switches and the button. Each reads "active" at the level given.
  /** Reed contact to ground with 1 MΩ to 3.3 V; open door = contact open = high ‡ (contact type).
   */
  Pin door;
  std::uint8_t door_open_level;
  /** Lever switch, wired so a closed cover holds it closed to ground: open cover = high. */
  Pin cover;
  std::uint8_t cover_open_level;
  /** The radio board's button D0: 10 kΩ pull-up, pressed = low (the report, P). */
  Pin button;
  std::uint8_t button_pressed_level;
  /** USB 5 V through the Olimex divider (220 kΩ / 470 kΩ, P): high while USB power is present. */
  Pin external_power;
  std::uint8_t external_power_level;

  // Analogue readings.
  /** The Olimex battery divider, 470 kΩ over 150 kΩ (P); no switch to turn it off. */
  Pin battery_sense;
  /** Battery millivolts per ADC millivolt, as a fraction: (470 + 150) / 150. */
  std::uint16_t battery_scale_numerator;
  std::uint16_t battery_scale_denominator;
  /** The pin that switches the divider on, or kNoPin when it is always on. */
  Pin battery_sense_enable;
  /** The charger's status line; the Olimex board has none on a pin (P). */
  Pin charger_status;
  /** Below this a cell counts as not fitted ‡ (the Olimex charger's output with no cell is unread).
   */
  std::uint16_t cell_present_millivolts;

  // Outputs.
  /** Piezo PS1240 from the pin to ground, driven with a square wave. */
  Pin buzzer;
  /** PS1240's loudest band is about 4 kHz ‡. */
  std::uint32_t buzzer_hz;
  /** The Olimex board's LED, lit when low (P). */
  Pin led;
  std::uint8_t led_on_level;
  /** The siren's output: the MOSFET module's control pin, 10 kΩ to ground (the report). */
  Pin siren_output;

  // Not used by the platform yet; here so the wiring is in one place.
  /** The 32.768 kHz crystal's pins, kept free (sdkconfig.crystal selects it). */
  Pin crystal_p;
  Pin crystal_n;
  /** The e-paper module (M3, the display engineer's): on the radio's SPI bus, CLK and DIN shared.
   */
  Pin epaper_cs;
  Pin epaper_dc;
  Pin epaper_reset;
  Pin epaper_busy;

  /**
   * PA settings for the powers the roles use. A power not listed uses the full-power setting
   * (duty 0x04, hpMax 0x07, the most the SX1262 allows, hardware notes 3, P) with SetTxParams at
   * the power asked.
   */
  PaSetting pa[2];
};

/**
 * The bench board. +14 dBm (sensors and sirens) uses Semtech's reference setting for its +22 dBm
 * boards (duty 0x03, hpMax 0x02, SetTxParams +22; dev-board-choice.md, P from Semtech's code),
 * whose current spike S8 measures; +22 dBm (the gateway's most) uses the full-power setting.
 */
constexpr Board kBoard{
    "olimex-esp32-s3-devkit-lipo+wio-sx1262",
    /* radio_nss */ 10,
    /* radio_mosi */ 11,
    /* radio_sck */ 12,
    /* radio_miso */ 13,
    /* radio_reset */ 14,
    /* radio_busy */ 18,
    /* radio_dio1 */ 21,
    /* radio_rf_switch */ 42,
    /* radio_spi_hz */ 2000000,
    /* tcxo_voltage_code */ 0x02,
    /* tcxo_start_us */ 5000,
    /* dio2_rf_switch */ true,
    /* radio_dcdc */ true,
    /* rssi_offset_db */ 0,
    /* door */ 2,
    /* door_open_level */ 1,
    /* cover */ 7,
    /* cover_open_level */ 1,
    /* button */ 4,
    /* button_pressed_level */ 0,
    /* external_power */ 5,
    /* external_power_level */ 1,
    /* battery_sense */ 6,
    /* battery_scale_numerator */ 620,
    /* battery_scale_denominator */ 150,
    /* battery_sense_enable */ kNoPin,
    /* charger_status */ kNoPin,
    /* cell_present_millivolts */ 3000,
    /* buzzer */ 17,
    /* buzzer_hz */ 4000,
    /* led */ 38,
    /* led_on_level */ 0,
    /* siren_output */ 1,
    /* crystal_p */ 15,
    /* crystal_n */ 16,
    /* epaper_cs */ 47,
    /* epaper_dc */ 39,
    /* epaper_reset */ 40,
    /* epaper_busy */ 41,
    /* pa */ {{14, 0x03, 0x02, 22}, {22, 0x04, 0x07, 22}},
};

/** Every pin below 22 can wake the chip from deep sleep (hardware notes 6, P; soc_caps.h). */
constexpr bool deep_sleep_wake_capable(Pin pin) {
  return pin >= 0 && pin <= 21;
}

static_assert(deep_sleep_wake_capable(kBoard.door) && deep_sleep_wake_capable(kBoard.cover) &&
                  deep_sleep_wake_capable(kBoard.button) &&
                  deep_sleep_wake_capable(kBoard.external_power),
              "every deep-sleep wake input must be on GPIO0 to GPIO21");

/**
 * True when no GPIO is wired twice, and none is one the module or the board keeps: 0, 3, 45, 46
 * (strapping), 19 and 20 (USB), 26 to 32 (the module's flash), 35 to 37 (the N8R8 module's octal
 * PSRAM), 43 and 44 (the console) (hardware notes 5, dev-board-choice.md).
 */
constexpr bool wiring_is_sound(const Board& board) {
  const Pin pins[] = {board.radio_nss,
                      board.radio_mosi,
                      board.radio_sck,
                      board.radio_miso,
                      board.radio_reset,
                      board.radio_busy,
                      board.radio_dio1,
                      board.radio_rf_switch,
                      board.door,
                      board.cover,
                      board.button,
                      board.external_power,
                      board.battery_sense,
                      board.battery_sense_enable,
                      board.charger_status,
                      board.buzzer,
                      board.led,
                      board.siren_output,
                      board.crystal_p,
                      board.crystal_n,
                      board.epaper_cs,
                      board.epaper_dc,
                      board.epaper_reset,
                      board.epaper_busy};
  const Pin kept[] = {0, 3, 45, 46, 19, 20, 26, 27, 28, 29, 30, 31, 32, 35, 36, 37, 43, 44};
  const std::size_t count = sizeof(pins) / sizeof(pins[0]);
  for (std::size_t i = 0; i < count; ++i) {
    if (pins[i] == kNoPin) {
      continue;
    }
    for (std::size_t j = i + 1; j < count; ++j) {
      if (pins[i] == pins[j]) {
        return false;
      }
    }
    for (const Pin reserved : kept) {
      if (pins[i] == reserved) {
        return false;
      }
    }
  }
  return true;
}

static_assert(wiring_is_sound(kBoard), "a GPIO is wired twice, or one the module keeps is used");

}  // namespace hsn::esp
