/* Host stand-in for ESP-IDF's components/esp_common/include/esp_err.h: the values the protocomm
 * and SRP sources use, copied from ESP-IDF v6.1.1. */
#pragma once
#include <stdint.h>
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_NO_MEM 0x101
#define ESP_ERR_INVALID_ARG 0x102
#define ESP_ERR_INVALID_STATE 0x103
#define ESP_ERR_INVALID_SIZE 0x104
#define ESP_ERR_NOT_FOUND 0x105
