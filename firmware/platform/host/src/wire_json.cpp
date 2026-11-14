#include "hsn/host/wire_json.hpp"

#include <algorithm>

namespace hsn::host::json {
namespace {

constexpr int kMaxDepth = 64;

const char* kind_name(Value::Kind kind) {
  switch (kind) {
    case Value::Kind::null:
      return "null";
    case Value::Kind::boolean:
      return "a boolean";
    case Value::Kind::integer:
      return "an integer";
    case Value::Kind::string:
      return "a string";
    case Value::Kind::array:
      return "an array";
    case Value::Kind::object:
      return "an object";
  }
  return "?";
}

void append_utf8(std::string& out, std::uint32_t code) {
  if (code < 0x80) {
    out.push_back(static_cast<char>(code));
  } else if (code < 0x800) {
    out.push_back(static_cast<char>(0xC0 | (code >> 6)));
    out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
  } else if (code < 0x10000) {
    out.push_back(static_cast<char>(0xE0 | (code >> 12)));
    out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xF0 | (code >> 18)));
    out.push_back(static_cast<char>(0x80 | ((code >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
  }
}

class Parser {
public:
  explicit Parser(std::string_view text) : text_(text) {}

  Value document() {
    skip_space();
    Value value = parse_value(0);
    skip_space();
    if (at_ != text_.size()) {
      fail("text after the value");
    }
    return value;
  }

private:
  [[noreturn]] void fail(const std::string& what) const {
    throw WireError("not this wire's JSON at offset " + std::to_string(at_) + ": " + what);
  }

  bool done() const {
    return at_ >= text_.size();
  }

  char peek() const {
    return done() ? '\0' : text_[at_];
  }

  void skip_space() {
    while (!done() &&
           (text_[at_] == ' ' || text_[at_] == '\t' || text_[at_] == '\n' || text_[at_] == '\r')) {
      ++at_;
    }
  }

  void expect(char c) {
    if (peek() != c) {
      fail(std::string("expected '") + c + "'");
    }
    ++at_;
  }

  void literal(std::string_view word) {
    if (text_.substr(at_, word.size()) != word) {
      fail("not a value");
    }
    at_ += word.size();
  }

  Value parse_value(int depth) {
    if (depth > kMaxDepth) {
      fail("nested more than 64 levels");
    }
    switch (peek()) {
      case '{':
        return parse_object(depth);
      case '[':
        return parse_array(depth);
      case '"':
        return Value(parse_string());
      case 't':
        literal("true");
        return Value(true);
      case 'f':
        literal("false");
        return Value(false);
      case 'n':
        literal("null");
        return Value();
      default:
        return parse_number();
    }
  }

  Value parse_object(int depth) {
    expect('{');
    Value object = Value::object();
    skip_space();
    if (peek() == '}') {
      ++at_;
      return object;
    }
    for (;;) {
      skip_space();
      if (peek() != '"') {
        fail("expected a member name");
      }
      std::string key = parse_string();
      if (object.find(key) != nullptr) {
        fail("member \"" + key + "\" given twice");
      }
      skip_space();
      expect(':');
      skip_space();
      Value value = parse_value(depth + 1);
      object.set(std::move(key), std::move(value));
      skip_space();
      if (peek() == ',') {
        ++at_;
        continue;
      }
      expect('}');
      return object;
    }
  }

  Value parse_array(int depth) {
    expect('[');
    Value array = Value::array();
    skip_space();
    if (peek() == ']') {
      ++at_;
      return array;
    }
    for (;;) {
      skip_space();
      array.push(parse_value(depth + 1));
      skip_space();
      if (peek() == ',') {
        ++at_;
        continue;
      }
      expect(']');
      return array;
    }
  }

  Value parse_number() {
    const std::size_t start = at_;
    bool negative = false;
    if (peek() == '-') {
      negative = true;
      ++at_;
    }
    if (peek() < '0' || peek() > '9') {
      fail("not a value");
    }
    if (peek() == '0' && at_ + 1 < text_.size() && text_[at_ + 1] >= '0' && text_[at_ + 1] <= '9') {
      fail("a number with a leading zero");
    }
    std::int64_t magnitude = 0;
    while (peek() >= '0' && peek() <= '9') {
      magnitude = magnitude * 10 + (peek() - '0');
      if (magnitude > kMaxSafeInteger) {
        fail("a number beyond 2^53 - 1");
      }
      ++at_;
    }
    if (peek() == '.' || peek() == 'e' || peek() == 'E') {
      fail("a number that is not an integer");
    }
    if (negative && magnitude == 0) {
      at_ = start;
      fail("-0");
    }
    return Value(negative ? -magnitude : magnitude);
  }

  std::uint32_t hex4() {
    if (at_ + 4 > text_.size()) {
      fail("a short \\u escape");
    }
    std::uint32_t code = 0;
    for (int i = 0; i < 4; ++i) {
      const char c = text_[at_++];
      code <<= 4;
      if (c >= '0' && c <= '9') {
        code |= static_cast<std::uint32_t>(c - '0');
      } else if (c >= 'a' && c <= 'f') {
        code |= static_cast<std::uint32_t>(c - 'a' + 10);
      } else if (c >= 'A' && c <= 'F') {
        code |= static_cast<std::uint32_t>(c - 'A' + 10);
      } else {
        fail("a bad \\u escape");
      }
    }
    return code;
  }

  /** One UTF-8 sequence starting at the current byte, checked, copied to `out`. */
  void utf8(std::string& out) {
    const auto byte = [this](std::size_t i) { return static_cast<std::uint8_t>(text_[i]); };
    const std::uint8_t lead = byte(at_);
    std::size_t length = 0;
    std::uint32_t code = 0;
    if (lead >= 0xC2 && lead <= 0xDF) {
      length = 2;
      code = lead & 0x1Fu;
    } else if (lead >= 0xE0 && lead <= 0xEF) {
      length = 3;
      code = lead & 0x0Fu;
    } else if (lead >= 0xF0 && lead <= 0xF4) {
      length = 4;
      code = lead & 0x07u;
    } else {
      fail("invalid UTF-8");
    }
    if (at_ + length > text_.size()) {
      fail("invalid UTF-8");
    }
    for (std::size_t i = 1; i < length; ++i) {
      const std::uint8_t next = byte(at_ + i);
      if ((next & 0xC0u) != 0x80u) {
        fail("invalid UTF-8");
      }
      code = (code << 6) | (next & 0x3Fu);
    }
    const bool overlong = (length == 3 && code < 0x800) || (length == 4 && code < 0x10000);
    if (overlong || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) {
      fail("invalid UTF-8");
    }
    out.append(text_.substr(at_, length));
    at_ += length;
  }

  std::string parse_string() {
    expect('"');
    std::string out;
    for (;;) {
      if (done()) {
        fail("an unended string");
      }
      const auto c = static_cast<std::uint8_t>(text_[at_]);
      if (c == '"') {
        ++at_;
        return out;
      }
      if (c < 0x20) {
        fail("a raw control character in a string");
      }
      if (c >= 0x80) {
        utf8(out);
        continue;
      }
      if (c != '\\') {
        out.push_back(static_cast<char>(c));
        ++at_;
        continue;
      }
      ++at_;
      const char escape = peek();
      ++at_;
      switch (escape) {
        case '"':
          out.push_back('"');
          break;
        case '\\':
          out.push_back('\\');
          break;
        case '/':
          out.push_back('/');
          break;
        case 'b':
          out.push_back('\b');
          break;
        case 'f':
          out.push_back('\f');
          break;
        case 'n':
          out.push_back('\n');
          break;
        case 'r':
          out.push_back('\r');
          break;
        case 't':
          out.push_back('\t');
          break;
        case 'u': {
          std::uint32_t code = hex4();
          if (code >= 0xDC00 && code <= 0xDFFF) {
            fail("a lone low surrogate");
          }
          if (code >= 0xD800 && code <= 0xDBFF) {
            if (text_.substr(at_, 2) != "\\u") {
              fail("a lone high surrogate");
            }
            at_ += 2;
            const std::uint32_t low = hex4();
            if (low < 0xDC00 || low > 0xDFFF) {
              fail("a lone high surrogate");
            }
            code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
          }
          append_utf8(out, code);
          break;
        }
        default:
          fail("an unknown escape");
      }
    }
  }

  std::string_view text_;
  std::size_t at_ = 0;
};

void write_string(std::string& out, const std::string& text) {
  static const char kHex[] = "0123456789abcdef";
  out.push_back('"');
  for (const char c : text) {
    const auto byte = static_cast<std::uint8_t>(c);
    switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (byte < 0x20) {
          out += "\\u00";
          out.push_back(kHex[byte >> 4]);
          out.push_back(kHex[byte & 0x0F]);
        } else {
          out.push_back(c);
        }
    }
  }
  out.push_back('"');
}

void write_value(std::string& out, const Value& value) {
  switch (value.kind()) {
    case Value::Kind::null:
      out += "null";
      break;
    case Value::Kind::boolean:
      out += value.as_bool() ? "true" : "false";
      break;
    case Value::Kind::integer:
      out += std::to_string(value.as_int());
      break;
    case Value::Kind::string:
      write_string(out, value.as_string());
      break;
    case Value::Kind::array: {
      out.push_back('[');
      bool first = true;
      for (const Value& item : value.as_array()) {
        if (!first) {
          out.push_back(',');
        }
        first = false;
        write_value(out, item);
      }
      out.push_back(']');
      break;
    }
    case Value::Kind::object: {
      out.push_back('{');
      bool first = true;
      for (const Value::Member& member : value.as_object()) {
        if (!first) {
          out.push_back(',');
        }
        first = false;
        write_string(out, member.first);
        out.push_back(':');
        write_value(out, member.second);
      }
      out.push_back('}');
      break;
    }
  }
}

}  // namespace

Value::Value(std::int64_t value) : kind_(Kind::integer), integer_(value) {
  if (value > kMaxSafeInteger || value < -kMaxSafeInteger) {
    throw WireError("the integer " + std::to_string(value) + " is beyond 2^53 - 1");
  }
}

Value Value::array() {
  Value value;
  value.kind_ = Kind::array;
  return value;
}

Value Value::object() {
  Value value;
  value.kind_ = Kind::object;
  return value;
}

bool Value::as_bool() const {
  if (kind_ != Kind::boolean) {
    throw WireError(std::string("expected a boolean, got ") + kind_name(kind_));
  }
  return boolean_;
}

std::int64_t Value::as_int() const {
  if (kind_ != Kind::integer) {
    throw WireError(std::string("expected an integer, got ") + kind_name(kind_));
  }
  return integer_;
}

const std::string& Value::as_string() const {
  if (kind_ != Kind::string) {
    throw WireError(std::string("expected a string, got ") + kind_name(kind_));
  }
  return string_;
}

const Value::Array& Value::as_array() const {
  if (kind_ != Kind::array) {
    throw WireError(std::string("expected an array, got ") + kind_name(kind_));
  }
  return items_;
}

const Value::Object& Value::as_object() const {
  if (kind_ != Kind::object) {
    throw WireError(std::string("expected an object, got ") + kind_name(kind_));
  }
  return members_;
}

const Value* Value::find(std::string_view key) const {
  for (const Member& member : as_object()) {
    if (member.first == key) {
      return &member.second;
    }
  }
  return nullptr;
}

const Value& Value::at(std::string_view key) const {
  const Value* found = find(key);
  if (found == nullptr) {
    throw WireError("no member \"" + std::string(key) + "\"");
  }
  return *found;
}

Value& Value::set(std::string key, Value value) {
  static_cast<void>(as_object());
  for (Member& member : members_) {
    if (member.first == key) {
      member.second = std::move(value);
      return *this;
    }
  }
  members_.emplace_back(std::move(key), std::move(value));
  return *this;
}

Value& Value::push(Value value) {
  static_cast<void>(as_array());
  items_.push_back(std::move(value));
  return *this;
}

bool operator==(const Value& a, const Value& b) {
  if (a.kind_ != b.kind_) {
    return false;
  }
  switch (a.kind_) {
    case Value::Kind::null:
      return true;
    case Value::Kind::boolean:
      return a.boolean_ == b.boolean_;
    case Value::Kind::integer:
      return a.integer_ == b.integer_;
    case Value::Kind::string:
      return a.string_ == b.string_;
    case Value::Kind::array:
      return a.items_ == b.items_;
    case Value::Kind::object:
      if (a.members_.size() != b.members_.size()) {
        return false;
      }
      return std::all_of(a.members_.begin(), a.members_.end(), [&b](const Value::Member& member) {
        const Value* other = b.find(member.first);
        return other != nullptr && *other == member.second;
      });
  }
  return false;
}

Value parse(std::string_view text) {
  return Parser(text).document();
}

std::string write(const Value& value) {
  std::string out;
  write_value(out, value);
  return out;
}

std::string to_hex(const std::vector<std::uint8_t>& bytes) {
  static const char kHex[] = "0123456789abcdef";
  std::string out;
  out.reserve(bytes.size() * 2);
  for (const std::uint8_t byte : bytes) {
    out.push_back(kHex[byte >> 4]);
    out.push_back(kHex[byte & 0x0F]);
  }
  return out;
}

std::vector<std::uint8_t> from_hex(std::string_view text) {
  if (text.size() % 2 != 0) {
    throw WireError("hexadecimal with an odd number of digits");
  }
  const auto digit = [](char c) -> int {
    if (c >= '0' && c <= '9') {
      return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
      return c - 'a' + 10;
    }
    throw WireError(std::string("not a lowercase hexadecimal digit: '") + c + "'");
  };
  std::vector<std::uint8_t> out(text.size() / 2);
  for (std::size_t i = 0; i < out.size(); ++i) {
    out[i] = static_cast<std::uint8_t>(digit(text[2 * i]) * 16 + digit(text[2 * i + 1]));
  }
  return out;
}

}  // namespace hsn::host::json
