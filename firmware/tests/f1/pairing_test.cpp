#include <array>
#include <string_view>

#include "doctest/doctest.h"
#include "hsn/esp/pairing_bitmap.hpp"

namespace {
using namespace hsn::esp;
using hsn::device::Instant;
using hsn::device::seconds;

constexpr ChipId kChip{0x3c, 0x71, 0xbf, 0x9a, 0x4f, 0x2a};

struct QrFixture {
  std::uint64_t secret;
  std::string_view code;
  std::string_view text;
  std::string_view matrix;
};

#include "qr_fixtures.hpp"

/** Supplies the five random bytes corresponding to a published 35-bit test secret. */
std::array<std::uint8_t, 5> bytes_of(std::uint64_t secret) {
  return {static_cast<std::uint8_t>(secret >> 32), static_cast<std::uint8_t>(secret >> 24),
          static_cast<std::uint8_t>(secret >> 16), static_cast<std::uint8_t>(secret >> 8),
          static_cast<std::uint8_t>(secret)};
}

/** Reads a black pixel from the MSB-first frame used by SPI. */
bool black(const Bitmap& bitmap, int x, int y) {
  return (bitmap[static_cast<std::size_t>(y * 25 + x / 8)] & (0x80 >> (x % 8))) == 0;
}

TEST_CASE("F1: published Crockford codes, canonical chip and check characters") {
  for (const auto& fixture : kQrFixtures) {
    const auto code = make_code(bytes_of(fixture.secret));
    const bool code_matches = code.data() == fixture.code;
    CHECK(code_matches);
    const bool url_matches = board_qr(code, kChip).data() == fixture.text;
    CHECK(url_matches);
    const auto formatted = display_code(code);
    const std::string_view shown(formatted.data());
    const bool groups_match = shown.size() == 9 && shown[4] == '-' &&
                              shown.substr(0, 4) == fixture.code.substr(0, 4) &&
                              shown.substr(5) == fixture.code.substr(4);
    CHECK(groups_match);

    auto high_bits = bytes_of(fixture.secret);
    high_bits[0] |= 0xf8;
    const bool ignores_extra_entropy = make_code(high_bits) == code;
    CHECK(ignores_extra_entropy);
  }
}

TEST_CASE("F1: the exact app QR matrices including every special check symbol") {
  for (const auto& fixture : kQrFixtures) {
    Qr qr{};
    REQUIRE(encode_qr(fixture.text, qr));
    REQUIRE(fixture.matrix.size() == qr.size());
    for (std::size_t i = 0; i < qr.size(); ++i) {
      CHECK(qr[i] == static_cast<std::uint8_t>(fixture.matrix[i] - '0'));
    }
  }
  Qr unused{};
  CHECK_FALSE(encode_qr("too short", unused));
}

TEST_CASE("F1: all QR pixels and the quiet zone, large code and supporting text") {
  const auto& fixture = kQrFixtures[0];
  const auto code = make_code(bytes_of(fixture.secret));
  Bitmap bitmap{};
  pairing_bitmap(code, kChip, 2, bitmap);
  for (int y = 0; y < 148; ++y) {
    for (int x = 0; x < 200; ++x) {
      const bool inside = x >= 42 && x < 158 && y >= 16 && y < 132;
      const bool expected =
          inside &&
          fixture.matrix[static_cast<std::size_t>((y - 16) / 4 * 29 + (x - 42) / 4)] == '1';
      CHECK(black(bitmap, x, y) == expected);
    }
  }
  // Pixel snapshot of exactly the three label lines, including their spacing.
  std::uint32_t hash = 2166136261u;
  for (std::size_t i = 148 * 25; i < bitmap.size(); ++i) {
    hash = (hash ^ bitmap[i]) * 16777619u;
  }
  CHECK(hash == 0xd6037cf6u);
}

TEST_CASE("F1: exact advertising fields, no service data and each payload within 31 bytes") {
  const auto pair = pair_advert(kChip);
  const auto update = update_advert(0x010a00ff);
  constexpr std::array<std::uint8_t, 21> pair_data{2,    1,    6,    17,   7,    0x8f, 0x0c,
                                                   0x8b, 0x2a, 0xb1, 0xb8, 0x12, 0xba, 0x31,
                                                   0x48, 0x8a, 0x5e, 0x44, 0xaa, 0x50, 0x3b};
  constexpr std::array<std::uint8_t, 21> update_data{2,    1,    6,    17,   7,    0xa4, 0x48,
                                                     0x01, 0x72, 0x34, 0x6c, 0x70, 0x91, 0xe0,
                                                     0x44, 0x53, 0x5d, 0xe5, 0xa7, 0x12, 0x10};
  CHECK(pair.data == pair_data);
  CHECK(update.data == update_data);
  CHECK((pair.response() == std::array<std::uint8_t, 15>{14, 9, 'h', 's', 'n', '-', 'p', 'a', 'i',
                                                         'r', '-', '4', 'f', '2', 'a'}));
  CHECK((update.response() == std::array<std::uint8_t, 15>{13, 9, 'h', 's', 'n', '-', '0', '1', '0',
                                                           'a', '0', '0', 'f', 'f'}));
  CHECK(pair.data.size() <= 31);
  CHECK(update.data.size() <= 31);
  CHECK(pair.name_size + 2 == 15);
  CHECK(update.name_size + 2 == 14);
}

TEST_CASE("F1: the link reports the negotiated payload and carries updates only at MTU 185+") {
  CHECK(update_payload(0) == 0);
  CHECK(update_payload(23) == 20);
  CHECK(update_payload(184) == 181);
  CHECK(update_payload(185) == 182);
  CHECK(update_payload(517) == 514);
  CHECK_FALSE(update_packet_fits(update_payload(184), 1));
  CHECK_FALSE(update_packet_fits(update_payload(185), 0));
  CHECK(update_packet_fits(update_payload(185), 182));
  CHECK_FALSE(update_packet_fits(update_payload(185), 183));
  CHECK(update_packet_fits(update_payload(517), 514));
}

TEST_CASE("F1: a truncated or zero-leading salt is redrawn and an RNG fault fails closed") {
  const char nonzero[] = {1, 2, 3};
  const char zeros[16]{};
  CHECK_FALSE(usable_salt(nonzero, 15));
  CHECK_FALSE(usable_salt(zeros, 16));
  CHECK_FALSE(usable_salt(nullptr, 16));
  CHECK(usable_salt(nonzero, 16));
  int tries = 0;
  CHECK(draw_salt([&tries] { return ++tries < 3 ? 0 : 1; }));
  CHECK(tries == 3);
  tries = 0;
  CHECK_FALSE(draw_salt([&tries] { return ++tries > 0 ? -1 : 0; }));
  CHECK(tries == 1);
  CHECK_FALSE(draw_salt([] { return 0; }));
}

TEST_CASE("F1: a hold opens while down at five seconds, and a reset wins at fifteen") {
  PairButton button;
  const Instant down{1234567};
  CHECK(button.due().is_never());
  button.down(down);
  CHECK(button.up(down + seconds(4)) == HoldAction::short_press);
  CHECK(button.due().is_never());
  button.down(down);
  CHECK(button.tick(down + seconds(5) + hsn::device::microseconds(-1)) == HoldAction::none);
  CHECK(button.tick(down + seconds(5)) == HoldAction::pair);
  CHECK(button.tick(down + seconds(5)) == HoldAction::none);
  CHECK(button.tick(down + seconds(15) + hsn::device::microseconds(-1)) == HoldAction::none);
  CHECK(button.tick(down + seconds(15)) == HoldAction::reset);
  CHECK(button.up(down + seconds(16)) == HoldAction::none);
}

TEST_CASE("F1: two-minute window, connected extension, fifth wrong proof and fresh window") {
  PairWindow window;
  const Instant now{32000000};
  window.open(now);
  CHECK_FALSE(window.expired(now + seconds(120) + hsn::device::microseconds(-1), false));
  CHECK(window.expired(now + seconds(120), false));
  CHECK_FALSE(window.expired(now + seconds(120), true));
  for (unsigned i = 1; i < 5; ++i) {
    CHECK_FALSE(window.mismatch());
    CHECK(window.wrong == i);
  }
  CHECK(window.mismatch());
  CHECK(window.locked());
  CHECK(window.mismatch());
  CHECK(window.wrong == 5);
  window.open(now + seconds(200));
  CHECK_FALSE(window.locked());
  CHECK_FALSE(window.expired(now + seconds(200), false));
}

}  // namespace
