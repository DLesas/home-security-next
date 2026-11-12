#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <type_traits>

namespace hsn::protocol {

/**
 * A non-owning view of contiguous elements (C++17 has no std::span). Slicing clamps to the view,
 * so a slice can never reach outside it.
 */
template <typename T>
class Span {
public:
  /**
   * Creates an empty view.
   */
  constexpr Span() = default;

  /**
   * Views `size` elements at `data`; a null pointer gives an empty view.
   */
  constexpr Span(T* data, std::size_t size) : data_(data), size_(data == nullptr ? 0 : size) {}

  /**
   * Views a whole C array.
   */
  template <std::size_t N>
  constexpr Span(T (&array)[N]) : data_(array), size_(N) {}

  /**
   * Views a whole std::array, mutable or const as T allows.
   */
  template <
      typename U, std::size_t N,
      typename = std::enable_if_t<std::is_same_v<std::remove_const_t<T>, std::remove_const_t<U>>>>
  constexpr Span(std::array<U, N>& array) : data_(array.data()), size_(N) {}

  /**
   * Views a whole const std::array; only for views of const elements.
   */
  template <
      typename U, std::size_t N,
      typename = std::enable_if_t<std::is_const_v<T> && std::is_same_v<std::remove_const_t<T>, U>>>
  constexpr Span(const std::array<U, N>& array) : data_(array.data()), size_(N) {}

  /**
   * Converts a mutable view to a const one.
   */
  template <typename U, typename = std::enable_if_t<std::is_const_v<T> &&
                                                    std::is_same_v<std::remove_const_t<T>, U>>>
  constexpr Span(Span<U> other) : data_(other.data()), size_(other.size()) {}

  /**
   * Returns the first element's address (null when empty and default-constructed).
   */
  constexpr T* data() const {
    return data_;
  }

  /**
   * Returns the number of elements.
   */
  constexpr std::size_t size() const {
    return size_;
  }

  /**
   * Returns true when the view has no elements.
   */
  constexpr bool empty() const {
    return size_ == 0;
  }

  /**
   * Returns element `index`. Precondition: index < size(); used only in loops bounded by size().
   */
  constexpr T& operator[](std::size_t index) const {
    return data_[index];
  }

  /**
   * Returns an iterator to the first element.
   */
  constexpr T* begin() const {
    return data_;
  }

  /**
   * Returns an iterator past the last element.
   */
  constexpr T* end() const {
    return data_ + size_;
  }

  /**
   * Returns the first `count` elements, or the whole view when it is shorter.
   */
  constexpr Span first(std::size_t count) const {
    return Span(data_, count < size_ ? count : size_);
  }

  /**
   * Returns the elements from `offset` on, or an empty view when `offset` is past the end.
   */
  constexpr Span subspan(std::size_t offset) const {
    return offset < size_ ? Span(data_ + offset, size_ - offset) : Span();
  }

