#pragma once

#include <array>
#include <cstdint>
#include <string_view>

#include "hsn/esp/pairing_logic.hpp"

namespace hsn::esp {

inline constexpr int kQrSide = 29;
using Qr = std::array<std::uint8_t, kQrSide * kQrSide>;

/** Encodes a version 3-L QR for the board's maximum 40-byte ASCII URL. */
bool encode_qr(std::string_view text, Qr& qr);

inline constexpr int kPanelSide = 200;
using Bitmap = std::array<std::uint8_t, kPanelSide * kPanelSide / 8>;

/** Paints the pairing label in the panel's white=1, leftmost pixel first format. */
void pairing_bitmap(const PairCode& code, const ChipId& chip, std::uint8_t role, Bitmap& bitmap);

}  // namespace hsn::esp
