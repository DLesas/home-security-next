/* Host stand-in for ESP-IDF's event loop: a posted event is kept, so a vector can say that the
 * board raised, say, PROTOCOMM_SECURITY_SESSION_CREDENTIALS_MISMATCH (how a board counts wrong
 * codes). */
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
typedef const char *esp_event_base_t;
#define ESP_EVENT_DECLARE_BASE(id) extern esp_event_base_t const id
#define ESP_EVENT_DEFINE_BASE(id) esp_event_base_t const id = #id
#define portMAX_DELAY 0xffffffffu
esp_err_t esp_event_post(esp_event_base_t event_base, int32_t event_id, const void *event_data,
                         size_t event_data_size, uint32_t ticks_to_wait);
