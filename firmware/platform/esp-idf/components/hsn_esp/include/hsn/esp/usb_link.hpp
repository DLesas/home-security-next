#pragma once

#include <array>
#include <atomic>
#include <cstdint>

#include "hsn/device/hal/link.hpp"
#include "hsn/esp/event_queue.hpp"
#include "hsn/esp/link_slots.hpp"
#include "hsn/protocol/framing.hpp"

namespace hsn::esp {

/**
 * The USB link (protocol section 10, "USB"): the chip's own USB Serial/JTAG port, which the hub
 * sees under Espressif's USB vendor number (the Olimex board's USB-OTG1 socket, GPIO19 and 20).
 * Each packet is one COBS frame ending in a zero byte, made and read by the core's encode_frame
 * and FrameDecoder. The port is byte-clean: the console is on UART0 and ESP-IDF's secondary
 * console on this port is off (sdkconfig.defaults). The ROM's own boot messages may still reach
 * it at reset ‡; the hub's decoder drops whatever precedes the first zero byte as a bad frame.
 *
 * `up` means a computer is attached (the port receives start-of-frame packets): connect() answers
 * up or down from that at once, and the waiter reports down if the computer goes while up. A
 * serial port carries frames whether up or not, as the fakes do (the gateway's hello goes out
 * while it waits for a welcome). A reader task decodes received bytes into the receive slots; a
 * writer task frames and writes queued packets, so send() never blocks.
 *
 * The port stops in light sleep and may not come back after it (ESP-IDF's Kconfig help for
 * USJ_NO_AUTO_LS_ON_CONNECTION): the waiter never light-sleeps while external power is present.
 */
class UsbLink final : public device::Link {
public:
  explicit UsbLink(EventQueue& queue) : queue_(queue) {}

  /** Installs the driver and starts the reader and writer tasks. */
  bool begin();

  device::LinkKind kind() const override {
    return device::LinkKind::usb;
  }
  device::HalError connect(const device::LinkTarget& target) override;
  void disconnect() override;
  device::HalError send(protocol::ByteView packet) override;
  bool up() const override;
  std::int8_t signal_dbm() const override {
    return 0;
  }
  std::uint16_t largest_packet() const override {
    return 0;
  }

  /** The waiter: a link_up or link_down message of this generation was delivered. */
  bool current(std::uint32_t generation) const {
    return generation == generation_;
  }
  void delivered_up(bool up_now) {
    up_ = up_now;
  }
  /** The waiter, each turn: posts down when the computer has gone while up. */
  void poll();
  /** Before a restart: waits at most `wait_ms` for queued frames to leave. */
  void flush(std::uint32_t wait_ms);

  LinkSlots& slots() {
    return slots_;
  }

private:
  static void reader(void* self);
  static void writer(void* self);
  void post_state(bool up_now);

  EventQueue& queue_;
  LinkSlots slots_;
  SendSlots outgoing_;
  std::atomic<std::uint32_t> generation_{0};
  bool up_ = false;
  bool down_posted_ = false;
  std::array<std::uint8_t, protocol::kMaxFrameDataSize> decoded_{};
  std::array<std::uint8_t, protocol::kMaxEncodedFrameSize + 1> frame_{};
  std::array<std::uint8_t, protocol::kMaxFrameDataSize> sending_{};
};

}  // namespace hsn::esp
