// Seeded random inputs: decoders and packet opening must never misbehave (the sanitizers catch
// any out-of-bounds access or undefined behaviour), and every single-bit change to a valid packet
// must be rejected.

#include <array>
#include <random>

#include "hsn/protocol/framing.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/packet.hpp"
#include "hsn/protocol/setup.hpp"
#include "hsn/psa/psa_packet_cipher.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using protocol::Direction;
using protocol::Error;
using protocol::MutableByteView;
using protocol::PacketLimit;

constexpr std::uint32_t kSeed = 0x48534E31;  // "HSN1"
constexpr int kRounds = 3000;

Bytes random_bytes(std::mt19937& random, std::size_t max_size) {
  Bytes bytes(random() % (max_size + 1));
  for (std::uint8_t& byte : bytes) {
    byte = static_cast<std::uint8_t>(random());
  }
  return bytes;
}

/** Re-encodes whatever decoded, and checks it decodes to the same fields again. */
struct ReencodeCheck {
  template <typename Message>
  void operator()(const Message& message) const {
    Bytes out(protocol::kMaxLinkPacketSize);
    const auto size = protocol::encode_plaintext(message, MutableByteView(out.data(), out.size()));
    REQUIRE_MESSAGE(size.ok(), error_name(size.error()));
    Message again{};
    REQUIRE(protocol::decode_body(view(out).subspan(1, size.value() - 1), again) == Error::none);
    CHECK(to_json(again) == to_json(message));
  }
};

TEST_CASE("random bytes never break a decoder") {
  std::mt19937 random(kSeed);
  for (int round = 0; round < kRounds; ++round) {
    const Bytes bytes = random_bytes(random, 1100);
    const protocol::ByteView input = view(bytes);

    // Every type byte the protocol knows, and one at random.
    protocol::for_each_type<protocol::Messages>([&](auto tag) {
      using Message = typename decltype(tag)::type;
      static_cast<void>(protocol::decode_message(Message::type, input, ReencodeCheck{}));
    });
    static_cast<void>(
        protocol::decode_message(static_cast<std::uint8_t>(random()), input, ReencodeCheck{}));

    static_cast<void>(protocol::decode_setup(input, [](const auto&) {}));
    if (!bytes.empty()) {
      Bytes setup = bytes;
      setup[0] = protocol::kSetupMarker;
      static_cast<void>(protocol::decode_setup(view(setup), [](const auto&) {}));
    }
    protocol::PairingData pairing{};
    static_cast<void>(protocol::decode_pairing_data(input, pairing));

    Bytes out(protocol::kMaxFrameDataSize);
    static_cast<void>(protocol::cobs_decode(input, MutableByteView(out.data(), out.size())));
    std::array<std::uint8_t, 64> small{};
    protocol::FrameDecoder decoder(small);
    for (const std::uint8_t byte : bytes) {
      const auto event = decoder.push(byte);
      CHECK(event.data.size() <= small.size());
    }

    for (const Direction direction : {Direction::to_hub, Direction::from_hub}) {
      for (const PacketLimit limit : {PacketLimit::radio, PacketLimit::link}) {
        static_cast<void>(protocol::read_header(input, direction, limit));
      }
    }
  }
}

TEST_CASE("random packets with a valid header never open, and never break open_packet") {
  std::mt19937 random(kSeed + 1);
  psa::PsaPacketCipher cipher;
  protocol::DeviceKey key{};
  for (std::uint8_t& byte : key) {
    byte = static_cast<std::uint8_t>(random());
  }
  REQUIRE(cipher.set_key(key) == Error::none);
  Bytes plaintext(protocol::kMaxLinkPacketSize);
  for (int round = 0; round < kRounds; ++round) {
    Bytes packet = random_bytes(random, protocol::kMaxLinkPacketSize);
    if (packet.size() >= protocol::kClearSize && random() % 2 == 0) {
      packet[0] = 0x10;  // so most packets reach the tag check
      packet[1] |= 1;
      packet[5] |= 1;
    }
    const auto opened = protocol::open_packet(cipher, view(packet), Direction::to_hub,
                                              protocol::Binding::none(), PacketLimit::link,
                                              MutableByteView(plaintext.data(), plaintext.size()));
    CHECK_FALSE(opened.ok());
  }
}

