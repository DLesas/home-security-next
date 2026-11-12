#include <array>

#include "hsn/protocol/bytes.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using protocol::ByteReader;
using protocol::ByteView;
using protocol::ByteWriter;
using protocol::MutableByteView;

TEST_CASE("spans clamp every slice to the view") {
  const std::array<std::uint8_t, 4> bytes{1, 2, 3, 4};
  const ByteView all(bytes);
  CHECK(all.size() == 4);
  CHECK(all.first(2).size() == 2);
  CHECK(all.first(9).size() == 4);
  CHECK(all.subspan(1).size() == 3);
  CHECK(all.subspan(4).empty());
  CHECK(all.subspan(99).empty());
  CHECK(all.subspan(3, 9).size() == 1);
  CHECK(all.subspan(3, 9)[0] == 4);
  CHECK(ByteView(nullptr, 5).empty());
  CHECK(ByteView().empty());
  CHECK(protocol::equal(all.first(2), ByteView(bytes.data(), 2)));
  CHECK_FALSE(protocol::equal(all.first(2), all.subspan(1, 2)));
  CHECK_FALSE(protocol::equal(all, all.first(3)));
}

TEST_CASE("signed conversions are exact for every byte value") {
  for (int value = 0; value < 256; ++value) {
    const auto raw = static_cast<std::uint8_t>(value);
    CHECK(protocol::to_signed(raw) == (value < 128 ? value : value - 256));
  }
  CHECK(protocol::to_signed(std::uint16_t{0x8000}) == -32768);
  CHECK(protocol::to_signed(std::uint16_t{0xFFFF}) == -1);
  CHECK(protocol::to_signed(std::uint16_t{0x7FFF}) == 32767);
}

TEST_CASE("the reader reads little-endian values and never past the end") {
  const std::array<std::uint8_t, 9> bytes{0x01, 0x34, 0x12, 0x78, 0x56, 0x34, 0x12, 0xFE, 0xFF};
  ByteReader reader{ByteView(bytes)};
  std::uint8_t u8 = 0;
  std::uint16_t u16 = 0;
  std::uint32_t u32 = 0;
  std::int16_t i16 = 0;
  REQUIRE(reader.read_u8(u8));
  REQUIRE(reader.read_u16(u16));
  REQUIRE(reader.read_u32(u32));
  CHECK(u8 == 0x01);
  CHECK(u16 == 0x1234);
  CHECK(u32 == 0x12345678);
  CHECK(reader.remaining() == 2);
  // A read that does not fit fails, consumes nothing and leaves the output alone.
  u32 = 7;
  CHECK_FALSE(reader.read_u32(u32));
  CHECK(u32 == 7);
  CHECK(reader.remaining() == 2);
  REQUIRE(reader.read_i16(i16));
  CHECK(i16 == -2);
  CHECK_FALSE(reader.read_u8(u8));
  std::int8_t i8 = 0;
  CHECK_FALSE(reader.read_i8(i8));
  CHECK(reader.read_rest().empty());
}

TEST_CASE("the reader's byte runs are exact") {
  const std::array<std::uint8_t, 5> bytes{1, 2, 3, 4, 5};
  ByteReader reader{ByteView(bytes)};
  std::array<std::uint8_t, 2> copy{};
  REQUIRE(reader.read_bytes(copy));
  CHECK(copy == std::array<std::uint8_t, 2>{1, 2});
  ByteView run;
  CHECK_FALSE(reader.read_view(4, run));
  CHECK(reader.remaining() == 3);
  REQUIRE(reader.read_view(2, run));
  CHECK(run.size() == 2);
  CHECK(run[0] == 3);
  std::array<std::uint8_t, 2> too_many{9, 9};
  CHECK_FALSE(reader.read_bytes(too_many));
  CHECK(too_many == std::array<std::uint8_t, 2>{9, 9});
  CHECK(reader.read_rest().size() == 1);
  CHECK(reader.remaining() == 0);
}

TEST_CASE("the writer writes nothing when a value does not fit") {
  // The writer sees three bytes; the rest of the array is a guard that must stay untouched.
  std::array<std::uint8_t, 8> buffer{};
  buffer.fill(0xEE);
  ByteWriter writer{MutableByteView(buffer.data(), 3)};
  CHECK_FALSE(writer.write_u32(0x01020304));
  CHECK(writer.size() == 0);
  REQUIRE(writer.write_u16(0x0102));
  CHECK_FALSE(writer.write_u16(0x0304));
  CHECK_FALSE(writer.write_i16(-1));
  const std::array<std::uint8_t, 2> pair{7, 8};
  CHECK_FALSE(writer.write_bytes(pair));
  REQUIRE(writer.write_i8(-1));
  CHECK_FALSE(writer.write_u8(1));
  CHECK_FALSE(writer.write_i8(1));
  CHECK(writer.size() == 3);
  CHECK(writer.remaining() == 0);
  CHECK(buffer == std::array<std::uint8_t, 8>{0x02, 0x01, 0xFF, 0xEE, 0xEE, 0xEE, 0xEE, 0xEE});
}

TEST_CASE("the writer's values are little-endian two's complement") {
  std::array<std::uint8_t, 9> buffer{};
  ByteWriter writer{MutableByteView(buffer)};
  REQUIRE(writer.write_u32(0x12345678));
  REQUIRE(writer.write_i16(-2));
  REQUIRE(writer.write_i8(-128));
  const std::array<std::uint8_t, 2> tail{0xAB, 0xCD};
  REQUIRE(writer.write_bytes(tail));
  CHECK(buffer ==
        std::array<std::uint8_t, 9>{0x78, 0x56, 0x34, 0x12, 0xFE, 0xFF, 0x80, 0xAB, 0xCD});
}

}  // namespace
}  // namespace hsn::test
