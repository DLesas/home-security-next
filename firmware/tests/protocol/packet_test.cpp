#include <array>

#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/packet.hpp"
#include "hsn/psa/psa_packet_cipher.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using protocol::Binding;
using protocol::Direction;
using protocol::Error;
using protocol::MutableByteView;
using protocol::PacketHeader;
using protocol::PacketLimit;

constexpr protocol::DeviceKey kKey{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15};
constexpr std::uint32_t kAddress = 0x1A2B3C4D;

/** A cipher that fails on demand and scribbles over its output first, to test the core's wipes. */
class FailingCipher final : public protocol::PacketCipher {
public:
  explicit FailingCipher(Error error) : error_(error) {}

  Error seal(const protocol::Nonce&, protocol::ByteView, protocol::ByteView,
             MutableByteView sealed) const override {
    scribble(sealed);
    return error_;
  }

  Error open(const protocol::Nonce&, protocol::ByteView, protocol::ByteView,
             MutableByteView plaintext) const override {
    scribble(plaintext);
    return error_;
  }

private:
  static void scribble(MutableByteView bytes) {
    for (std::uint8_t& byte : bytes) {
      byte = 0xAB;
    }
  }

  Error error_;
};

/** A PSA cipher holding `key`. */
class KeyedCipher {
public:
  explicit KeyedCipher(const protocol::DeviceKey& key = kKey) {
    REQUIRE(cipher_.set_key(key) == Error::none);
  }

  operator const protocol::PacketCipher&() const {
    return cipher_;
  }

private:
  psa::PsaPacketCipher cipher_;
};

/** Seals a plaintext of `size` bytes whose type byte is `type`. */
Bytes seal(const protocol::PacketCipher& cipher, const PacketHeader& header, const Binding& binding,
           std::uint8_t type, std::size_t size, PacketLimit limit = PacketLimit::link) {
  Bytes plaintext(size, 0x5A);
  plaintext[0] = type;
  Bytes packet(protocol::kMaxLinkPacketSize);
  const auto sealed = protocol::seal_packet(cipher, header, binding, view(plaintext), limit,
                                            MutableByteView(packet.data(), packet.size()));
  REQUIRE_MESSAGE(sealed.ok(), error_name(sealed.error()));
  packet.resize(sealed.value());
  return packet;
}

const PacketHeader kToHub{Direction::to_hub, kAddress, 7};
const PacketHeader kFromHub{Direction::from_hub, kAddress, 7};

TEST_CASE("the header byte is 0x10 to the hub and 0x18 from the hub") {
  const KeyedCipher cipher;
  CHECK(seal(cipher, kToHub, Binding::none(), protocol::message_type::heartbeat, 8)[0] == 0x10);
  CHECK(seal(cipher, kFromHub, Binding::none(), protocol::message_type::reply, 13)[0] == 0x18);
}

TEST_CASE("read_header checks every clear field") {
  const KeyedCipher cipher;
  Bytes packet = seal(cipher, kToHub, Binding::none(), protocol::message_type::heartbeat, 8);
  const auto header = protocol::read_header(view(packet), Direction::to_hub, PacketLimit::radio);
  REQUIRE(header.ok());
  CHECK(header.value().address == kAddress);
  CHECK(header.value().counter == 7);
  CHECK(protocol::read_header(view(packet), Direction::from_hub, PacketLimit::radio).error() ==
        Error::wrong_direction);
  CHECK(protocol::read_header(view(packet).first(17), Direction::to_hub, PacketLimit::radio)
            .error() == Error::truncated);
  CHECK(protocol::read_header(view(packet).first(18), Direction::to_hub, PacketLimit::radio).ok());
  packet[0] = 0x17;  // low bits are ignored
  CHECK(protocol::read_header(view(packet), Direction::to_hub, PacketLimit::radio).ok());
  packet[0] = 0x00;
  CHECK(protocol::read_header(view(packet), Direction::to_hub, PacketLimit::radio).error() ==
        Error::bad_version);
  const Bytes too_long(256, 0x10);
  CHECK(protocol::read_header(view(too_long), Direction::to_hub, PacketLimit::radio).error() ==
        Error::too_long);
  const Bytes link_sized(1025, 0x10);
  CHECK(protocol::read_header(view(link_sized), Direction::to_hub, PacketLimit::link).error() ==
        Error::too_long);
}

