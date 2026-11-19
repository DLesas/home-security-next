#include "hsn/esp/pairing_bitmap.hpp"

#include <algorithm>

namespace hsn::esp {
namespace {

/** 5x7 glyph rows used by the pairing label. */
constexpr std::string_view kCharacters =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-*~$=. abcdefghijklmnopqrstuvwxyz";
constexpr std::uint8_t kGlyphs[][7] = {
    {14, 17, 19, 21, 25, 17, 14}, {4, 12, 4, 4, 4, 4, 14},      {14, 17, 1, 2, 4, 8, 31},
    {30, 1, 1, 14, 1, 1, 30},     {2, 6, 10, 18, 31, 2, 2},     {31, 16, 16, 30, 1, 1, 30},
    {6, 8, 16, 30, 17, 17, 14},   {31, 1, 2, 4, 8, 8, 8},       {14, 17, 17, 14, 17, 17, 14},
    {14, 17, 17, 15, 1, 2, 12},   {14, 17, 17, 31, 17, 17, 17}, {30, 17, 17, 30, 17, 17, 30},
    {14, 17, 16, 16, 16, 17, 14}, {30, 17, 17, 17, 17, 17, 30}, {31, 16, 16, 30, 16, 16, 31},
    {31, 16, 16, 30, 16, 16, 16}, {14, 17, 16, 23, 17, 17, 15}, {17, 17, 17, 31, 17, 17, 17},
    {14, 4, 4, 4, 4, 4, 14},      {7, 2, 2, 2, 18, 18, 12},     {17, 18, 20, 24, 20, 18, 17},
    {16, 16, 16, 16, 16, 16, 31}, {17, 27, 21, 21, 17, 17, 17}, {17, 25, 21, 19, 17, 17, 17},
    {14, 17, 17, 17, 17, 17, 14}, {30, 17, 17, 30, 16, 16, 16}, {14, 17, 17, 17, 21, 18, 13},
    {30, 17, 17, 30, 20, 18, 17}, {15, 16, 16, 14, 1, 1, 30},   {31, 4, 4, 4, 4, 4, 4},
    {17, 17, 17, 17, 17, 17, 14}, {17, 17, 17, 17, 17, 10, 4},  {17, 17, 17, 21, 21, 21, 10},
    {17, 17, 10, 4, 10, 17, 17},  {17, 17, 10, 4, 4, 4, 4},     {31, 1, 2, 4, 8, 16, 31},
    {0, 0, 0, 31, 0, 0, 0},       {0, 21, 14, 31, 14, 21, 0},   {0, 0, 9, 22, 0, 0, 0},
    {4, 15, 20, 14, 5, 30, 4},    {0, 0, 31, 0, 31, 0, 0},      {0, 0, 0, 0, 0, 4, 4},
    {0, 0, 0, 0, 0, 0, 0},        {0, 0, 14, 1, 15, 17, 15},    {16, 16, 30, 17, 17, 17, 30},
    {0, 0, 14, 16, 16, 17, 14},   {1, 1, 15, 17, 17, 17, 15},   {0, 0, 14, 17, 31, 16, 14},
    {6, 9, 8, 28, 8, 8, 8},       {0, 0, 15, 17, 15, 1, 14},    {16, 16, 30, 17, 17, 17, 17},
    {4, 0, 12, 4, 4, 4, 14},      {2, 0, 6, 2, 2, 18, 12},      {16, 16, 18, 20, 24, 20, 18},
    {12, 4, 4, 4, 4, 4, 14},      {0, 0, 26, 21, 21, 21, 21},   {0, 0, 30, 17, 17, 17, 17},
    {0, 0, 14, 17, 17, 17, 14},   {0, 0, 30, 17, 30, 16, 16},   {0, 0, 15, 17, 15, 1, 1},
    {0, 0, 22, 25, 16, 16, 16},   {0, 0, 15, 16, 14, 1, 30},    {8, 8, 28, 8, 8, 9, 6},
    {0, 0, 17, 17, 17, 19, 13},   {0, 0, 17, 17, 17, 10, 4},    {0, 0, 17, 17, 21, 21, 10},
    {0, 0, 17, 10, 4, 10, 17},    {0, 0, 17, 17, 15, 1, 14},    {0, 0, 31, 2, 4, 8, 31},
};
static_assert(std::size(kGlyphs) == kCharacters.size());

/** Fills a small black square in the panel's packed bitmap. */
void square(Bitmap& bitmap, int x, int y, int size) {
  for (int row = y; row < y + size; ++row) {
    for (int col = x; col < x + size; ++col) {
      bitmap[static_cast<std::size_t>(row * (kPanelSide / 8) + col / 8)] &=
          static_cast<std::uint8_t>(~(0x80u >> (col % 8)));
    }
  }
}

/** Draws one centered line in the 5x7 face at an integer pixel scale. */
void line(Bitmap& bitmap, std::string_view text, int y, int scale) {
  int x = (kPanelSide - (static_cast<int>(text.size()) * 6 - 1) * scale) / 2;
  for (char ch : text) {
    const auto glyph = kCharacters.find(ch);
    if (glyph != std::string_view::npos) {
      for (int row = 0; row < 7; ++row) {
        for (int col = 0; col < 5; ++col) {
          if ((kGlyphs[glyph][row] & (16 >> col)) != 0) {
            square(bitmap, x + col * scale, y + row * scale, scale);
          }
        }
      }
    }
    x += 6 * scale;
  }
}

}  // namespace

void pairing_bitmap(const PairCode& code, const ChipId& chip, std::uint8_t role, Bitmap& bitmap) {
  bitmap.fill(0xff);
  Qr qr{};
  if (encode_qr(board_qr(code, chip).data(), qr)) {
    // Four white modules around the QR. The four-pixel interior is centered horizontally.
    for (int y = 0; y < kQrSide; ++y) {
      for (int x = 0; x < kQrSide; ++x) {
        if (qr[static_cast<std::size_t>(y * kQrSide + x)] != 0) {
          square(bitmap, 42 + 4 * x, 16 + 4 * y, 4);
        }
      }
    }
  }
  line(bitmap, display_code(code).data(), 149, 3);
  constexpr std::string_view labels[] = {"Role unset", "Door sensor", "Siren", "Gateway"};
  const auto label = labels[role < std::size(labels) ? role : 0];
  std::array<char, 16> caption{};
  auto* suffix = std::copy(label.begin(), label.end(), caption.begin());
  *suffix++ = ' ';
  constexpr std::string_view hex = "0123456789ABCDEF";
  for (const auto byte : {chip[4], chip[5]}) {
    *suffix++ = hex[byte >> 4];
    *suffix++ = hex[byte & 15];
  }
  line(bitmap, std::string_view(caption.data(), static_cast<std::size_t>(suffix - caption.data())),
       173, 2);
  line(bitmap, "Add it in the app.", 191, 1);
}

}  // namespace hsn::esp
