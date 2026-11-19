#include "hsn/esp/link_slots.hpp"

#include <algorithm>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

namespace hsn::esp {

bool SendSlots::begin() {
  free_ = xQueueCreate(kSlots, sizeof(std::uint8_t));
  full_ = xQueueCreate(kSlots, sizeof(std::uint8_t));
  if (free_ == nullptr || full_ == nullptr) {
    return false;
  }
  for (std::uint8_t i = 0; i < kSlots; ++i) {
    xQueueSend(static_cast<QueueHandle_t>(free_), &i, 0);
  }
  return true;
}

bool SendSlots::put(protocol::ByteView packet) {
  std::uint8_t index = 0;
  if (packet.size() > protocol::kMaxFrameDataSize ||
      xQueueReceive(static_cast<QueueHandle_t>(free_), &index, 0) != pdTRUE) {
    return false;
  }
  Item& item = items_[index];
  std::copy(packet.begin(), packet.end(), item.bytes.begin());
  item.size = static_cast<std::uint16_t>(packet.size());
  in_flight_.fetch_add(1);
  xQueueSend(static_cast<QueueHandle_t>(full_), &index, 0);
  return true;
}

bool SendSlots::take(std::array<std::uint8_t, protocol::kMaxFrameDataSize>& out, std::size_t& size,
                     std::uint32_t wait_ms) {
  std::uint8_t index = 0;
  const TickType_t ticks = wait_ms == UINT32_MAX ? portMAX_DELAY : pdMS_TO_TICKS(wait_ms);
  if (xQueueReceive(static_cast<QueueHandle_t>(full_), &index, ticks) != pdTRUE) {
    return false;
  }
  const Item& item = items_[index];
  std::copy(item.bytes.begin(), item.bytes.begin() + item.size, out.begin());
  size = item.size;
  xQueueSend(static_cast<QueueHandle_t>(free_), &index, 0);
  return true;
}

bool SendSlots::empty() const {
  return in_flight_.load() == 0;
}

void SendSlots::sent() {
  in_flight_.fetch_sub(1);
}

}  // namespace hsn::esp
