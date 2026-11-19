#include "hsn/esp/retained.hpp"

#include <cstdint>

#include "esp_attr.h"

namespace hsn::esp {
namespace {

// .rtc_noinit, placed in RTC slow memory (esp32s3 sections.ld.in: rtc_data_location is
// rtc_slow_seg unless CONFIG_ESP32S3_RTCDATA_IN_FAST_MEM).
RTC_NOINIT_ATTR alignas(4) std::uint8_t g_block[device::kRetainedBlockSize];
RTC_NOINIT_ATTR alignas(4) std::uint8_t g_breadcrumb[device::kBreadcrumbSize];

}  // namespace

protocol::MutableByteView EspRetainedMemory::block() {
  return protocol::MutableByteView(g_block, sizeof(g_block));
}

protocol::MutableByteView EspRetainedMemory::breadcrumb() {
  return protocol::MutableByteView(g_breadcrumb, sizeof(g_breadcrumb));
}

}  // namespace hsn::esp
