// The bounded log (FW6) and typed flash records.

#include <limits>
#include <string>

#include "device/device_support.hpp"
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
  log.release(3);
  CHECK(log.size() == 5);
  log.release(100);
  CHECK(log.size() == 0);
  CHECK(log.prepare(at_seconds(30), entries) == 0);
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
