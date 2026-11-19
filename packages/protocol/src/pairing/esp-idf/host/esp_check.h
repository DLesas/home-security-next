/* Host stand-in for ESP-IDF's components/esp_common/include/esp_check.h: the two macros the SRP
 * and security 2 sources use, with ESP-IDF's behaviour (log, then return or jump). */
#pragma once
#include "esp_log.h"
#define ESP_RETURN_ON_FALSE(a, err_code, log_tag, format, ...) do { \
        if (!(a)) { ESP_LOGE(log_tag, format __VA_OPT__(,) __VA_ARGS__); return err_code; } \
    } while (0)
#define ESP_GOTO_ON_FALSE(a, err_code, goto_tag, log_tag, format, ...) do { \
        if (!(a)) { ESP_LOGE(log_tag, format __VA_OPT__(,) __VA_ARGS__); ret = err_code; goto goto_tag; } \
    } while (0)
