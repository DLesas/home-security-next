#include "hsn/device/services/log_buffer.hpp"

namespace hsn::device {
namespace {

/** Writes `value` in decimal at `out[at…]` and returns the new size; bounded by `out.size()`. */
template <std::size_t N>
std::size_t append_number(std::array<std::uint8_t, N>& out, std::size_t at, std::int64_t value) {
  std::array<std::uint8_t, 20> digits{};
  std::size_t count = 0;
  const bool negative = value < 0;
  std::uint64_t magnitude =
      negative ? static_cast<std::uint64_t>(-(value + 1)) + 1 : static_cast<std::uint64_t>(value);
  do {
    digits[count++] = static_cast<std::uint8_t>('0' + magnitude % 10);
    magnitude /= 10;
  } while (magnitude != 0 && count < digits.size());
  if (negative && at < N) {
    out[at++] = '-';
  }
  for (std::size_t i = 0; i < count && at < N; ++i) {
    out[at++] = digits[count - 1 - i];
  }
  return at;
}

}  // namespace

void LogBuffer::set_min_level(LogLevel level) {
  state_.min_level = static_cast<std::uint8_t>(level);
}

void LogBuffer::add(Instant now, LogLevel level, std::uint16_t code, const char* text) {
  const auto level_byte = static_cast<std::uint8_t>(level);
  if (level_byte < state_.min_level) {
    return;
  }
  if (state_.count > 0) {
    LogRecord& newest = state_.records[(state_.start + state_.count - 1u) % kLogCapacity];
    // An entry in a packet stays as it was sent; a repeat after it starts a new entry.
    if (newest.code == code && newest.level == level_byte && !newest.in_packet) {
      if (newest.repeats < 0xFF) {
        newest.repeats = static_cast<std::uint8_t>(newest.repeats + 1);
      }
      return;
    }
  }
  std::size_t index = 0;
  if (state_.count < kLogCapacity) {
    index = (state_.start + state_.count) % kLogCapacity;
    state_.count = static_cast<std::uint8_t>(state_.count + 1);
  } else {
    index = state_.start;
    state_.start = static_cast<std::uint8_t>((state_.start + 1u) % kLogCapacity);
    if (state_.dropped < 0xFFFF) {
      state_.dropped = static_cast<std::uint16_t>(state_.dropped + 1);
    }
  }
  LogRecord& record = state_.records[index];
  record = LogRecord{};
  record.at = now;
  record.code = code;
  record.level = level_byte;
  record.repeats = 1;
  std::size_t size = 0;
  while (text != nullptr && size < kLogTextSize && text[size] != '\0') {
    record.text[size] = static_cast<std::uint8_t>(text[size]);
    ++size;
  }
  record.text_size = static_cast<std::uint8_t>(size);
}

void LogBuffer::add(Instant now, LogLevel level, std::uint16_t code, const char* text,
                    std::int32_t value) {
  const std::size_t before = state_.count;
  const std::uint8_t start_before = state_.start;
  add(now, level, code, text);
  // Only a newly taken slot gets the number; a repeat keeps its first text.
  if (state_.count == before && state_.start == start_before) {
    return;
  }
  LogRecord& record = state_.records[(state_.start + state_.count - 1u) % kLogCapacity];
  std::size_t size = record.text_size;
  if (size + 1 < kLogTextSize) {
    record.text[size++] = ' ';
    size = append_number(record.text, size, value);
  }
  record.text_size = static_cast<std::uint8_t>(size);
}

std::size_t LogBuffer::prepare(Instant now, protocol::LogEntries& out, LogLevel at_least,
                               std::size_t most) {
  out = protocol::LogEntries{};
  for (std::size_t i = 0; i < state_.count; ++i) {
    state_.records[(state_.start + i) % kLogCapacity].in_packet = false;
  }
  const auto level_byte = static_cast<std::uint8_t>(at_least);
  protocol::LogEntriesWriter writer{protocol::MutableByteView(scratch_)};
  std::size_t appended = 0;
  for (std::size_t i = 0; i < state_.count && appended < most; ++i) {
    LogRecord& record = state_.records[(state_.start + i) % kLogCapacity];
    if (record.level < level_byte) {
      continue;
    }
    // The text, then " xN" for a repeated entry.
    std::array<std::uint8_t, kLogTextSize + 8> text{};
    std::size_t size = 0;
    for (; size < record.text_size && size < kLogTextSize; ++size) {
      text[size] = record.text[size];
    }
    if (record.repeats > 1) {
      text[size++] = ' ';
      text[size++] = 'x';
      size = append_number(text, size, record.repeats);
    }
    const Duration age = now - record.at;
    const std::int64_t tenths = age.us <= 0 ? 0 : age.us / 100000;
    protocol::LogEntry entry;
    entry.age_tenths = static_cast<std::uint32_t>(tenths > 0xFFFFFFFF ? 0xFFFFFFFF : tenths);
    entry.level = record.level;
    entry.code = record.code;
    entry.text.bytes = protocol::ByteView(text.data(), size);
    if (writer.append(entry) != protocol::Error::none) {
      break;
    }
    record.in_packet = true;
    ++appended;
  }
  if (appended > 0) {
    out.entries = writer.entries();
  }
  return appended;
}

void LogBuffer::release() {
  // Keeps the entries outside the packet, in order, closing the gaps the packet's leave.
  std::size_t kept = 0;
  for (std::size_t i = 0; i < state_.count; ++i) {
    const LogRecord& record = state_.records[(state_.start + i) % kLogCapacity];
    if (!record.in_packet) {
      state_.records[(state_.start + kept) % kLogCapacity] = record;
      ++kept;
    }
  }
  state_.count = static_cast<std::uint8_t>(kept);
  if (state_.count == 0) {
    state_.start = 0;
    state_.dropped = 0;
  }
}

}  // namespace hsn::device