  /**
   * Returns up to `count` elements from `offset`, clamped to the view.
   */
  constexpr Span subspan(std::size_t offset, std::size_t count) const {
    return subspan(offset).first(count);
  }

private:
  T* data_ = nullptr;
  std::size_t size_ = 0;
};

/**
 * Read-only bytes owned by someone else.
 */
using ByteView = Span<const std::uint8_t>;

/**
 * Writable bytes owned by someone else, typically a caller-supplied buffer.
 */
using MutableByteView = Span<std::uint8_t>;

/**
 * Returns true when the two views share at least one byte. Compares addresses as integers, since
 * ordering pointers into different objects is unspecified in C++.
 */
inline bool overlap(ByteView a, ByteView b) {
  if (a.empty() || b.empty()) {
    return false;
  }
  const auto a_start = reinterpret_cast<std::uintptr_t>(a.data());
  const auto b_start = reinterpret_cast<std::uintptr_t>(b.data());
  return a_start < b_start + b.size() && b_start < a_start + a.size();
}

/**
 * Returns true when both views hold the same bytes. Not constant-time; never used on secrets.
 */
constexpr bool equal(ByteView a, ByteView b) {
  if (a.size() != b.size()) {
    return false;
  }
  for (std::size_t i = 0; i < a.size(); ++i) {
    if (a[i] != b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Converts a wire byte to a signed value by arithmetic, so the result never depends on how the
 * compiler converts out-of-range values.
 */
constexpr std::int8_t to_signed(std::uint8_t value) {
  const int wide = value < 0x80 ? static_cast<int>(value) : static_cast<int>(value) - 0x100;
  return static_cast<std::int8_t>(wide);
}

/**
 * Converts a 16-bit wire value to a signed value by arithmetic.
 */
constexpr std::int16_t to_signed(std::uint16_t value) {
  const std::int32_t wide = value < 0x8000 ? static_cast<std::int32_t>(value)
                                           : static_cast<std::int32_t>(value) - 0x10000;
  return static_cast<std::int16_t>(wide);
}

/**
 * Reads little-endian integers and byte runs from a view, never past its end. A failed read
 * returns false and consumes nothing.
 */
class ByteReader {
public:
  /**
   * Starts reading at the first byte of `bytes`.
   */
  explicit constexpr ByteReader(ByteView bytes) : bytes_(bytes) {}

  /**
   * Reads one byte.
   */
  [[nodiscard]] bool read_u8(std::uint8_t& out);

  /**
   * Reads a little-endian 16-bit value.
   */
  [[nodiscard]] bool read_u16(std::uint16_t& out);

  /**
   * Reads a little-endian 32-bit value.
   */
  [[nodiscard]] bool read_u32(std::uint32_t& out);

  /**
   * Reads one byte as a two's complement signed value.
   */
  [[nodiscard]] bool read_i8(std::int8_t& out);

  /**
   * Reads a little-endian 16-bit two's complement signed value.
   */
  [[nodiscard]] bool read_i16(std::int16_t& out);

  /**
   * Copies exactly `out.size()` bytes into `out`.
   */
  [[nodiscard]] bool read_bytes(MutableByteView out);

  /**
   * Returns a view of the next `count` bytes without copying them.
   */
  [[nodiscard]] bool read_view(std::size_t count, ByteView& out);

  /**
   * Returns a view of every byte not yet read, and consumes them.
   */
  ByteView read_rest();

  /**
   * Returns the number of bytes not yet read.
   */
  constexpr std::size_t remaining() const {
    return bytes_.size() - position_;
  }

private:
  ByteView bytes_;
  std::size_t position_ = 0;
};

/**
 * Writes little-endian integers and byte runs into a caller's buffer. A write that does not fit
 * returns false and writes nothing at all.
 */
class ByteWriter {
public:
  /**
   * Starts writing at the first byte of `out`.
   */
  explicit constexpr ByteWriter(MutableByteView out) : out_(out) {}

  /**
   * Writes one byte.
   */
  [[nodiscard]] bool write_u8(std::uint8_t value);

  /**
   * Writes a little-endian 16-bit value.
   */
  [[nodiscard]] bool write_u16(std::uint16_t value);

  /**
   * Writes a little-endian 32-bit value.
   */
  [[nodiscard]] bool write_u32(std::uint32_t value);

  /**
   * Writes a signed byte in two's complement.
   */
  [[nodiscard]] bool write_i8(std::int8_t value);

  /**
   * Writes a little-endian 16-bit signed value in two's complement.
   */
  [[nodiscard]] bool write_i16(std::int16_t value);

  /**
   * Copies all of `bytes`.
   */
  [[nodiscard]] bool write_bytes(ByteView bytes);

  /**
   * Returns the number of bytes written so far.
   */
  constexpr std::size_t size() const {
    return position_;
  }

  /**
   * Returns the room left in the buffer.
   */
  constexpr std::size_t remaining() const {
    return out_.size() - position_;
  }

private:
  MutableByteView out_;
  std::size_t position_ = 0;
};

}  // namespace hsn::protocol
