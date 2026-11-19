#include "hsn/esp/event_queue.hpp"

#include "esp_attr.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

namespace hsn::esp {

bool EventQueue::begin() {
  queue_ = xQueueCreate(kLength, sizeof(Message));
  return queue_ != nullptr;
}

bool EventQueue::post(const Message& message) {
  if (xQueueSend(static_cast<QueueHandle_t>(queue_), &message, 0) != pdTRUE) {
    dropped_ = dropped_ + 1;
    return false;
  }
  return true;
}

// FreeRTOS keeps the functions an interrupt may call in IRAM unless
// CONFIG_FREERTOS_PLACE_ISR_FUNCTIONS_INTO_FLASH (which needs flash auto-suspend, off here), so
// this runs while flash is busy (an NVS or slot write). The link map is checked for it (the spike
// report).
IRAM_ATTR bool EventQueue::post_from_isr(const Message& message, int* woken) {
  BaseType_t higher = pdFALSE;
  const bool sent =
      xQueueSendFromISR(static_cast<QueueHandle_t>(queue_), &message, &higher) == pdTRUE;
  if (!sent) {
    dropped_ = dropped_ + 1;
  }
  if (higher == pdTRUE) {
    *woken = 1;
  }
  return sent;
}

bool EventQueue::take(Message& out, std::uint32_t wait_ms) {
  const TickType_t ticks = wait_ms == UINT32_MAX ? portMAX_DELAY : pdMS_TO_TICKS(wait_ms);
  return xQueueReceive(static_cast<QueueHandle_t>(queue_), &out, ticks) == pdTRUE;
}

}  // namespace hsn::esp
