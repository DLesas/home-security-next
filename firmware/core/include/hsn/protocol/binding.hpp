#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "hsn/protocol/bytes.hpp"

namespace hsn::protocol {

/** Size of a gateway's or hub's random connection value (section 6, hello and welcome). */
constexpr std::size_t kRandomValueSize = 8;

/** Largest binding: the 16-byte session value (section 4). */
constexpr std::size_t kMaxBindingSize = 2 * kRandomValueSize;

/** A random connection value from a hello or a welcome. */
using RandomValue = std::array<std::uint8_t, kRandomValueSize>;

/**
 * Extra authenticated data that both ends know and never send (section 4, "Bindings"). Only the
 * three cases of the spec can be built, so a binding of any other shape cannot exist.
 */
class Binding {
public:
  /**
   * No binding: every packet not listed in section 4's table.
   */
  static constexpr Binding none() {
    return Binding();
  }

  /**
   * A hub packet to a sensor: the counter of the sensor packet it answers, 4 bytes little-endian.
   */
  static constexpr Binding sensor_packet(std::uint32_t counter) {
    Binding binding;
    for (std::size_t i = 0; i < 4; ++i) {
      binding.bytes_[i] = static_cast<std::uint8_t>((counter >> (8 * i)) & 0xFFu);
    }
    binding.size_ = 4;
    return binding;
  }

  /**
   * The hub's welcome: the gateway's random value from its hello.
   */
  static constexpr Binding hello(const RandomValue& gateway_random) {
    Binding binding;
    binding.append(gateway_random);
    return binding;
  }

  /**
   * Every later packet on a gateway connection: gateway random followed by hub random.
   */
  static constexpr Binding session(const RandomValue& gateway_random,
                                   const RandomValue& hub_random) {
    Binding binding;
    binding.append(gateway_random);
    binding.append(hub_random);
    return binding;
  }

  /**
   * Returns the binding's bytes, as appended to the associated data.
   */
  constexpr ByteView view() const {
    return ByteView(bytes_.data(), size_);
  }

private:
  constexpr Binding() = default;

  constexpr void append(const RandomValue& value) {
    for (std::size_t i = 0; i < value.size(); ++i) {
      bytes_[size_ + i] = value[i];
    }
    size_ += value.size();
  }

  std::array<std::uint8_t, kMaxBindingSize> bytes_{};
  std::size_t size_ = 0;
};

}  // namespace hsn::protocol
