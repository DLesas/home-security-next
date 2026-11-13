#pragma once

#include <cstdint>

#include "hsn/device/time.hpp"

namespace hsn::roles::gateway {

/**
 * Returns the gateway's microsecond clock at `at`: the low 32 bits of the instant (protocol
 * section 6, forwarded packet; design section 2).
 */
std::uint32_t clock_value(device::Instant at);

/**
 * Returns the instant nearest `now` whose low 32 bits are `value`: a transmit request's time,
 * which may lie up to half the clock's span (about 35 minutes) either side of now (design
 * section 7, gateway).
 */
device::Instant nearest_instant(device::Instant now, std::uint32_t value);

}  // namespace hsn::roles::gateway
