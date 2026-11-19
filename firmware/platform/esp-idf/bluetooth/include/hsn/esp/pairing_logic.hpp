#pragma once

#include <array>
#include <cstdint>
#include <string_view>

#include "hsn/device/time.hpp"

namespace hsn::esp {

using ChipId = std::array<std::uint8_t, 6>;
using PairCode = std::array<char, 9>;
using Uuid = std::array<std::uint8_t, 16>;

inline constexpr Uuid kPairUuid{0x8f, 0x0c, 0x8b, 0x2a, 0xb1, 0xb8, 0x12, 0xba,
                                0x31, 0x48, 0x8a, 0x5e, 0x44, 0xaa, 0x50, 0x3b};
inline constexpr Uuid kUpdateUuid{0xa4, 0x48, 0x01, 0x72, 0x34, 0x6c, 0x70, 0x91,
                                  0xe0, 0x44, 0x53, 0x5d, 0xe5, 0xa7, 0x12, 0x10};
inline constexpr std::uint16_t kMinUpdateMtu = 185;
inline constexpr int kSaltBytes = 16;

/** Converts binary to lowercase hex, in wire order, and terminates the string. */
template <std::size_t N>
std::array<char, 2 * N + 1> hex_of(const std::array<std::uint8_t, N>& bytes) {
  constexpr std::string_view hex = "0123456789abcdef";
  std::array<char, 2 * N + 1> text{};
  for (std::size_t i = 0; i < N; ++i) {
    text[2 * i] = hex[bytes[i] >> 4];
    text[2 * i + 1] = hex[bytes[i] & 15];
  }
  return text;
}

/** Makes seven unbiased Crockford digits and their mod-37 check character. */
PairCode make_code(const std::array<std::uint8_t, 5>& random);
/** Groups a valid code into two groups of four for the panel. */
std::array<char, 10> display_code(const PairCode& code);
/** Encodes the board's canonical pairing URL including its chip ID. */
std::array<char, 41> board_qr(const PairCode& code, const ChipId& chip);

struct Advert {
  std::array<std::uint8_t, 21> data{};
  // Complete Local Name is 13 bytes for pairing and 12 for updates.
  std::array<char, 14> name{};
  std::size_t name_size = 0;

  /** Appends the Complete Local Name AD structure to a scan response. */
  std::array<std::uint8_t, 15> response() const;
};

/** The pairing UUID and last two chip-ID bytes identify the board while pairing. */
Advert pair_advert(const ChipId& chip);
/** The update UUID and device address identify the board during an update. */
Advert update_advert(std::uint32_t address);

/** Converts an agreed MTU to the payload published in a subscribed update link. */
inline constexpr std::uint16_t update_payload(std::uint16_t mtu) {
  return mtu >= 23 ? static_cast<std::uint16_t>(mtu - 3) : 0;
}

/** Applies the ruling's floor and the exact one-frame ATT ceiling to both directions. */
inline constexpr bool update_packet_fits(std::uint16_t payload, std::size_t size) {
  return payload >= update_payload(kMinUpdateMtu) && size > 0 && size <= payload;
}

/** The SRP generator drops leading zeroes when it serializes the salt's MPI. */
inline bool usable_salt(const char* salt, int actual_size) {
  return salt != nullptr && actual_size == kSaltBytes && salt[0] != 0;
}

/** Retries only truncated salts, with a bound for a faulting random source. */
template <typename Draw>
bool draw_salt(Draw draw) {
  for (int i = 0; i < 8; ++i) {
    const int result = draw();
    if (result != 0) {
      return result > 0;
    }
  }
  return false;
}

struct PairWindow {
  device::Instant end = device::Instant::never();
  unsigned wrong = 0;

  /** Opens a fresh two-minute window. */
  void open(device::Instant now) {
    end = now + device::seconds(120);
    wrong = 0;
  }

  /** Counts a bad proof and returns true at the cutoff. */
  bool mismatch() {
    if (!locked()) {
      ++wrong;
    }
    return locked();
  }

  /** Blocks all further proofs once five have failed. */
  bool locked() const {
    return wrong >= 5;
  }

  /** A connection keeps the window alive until it disconnects. */
  bool expired(device::Instant now, bool connected) const {
    return !connected && now >= end;
  }
};

enum class HoldAction { none, short_press, pair, reset };

struct PairButton {
  device::Instant pressed = device::Instant::never();
  bool signalled = false;

  /** Dates the debounced down edge; a held button can also have woken the board. */
  void down(device::Instant at) {
    pressed = at;
    signalled = false;
  }

  /** Reports a short press on release, and disarms both hold deadlines. */
  HoldAction up(device::Instant at);

  /** Provides the next threshold while held. */
  device::Instant due() const {
    return pressed + device::seconds(signalled ? 15 : 5);
  }

  /** Handles thresholds while the button is down, without waiting for a release. */
  HoldAction tick(device::Instant now);
};

}  // namespace hsn::esp
