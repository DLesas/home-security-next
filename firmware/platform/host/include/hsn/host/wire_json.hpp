#pragma once

#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace hsn::host::json {

/** A line that is not the JSON this wire allows, or a value read as what it is not. */
class WireError : public std::runtime_error {
public:
  using std::runtime_error::runtime_error;
};

/** The largest magnitude a number may have: 2^53 − 1, what JSON numbers carry exactly. */
constexpr std::int64_t kMaxSafeInteger = 9007199254740991;

/**
 * A JSON value as the lockstep wire carries it (hub-design.md section 11, "Lockstep: the wire"):
 * null, true or false, an integer within ±(2^53 − 1), a string, an array, or an object whose
 * members keep their order. The wire has no other numbers, so neither does this.
 */
class Value {
public:
  enum class Kind : std::uint8_t { null, boolean, integer, string, array, object };
  using Array = std::vector<Value>;
  using Member = std::pair<std::string, Value>;
  using Object = std::vector<Member>;

  /** null. */
  Value() = default;
  Value(std::nullptr_t) {}
  Value(bool value) : kind_(Kind::boolean), boolean_(value) {}
  /** An integer; throws WireError beyond ±(2^53 − 1). */
  Value(std::int64_t value);
  Value(int value) : Value(static_cast<std::int64_t>(value)) {}
  Value(std::uint32_t value) : Value(static_cast<std::int64_t>(value)) {}
  Value(std::string value) : kind_(Kind::string), string_(std::move(value)) {}
  Value(const char* value) : Value(std::string(value)) {}

  /** An empty array or object, to fill with push() or set(). */
  static Value array();
  static Value object();

  Kind kind() const {
    return kind_;
  }
  bool is_null() const {
    return kind_ == Kind::null;
  }

  /** The value as each kind; throws WireError when it is another. */
  bool as_bool() const;
  std::int64_t as_int() const;
  const std::string& as_string() const;
  const Array& as_array() const;
  const Object& as_object() const;

  /** An object's member, or null when there is none (throws when not an object). */
  const Value* find(std::string_view key) const;
  /** An object's member; throws WireError, naming it, when there is none. */
  const Value& at(std::string_view key) const;

  /** Appends a member to an object (replacing one of that name); returns it for chaining. */
  Value& set(std::string key, Value value);
  /** Appends an element to an array. */
  Value& push(Value value);

  /** Same value: objects compare by members whatever their order, arrays element by element. */
  friend bool operator==(const Value& a, const Value& b);
  friend bool operator!=(const Value& a, const Value& b) {
    return !(a == b);
  }

private:
  Kind kind_ = Kind::null;
  bool boolean_ = false;
  std::int64_t integer_ = 0;
  std::string string_;
  Array items_;
  Object members_;
};

/**
 * Reads one JSON text, strictly (RFC 8259 and this wire's rules): no number that is not an
 * integer within ±(2^53 − 1) (no fraction, exponent, leading zero or −0), no duplicate member
 * names, no raw control character or invalid UTF-8 or lone surrogate in a string, nothing after
 * the value but white space, at most 64 levels deep. Throws WireError naming the offset.
 */
Value parse(std::string_view text);

/** Writes a value compactly, as JavaScript's JSON.stringify does: members in their order. */
std::string write(const Value& value);

/** Bytes as lowercase hexadecimal, two digits a byte. */
std::string to_hex(const std::vector<std::uint8_t>& bytes);

/** Reads lowercase hexadecimal, two digits a byte; throws WireError on anything else. */
std::vector<std::uint8_t> from_hex(std::string_view text);

}  // namespace hsn::host::json
