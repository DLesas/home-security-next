// Record<T>::load against the rule of m3-updates-design.md section 2 (D134): a stored record
// changes format only by adding fields at its end, and every image reads the fields it knows. After
// a rollback an older image reads a newer, longer record; a newer image reads an older, shorter
// one. Everything else about a record stays as it was: the version byte, a missing record, a fault,
// the write only on change.

#include <doctest/doctest.h>

#include <array>
#include <cstdint>
#include <vector>

#include "hsn/device/services/record.hpp"
#include "hsn/host/fake_clock.hpp"
#include "hsn/host/fake_storage.hpp"

namespace hsn::test {
namespace {

using device::HalError;
using device::StoreKey;
using Bytes = std::vector<std::uint8_t>;

constexpr StoreKey kKey = StoreKey::sensor_first;
constexpr std::uint8_t kVersion = 3;

/** The record as an older image knows it. */
struct Old {
  std::uint8_t a = 1;
  std::uint8_t b = 2;
  std::uint16_t c = 0x0303;
};

/** The same record after a newer image added two fields at its end. */
struct New {
  std::uint8_t a = 1;
  std::uint8_t b = 2;
  std::uint16_t c = 0x0303;
  std::uint8_t d = 4;
  std::uint8_t e = 5;
};

struct Store {
  host::FakeClock clock;
  host::FakeStorage storage{clock};
};

TEST_CASE("a record of exactly the type's size loads as before") {
  Store s;
  s.storage.records[kKey] = Bytes{kVersion, 10, 20, 0x34, 0x12};
  device::Record<Old> record(s.storage, kKey, kVersion, Old{});
  CHECK(record.load() == HalError::none);
  CHECK(record.stored());
  CHECK(record.get().a == 10);
  CHECK(record.get().b == 20);
  CHECK(record.get().c == 0x1234);
}

TEST_CASE("an older image reads a newer, longer record: the fields it knows, the rest ignored") {
  Store s;
  device::Record<New> newer(s.storage, kKey, kVersion, New{});
  REQUIRE(newer.update(New{10, 20, 0x1234, 40, 50}) == HalError::none);
  REQUIRE(s.storage.records[kKey].size() == 1 + sizeof(New));

  device::Record<Old> older(s.storage, kKey, kVersion, Old{});
  CHECK(older.load() == HalError::none);
  CHECK(older.stored());
  CHECK(older.get().a == 10);
  CHECK(older.get().b == 20);
  CHECK(older.get().c == 0x1234);
  // Reading wrote nothing; the newer bytes are still there.
  CHECK(s.storage.records[kKey].size() == 1 + sizeof(New));
  // The same value again writes nothing: it is what is stored, as far as this image knows.
  CHECK(older.update(Old{10, 20, 0x1234}) == HalError::none);
  CHECK(s.storage.write_count(kKey) == 1);
  // A change writes this image's whole struct, at its own length.
  CHECK(older.update(Old{11, 20, 0x1234}) == HalError::none);
  CHECK(s.storage.records[kKey] == Bytes{kVersion, 11, 20, 0x34, 0x12});
}

TEST_CASE("the longest record storage allows still loads") {
  Store s;
  Bytes longest(device::kMaxRecordSize, 0xAB);
  longest[0] = kVersion;
  longest[1] = 7;
  s.storage.records[kKey] = longest;
  device::Record<Old> record(s.storage, kKey, kVersion, Old{});
  CHECK(record.load() == HalError::none);
  CHECK(record.get().a == 7);
  CHECK(record.get().b == 0xAB);
  CHECK(record.get().c == 0xABAB);
}

TEST_CASE(
    "a newer image reads an older, shorter record: the fields it holds, the rest as fallback") {
  Store s;
  device::Record<Old> older(s.storage, kKey, kVersion, Old{});
  REQUIRE(older.update(Old{10, 20, 0x1234}) == HalError::none);

  device::Record<New> newer(s.storage, kKey, kVersion, New{0, 0, 0, 44, 55});
  CHECK(newer.load() == HalError::none);
  CHECK(newer.stored());
  CHECK(newer.get().a == 10);
  CHECK(newer.get().b == 20);
  CHECK(newer.get().c == 0x1234);
  CHECK(newer.get().d == 44);
  CHECK(newer.get().e == 55);
  // A change writes the newer, longer record.
  CHECK(newer.update(New{10, 20, 0x1234, 44, 56}) == HalError::none);
  CHECK(s.storage.records[kKey] == Bytes{kVersion, 10, 20, 0x34, 0x12, 44, 56});
}

TEST_CASE("one byte short or one byte long loads too; a field cut in the middle keeps its start") {
  Store s;
  s.storage.records[kKey] = Bytes{kVersion, 10, 20, 0x34};
  device::Record<Old> shorter(s.storage, kKey, kVersion, Old{});
  CHECK(shorter.load() == HalError::none);
  CHECK(shorter.get().a == 10);
  CHECK(shorter.get().b == 20);
  CHECK(shorter.get().c == 0x0334);  // its low byte stored, its high byte the fallback's

  s.storage.records[kKey] = Bytes{kVersion, 10, 20, 0x34, 0x12, 99};
  device::Record<Old> longer(s.storage, kKey, kVersion, Old{});
  CHECK(longer.load() == HalError::none);
  CHECK(longer.get().c == 0x1234);
}

TEST_CASE("a record holding only its version byte gives every field at the fallback") {
  Store s;
  s.storage.records[kKey] = Bytes{kVersion};
  device::Record<Old> record(s.storage, kKey, kVersion, Old{7, 8, 9});
  CHECK(record.load() == HalError::none);
  CHECK(record.stored());
  CHECK(record.get().a == 7);
  CHECK(record.get().b == 8);
  CHECK(record.get().c == 9);
}

TEST_CASE("unchanged: another version, an empty record, a missing one, a fault give the fallback") {
  Store s;
  const Old fallback{7, 8, 9};

  s.storage.records[kKey] = Bytes{kVersion + 1, 10, 20, 0x34, 0x12};
  device::Record<Old> other(s.storage, kKey, kVersion, fallback);
  CHECK(other.load() == HalError::invalid);
  CHECK_FALSE(other.stored());
  CHECK(other.get().a == 7);
  // A longer one of another version too.
  s.storage.records[kKey] = Bytes{kVersion + 1, 10, 20, 0x34, 0x12, 1, 2, 3};
  CHECK(other.load() == HalError::invalid);
  CHECK(other.get().a == 7);

  s.storage.records[kKey] = Bytes{};
  device::Record<Old> empty(s.storage, kKey, kVersion, fallback);
  CHECK(empty.load() == HalError::invalid);
  CHECK_FALSE(empty.stored());
  CHECK(empty.get().c == 9);

  s.storage.records.erase(kKey);
  device::Record<Old> missing(s.storage, kKey, kVersion, fallback);
  CHECK(missing.load() == HalError::not_found);
  CHECK_FALSE(missing.stored());
  CHECK(missing.get().b == 8);

  s.storage.records[kKey] = Bytes{kVersion, 10, 20, 0x34, 0x12};
  s.storage.fail_reads = true;
  device::Record<Old> faulty(s.storage, kKey, kVersion, fallback);
  CHECK(faulty.load() == HalError::io);
  CHECK_FALSE(faulty.stored());
  CHECK(faulty.get().a == 7);

  // A load that fails after one that worked goes back to the fallback.
  s.storage.fail_reads = false;
  device::Record<Old> again(s.storage, kKey, kVersion, fallback);
  REQUIRE(again.load() == HalError::none);
  CHECK(again.get().a == 10);
  s.storage.records.erase(kKey);
  CHECK(again.load() == HalError::not_found);
  CHECK_FALSE(again.stored());
  CHECK(again.get().a == 7);
}

TEST_CASE("read_record copies only what is stored, and nothing on a failure") {
  Store s;
  std::array<std::uint8_t, 4> out{0xEE, 0xEE, 0xEE, 0xEE};
  CHECK(device::read_record(s.storage, kKey, kVersion, protocol::MutableByteView(out)) ==
        HalError::not_found);
  CHECK(out == std::array<std::uint8_t, 4>{0xEE, 0xEE, 0xEE, 0xEE});
  s.storage.records[kKey] = Bytes{kVersion + 1, 1, 2};
  CHECK(device::read_record(s.storage, kKey, kVersion, protocol::MutableByteView(out)) ==
        HalError::invalid);
  CHECK(out == std::array<std::uint8_t, 4>{0xEE, 0xEE, 0xEE, 0xEE});
  s.storage.records[kKey] = Bytes{kVersion, 1, 2};
  CHECK(device::read_record(s.storage, kKey, kVersion, protocol::MutableByteView(out)) ==
        HalError::none);
  CHECK(out == std::array<std::uint8_t, 4>{1, 2, 0xEE, 0xEE});
  s.storage.records[kKey] = Bytes{kVersion, 1, 2, 3, 4, 5, 6};
  CHECK(device::read_record(s.storage, kKey, kVersion, protocol::MutableByteView(out)) ==
        HalError::none);
  CHECK(out == std::array<std::uint8_t, 4>{1, 2, 3, 4});
}

}  // namespace
}  // namespace hsn::test
