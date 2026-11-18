#pragma once

// Helpers for the test hub's update and key change tests: sealing a device's packets by hand and
// opening the hub's, as a device would, with the codec only.

#include <doctest/doctest.h>

#include <optional>

#include "hsn/host/replay_radio.hpp"
#include "hsn/host/test_hub.hpp"
#include "hsn/protocol/packet.hpp"
#include "hsn/psa/psa_packet_cipher.hpp"
#include "support.hpp"

namespace hsn::test {

/** Seals `message` as the device `address` would, under `key`, with `counter`. */
template <typename Message>
Bytes seal_as_device(const protocol::DeviceKey& key, std::uint32_t address, std::uint32_t counter,
                     const Message& message,
                     protocol::PacketLimit limit = protocol::PacketLimit::radio,
                     const protocol::Binding& binding = protocol::Binding::none()) {
  psa::PsaPacketCipher cipher;
  REQUIRE(cipher.set_key(key) == protocol::Error::none);
  Bytes plaintext(protocol::kMaxLinkPacketSize);
  const auto size = protocol::encode_plaintext(
      message, protocol::MutableByteView(plaintext.data(), plaintext.size()));
  REQUIRE(size.ok());
  Bytes out(protocol::kMaxLinkPacketSize);
  const auto sealed = protocol::seal_packet(
      cipher, protocol::PacketHeader{protocol::Direction::to_hub, address, counter}, binding,
      protocol::ByteView(plaintext.data(), size.value()), limit,
      protocol::MutableByteView(out.data(), out.size()));
  REQUIRE(sealed.ok());
  out.resize(sealed.value());
  return out;
}

/** Opens a packet from the hub under `key` and `binding`, and decodes it as M; empty if not. */
template <typename Message>
std::optional<Message> open_from_hub(const protocol::DeviceKey& key, const Bytes& packet,
                                     const protocol::Binding& binding,
                                     protocol::PacketLimit limit = protocol::PacketLimit::link) {
  psa::PsaPacketCipher cipher;
  REQUIRE(cipher.set_key(key) == protocol::Error::none);
  Bytes plaintext(protocol::kMaxLinkPacketSize);
  const auto opened =
      protocol::open_packet(cipher, view(packet), protocol::Direction::from_hub, binding, limit,
                            protocol::MutableByteView(plaintext.data(), plaintext.size()));
  if (!opened.ok() || opened.value().type != Message::type) {
    return std::nullopt;
  }
  Message message{};
  if (protocol::decode_body(opened.value().body, message) != protocol::Error::none) {
    return std::nullopt;
  }
  return message;
}

/** The site channel's frequency and DR5: where the test hub's radio hears sensors. */
inline device::RadioChannel site_dr5() {
  return device::RadioChannel{868300000u, 5};
}

/** A Started of `version`, with its image fields. */
inline protocol::Started started_of(std::uint8_t role, const protocol::FirmwareVersion& version,
                                    bool on_trial, bool rolled_back,
                                    const protocol::FirmwareVersion& failed = {}) {
  protocol::Started started;
  started.role = role;
  started.firmware_version = version;
  started.reset_cause = 3;
  started.settings_version = 1;
  started.image.present = true;
  started.image.fields.flags.on_trial = on_trial;
  started.image.fields.flags.rolled_back = rolled_back;
  started.image.fields.failed_version = failed;
  return started;
}

}  // namespace hsn::test
