#include "hsn/esp/pairing_logic.hpp"

#include <algorithm>

namespace hsn::esp {
namespace {

/** Common legacy advertising fields: flags and one complete 128-bit UUID. */
Advert advert(const Uuid& uuid, std::string_view prefix, std::string_view suffix) {
  Advert result;
  result.data = {2, 0x01, 0x06, 17, 0x07};
  std::copy(uuid.begin(), uuid.end(), result.data.begin() + 5);
  std::copy(prefix.begin(), prefix.end(), result.name.begin());
  std::copy(suffix.begin(), suffix.end(), result.name.begin() + prefix.size());
  result.name_size = prefix.size() + suffix.size();
  return result;
}

}  // namespace

PairCode make_code(const std::array<std::uint8_t, 5>& random) {
  constexpr std::string_view alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U";
  std::uint64_t value = random[0] & 7u;
  for (std::size_t i = 1; i < random.size(); ++i) {
    value = (value << 8) | random[i];
  }
  PairCode code{};
  code[7] = alphabet[static_cast<std::size_t>(value % 37)];
  for (int i = 6; i >= 0; --i) {
    code[static_cast<std::size_t>(i)] = alphabet[static_cast<std::size_t>(value & 31u)];
    value >>= 5;
  }
  return code;
}

std::array<char, 10> display_code(const PairCode& code) {
  return {code[0], code[1], code[2], code[3], '-', code[4], code[5], code[6], code[7], '\0'};
}

std::array<char, 41> board_qr(const PairCode& code, const ChipId& chip) {
  std::array<char, 41> text{};
  constexpr std::string_view prefix = "hsn://pair/1?c=";
  char* end = std::copy(prefix.begin(), prefix.end(), text.data());
  end = std::copy_n(code.begin(), 7, end);
  const std::string_view check = code[7] == '$'   ? "%24"
                                 : code[7] == '=' ? "%3D"
                                                  : std::string_view(&code[7], 1);
  end = std::copy(check.begin(), check.end(), end);
  *end++ = '&';
  *end++ = 'd';
  *end++ = '=';
  const auto hex = hex_of(chip);
  std::copy(hex.begin(), hex.end(), end);
  return text;
}

std::array<std::uint8_t, 15> Advert::response() const {
  std::array<std::uint8_t, 15> out{};
  out[0] = static_cast<std::uint8_t>(name_size + 1);
  out[1] = 0x09;
  std::copy_n(name.begin(), name_size, out.begin() + 2);
  return out;
}

Advert pair_advert(const ChipId& chip) {
  return advert(kPairUuid, "hsn-pair-", hex_of(std::array{chip[4], chip[5]}).data());
}

Advert update_advert(std::uint32_t address) {
  const auto byte = [address](unsigned shift) {
    return static_cast<std::uint8_t>(address >> shift);
  };
  return advert(kUpdateUuid, "hsn-",
                hex_of(std::array{byte(24), byte(16), byte(8), byte(0)}).data());
}

HoldAction PairButton::up(device::Instant at) {
  const bool short_press = !pressed.is_never() && at < pressed + device::seconds(5);
  pressed = device::Instant::never();
  return short_press ? HoldAction::short_press : HoldAction::none;
}

HoldAction PairButton::tick(device::Instant now) {
  if (now < due()) {
    return HoldAction::none;
  }
  if (now >= pressed + device::seconds(15)) {
    pressed = device::Instant::never();
    return HoldAction::reset;
  }
  signalled = true;
  return HoldAction::pair;
}

}  // namespace hsn::esp
