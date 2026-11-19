#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <initializer_list>

#include "hsn/device/events.hpp"
#include "hsn/device/hal/radio.hpp"
#include "hsn/esp/clock.hpp"
#include "hsn/esp/event_queue.hpp"
#include "hsn/esp/sx1262.hpp"

namespace hsn::esp {

/**
 * device::Radio on the SX1262 (design section 3, "Radio"). Each call configures the chip for the
 * operation and starts it, then returns; its end comes through DIO1. The DIO1 interrupt, in IRAM,
 * only takes the time and posts a message (hardware notes (a) 13); the main task then calls
 * service(), which reads and clears the IRQ over SPI and turns it into RadioEvents.
 *
 * Fixed by the platform, never passed in (protocol section 2): LoRa at 125 kHz, coding rate 4/5,
 * preamble 8, explicit header, CRC on, normal IQ, private sync word 0x12 (registers 0x14, 0x24),
 * low data rate optimisation exactly at SF11 and SF12. Applied as hardware notes section 3 asks:
 * the TCXO on DIO3 then a full calibration and the 863–870 MHz image calibration, DIO2 as the RF
 * switch, the TX clamp fix (15.2) after every cold start, the modulation-quality bit (15.1) before
 * each transmit, the IQ bit (15.4) on every configuration, the timer fix (15.3) after every timed
 * receive, and a sleep between a receive timeout and a channel check (AN1200.48 section 3.1).
 *
 * Starting an operation puts the chip in standby and clears every IRQ first, so the operation it
 * replaces raises no event. A transmit has no timeout of the chip's own: the core's RadioPort guard
 * (airtime + 100 ms) calls recover() if tx_done never comes.
 */
class EspRadio final : public device::Radio {
public:
  EspRadio(const EspClock& clock, EventQueue& queue) : clock_(clock), queue_(queue) {}

  /**
   * Starts the bus, resets and configures the chip, and attaches the DIO1 interrupt (the GPIO
   * interrupt service must be installed). False when the chip does not answer; the radio's calls
   * then fail with HalError::io until recover() succeeds.
   */
  bool begin();

  device::HalError transmit(const device::RadioChannel& channel, std::int8_t power_dbm,
                            protocol::ByteView packet) override;
  device::HalError receive(const device::RxParams& params) override;
  device::HalError detect_activity(const device::CadParams& params) override;
  device::HalResult<std::int16_t> noise_dbm() override;
  device::HalError sleep(bool warm) override;
  device::HalError recover() override;

  /**
   * DIO1 rose at `at`: reads and clears the IRQ and writes the events it means into `out`, at most
   * two (header_seen, then rx_done or rx_crc_error), returning how many. A packet's bytes are in
   * the radio's own buffer, valid until the next service().
   */
  std::size_t service(device::Instant at, std::array<device::RadioEvent, 2>& out);

  /** True while an operation that ends with DIO1 is under way. */
  bool operation_under_way() const;

  /** Before deep sleep: the chip in cold sleep (160 nA), NSS and the RF switch held. */
  void prepare_deep_sleep();

  /** The deep sleep did not happen (an input changed): the pins are released again. */
  void cancel_deep_sleep();

private:
  enum class Mode : std::uint8_t {
    off,
    standby,
    sleeping_warm,
    sleeping_cold,
    transmitting,
    receiving_timed,
    receiving_continuous,
    channel_check,
  };

  device::HalError init();
  device::HalError ready();
  device::HalError configure(const device::RadioChannel& channel, std::uint8_t payload_size);
  device::HalError send(std::uint8_t opcode, std::initializer_list<std::uint8_t> params);
  device::HalError set_register_bits(std::uint16_t address, std::uint8_t bits);
  device::HalError end_timed_receive();
  static void on_dio1(void* self);

  const EspClock& clock_;
  EventQueue& queue_;
  Sx1262Bus bus_;
  Mode mode_ = Mode::off;
  /** The last operation was a receive that timed out: sleep before a channel check. */
  bool timed_out_last_ = false;
  std::array<std::uint8_t, 255> rx_buffer_{};
};

}  // namespace hsn::esp
