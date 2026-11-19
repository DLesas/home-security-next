/* Host stand-in for ESP-IDF's log: the first error or warning since the harness cleared it is kept,
 * so a vector can say which check refused (later ones are cleanup); info and debug are dropped. ESP-IDF's sources log the
 * passphrase and the session key at debug level, which therefore never reach the output. */
#pragma once
#include <stdio.h>
extern char harness_last_log[256];
#define ESP_LOG_NONE 0
#define ESP_LOG_ERROR 1
#define ESP_LOG_WARN 2
#define ESP_LOG_INFO 3
#define ESP_LOG_DEBUG 4
#define ESP_LOG_VERBOSE 5
#define ESP_LOGE(tag, format, ...) do { (void)(tag); if (harness_last_log[0] == 0) snprintf(harness_last_log, sizeof harness_last_log, format __VA_OPT__(,) __VA_ARGS__); } while (0)
#define ESP_LOGW(tag, format, ...) ESP_LOGE(tag, format __VA_OPT__(,) __VA_ARGS__)
#define ESP_LOGI(tag, format, ...) do { (void)(tag); } while (0)
#define ESP_LOGD(tag, format, ...) do { (void)(tag); } while (0)
#define ESP_LOGV(tag, format, ...) do { (void)(tag); } while (0)
#define ESP_LOG_BUFFER_HEX_LEVEL(tag, buffer, len, level) do { (void)(tag); (void)(buffer); (void)(len); } while (0)
#define ESP_LOG_BUFFER_HEXDUMP(tag, buffer, len, level) do { (void)(tag); (void)(buffer); (void)(len); } while (0)
