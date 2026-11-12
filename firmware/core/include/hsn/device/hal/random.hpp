#pragma once

#include "hsn/protocol/bytes.hpp"

namespace hsn::device {

/**
 * The hardware random number generator. On the ESP32-S3 its output is truly random only while
 * Wi-Fi or the radio is on, which holds for the gateway's hello; retry jitter needs no more.
 */
class Random {
public:
  /**
   * Fills `out` with random bytes. Never fails and never blocks.
   */
  virtual void fill(protocol::MutableByteView out) = 0;

protected:
  Random() = default;
  Random(const Random&) = default;
  Random& operator=(const Random&) = default;
  ~Random() = default;
};

}  // namespace hsn::device