TEST_CASE("seal refuses what no receiver may accept") {
  const KeyedCipher cipher;
  Bytes out(protocol::kMaxLinkPacketSize);
  const MutableByteView out_view(out.data(), out.size());
  const Bytes heartbeat{protocol::message_type::heartbeat, 3, 0, 120, 21, 0, 0, 0};
  const auto seal_with = [&](const PacketHeader& header, const Bytes& plaintext,
                             PacketLimit limit) {
    return protocol::seal_packet(cipher, header, Binding::none(), view(plaintext), limit, out_view)
        .error();
  };
  CHECK(seal_with({Direction::to_hub, 0, 1}, heartbeat, PacketLimit::radio) == Error::bad_address);
  CHECK(seal_with({Direction::to_hub, 0xFFFFFFFFu, 1}, heartbeat, PacketLimit::radio) ==
        Error::bad_address);
  CHECK(seal_with({Direction::to_hub, kAddress, 0}, heartbeat, PacketLimit::radio) ==
        Error::bad_counter);
  CHECK(seal_with(kToHub, Bytes{}, PacketLimit::radio) == Error::truncated);
  CHECK(seal_with(kFromHub, heartbeat, PacketLimit::radio) == Error::wrong_direction);
  Bytes largest(protocol::kMaxRadioPacketSize - protocol::kPacketOverhead, 0);
  largest[0] = protocol::message_type::log_entries;
  CHECK(seal_with(kToHub, largest, PacketLimit::radio) == Error::none);
  largest.push_back(0);
  CHECK(seal_with(kToHub, largest, PacketLimit::radio) == Error::too_long);
  CHECK(seal_with(kToHub, largest, PacketLimit::link) == Error::none);
  const auto small = protocol::seal_packet(cipher, kToHub, Binding::none(), view(heartbeat),
                                           PacketLimit::radio, out_view.first(24));
  CHECK(small.error() == Error::buffer_too_small);
}

TEST_CASE("seal wipes its output when the cipher fails") {
  const FailingCipher failing(Error::cipher_failure);
  Bytes out(64, 0xEE);
  const Bytes heartbeat{protocol::message_type::heartbeat, 3, 0, 120, 21, 0, 0, 0};
  const auto sealed =
      protocol::seal_packet(failing, kToHub, Binding::none(), view(heartbeat), PacketLimit::radio,
                            MutableByteView(out.data(), out.size()));
  CHECK(sealed.error() == Error::cipher_failure);
  for (std::size_t i = 0; i < out.size(); ++i) {
    CHECK(out[i] == (i < heartbeat.size() + protocol::kPacketOverhead ? 0x00 : 0xEE));
  }
}

TEST_CASE("open exposes nothing unless the tag verifies and the type fits the direction") {
  const KeyedCipher cipher;
  Bytes plaintext(64, 0xEE);
  const MutableByteView plaintext_view(plaintext.data(), plaintext.size());

  SUBCASE("wrong key") {
    protocol::DeviceKey other = kKey;
    other[0] ^= 1;
    const Bytes packet = seal(KeyedCipher(other), kToHub, Binding::none(), 0x01, 8);
    CHECK(protocol::open_packet(cipher, view(packet), Direction::to_hub, Binding::none(),
                                PacketLimit::radio, plaintext_view)
              .error() == Error::bad_tag);
    for (std::size_t i = 0; i < 8; ++i) {
      CHECK(plaintext[i] == 0);
    }
  }
  SUBCASE("a from-hub type in a to-hub packet") {
    // This cipher reports success after writing 0xAB, a from-hub type: it stands in for a peer
    // that sealed a reply in the to-hub direction.
    const FailingCipher accepting(Error::none);
    const Bytes packet = seal(cipher, kToHub, Binding::none(), 0x01, 8);
    CHECK(protocol::open_packet(accepting, view(packet), Direction::to_hub, Binding::none(),
                                PacketLimit::radio, plaintext_view)
              .error() == Error::wrong_direction);
    for (std::size_t i = 0; i < 8; ++i) {
      CHECK(plaintext[i] == 0);
    }
  }
  SUBCASE("cipher failure") {
    const FailingCipher failing(Error::cipher_failure);
    const Bytes packet = seal(cipher, kToHub, Binding::none(), 0x01, 8);
    CHECK(protocol::open_packet(failing, view(packet), Direction::to_hub, Binding::none(),
                                PacketLimit::radio, plaintext_view)
              .error() == Error::cipher_failure);
    for (std::size_t i = 0; i < 8; ++i) {
      CHECK(plaintext[i] == 0);
    }
  }
  SUBCASE("plaintext buffer too small") {
    const Bytes packet = seal(cipher, kToHub, Binding::none(), 0x01, 8);
    CHECK(protocol::open_packet(cipher, view(packet), Direction::to_hub, Binding::none(),
                                PacketLimit::radio, plaintext_view.first(7))
              .error() == Error::buffer_too_small);
    CHECK(protocol::open_packet(cipher, view(packet), Direction::to_hub, Binding::none(),
                                PacketLimit::radio, plaintext_view.first(8))
              .ok());
  }
}

