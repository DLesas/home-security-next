#pragma once

// Test helpers: hex, error names, and the JSON view of message structs, built from the same
// layout declarations the encoder and decoder use.

#include <doctest/doctest.h>

#include <cstdint>
#include <deque>
#include <filesystem>
#include <limits>
#include <nlohmann/json.hpp>
#include <string>
#include <tuple>
#include <type_traits>
#include <vector>

#include "hsn/protocol/binding.hpp"
#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/error.hpp"
#include "hsn/protocol/layout.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/packet.hpp"
#include "hsn/protocol/setup.hpp"

namespace hsn::test {

using json = nlohmann::json;
using Bytes = std::vector<std::uint8_t>;
namespace protocol = hsn::protocol;

/**
 * Decodes lowercase or uppercase hex; fails the test on malformed input.
 */
Bytes from_hex(const std::string& hex);

/**
 * Encodes bytes as lowercase hex.
 */
std::string to_hex(protocol::ByteView bytes);

/**
 * Views a byte vector.
 */
inline protocol::ByteView view(const Bytes& bytes) {
  return protocol::ByteView(bytes.data(), bytes.size());
}

/**
 * Returns the vectors' README name of an error ("none" and our own names for the rest).
 */
std::string error_name(protocol::Error error);

/**
 * Decodes bytes as UTF-8 the WHATWG way: one U+FFFD per maximal invalid subsequence.
 */
std::string utf8_with_replacement(protocol::ByteView bytes);

/**
 * Builds a binding from its bytes with the binding helpers, by length (0, 4, 8 or 16).
 */
protocol::Binding binding_from_bytes(const Bytes& bytes);

/**
 * Maps a vector's maxLength onto a packet limit.
 */
protocol::PacketLimit limit_from(std::uint32_t max_length);

/**
 * Reads and parses a JSON file.
 */
json load_json(const std::filesystem::path& path);

/**
 * Keeps byte buffers alive for structs that hold views, while a test case runs.
 */
class Arena {
public:
  /**
   * Stores `bytes` and returns a view of the stored copy.
   */
  protocol::ByteView keep(Bytes bytes) {
    buffers_.push_back(std::move(bytes));
    return view(buffers_.back());
  }

private:
  std::deque<Bytes> buffers_;
};

// ---- struct to JSON ----

template <typename T>
std::enable_if_t<protocol::has_flag_bits<T>::value, json> to_json(const T& value);
template <typename T>
std::enable_if_t<protocol::has_layout<T>::value, json> to_json(const T& value);

inline json to_json(std::uint8_t value) {
  return value;
}
inline json to_json(std::uint16_t value) {
  return value;
}
inline json to_json(std::uint32_t value) {
  return value;
}
inline json to_json(std::int8_t value) {
  return value;
}
inline json to_json(std::int16_t value) {
  return value;
}
inline json to_json(bool value) {
  return value;
}
template <std::size_t N>
json to_json(const std::array<std::uint8_t, N>& value) {
  return to_hex(value);
}
template <std::size_t Max>
json to_json(const protocol::LengthPrefixed<Max, protocol::ByteContent>& value) {
  return to_hex(value.bytes);
}
template <std::size_t Max>
json to_json(const protocol::LengthPrefixed<Max, protocol::TextContent>& value) {
  return utf8_with_replacement(value.bytes);
}
inline json to_json(const protocol::CarriedPacket& value) {
  return to_hex(value.bytes);
}
json to_json(const protocol::LogEntryList& value);

template <typename T, typename Owner, typename Member>
void add_element(json& object, const T& value, const protocol::Field<Owner, Member>& element) {
  object[element.name] = to_json(value.*(element.member));
}
template <typename T, typename Owner, typename Member>
void add_element(json& object, const T& value,
                 const protocol::CheckedField<Owner, Member>& element) {
  object[element.name] = to_json(value.*(element.member));
}
template <typename T>
void add_element(json&, const T&, const protocol::FixedByte&) {}

template <typename T>
std::enable_if_t<protocol::has_flag_bits<T>::value, json> to_json(const T& value) {
  json object = json::object();
  std::apply([&](const auto&... bits) { ((object[bits.name] = value.*(bits.member)), ...); },
             T::flag_bits());
  return object;
}

template <typename T>
std::enable_if_t<protocol::has_layout<T>::value, json> to_json(const T& value) {
  json object = json::object();
  std::apply([&](const auto&... elements) { (add_element(object, value, elements), ...); },
             T::layout());
  return object;
}

// ---- JSON to struct ----

template <typename T>
std::enable_if_t<protocol::has_flag_bits<T>::value> from_json(const json& j, T& out, Arena& arena);
template <typename T>
std::enable_if_t<protocol::has_layout<T>::value> from_json(const json& j, T& out, Arena& arena);

template <typename Integer>
std::enable_if_t<std::is_integral_v<Integer> && !std::is_same_v<Integer, bool>> from_json(
    const json& j, Integer& out, Arena&) {
  REQUIRE(j.is_number_integer());
  const auto value = j.get<std::int64_t>();
  REQUIRE(value >= std::numeric_limits<Integer>::min());
  REQUIRE(value <= static_cast<std::int64_t>(std::numeric_limits<Integer>::max()));
  out = static_cast<Integer>(value);
}
inline void from_json(const json& j, bool& out, Arena&) {
  REQUIRE(j.is_boolean());
  out = j.get<bool>();
}
template <std::size_t N>
void from_json(const json& j, std::array<std::uint8_t, N>& out, Arena&) {
  const Bytes bytes = from_hex(j.get<std::string>());
  REQUIRE(bytes.size() == N);
  std::copy(bytes.begin(), bytes.end(), out.begin());
}
template <std::size_t Max>
void from_json(const json& j, protocol::LengthPrefixed<Max, protocol::ByteContent>& out,
               Arena& arena) {
  out.bytes = arena.keep(from_hex(j.get<std::string>()));
}
template <std::size_t Max>
void from_json(const json& j, protocol::LengthPrefixed<Max, protocol::TextContent>& out,
               Arena& arena) {
  const std::string text = j.get<std::string>();
  out.bytes = arena.keep(Bytes(text.begin(), text.end()));
}
inline void from_json(const json& j, protocol::CarriedPacket& out, Arena& arena) {
  out.bytes = arena.keep(from_hex(j.get<std::string>()));
}
void from_json(const json& j, protocol::LogEntryList& out, Arena& arena);

template <typename T, typename Owner, typename Member>
void read_element(const json& j, T& out, const protocol::Field<Owner, Member>& element,
                  Arena& arena) {
  from_json(j.at(element.name), out.*(element.member), arena);
}
template <typename T, typename Owner, typename Member>
void read_element(const json& j, T& out, const protocol::CheckedField<Owner, Member>& element,
                  Arena& arena) {
  from_json(j.at(element.name), out.*(element.member), arena);
}
template <typename T>
void read_element(const json&, T&, const protocol::FixedByte&, Arena&) {}

template <typename T>
std::enable_if_t<protocol::has_flag_bits<T>::value> from_json(const json& j, T& out, Arena& arena) {
  std::apply(
      [&](const auto&... bits) { (from_json(j.at(bits.name), out.*(bits.member), arena), ...); },
      T::flag_bits());
}

template <typename T>
std::enable_if_t<protocol::has_layout<T>::value> from_json(const json& j, T& out, Arena& arena) {
  REQUIRE(j.is_object());
  std::apply([&](const auto&... elements) { (read_element(j, out, elements, arena), ...); },
             T::layout());
}

/**
 * Builds a struct from a vector's `fields`.
 */
template <typename T>
T struct_from_json(const json& j, Arena& arena) {
  T value{};
  from_json(j, value, arena);
  return value;
}

/**
 * A valid instance of a message: defaults, plus the parts that may not be empty.
 */
template <typename Message>
Message sample_message(Arena& arena) {
  Message message{};
  if constexpr (std::is_same_v<Message, protocol::ForwardedPacket> ||
                std::is_same_v<Message, protocol::TransmitRequest>) {
    message.packet.bytes = arena.keep(Bytes(protocol::kMinCarriedPacketSize, 0x10));
  } else if constexpr (std::is_same_v<Message, protocol::LogEntries>) {
    const json entries =
        json::array({{{"millisecondsSinceStart", 1}, {"level", 2}, {"code", 3}, {"text", "door"}}});
    from_json(entries, message.entries, arena);
  }
  return message;
}

}  // namespace hsn::test
