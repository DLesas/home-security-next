#include "hsn/esp/pairing_bitmap.hpp"

#include <algorithm>
#include <cstdlib>

namespace hsn::esp {
namespace {

constexpr std::size_t kData = 55;
constexpr std::size_t kEcc = 15;
constexpr int kSide = kQrSide;

/** QR's GF(256) multiply, reduced modulo x^8+x^4+x^3+x^2+1. */
constexpr unsigned multiply(unsigned a, unsigned b) {
  unsigned product = 0;
  while (b != 0) {
    if ((b & 1u) != 0) {
      product ^= a;
    }
    a <<= 1;
    if ((a & 256u) != 0) {
      a ^= 0x11d;
    }
    b >>= 1;
  }
  return product;
}

/** Coefficients for the single version 3-L Reed–Solomon block. */
constexpr auto generator() {
  std::array<unsigned, kEcc + 1> polynomial{1};
  unsigned root = 1;
  for (std::size_t i = 1; i <= kEcc; ++i) {
    for (std::size_t j = i; j > 0; --j) {
      polynomial[j] ^= multiply(polynomial[j - 1], root);
    }
    root = multiply(root, 2);
  }
  return polynomial;
}

/** Builds byte-mode codewords and appends the Reed–Solomon remainder. */
auto codewords(std::string_view text) {
  std::array<unsigned, kData + kEcc> bytes{};
  unsigned nibble = static_cast<unsigned>(text.size()) & 15u;
  bytes[0] = 0x40 | (static_cast<unsigned>(text.size()) >> 4);
  std::size_t pos = 1;
  for (const char character : text) {
    const auto ch = static_cast<unsigned char>(character);
    bytes[pos++] = (nibble << 4) | (ch >> 4);
    nibble = ch & 15u;
  }
  bytes[pos++] = nibble << 4;
  for (unsigned pad = 0xec; pos < kData; pad ^= 0xec ^ 0x11) {
    bytes[pos++] = pad;
  }
  constexpr auto polynomial = generator();
  auto remainder = bytes;
  for (std::size_t i = 0; i < kData; ++i) {
    const unsigned factor = remainder[i];
    for (std::size_t j = 1; j <= kEcc; ++j) {
      remainder[i + j] ^= multiply(polynomial[j], factor);
    }
  }
  std::copy(remainder.begin() + kData, remainder.end(), bytes.begin() + kData);
  return bytes;
}

/** Indexes modules left to right and top to bottom. */
std::size_t index(int x, int y) {
  return static_cast<std::size_t>(y * kSide + x);
}

/** Places the fixed patterns and reserves their modules from data and masks. */
void patterns(Qr& qr, Qr& fixed) {
  const auto mark = [&](int x, int y, bool dark) {
    qr[index(x, y)] = dark;
    fixed[index(x, y)] = 1;
  };
  for (const auto& xy :
       {std::array{3, 3}, std::array{kSide - 4, 3}, std::array{3, kSide - 4}, std::array{22, 22}}) {
    const int radius = xy[0] == 22 ? 2 : 4;
    for (int dy = -radius; dy <= radius; ++dy) {
      for (int dx = -radius; dx <= radius; ++dx) {
        const int x = xy[0] + dx;
        const int y = xy[1] + dy;
        const int distance = std::max(std::abs(dx), std::abs(dy));
        if (x >= 0 && y >= 0 && x < kSide && y < kSide) {
          mark(x, y, radius == 2 ? distance != 1 : distance != 2 && distance != 4);
        }
      }
    }
  }
  for (int i = 8; i < kSide - 8; ++i) {
    mark(i, 6, i % 2 == 0);
    mark(6, i, i % 2 == 0);
  }
  for (int i = 0; i < 8; ++i) {
    fixed[index(8, i)] = fixed[index(i, 8)] = 1;
    fixed[index(kSide - 8 + i, 8)] = fixed[index(8, kSide - 8 + i)] = 1;
  }
  fixed[index(8, 8)] = 1;
}

/** Answers whether the QR mask flips the data module at (x, y). */
bool masked(int mask, int x, int y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 == 0;
    case 1:
      return y % 2 == 0;
    case 2:
      return x % 3 == 0;
    case 3:
      return (x + y) % 3 == 0;
    case 4:
      return (x / 3 + y / 2) % 2 == 0;
    case 5:
      return x * y % 2 + x * y % 3 == 0;
    case 6:
      return (x * y % 2 + x * y % 3) % 2 == 0;
    default:
      return ((x + y) % 2 + x * y % 3) % 2 == 0;
  }
}

/** Changes only data and remainder modules; applying the same mask twice undoes it. */
void mask_data(Qr& qr, const Qr& fixed, int mask) {
  for (int y = 0; y < kSide; ++y) {
    for (int x = 0; x < kSide; ++x) {
      const auto i = index(x, y);
      qr[i] ^= static_cast<std::uint8_t>(fixed[i] == 0 && masked(mask, x, y));
    }
  }
}

/** Scores runs, finder-like sequences, 2x2 blocks and dark balance as the app does. */
int penalty(const Qr& qr) {
  int score = 0;
  int dark = 0;
  for (int i = 0; i < kSide; ++i) {
    for (bool column : {false, true}) {
      int run = 0;
      int previous = -1;
      int bits = 0;
      for (int j = 0; j < kSide; ++j) {
        const int value = qr[column ? index(i, j) : index(j, i)];
        run = value == previous ? run + 1 : 1;
        score += run == 5 ? 3 : run > 5 ? 1 : 0;
        previous = value;
        bits = ((bits << 1) | value) & 2047;
        if (j >= 10 && (bits == 0b10111010000 || bits == 0b00001011101)) {
          score += 40;
        }
        if (!column) {
          dark += value;
          if (i > 0 && j > 0 && qr[index(j - 1, i)] == value && qr[index(j, i - 1)] == value &&
              qr[index(j - 1, i - 1)] == value) {
            score += 3;
          }
        }
      }
    }
  }
  return score + 10 * (10 * std::abs(2 * dark - kSide * kSide) / (kSide * kSide));
}

/** Writes both copies of the BCH-protected format bits, with level L and the winning mask. */
void format(Qr& qr, int mask) {
  const int data = (8 | mask) << 10;
  int remainder = data;
  for (int i = 4; i >= 0; --i) {
    if ((remainder & (1 << (10 + i))) != 0) {
      remainder ^= 0x537 << i;
    }
  }
  const int bits = (data | remainder) ^ 0x5412;
  for (int i = 0; i < 15; ++i) {
    const auto value = static_cast<std::uint8_t>((bits >> i) & 1);
    if (i < 8) {
      qr[index(8, i < 6 ? i : i + 1)] = value;
      qr[index(kSide - 1 - i, 8)] = value;
    } else {
      qr[index(i == 8 ? 7 : 14 - i, 8)] = value;
      qr[index(8, kSide - 15 + i)] = value;
    }
  }
  qr[index(8, kSide - 8)] = 1;
}

}  // namespace