TEST_CASE("seal and open refuse overlapping input and output buffers") {
  const KeyedCipher cipher;
  const Bytes packet = seal(cipher, kToHub, Binding::none(), 0x01, 8);

  // Opening in place, or into a buffer that shares one byte with the packet, is refused.
  Bytes buffer(2 * protocol::kMaxLinkPacketSize, 0);
  std::copy(packet.begin(), packet.end(), buffer.begin());
  const protocol::ByteView in_buffer(buffer.data(), packet.size());
  const auto open_into = [&](std::size_t offset, std::size_t size) {
    return protocol::open_packet(cipher, in_buffer, Direction::to_hub, Binding::none(),
                                 PacketLimit::radio, MutableByteView(buffer.data() + offset, size))
        .error();
  };
  CHECK(open_into(0, 64) == Error::overlapping_buffers);
  CHECK(open_into(packet.size() - 1, 64) == Error::overlapping_buffers);
  CHECK(open_into(packet.size(), 64) == Error::none);  // adjacent is fine

  // Sealing from a plaintext inside the output buffer is refused.
  Bytes plaintext_and_out(64, 0);
  plaintext_and_out[40] = protocol::message_type::heartbeat;
  const protocol::ByteView plaintext(plaintext_and_out.data() + 40, 8);
  const auto seal_into = [&](std::size_t size) {
    return protocol::seal_packet(cipher, kToHub, Binding::none(), plaintext, PacketLimit::radio,
                                 MutableByteView(plaintext_and_out.data(), size))
        .error();
  };
  CHECK(seal_into(64) == Error::overlapping_buffers);
  CHECK(seal_into(41) == Error::overlapping_buffers);
  CHECK(seal_into(40) == Error::none);  // adjacent is fine

  CHECK_FALSE(protocol::overlap(protocol::ByteView(), in_buffer));
}

TEST_CASE("each binding authenticates, and only its own value opens the packet") {
  const KeyedCipher cipher;
  const protocol::RandomValue gateway{1, 2, 3, 4, 5, 6, 7, 8};
  const protocol::RandomValue hub{9, 10, 11, 12, 13, 14, 15, 16};
  const std::array<Binding, 4> bindings{Binding::none(), Binding::sensor_packet(0x01020304),
                                        Binding::hello(gateway), Binding::session(gateway, hub)};
  CHECK(to_hex(bindings[1].view()) == "04030201");
  CHECK(to_hex(bindings[3].view()) == "0102030405060708090a0b0c0d0e0f10");
  Bytes plaintext(64);
  for (std::size_t sealed_with = 0; sealed_with < bindings.size(); ++sealed_with) {
    const Bytes packet =
        seal(cipher, kFromHub, bindings[sealed_with], protocol::message_type::reply, 13);
    for (std::size_t opened_with = 0; opened_with < bindings.size(); ++opened_with) {
      const auto opened = protocol::open_packet(
          cipher, view(packet), Direction::from_hub, bindings[opened_with], PacketLimit::radio,
          MutableByteView(plaintext.data(), plaintext.size()));
      CHECK(opened.ok() == (sealed_with == opened_with));
    }
  }
}

TEST_CASE("the PSA cipher refuses to work without a key or with mismatched buffers") {
  psa::PsaPacketCipher cipher;
  const protocol::Nonce nonce{};
  std::array<std::uint8_t, 16> buffer{};
  const std::array<std::uint8_t, 8> plaintext{};
  CHECK(cipher.seal(nonce, {}, plaintext, buffer) == Error::cipher_failure);
  CHECK(cipher.open(nonce, {}, buffer, MutableByteView(buffer.data(), 8)) == Error::cipher_failure);
  REQUIRE(cipher.set_key(kKey) == Error::none);
  CHECK(cipher.seal(nonce, {}, plaintext, MutableByteView(buffer.data(), 15)) ==
        Error::buffer_too_small);
  CHECK(cipher.open(nonce, {}, buffer, MutableByteView(buffer.data(), 9)) ==
        Error::buffer_too_small);
  CHECK(cipher.open(nonce, {}, protocol::ByteView(buffer.data(), 7), MutableByteView()) ==
        Error::buffer_too_small);
  // A second key replaces the first.
  REQUIRE(cipher.set_key(kKey) == Error::none);
  REQUIRE(cipher.seal(nonce, {}, plaintext, buffer) == Error::none);
  std::array<std::uint8_t, 8> opened{};
  CHECK(cipher.open(nonce, {}, buffer, opened) == Error::none);
  CHECK(opened == plaintext);
}

}  // namespace
}  // namespace hsn::test
