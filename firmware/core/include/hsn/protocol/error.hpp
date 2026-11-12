#pragma once

#include <cstdint>

namespace hsn::protocol {

/**
 * Why an operation failed. The first group mirrors the error names of the test vectors' README;
 * the rest are failures of the caller's buffers or of the cipher.
 */
enum class [[nodiscard]] Error : std::uint8_t {
  none,
  truncated,
  too_long,
  bad_version,
  wrong_direction,
  bad_address,
  bad_counter,
  bad_tag,
  unknown_type,
  bad_length,
  bad_value,
  bad_frame,
  counter_exhausted,
  buffer_too_small,
  cipher_failure,
  overlapping_buffers,
};

/**
 * A value or the error that prevented it. On error the value is default-constructed, so reading
 * it is never undefined; callers check `ok()` first.
 */
template <typename T>
class [[nodiscard]] Result {
public:
  /**
   * Wraps a successful value.
   */
  constexpr Result(T value) : value_(value) {}

  /**
   * Wraps a failure.
   */
  constexpr Result(Error error) : error_(error) {}

  /**
   * Returns true when the operation succeeded.
   */
  constexpr bool ok() const {
    return error_ == Error::none;
  }

  /**
   * Returns the failure, or Error::none.
   */
  constexpr Error error() const {
    return error_;
  }

  /**
   * Returns the value; default-constructed when the operation failed.
   */
  constexpr const T& value() const {
    return value_;
  }

private:
  T value_{};
  Error error_ = Error::none;
};

}  // namespace hsn::protocol
