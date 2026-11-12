#include "hsn/device/services/health.hpp"

#include <array>

namespace hsn::device {

void Health::boot(const BootInfo& boot, std::uint32_t previous_breadcrumb) {
  reset_cause_ = boot.reset_cause;
  restart_requested_ = false;
  std::array<std::uint8_t, 2> bytes{};
  const auto read = storage_.read(StoreKey::fatal_error, protocol::MutableByteView(bytes));
  const std::uint16_t stored = read.ok() && read.value() == bytes.size()
                                   ? static_cast<std::uint16_t>(bytes[0] | (bytes[1] << 8))
                                   : static_cast<std::uint16_t>(0);
  stored_ = stored != 0;
  if (stored_) {
    last_fatal_ = stored;
  } else if (boot.watchdog_reset) {
    last_fatal_ =
        static_cast<std::uint16_t>(fatal_code::watchdog | (previous_breadcrumb & 0x7FFFu));
  } else {
    last_fatal_ = 0;
  }
}

protocol::Started Health::started(std::uint8_t role, std::uint8_t settings_version) const {
  protocol::Started started;
  started.role = role;
  started.firmware_version = build_.version;
  started.reset_cause = reset_cause_;
  started.last_fatal_error = last_fatal_;
  started.settings_version = settings_version;
  return started;
}

void Health::raise_fatal(std::uint16_t code, Instant now, LogBuffer& log) {
  log.add(now, LogLevel::critical, log_code::fatal, "fatal", code);
  const std::array<std::uint8_t, 2> bytes{static_cast<std::uint8_t>(code & 0xFFu),
                                          static_cast<std::uint8_t>(code >> 8)};
  if (storage_.write(StoreKey::fatal_error, protocol::ByteView(bytes)) == HalError::none) {
    stored_ = true;
  }
  restart_requested_ = true;
}

HalError Health::reported() {
  last_fatal_ = 0;
  if (!stored_) {
    return HalError::none;
  }
  const HalError error = storage_.erase(StoreKey::fatal_error);
  if (error == HalError::none) {
    stored_ = false;
  }
  return error;
}

}  // namespace hsn::device