TEST_CASE("every single-bit change to a valid packet is rejected") {
  std::mt19937 random(kSeed + 2);
  psa::PsaPacketCipher cipher;
  const protocol::DeviceKey key{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16};
  REQUIRE(cipher.set_key(key) == Error::none);
  const protocol::RandomValue gateway{1, 1, 2, 3, 5, 8, 13, 21};
  const protocol::RandomValue hub{34, 55, 89, 144, 233, 121, 98, 219};
  const std::array<protocol::Binding, 4> bindings{
      protocol::Binding::none(), protocol::Binding::sensor_packet(0xDEADBEEF),
      protocol::Binding::hello(gateway), protocol::Binding::session(gateway, hub)};
  Bytes plaintext(protocol::kMaxLinkPacketSize);
  const MutableByteView plaintext_view(plaintext.data(), plaintext.size());
  int flips = 0;
  for (int round = 0; round < 40; ++round) {
    const Direction direction = round % 2 == 0 ? Direction::to_hub : Direction::from_hub;
    const protocol::Binding& binding = bindings[static_cast<std::size_t>(round) % bindings.size()];
    Bytes message = random_bytes(random, 60);
    message.insert(message.begin(),
                   static_cast<std::uint8_t>(direction == Direction::to_hub ? 0x01 : 0x81));
    const protocol::PacketHeader header{direction,
                                        1 + static_cast<std::uint32_t>(random() % 0xFFFFFFFDu),
                                        1 + static_cast<std::uint32_t>(random() % 0xFFFFFFFEu)};
    Bytes packet(protocol::kMaxRadioPacketSize);
    const auto size =
        protocol::seal_packet(cipher, header, binding, view(message), PacketLimit::radio,
                              MutableByteView(packet.data(), packet.size()));
    REQUIRE(size.ok());
    packet.resize(size.value());
    REQUIRE(protocol::open_packet(cipher, view(packet), direction, binding, PacketLimit::radio,
                                  plaintext_view)
                .ok());
    for (std::size_t bit = 0; bit < 8 * packet.size(); ++bit) {
      Bytes changed = packet;
      changed[bit / 8] = static_cast<std::uint8_t>(changed[bit / 8] ^ (1u << (bit % 8)));
      const auto opened = protocol::open_packet(cipher, view(changed), direction, binding,
                                                PacketLimit::radio, plaintext_view);
      CHECK_FALSE(opened.ok());
      flips += 1;
    }
  }
  CHECK(flips > 10000);
}

TEST_CASE("random data survives framing in random chunks") {
  std::mt19937 random(kSeed + 3);
  std::array<std::uint8_t, protocol::kMaxFrameDataSize> storage{};
  protocol::FrameDecoder decoder(storage);
  Bytes frame(protocol::kMaxEncodedFrameSize + 1);
  for (int round = 0; round < 500; ++round) {
    Bytes data = random_bytes(random, protocol::kMaxFrameDataSize);
    // Runs of zeros and of non-zero bytes reach the block edges more often.
    if (round % 3 == 0) {
      std::fill(data.begin(), data.end(), static_cast<std::uint8_t>(round % 2));
    }
    const auto size =
        protocol::encode_frame(view(data), MutableByteView(frame.data(), frame.size()));
    REQUIRE(size.ok());
    int frames = 0;
    for (std::size_t i = 0; i < size.value(); ++i) {
      const auto event = decoder.push(frame[i]);
      if (event.status == protocol::FrameStatus::frame) {
        frames += 1;
        CHECK(to_hex(event.data) == to_hex(view(data)));
      } else {
        CHECK(event.status == protocol::FrameStatus::pending);
      }
    }
    CHECK(frames == 1);
  }
}

}  // namespace
}  // namespace hsn::test
