// The bounded log (FW6) and typed flash records.

#include <limits>
#include <string>
#include <vector>

#include "device_support.hpp"
#include "hsn/device/services/log_buffer.hpp"
#include "hsn/device/services/record.hpp"
#include "hsn/host/fake_clock.hpp"
#include "hsn/host/fake_storage.hpp"

namespace hsn::test {
namespace {

using device::LogBuffer;
using device::LogLevel;

struct Drained {
  std::uint32_t age_tenths;
  std::uint8_t level;
  std::uint16_t code;
  std::string text;
};

std::vector<Drained> read_entries(const protocol::LogEntries& entries) {
  std::vector<Drained> out;
  protocol::LogEntryReader reader(entries.entries);
  protocol::LogEntry entry;
  while (reader.next(entry)) {
    out.push_back({entry.age_tenths, entry.level, entry.code,
                   std::string(entry.text.bytes.begin(), entry.text.bytes.end())});
  }
  return out;
}

TEST_CASE("the log keeps the newest entries, counts repeats, and dates by age at drain") {
  device::LogState state;
  LogBuffer log(state);
  for (std::uint16_t code = 1; code <= 10; ++code) {
    log.add(at_seconds(code), LogLevel::warning, code, "entry", code);
  }
  CHECK(log.size() == device::kLogCapacity);
  log.add(at_seconds(11), LogLevel::warning, 10, "entry");
  log.add(at_seconds(12), LogLevel::warning, 10, "entry");
  CHECK(log.size() == device::kLogCapacity);
  protocol::LogEntries entries;
  const std::size_t count = log.prepare(at_seconds(20), entries);
  REQUIRE(count == device::kLogCapacity);
  const auto drained = read_entries(entries);
  REQUIRE(drained.size() == device::kLogCapacity);
  CHECK(drained.front().code == 3);
  CHECK(drained.front().text == "entry 3");
  CHECK(drained.front().age_tenths == 170);
  CHECK(drained.back().code == 10);
  CHECK(drained.back().text == "entry 10 x3");
  // The packet's body is valid log entries: it decodes as the hub would.
  protocol::LogEntryList list;
  CHECK(protocol::decode_log_entry_list(entries.entries.encoded(), list) == protocol::Error::none);
  // The link path: everything went, so everything goes.
  log.release();
  CHECK(log.size() == 0);
  CHECK(log.prepare(at_seconds(30), entries) == 0);
}

/** The codes a link prepare would send now, oldest first (the next release() takes them all). */
std::vector<std::uint16_t> kept_codes(LogBuffer& log, device::Instant now) {
  protocol::LogEntries entries;
  static_cast<void>(log.prepare(now, entries));
  std::vector<std::uint16_t> codes;
  for (const Drained& entry : read_entries(entries)) {
    codes.push_back(entry.code);
  }
  return codes;
}

TEST_CASE("a link prepare takes every level, oldest first, and release empties the log") {
  device::LogState state;
  LogBuffer log(state);
  log.add(at_seconds(1), LogLevel::debug, 1, "a");
  log.add(at_seconds(2), LogLevel::critical, 2, "b");
  log.add(at_seconds(3), LogLevel::info, 3, "c");
  protocol::LogEntries entries;
  REQUIRE(log.prepare(at_seconds(4), entries) == 3);
  const auto drained = read_entries(entries);
  REQUIRE(drained.size() == 3);
  CHECK(drained[0].code == 1);
  CHECK(drained[1].code == 2);
  CHECK(drained[2].code == 3);
  log.release();
  CHECK(log.size() == 0);
  // Nothing is in a packet now: a second release removes nothing.
  log.add(at_seconds(5), LogLevel::info, 4, "d");
  log.release();
  CHECK(log.size() == 1);
}

TEST_CASE("a LoRa prepare takes the oldest entry at warning or above and leaves the lower ones") {
  device::LogState state;
  LogBuffer log(state);
  log.add(at_seconds(1), LogLevel::info, 1, "info");
  log.add(at_seconds(2), LogLevel::debug, 2, "debug");
  log.add(at_seconds(3), LogLevel::warning, 3, "warning");
  log.add(at_seconds(4), LogLevel::error, 4, "error");
  protocol::LogEntries entries;
  REQUIRE(log.prepare(at_seconds(10), entries, LogLevel::warning, 1) == 1);
  const auto drained = read_entries(entries);
  REQUIRE(drained.size() == 1);
  CHECK(drained[0].code == 3);
  CHECK(drained[0].level == static_cast<std::uint8_t>(LogLevel::warning));
  CHECK(drained[0].age_tenths == 70);
  // Skipped is not lost: all four are still kept until the reply.
  CHECK(log.size() == 4);
  REQUIRE(log.prepare(at_seconds(10), entries, LogLevel::warning, 1) == 1);
  log.release();
  CHECK(kept_codes(log, at_seconds(10)) == std::vector<std::uint16_t>{1, 2, 4});
  // Nothing at warning or above leaves nothing to send over LoRa.
  device::LogState low_state;
  LogBuffer low(low_state);
  low.add(at_seconds(1), LogLevel::info, 1, "info");
  CHECK(low.prepare(at_seconds(2), entries, LogLevel::warning, 1) == 0);
  low.release();
  CHECK(low.size() == 1);
}

TEST_CASE("release removes exactly the prepared entries when others were added in between") {
  SUBCASE("a new entry and a repeat of the entry in flight both survive") {
    device::LogState state;
    LogBuffer log(state);
    log.add(at_seconds(1), LogLevel::info, 1, "info");
    log.add(at_seconds(2), LogLevel::warning, 3, "radio");
    protocol::LogEntries entries;
    REQUIRE(log.prepare(at_seconds(5), entries, LogLevel::warning, 1) == 1);
    // While the packet waits for its reply: the same code again, then something new.
    log.add(at_seconds(6), LogLevel::warning, 3, "radio");
    log.add(at_seconds(7), LogLevel::error, 5, "storage");
    log.release();
    REQUIRE(log.prepare(at_seconds(9), entries) == 3);
    const auto drained = read_entries(entries);
    REQUIRE(drained.size() == 3);
    CHECK(drained[0].code == 1);
    // The repeat is an entry of its own, dated by itself, not "x2" on the one that went.
    CHECK(drained[1].code == 3);
    CHECK(drained[1].text == "radio");
    CHECK(drained[1].age_tenths == 30);
    CHECK(drained[2].code == 5);
  }
  SUBCASE("an entry in flight pushed out by newer ones takes no other entry with it") {
    device::LogState state;
    LogBuffer log(state);
    for (std::uint16_t code = 1; code <= device::kLogCapacity; ++code) {
      log.add(at_seconds(code), LogLevel::warning, code, "entry");
    }
    protocol::LogEntries entries;
    REQUIRE(log.prepare(at_seconds(20), entries, LogLevel::warning, 1) == 1);
    CHECK(read_entries(entries)[0].code == 1);
    log.add(at_seconds(21), LogLevel::warning, 9, "entry");
    log.release();
    CHECK(log.size() == device::kLogCapacity);
    CHECK(kept_codes(log, at_seconds(22)) == std::vector<std::uint16_t>{2, 3, 4, 5, 6, 7, 8, 9});
  }
}

TEST_CASE("an entry whose reply never came is offered again, and only the latest packet goes") {
  device::LogState state;
  LogBuffer log(state);
  log.add(at_seconds(1), LogLevel::info, 1, "info");
  log.add(at_seconds(2), LogLevel::warning, 2, "first");
  protocol::LogEntries entries;
  REQUIRE(log.prepare(at_seconds(10), entries, LogLevel::warning, 1) == 1);
  // No reply: nothing is released. A newer warning arrives before the next heartbeat.
  log.add(at_seconds(50), LogLevel::warning, 3, "second");
  REQUIRE(log.prepare(at_seconds(70), entries, LogLevel::warning, 1) == 1);
  auto drained = read_entries(entries);
  REQUIRE(drained.size() == 1);
  CHECK(drained[0].code == 2);
  CHECK(drained[0].age_tenths == 680);
  log.release();
  CHECK(kept_codes(log, at_seconds(70)) == std::vector<std::uint16_t>{1, 3});
  // A link prepare that was not sent, then a LoRa one: release takes the LoRa packet's entry only.
  REQUIRE(log.prepare(at_seconds(71), entries) == 2);
  REQUIRE(log.prepare(at_seconds(71), entries, LogLevel::warning, 1) == 1);
  log.release();
  CHECK(kept_codes(log, at_seconds(72)) == std::vector<std::uint16_t>{1});
}

TEST_CASE("ages are whole tenths of a second at the moment the packet is built") {
  const device::Instant made = at_seconds(100);
  struct Case {
    std::int64_t after_us;
    std::uint32_t tenths;
  };
  // A clock that went back gives an age of 0, never a huge one.
  const Case cases[] = {{0, 0},      {99999, 0}, {100000, 1},  {199999, 1},
                        {200000, 2}, {-1, 0},    {-5000000, 0}};
  for (const Case& item : cases) {
    const std::int64_t after_us = item.after_us;
    const std::uint32_t tenths = item.tenths;
    INFO("built " << after_us << " us after the entry");
    device::LogState state;
    LogBuffer log(state);
    log.add(made, LogLevel::warning, 1, "entry");
    protocol::LogEntries entries;
    REQUIRE(log.prepare(made + device::microseconds(after_us), entries, LogLevel::warning, 1) == 1);
    CHECK(read_entries(entries)[0].age_tenths == tenths);
  }
}

TEST_CASE("the log cuts long text, formats negative numbers and filters by level") {
  device::LogState state;
  LogBuffer log(state);
  log.set_min_level(LogLevel::warning);
  log.add(at_seconds(1), LogLevel::info, 1, "dropped");
  CHECK(log.size() == 0);
  log.add(at_seconds(1), LogLevel::error, 2, "a text much longer than twenty-four bytes");
  log.add(at_seconds(1), LogLevel::error, 3, "rssi", -120);
  log.add(at_seconds(1), LogLevel::error, 4, "min", std::numeric_limits<std::int32_t>::min());
  protocol::LogEntries entries;
  REQUIRE(log.prepare(at_seconds(1), entries) == 3);
  const auto drained = read_entries(entries);
  CHECK(drained[0].text == "a text much longer than ");
  CHECK(drained[1].text == "rssi -120");
  CHECK(drained[2].text.substr(0, 4) == "min ");
  CHECK(drained[2].text.size() <= device::kLogTextSize);
}

struct Settings {
  std::uint8_t version = 0;
  std::uint8_t interval = 12;
};

TEST_CASE("a record writes only when the value changes, and falls back on a foreign record") {
  host::FakeClock clock;
  host::FakeStorage storage(clock);
  device::Record<Settings> record(storage, device::StoreKey::sensor_first, 1, Settings{});
  CHECK(record.load() == device::HalError::not_found);
  CHECK(record.get().interval == 12);
  CHECK(record.update(Settings{1, 12}) == device::HalError::none);
  CHECK(record.update(Settings{1, 12}) == device::HalError::none);
  CHECK(storage.write_count(device::StoreKey::sensor_first) == 1);
  CHECK(record.update(Settings{2, 20}) == device::HalError::none);
  CHECK(storage.write_count(device::StoreKey::sensor_first) == 2);

  device::Record<Settings> again(storage, device::StoreKey::sensor_first, 1, Settings{});
  CHECK(again.load() == device::HalError::none);
  CHECK(again.get().interval == 20);
  device::Record<Settings> other_version(storage, device::StoreKey::sensor_first, 2, Settings{});
  CHECK(other_version.load() == device::HalError::invalid);
  CHECK(other_version.get().interval == 12);

  storage.fail_writes = true;
  CHECK(record.update(Settings{3, 30}) == device::HalError::io);
  CHECK(record.get().interval == 30);
  storage.fail_writes = false;
  CHECK(record.update(Settings{3, 30}) == device::HalError::none);
  CHECK(storage.write_count(device::StoreKey::sensor_first) == 3);
}

}  // namespace
}  // namespace hsn::test
