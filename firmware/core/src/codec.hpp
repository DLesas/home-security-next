#pragma once

// The one encoder and decoder that every layout drives. Private to hsn_core: the public headers
// declare layouts and the explicitly instantiated decode/encode entry points.

#include <array>
#include <cstddef>
#include <cstdint>
#include <tuple>
#include <type_traits>
#include <utility>

#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/error.hpp"
#include "hsn/protocol/layout.hpp"
#include "hsn/protocol/messages.hpp"

namespace hsn::protocol::codec {

/**
 * A reader and the first error met; once an error is set, every later field is skipped.
 */
struct Decoder {
  ByteReader reader;
  Error error = Error::none;

  /**
   * Returns true while no error has been met.
   */
  bool ok() const {
    return error == Error::none;
  }

  /**
   * Records `failure` unless an earlier error is already recorded.
   */
  void fail(Error failure) {
    if (ok()) {
      error = failure;
    }
  }
};

/**
 * A writer and the first error met; once an error is set, nothing more is written.
 */
struct Encoder {
  ByteWriter writer;
  Error error = Error::none;

  /**
   * Returns true while no error has been met.
   */
  bool ok() const {
    return error == Error::none;
  }

  /**
   * Records `failure` unless an earlier error is already recorded.
   */
  void fail(Error failure) {
    if (ok()) {
      error = failure;
    }
  }
};

// Scalars. A read past the end is Error::truncated; a write past the end is buffer_too_small.

inline void decode_value(Decoder& d, std::uint8_t& out) {
  if (d.ok() && !d.reader.read_u8(out)) {
    d.fail(Error::truncated);
  }
}

inline void decode_value(Decoder& d, std::uint16_t& out) {
  if (d.ok() && !d.reader.read_u16(out)) {
    d.fail(Error::truncated);
  }
}

inline void decode_value(Decoder& d, std::uint32_t& out) {
  if (d.ok() && !d.reader.read_u32(out)) {
    d.fail(Error::truncated);
  }
}

inline void decode_value(Decoder& d, std::int8_t& out) {
  if (d.ok() && !d.reader.read_i8(out)) {
    d.fail(Error::truncated);
  }
}

inline void decode_value(Decoder& d, std::int16_t& out) {
  if (d.ok() && !d.reader.read_i16(out)) {
    d.fail(Error::truncated);
  }
}

inline void encode_value(Encoder& e, std::uint8_t value) {
  if (e.ok() && !e.writer.write_u8(value)) {
    e.fail(Error::buffer_too_small);
  }
}

inline void encode_value(Encoder& e, std::uint16_t value) {
  if (e.ok() && !e.writer.write_u16(value)) {
    e.fail(Error::buffer_too_small);
  }
}

inline void encode_value(Encoder& e, std::uint32_t value) {
  if (e.ok() && !e.writer.write_u32(value)) {
    e.fail(Error::buffer_too_small);
  }
}

inline void encode_value(Encoder& e, std::int8_t value) {
  if (e.ok() && !e.writer.write_i8(value)) {
    e.fail(Error::buffer_too_small);
  }
}

inline void encode_value(Encoder& e, std::int16_t value) {
  if (e.ok() && !e.writer.write_i16(value)) {
    e.fail(Error::buffer_too_small);
  }
}

inline void encode_bytes(Encoder& e, ByteView bytes) {
  if (e.ok() && !e.writer.write_bytes(bytes)) {
    e.fail(Error::buffer_too_small);
  }
}

// Booleans are one byte, 0 or 1; anything else is Error::bad_value (section 10).

inline void decode_value(Decoder& d, bool& out) {
  std::uint8_t raw = 0;
  decode_value(d, raw);
  if (d.ok() && raw > 1) {
    d.fail(Error::bad_value);
  }
  out = raw == 1;
}

inline void encode_value(Encoder& e, bool value) {
  encode_value(e, static_cast<std::uint8_t>(value ? 1 : 0));
}

// Fixed-length byte strings.

template <std::size_t N>
void decode_value(Decoder& d, std::array<std::uint8_t, N>& out) {
  if (d.ok() && !d.reader.read_bytes(out)) {
    d.fail(Error::truncated);
  }
}

template <std::size_t N>
void encode_value(Encoder& e, const std::array<std::uint8_t, N>& value) {
  encode_bytes(e, value);
}

// Length-prefixed bytes. A length over the limit is Error::bad_length even when the data after it
// is also cut short (section 3, "Any failed check").

template <std::size_t Max, typename Content>
void decode_value(Decoder& d, LengthPrefixed<Max, Content>& out) {
  std::uint8_t length = 0;
  decode_value(d, length);
  if (!d.ok()) {
    return;
  }
  if (length > Max) {
    d.fail(Error::bad_length);
    return;
  }
  if (!d.reader.read_view(length, out.bytes)) {
    d.fail(Error::truncated);
  }
}

template <std::size_t Max, typename Content>
void encode_value(Encoder& e, const LengthPrefixed<Max, Content>& value) {
  if (e.ok() && value.bytes.size() > Max) {
    e.fail(Error::bad_length);
    return;
  }
  encode_value(e, static_cast<std::uint8_t>(value.bytes.size()));
  encode_bytes(e, value.bytes);
}

// A carried radio packet runs to the end of the body and must be 18 to 255 bytes (section 6).

inline Error check_carried_size(std::size_t size) {
  if (size < kMinCarriedPacketSize) {
    return Error::truncated;
  }
  if (size > kMaxCarriedPacketSize) {
    return Error::too_long;
  }
  return Error::none;
}

inline void decode_value(Decoder& d, CarriedPacket& out) {
  if (!d.ok()) {
    return;
  }
  const ByteView rest = d.reader.read_rest();
  const Error size_error = check_carried_size(rest.size());
  if (size_error != Error::none) {
    d.fail(size_error);
    return;
  }
  out.bytes = rest;
}

inline void encode_value(Encoder& e, const CarriedPacket& value) {
  const Error size_error = check_carried_size(value.bytes.size());
  if (size_error != Error::none) {
    e.fail(size_error);
    return;
  }
  encode_bytes(e, value.bytes);
}

// Trailing bytes run to the end of the body: at least one, at most their limit.

inline Error check_trailing_size(std::size_t size, std::size_t max) {
  if (size == 0) {
    return Error::truncated;
  }
  return size > max ? Error::too_long : Error::none;
}

template <std::size_t Max>
void decode_value(Decoder& d, TrailingBytes<Max>& out) {
  if (!d.ok()) {
    return;
  }
  const ByteView rest = d.reader.read_rest();
  const Error size_error = check_trailing_size(rest.size(), Max);
  if (size_error != Error::none) {
    d.fail(size_error);
    return;
  }
  out.bytes = rest;
}

template <std::size_t Max>
void encode_value(Encoder& e, const TrailingBytes<Max>& value) {
  const Error size_error = check_trailing_size(value.bytes.size(), Max);
  if (e.ok() && size_error != Error::none) {
    e.fail(size_error);
    return;
  }
  encode_bytes(e, value.bytes);
}

// Log entries are validated as a whole; defined in messages.cpp.

void decode_value(Decoder& d, LogEntryList& out);
void encode_value(Encoder& e, const LogEntryList& value);

// Structs: flags bytes and nested layouts. Declared first so each can contain the other.

template <typename T>
std::enable_if_t<has_flag_bits<T>::value> decode_value(Decoder& d, T& out);
template <typename T>
std::enable_if_t<has_flag_bits<T>::value> encode_value(Encoder& e, const T& value);
template <typename T>
std::enable_if_t<has_layout<T>::value> decode_value(Decoder& d, T& out);
template <typename T>
std::enable_if_t<has_layout<T>::value> encode_value(Encoder& e, const T& value);

// Fields added at the end (section 11): absent when the body ends where they start, whole
// otherwise; written only when present.

template <typename Fields>
void decode_value(Decoder& d, Appended<Fields>& out) {
  out = Appended<Fields>{};
  if (!d.ok() || d.reader.remaining() == 0) {
    return;
  }
  decode_value(d, out.fields);
  out.present = d.ok();
}

template <typename Fields>
void encode_value(Encoder& e, const Appended<Fields>& value) {
  if (value.present) {
    encode_value(e, value.fields);
  }
}

template <typename Member>
struct is_appended : std::false_type {};

template <typename Fields>
struct is_appended<Appended<Fields>> : std::true_type {};

// The descriptors are read as compile-time constants, one index at a time. Only their member
// pointers, checks and constants are used, so the field names never reach the binary.

template <typename T, std::size_t I>
constexpr auto layout_element = std::get<I>(T::layout());

template <typename T, std::size_t I>
constexpr auto flag_member = std::get<I>(T::flag_bits()).member;

template <typename Element>
struct is_checked_field : std::false_type {};

template <typename Owner, typename Member>
struct is_checked_field<CheckedField<Owner, Member>> : std::true_type {};

template <typename T, std::size_t I>
void decode_element(Decoder& d, T& out) {
  using Element = std::decay_t<decltype(layout_element<T, I>)>;
  if constexpr (std::is_same_v<Element, FixedByte>) {
    std::uint8_t value = 0;
    decode_value(d, value);
    if (d.ok() && value != layout_element<T, I>.value) {
      d.fail(layout_element<T, I>.error);
    }
  } else {
    auto& member = out.*(layout_element<T, I>.member);
    decode_value(d, member);
    if constexpr (is_checked_field<Element>::value) {
      if (d.ok() && !layout_element<T, I>.is_valid(member)) {
        d.fail(layout_element<T, I>.error);
      }
    }
  }
}

template <typename T, std::size_t I>
void encode_element(Encoder& e, const T& in) {
  using Element = std::decay_t<decltype(layout_element<T, I>)>;
  if constexpr (std::is_same_v<Element, FixedByte>) {
    encode_value(e, layout_element<T, I>.value);
  } else {
    const auto& member = in.*(layout_element<T, I>.member);
    if constexpr (is_checked_field<Element>::value) {
      if (e.ok() && !layout_element<T, I>.is_valid(member)) {
        e.fail(layout_element<T, I>.error);
        return;
      }
    }
    encode_value(e, member);
  }
}

template <typename T, std::size_t... I>
void decode_flags(T& out, std::uint8_t raw, std::index_sequence<I...>) {
  ((out.*(flag_member<T, I>) = ((static_cast<unsigned>(raw) >> I) & 1u) != 0), ...);
}

template <typename T, std::size_t... I>
std::uint8_t encode_flags(const T& value, std::index_sequence<I...>) {
  return static_cast<std::uint8_t>((0u | ... | ((value.*(flag_member<T, I>) ? 1u : 0u) << I)));
}

template <typename T, std::size_t... I>
void decode_fields(Decoder& d, T& out, std::index_sequence<I...>) {
  (decode_element<T, I>(d, out), ...);
}

template <typename T, std::size_t... I>
void encode_fields(Encoder& e, const T& value, std::index_sequence<I...>) {
  (encode_element<T, I>(e, value), ...);
}

template <typename T>
constexpr std::size_t flag_count = std::tuple_size_v<decltype(T::flag_bits())>;

template <typename T>
constexpr std::size_t field_count = std::tuple_size_v<decltype(T::layout())>;

/** True when element I of T's layout is an appended group. */
template <typename T, std::size_t I>
constexpr bool element_is_appended() {
  using Element = std::decay_t<decltype(layout_element<T, I>)>;
  if constexpr (std::is_same_v<Element, FixedByte>) {
    return false;
  } else {
    return is_appended<std::decay_t<decltype(T{}.*(layout_element<T, I>.member))>>::value;
  }
}

/** True when no element but the last of T's layout is an appended group. */
template <typename T, std::size_t... I>
constexpr bool appended_only_last(std::index_sequence<I...>) {
  return ((!element_is_appended<T, I>() || I + 1 == sizeof...(I)) && ...);
}

template <typename T>
std::enable_if_t<has_flag_bits<T>::value> decode_value(Decoder& d, T& out) {
  static_assert(flag_count<T> <= 8, "a flags byte has eight bits");
  std::uint8_t raw = 0;
  decode_value(d, raw);
  if (d.ok()) {
    // Bits the layout does not name are ignored (section 3, "Flags").
    decode_flags(out, raw, std::make_index_sequence<flag_count<T>>());
  }
}

template <typename T>
std::enable_if_t<has_flag_bits<T>::value> encode_value(Encoder& e, const T& value) {
  // Bits the layout does not name are written as zero.
  encode_value(e, encode_flags(value, std::make_index_sequence<flag_count<T>>()));
}

template <typename T>
std::enable_if_t<has_layout<T>::value> decode_value(Decoder& d, T& out) {
  static_assert(appended_only_last<T>(std::make_index_sequence<field_count<T>>()),
                "an appended group is the last element of a layout");
  decode_fields(d, out, std::make_index_sequence<field_count<T>>());
}

template <typename T>
std::enable_if_t<has_layout<T>::value> encode_value(Encoder& e, const T& value) {
  static_assert(appended_only_last<T>(std::make_index_sequence<field_count<T>>()),
                "an appended group is the last element of a layout");
  encode_fields(e, value, std::make_index_sequence<field_count<T>>());
}

/**
 * Decodes `bytes` as the fields of T into `out`, which is left unchanged on error.
 */
template <typename T>
Error decode_struct(ByteView bytes, T& out) {
  Decoder d{ByteReader(bytes)};
  T decoded{};
  decode_value(d, decoded);
  if (d.ok()) {
    out = decoded;
  }
  return d.error;
}

/**
 * Writes an optional leading byte, then the fields of T, and returns the size written.
 */
template <typename T>
Result<std::size_t> encode_struct(Encoder& e, const T& value) {
  encode_value(e, value);
  if (!e.ok()) {
    return e.error;
  }
  return e.writer.size();
}

}  // namespace hsn::protocol::codec
