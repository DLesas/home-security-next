#include "support.hpp"

#include <fstream>

namespace hsn::test {

Bytes from_hex(const std::string& hex) {
  REQUIRE(hex.size() % 2 == 0);
  const auto nibble = [](char c) -> int {
    if (c >= '0' && c <= '9') {
      return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
      return c - 'a' + 10;
    }
    if (c >= 'A' && c <= 'F') {
      return c - 'A' + 10;
    }
    FAIL("not a hex digit: " << c);
    return 0;
  };
  Bytes bytes;
  bytes.reserve(hex.size() / 2);
  for (std::size_t i = 0; i < hex.size(); i += 2) {
    bytes.push_back(static_cast<std::uint8_t>(nibble(hex[i]) * 16 + nibble(hex[i + 1])));
  }
  return bytes;
}

std::string to_hex(protocol::ByteView bytes) {
  static constexpr char kDigits[] = "0123456789abcdef";
  std::string hex;
  hex.reserve(bytes.size() * 2);
  for (const std::uint8_t byte : bytes) {
    hex.push_back(kDigits[byte >> 4]);
    hex.push_back(kDigits[byte & 0x0F]);
  }
  return hex;
}

std::string error_name(protocol::Error error) {
  using protocol::Error;
  switch (error) {
    case Error::none:
      return "none";
    case Error::truncated:
      return "truncated";
    case Error::too_long:
      return "tooLong";
    case Error::bad_version:
      return "badVersion";
    case Error::wrong_direction:
      return "wrongDirection";
    case Error::bad_address:
      return "badAddress";
    case Error::bad_counter:
      return "badCounter";
    case Error::bad_tag:
      return "badTag";
    case Error::unknown_type:
      return "unknownType";
    case Error::bad_length:
      return "badLength";
    case Error::bad_value:
      return "badValue";
    case Error::bad_frame:
      return "badFrame";
    case Error::counter_exhausted:
      return "counterExhausted";
    case Error::buffer_too_small:
      return "bufferTooSmall (not a vector name)";
    case Error::cipher_failure:
      return "cipherFailure (not a vector name)";
    case Error::overlapping_buffers:
      return "overlappingBuffers (not a vector name)";
  }
  return "unknown error value";
}

namespace {

void append_utf8(std::string& out, std::uint32_t code_point) {
  if (code_point < 0x80) {
    out.push_back(static_cast<char>(code_point));
  } else if (code_point < 0x800) {
    out.push_back(static_cast<char>(0xC0 | (code_point >> 6)));
    out.push_back(static_cast<char>(0x80 | (code_point & 0x3F)));
  } else if (code_point < 0x10000) {
    out.push_back(static_cast<char>(0xE0 | (code_point >> 12)));
    out.push_back(static_cast<char>(0x80 | ((code_point >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (code_point & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xF0 | (code_point >> 18)));
    out.push_back(static_cast<char>(0x80 | ((code_point >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((code_point >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (code_point & 0x3F)));
  }
}

}  // namespace

std::string utf8_with_replacement(protocol::ByteView bytes) {
  // The WHATWG Encoding Standard's UTF-8 decoder.
  constexpr std::uint32_t kReplacement = 0xFFFD;
  std::string out;
  std::uint32_t code_point = 0;
  int needed = 0;
  int seen = 0;
  std::uint8_t lower = 0x80;
  std::uint8_t upper = 0xBF;
  std::size_t i = 0;
  while (i < bytes.size()) {
    const std::uint8_t byte = bytes[i];
    if (needed == 0) {
      i += 1;
      if (byte <= 0x7F) {
        append_utf8(out, byte);
      } else if (byte >= 0xC2 && byte <= 0xDF) {
        needed = 1;
        code_point = byte & 0x1Fu;
      } else if (byte >= 0xE0 && byte <= 0xEF) {
        lower = byte == 0xE0 ? 0xA0 : 0x80;
        upper = byte == 0xED ? 0x9F : 0xBF;
        needed = 2;
        code_point = byte & 0x0Fu;
      } else if (byte >= 0xF0 && byte <= 0xF4) {
        lower = byte == 0xF0 ? 0x90 : 0x80;
        upper = byte == 0xF4 ? 0x8F : 0xBF;
        needed = 3;
        code_point = byte & 0x07u;
      } else {
        append_utf8(out, kReplacement);
      }
      continue;
    }
    if (byte < lower || byte > upper) {
      // Not consumed: the byte is processed again as the start of a sequence.
      code_point = 0;
      needed = 0;
      seen = 0;
      lower = 0x80;
      upper = 0xBF;
      append_utf8(out, kReplacement);
      continue;
    }
    i += 1;
    lower = 0x80;
    upper = 0xBF;
    code_point = (code_point << 6) | (byte & 0x3Fu);
    seen += 1;
    if (seen == needed) {
      append_utf8(out, code_point);
      code_point = 0;
      needed = 0;
      seen = 0;
    }
  }
  if (needed != 0) {
    append_utf8(out, kReplacement);
  }
  return out;
}

protocol::Binding binding_from_bytes(const Bytes& bytes) {
  protocol::RandomValue first{};
  protocol::RandomValue second{};
  switch (bytes.size()) {
    case 0:
      return protocol::Binding::none();
    case 4:
      return protocol::Binding::sensor_packet(
          static_cast<std::uint32_t>(bytes[0]) | static_cast<std::uint32_t>(bytes[1]) << 8 |
          static_cast<std::uint32_t>(bytes[2]) << 16 | static_cast<std::uint32_t>(bytes[3]) << 24);
    case 8:
      std::copy(bytes.begin(), bytes.end(), first.begin());
      return protocol::Binding::hello(first);
    case 16:
      std::copy(bytes.begin(), bytes.begin() + 8, first.begin());
      std::copy(bytes.begin() + 8, bytes.end(), second.begin());
      return protocol::Binding::session(first, second);
    default:
      FAIL("binding of " << bytes.size() << " bytes");
      return protocol::Binding::none();
  }
}

protocol::PacketLimit limit_from(std::uint32_t max_length) {
  if (max_length == protocol::kMaxRadioPacketSize) {
    return protocol::PacketLimit::radio;
  }
  REQUIRE(max_length == protocol::kMaxLinkPacketSize);
  return protocol::PacketLimit::link;
}

json load_json(const std::filesystem::path& path) {
  std::ifstream stream(path);
  REQUIRE(stream.good());
  return json::parse(stream);
}

json to_json(const protocol::LogEntryList& value) {
  json entries = json::array();
  protocol::LogEntryReader reader(value);
  protocol::LogEntry entry;
  while (reader.next(entry)) {
    entries.push_back(to_json(entry));
  }
  return entries;
}

void from_json(const json& j, protocol::LogEntryList& out, Arena& arena) {
  REQUIRE(j.is_array());
  Bytes buffer(protocol::kMaxLinkPacketSize);
  protocol::LogEntriesWriter writer(protocol::MutableByteView(buffer.data(), buffer.size()));
  for (const json& item : j) {
    const auto entry = struct_from_json<protocol::LogEntry>(item, arena);
    REQUIRE(writer.append(entry) == protocol::Error::none);
  }
  const auto size = writer.finish();
  REQUIRE(size.ok());
  buffer.resize(size.value());
  const protocol::ByteView kept = arena.keep(std::move(buffer));
  REQUIRE(protocol::decode_log_entry_list(kept.subspan(1), out) == protocol::Error::none);
}

}  // namespace hsn::test
