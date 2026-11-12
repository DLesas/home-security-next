#pragma once

#include <cstdint>

#include "hsn/device/status.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/bytes.hpp"

namespace hsn::device {

/** A frequency and a data rate (protocol section 2). */
struct RadioChannel {
  std::uint32_t frequency_hz = 0;
  /** See protocol::DataRate. */
  std::uint8_t data_rate = 0;
};

/** What stops a timed receive from timing out (hardware notes, section 3). */
enum class RxStop : std::uint8_t {
  /** The timer stops when the LoRa header is detected: the radio's default. */
  header,
  /** The timer stops at preamble detection (StopTimerOnPreamble). */
  preamble,
};

/** One receive. */
struct RxParams {
  RadioChannel channel;
  /** Zero for continuous receive. */
  Duration timeout;
  RxStop stop = RxStop::preamble;
  /** Symbols to confirm a detection (SetLoRaSymbNumTimeout); 0 locks on the first symbol. */
  std::uint8_t symbol_timeout = 0;
};

/** One channel activity detection; the core picks the values per spreading factor. */
struct CadParams {
  RadioChannel channel;
  /** 1, 2, 4, 8 or 16 symbols; the platform maps it to the radio's code. */
  std::uint8_t symbols = 0;
  std::uint8_t detect_peak = 0;
  std::uint8_t detect_min = 0;
};

/**
 * The SX1262, non-blocking. Each call starts an operation and returns at once; its end comes as a
 * RadioEvent stamped with the moment the interrupt fired. Starting an operation cancels the
 * current one and raises no event for it. The fixed settings of protocol section 2 (sync word
 * 0x12, CRC on, explicit header, normal IQ, preamble 8, low data rate optimisation exactly at
 * SF11 and SF12) and the workarounds of hardware notes section 3 belong to the platform. The
 * interface maps onto Semtech's sx126x driver and onto RadioLib's interrupt-driven calls.
 */
class Radio {
public:
  /**
   * Copies `packet` (18 to 255 bytes) into the radio and starts sending it; `tx_done` follows.
   */
  virtual HalError transmit(const RadioChannel& channel, std::int8_t power_dbm,
                            protocol::ByteView packet) = 0;

  /**
   * Starts receiving; `header_seen`, then `rx_done` or `rx_crc_error`, or `rx_timeout` follow.
   * A continuous receive keeps receiving after each packet.
   */
  virtual HalError receive(const RxParams& params) = 0;

  /**
   * Starts a channel activity detection; `cad_done` follows with `busy` set or clear.
   */
  virtual HalError detect_activity(const CadParams& params) = 0;

  /**
   * Returns the instantaneous noise level in dBm. Only while receiving; HalError::busy otherwise.
   */
  virtual HalResult<std::int16_t> noise_dbm() = 0;

  /**
   * Puts the radio to sleep, keeping its configuration when `warm` is true. Cancels any
   * operation.
   */
  virtual HalError sleep(bool warm) = 0;

  /**
   * Resets the radio by its reset pin and configures it again. At most 50 ms. Used when an
   * operation's event never came.
   */
  virtual HalError recover() = 0;

protected:
  Radio() = default;
  Radio(const Radio&) = default;
  Radio& operator=(const Radio&) = default;
  ~Radio() = default;
};

}  // namespace hsn::device
