/* Host stand-in for ESP-IDF's esp_random.h: the harness supplies each random byte, so every value
 * the board's code draws (the salt, the private value b, the session id) is fixed and recorded. */
#pragma once
#include <stddef.h>
void esp_fill_random(void *buf, size_t len);
