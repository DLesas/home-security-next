#pragma once

// Log entries for the scripted devices: entries a test makes a device log at given times, into
// the core's LogBuffer, which the device then drains as protocol section 6 says for its path.

#include <cstddef>
#include <cstdint>
#include <vector>

#include "hsn/device/services/log_buffer.hpp"
#include "hsn/device/time.hpp"

namespace hsn::test {

/** An entry a scripted device logs at a given instant on its own clock. */
struct ScriptLogEntry {
  device::Instant at;
  device::LogLevel level = device::LogLevel::warning;
  std::uint16_t code = 0;
  /** A constant, as LogBuffer::add takes. */
  const char* text = "";
};

/** Logs a script's entries in time order as their instants come. */
class ScriptLogger {
public:
  explicit ScriptLogger(const std::vector<ScriptLogEntry>& entries) : entries_(entries) {}

  /** Adds every entry whose instant has come; returns true if it added any. */
  bool run(device::LogBuffer& log, device::Instant now) {
    bool added = false;
    while (next_ < entries_.size() && entries_[next_].at <= now) {
      const ScriptLogEntry& entry = entries_[next_++];
      log.add(now, entry.level, entry.code, entry.text);
      added = true;
    }
    return added;
  }

  /** The next entry's instant, or never. */
  device::Instant next() const {
    return next_ < entries_.size() ? entries_[next_].at : device::Instant::never();
  }

private:
  std::vector<ScriptLogEntry> entries_;
  std::size_t next_ = 0;
};

}  // namespace hsn::test
