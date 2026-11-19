#pragma once

#include <cstdint>

#include "hsn/device/time.hpp"

namespace hsn::esp {

/** What an interrupt or another task tells the main task. */
enum class MessageKind : std::uint8_t {
  /** The radio's DIO1 rose; `at` was taken in the interrupt. */
  radio_irq,
  /** An input pin changed; `index` is the device::Input, `at` taken in the interrupt. */
  input_edge,
  /** A link received a whole packet; `index` is the LinkKind, `slot` its receive slot. */
  link_packet,
  /** A link came up or went down; `generation` tells a stale message from a current one. */
  link_up,
  link_down,
  /** An esp_timer alarm the waiter set for its deadline. */
  deadline,
};

struct Message {
  MessageKind kind = MessageKind::deadline;
  std::uint8_t index = 0;
  std::uint8_t slot = 0;
  std::uint32_t generation = 0;
  device::Instant at;
};

/**
 * The platform's one queue (design section 1: interrupts and other tasks only post; the core runs
 * on the main task alone, so it has no locks). A FreeRTOS queue of Messages, copied in and out.
 */
class EventQueue {
public:
  /** Room for this many messages; a full queue drops the newest (counted). */
  static constexpr std::uint32_t kLength = 32;

  /** Creates the queue; false when FreeRTOS cannot. */
  bool begin();

  /** From a task: never blocks. False when the queue is full. */
  bool post(const Message& message);

  /** From an interrupt, in IRAM. `woken` is set when a higher-priority task was woken. */
  bool post_from_isr(const Message& message, int* woken);

  /** Takes the oldest message, waiting at most `wait_ms` (0: none, UINT32_MAX: for ever). */
  bool take(Message& out, std::uint32_t wait_ms);

  /** Messages dropped because the queue was full, since start. */
  std::uint32_t dropped() const {
    return dropped_;
  }

private:
  void* queue_ = nullptr;
  volatile std::uint32_t dropped_ = 0;
};

}  // namespace hsn::esp
