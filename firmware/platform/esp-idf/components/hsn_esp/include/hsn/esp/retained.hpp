#pragma once

#include "hsn/device/hal/retained.hpp"

namespace hsn::esp {

/**
 * The retained block and the breadcrumb (design section 5), in RTC slow memory as RTC_NOINIT_ATTR
 * data: no start-up code clears it, so it keeps its bytes through deep sleep (ESP-IDF memory
 * types, P) and, unverified, through a watchdog or software reset (hardware notes (b)) ‡. After a
 * power loss it holds anything at all; the core checks it on every boot (CRC, magic, layouts).
 * RTC_DATA_ATTR would not do: start-up code initialises it on every reset that is not a
 * deep-sleep wake, which would lose the siren's sounding state after a watchdog reset (SR5).
 */
class EspRetainedMemory final : public device::RetainedMemory {
public:
  protocol::MutableByteView block() override;
  protocol::MutableByteView breadcrumb() override;
};

}  // namespace hsn::esp
