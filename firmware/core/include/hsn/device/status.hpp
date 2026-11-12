#pragma once

#include <cstdint>

#include "hsn/protocol/error.hpp"

namespace hsn::device {

/**
 * What a hardware interface call reports (design section 3). Results that come later are events.
 */
enum class [[nodiscard]] HalError : std::uint8_t {
  none,
  /** The device is in the middle of something else, or a queue is full. */
  busy,
  /** A stored record does not exist. */
  not_found,
  /** The hardware failed: flash, SPI, radio, link. */
  io,
  /** An argument is out of range or a buffer is too small. */
  invalid,
  /** This board or platform cannot do it. */
  unsupported,
};

/** A value from a hardware call, or the error that prevented it. */
template <typename T>
class [[nodiscard]] HalResult {
public:
  constexpr HalResult(T value) : value_(value) {}
  constexpr HalResult(HalError error) : error_(error) {}

  constexpr bool ok() const {
    return error_ == HalError::none;
  }
  constexpr HalError error() const {
    return error_;
  }
  /** Default-constructed when the call failed. */
  constexpr const T& value() const {
    return value_;
  }

private:
  T value_{};
  HalError error_ = HalError::none;
};

/** What a shared service reports. */
enum class [[nodiscard]] Status : std::uint8_t {
  ok,
  /** The codec refused it; the detail says why. */
  protocol_error,
  /** A flash read or write failed. */
  storage_error,
  /** The radio refused an operation. */
  radio_error,
  /** The service is busy with an earlier request. */
  busy,
  /** The service has not been started, or the device is not paired. */
  not_ready,
  /** The packet is not for this device, or a rule refused it. */
  refused,
  /** It does not fit the airtime budget yet; try again later. */
  deferred,
};

/** A value from a service, or the status that prevented it, with the codec's detail. */
template <typename T>
class [[nodiscard]] Outcome {
public:
  constexpr Outcome(T value) : value_(value) {}
  constexpr Outcome(Status status, protocol::Error detail = protocol::Error::none)
      : status_(status), detail_(detail) {}

  constexpr bool ok() const {
    return status_ == Status::ok;
  }
  constexpr Status status() const {
    return status_;
  }
  /** The codec's error when the status is protocol_error. */
  constexpr protocol::Error detail() const {
    return detail_;
  }
  /** Default-constructed when the operation failed. */
  constexpr const T& value() const {
    return value_;
  }

private:
  T value_{};
  Status status_ = Status::ok;
  protocol::Error detail_ = protocol::Error::none;
};

}  // namespace hsn::device
