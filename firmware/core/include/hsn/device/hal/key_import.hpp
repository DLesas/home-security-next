#pragma once

#include "hsn/device/status.hpp"
#include "hsn/protocol/cipher.hpp"

namespace hsn::device {

/**
 * Replaces the device key the platform holds: the one its packet cipher uses, and so the one
 * UpdateCrypto::session_key derives from. The platform imports the paired key itself at start-up;
 * the core calls this only for a key change after a hub restore (m3-updates-design.md section 7,
 * step 3), after the new key and its resume point are in flash.
 */
class KeyImport {
public:
  /**
   * Imports `key`; from its return every seal and open uses it. HalError::io when the crypto
   * refuses it, in which case the old key is kept.
   */
  virtual HalError import_key(const protocol::DeviceKey& key) = 0;

protected:
  KeyImport() = default;
  KeyImport(const KeyImport&) = default;
  KeyImport& operator=(const KeyImport&) = default;
  ~KeyImport() = default;
};

}  // namespace hsn::device
