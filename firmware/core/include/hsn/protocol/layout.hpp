#pragma once

#include <cstddef>
#include <cstdint>
#include <tuple>
#include <type_traits>

#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/error.hpp"

namespace hsn::protocol {

/**
 * Wire layouts are declared once, as a constexpr tuple of descriptors returned by a struct's
 * static `layout()` (fields, in wire order) or `flag_bits()` (one bool per bit, bit 0 first).
 * The member's C++ type selects its wire form: uint8_t u8, int8_t i8, uint16_t/int16_t/uint32_t
 * little-endian, std::array<uint8_t, N> N bytes, bool a strict 0/1 byte, a struct with flag_bits()
 * one flags byte, a struct with layout() its own fields, and the view types below. The encoder,
 * the decoder and the tests' JSON comparison all walk the same tuple.
 */

/** A named member of `Owner`; the name is the field's name in the test vectors. */
template <typename Owner, typename Member>
struct Field {
  const char* name;
  Member Owner::* member;
};

/** A named member that must also pass `is_valid`, failing with `error` otherwise. */
template <typename Owner, typename Member>
struct CheckedField {
  const char* name;
  Member Owner::* member;
  bool (*is_valid)(Member);
  Error error;
};

/** A constant byte on the wire that is not a field, such as a format version. */
struct FixedByte {
  std::uint8_t value;
  Error error;
};

/**
 * Declares a field.
 */
template <typename Owner, typename Member>
constexpr Field<Owner, Member> field(const char* name, Member Owner::* member) {
  return {name, member};
}

/**
 * Declares a field with a validity check applied on both encode and decode.
 */
template <typename Owner, typename Member>
constexpr CheckedField<Owner, Member> checked_field(const char* name, Member Owner::* member,
                                                    bool (*is_valid)(Member), Error error) {
  return {name, member, is_valid, error};
}

/**
 * Declares a constant byte; decoding any other value fails with `error`.
 */
constexpr FixedByte fixed_byte(std::uint8_t value, Error error) {
  return {value, error};
}

/** Marks a length-prefixed field as UTF-8 text (shown with replacement characters). */
struct TextContent {};

/** Marks a length-prefixed field as opaque bytes. */
struct ByteContent {};

/**
 * A length byte followed by at most `Max` bytes, kept as a view into the input (no copy).
 */
template <std::size_t Max, typename Content>
struct LengthPrefixed {
  static_assert(Max <= 255, "the length is one byte");
  static constexpr std::size_t max_size = Max;
  ByteView bytes;
};

/** Smallest packet a gateway carries (section 6, forwarded packet). */
constexpr std::size_t kMinCarriedPacketSize = 18;

/** Largest packet a gateway carries: a radio packet (section 6). */
constexpr std::size_t kMaxCarriedPacketSize = 255;

/**
 * A radio packet carried to the end of a body, kept as a view into the input. Its length must be
 * 18 to 255 bytes: shorter is Error::truncated, longer Error::too_long.
 */
struct CarriedPacket {
  ByteView bytes;
};

/**
 * Returns true when an enumerated byte holds a value this protocol version lists. Enumerated
 * fields keep the raw byte, because unlisted values are valid and pass through (section 3);
 * `Kind` is a struct of named constants with a `known` array.
 */
template <typename Kind>
constexpr bool is_known(std::uint8_t value) {
  for (const std::uint8_t known : Kind::known) {
    if (known == value) {
      return true;
    }
  }
  return false;
}

/** True when T declares a field layout. */
template <typename T, typename = void>
struct has_layout : std::false_type {};

template <typename T>
struct has_layout<T, std::void_t<decltype(T::layout())>> : std::true_type {};

/** True when T declares flag bits. */
template <typename T, typename = void>
struct has_flag_bits : std::false_type {};

template <typename T>
struct has_flag_bits<T, std::void_t<decltype(T::flag_bits())>> : std::true_type {};

/** Carries a type through a fold without constructing it. */
template <typename T>
struct TypeTag {
  using type = T;
};

/** Expands a std::tuple type into its element types. */
template <typename Tuple>
struct TypeList;

template <typename... Ts>
struct TypeList<std::tuple<Ts...>> {
  template <typename Function>
  static constexpr void for_each(Function& function) {
    (function(TypeTag<Ts>{}), ...);
  }
};

/**
 * Calls `function(TypeTag<T>{})` for every T of a std::tuple type, in order, without recursion.
 */
template <typename Tuple, typename Function>
constexpr void for_each_type(Function&& function) {
  TypeList<Tuple>::for_each(function);
}

}  // namespace hsn::protocol