bool encode_qr(std::string_view text, Qr& qr) {
  if (text.size() < 38 || text.size() > 40) {
    return false;
  }
  qr.fill(0);
  Qr fixed{};
  patterns(qr, fixed);
  const auto data = codewords(text);
  std::size_t bit = 0;
  bool upwards = true;
  for (int right = kSide - 1; right > 0; right -= 2) {
    if (right == 6) {
      --right;
    }
    for (int row = 0; row < kSide; ++row) {
      const int y = upwards ? kSide - 1 - row : row;
      for (int x : {right, right - 1}) {
        const auto i = index(x, y);
        if (!fixed[i] && bit < 8 * data.size()) {
          qr[i] = static_cast<std::uint8_t>((data[bit / 8] >> (7 - bit % 8)) & 1u);
          ++bit;
        }
      }
    }
    upwards = !upwards;
  }
  int best = 0;
  int lowest = 0;
  for (int mask = 0; mask < 8; ++mask) {
    mask_data(qr, fixed, mask);
    const int score = penalty(qr);
    if (mask == 0 || score < lowest) {
      best = mask;
      lowest = score;
    }
    mask_data(qr, fixed, mask);
  }
  mask_data(qr, fixed, best);
  format(qr, best);
  return true;
}

}  // namespace hsn::esp
