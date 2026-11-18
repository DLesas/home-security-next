// The update crypto fake and the key import (m3-updates-design.md sections 3, 5 and 7) against the
// vectors: SHA-256, P-256 verification of image headers, the Bluetooth session key and Open tag,
// and the key the board's cipher and session key use after an import.

#include <doctest/doctest.h>

#include <array>
#include <filesystem>

#include "hsn/host/fake_update.hpp"
#include "hsn/host/host_board.hpp"
#include "hsn/host/test_image.hpp"
#include "hsn/protocol/packet.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using device::HalError;

json vectors(const char* name) {
  return load_json(std::filesystem::path(HSN_VECTORS_DIR) / name);
}

protocol::DeviceKey key_of(const std::string& hex) {
  const Bytes bytes = from_hex(hex);
  protocol::DeviceKey key{};
  REQUIRE(bytes.size() == key.size());
  std::copy(bytes.begin(), bytes.end(), key.begin());
  return key;
}

Bytes sha(host::FakeUpdateCrypto& crypto, const Bytes& bytes, std::size_t pieces) {
  REQUIRE(crypto.sha256_start() == HalError::none);
  const std::size_t step = pieces == 0 ? bytes.size() : (bytes.size() + pieces - 1) / pieces;
  for (std::size_t at = 0; at < bytes.size(); at += step) {
    const std::size_t length = std::min(step, bytes.size() - at);
    REQUIRE(crypto.sha256_add(protocol::ByteView(bytes.data() + at, length)) == HalError::none);
  }
  Bytes digest(32);
  REQUIRE(crypto.sha256_finish(protocol::MutableByteView(digest.data(), digest.size())) ==
          HalError::none);
  return digest;
}

TEST_CASE("SHA-256 in pieces equals the known digests") {
  host::HostBoard board;
  host::FakeUpdateCrypto& crypto = board.update_crypto;
  const Bytes abc{'a', 'b', 'c'};
  CHECK(to_hex(view(sha(crypto, abc, 1))) ==
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  CHECK(to_hex(view(sha(crypto, Bytes{}, 0))) ==
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const Bytes image = host::make_test_image(protocol::FirmwareVersion{1, 0, 0}, 9000);
  const protocol::Sha256Digest whole = host::sha256_of(view(image));
  CHECK(sha(crypto, image, 9) == Bytes(whole.begin(), whole.end()));
  // A new start discards the one under way.
  REQUIRE(crypto.sha256_start() == HalError::none);
  REQUIRE(crypto.sha256_add(view(image)) == HalError::none);
  CHECK(sha(crypto, abc, 1) ==
        from_hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
}

TEST_CASE("SHA-256 refuses adding or finishing with none started, and a digest of the wrong size") {
  host::HostBoard board;
  host::FakeUpdateCrypto& crypto = board.update_crypto;
  const Bytes abc{'a', 'b', 'c'};
  CHECK(crypto.sha256_add(view(abc)) == HalError::invalid);
  std::array<std::uint8_t, 32> digest{};
  digest.fill(0xAA);
  CHECK(crypto.sha256_finish(protocol::MutableByteView(digest)) == HalError::invalid);
  CHECK(digest == std::array<std::uint8_t, 32>{});
  REQUIRE(crypto.sha256_start() == HalError::none);
  std::array<std::uint8_t, 31> small{};
  CHECK(crypto.sha256_finish(protocol::MutableByteView(small)) == HalError::invalid);
  // A finish ends the hash: adding after it is refused.
  REQUIRE(crypto.sha256_start() == HalError::none);
  REQUIRE(crypto.sha256_finish(protocol::MutableByteView(digest)) == HalError::none);
  CHECK(crypto.sha256_add(view(abc)) == HalError::invalid);
}

TEST_CASE("P-256 verification passes the vectors' headers and fails every change") {
  const json file = vectors("image-header.json");
  const Bytes public_key = from_hex(file.at("signingKey").get<std::string>());
  host::HostBoard board;
  host::FakeUpdateCrypto& crypto = board.update_crypto;
  for (const json& valid : file.at("valid")) {
    CAPTURE(valid.at("name").get<std::string>());
    const Bytes digest = from_hex(valid.at("signedSha256").get<std::string>());
    const Bytes signature = from_hex(valid.at("signature").get<std::string>());
    CHECK(crypto.verify_p256(view(public_key), view(digest), view(signature)));
    for (const std::size_t at :
         {std::size_t{0}, std::size_t{31}, std::size_t{32}, std::size_t{63}}) {
      Bytes broken = signature;
      broken[at] ^= 0x01;
      CHECK_FALSE(crypto.verify_p256(view(public_key), view(digest), view(broken)));
    }
    Bytes other_digest = digest;
    other_digest[5] ^= 0x01;
    CHECK_FALSE(crypto.verify_p256(view(public_key), view(other_digest), view(signature)));
    Bytes other_key = public_key;
    other_key[10] ^= 0x01;  // not even a point on the curve
    CHECK_FALSE(crypto.verify_p256(view(other_key), view(digest), view(signature)));
    // Wrong sizes: the key with its 0x04, a short digest, a DER signature's length.
    Bytes prefixed{0x04};
    prefixed.insert(prefixed.end(), public_key.begin(), public_key.end());
    CHECK_FALSE(crypto.verify_p256(view(prefixed), view(digest), view(signature)));
    CHECK_FALSE(crypto.verify_p256(view(public_key), protocol::ByteView(digest.data(), 31),
                                   view(signature)));
    CHECK_FALSE(crypto.verify_p256(view(public_key), view(digest),
                                   protocol::ByteView(signature.data(), 63)));
  }
  // A signature by another key does not verify under this one.
  const host::HubSigningKey other(host::SigningScalar{1,  2,  3,  4,  5,  6,  7,  8,  9,  10, 11,
                                                      12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
                                                      23, 24, 25, 26, 27, 28, 29, 30, 31, 32});
  const Bytes digest = from_hex(file.at("valid")[0].at("signedSha256").get<std::string>());
  protocol::Sha256Digest fixed{};
  std::copy(digest.begin(), digest.end(), fixed.begin());
  const protocol::ImageSignature signature = other.sign_digest(fixed);
  CHECK(crypto.verify_p256(protocol::ByteView(other.public_key()), view(digest),
                           protocol::ByteView(signature)));
  CHECK_FALSE(crypto.verify_p256(view(public_key), view(digest), protocol::ByteView(signature)));
  CHECK(crypto.verifications > crypto.verified);
}

TEST_CASE("the session key derives from the key the board holds, as the vectors say") {
  const json file = vectors("ble-update-session.json");
  for (const json& item : file.at("sessionKeys")) {
    CAPTURE(item.at("name").get<std::string>());
    host::HostBoard board;
    host::FakeUpdateCrypto& crypto = board.update_crypto;
    const Bytes nonce = from_hex(item.at("nonce").get<std::string>());
    const auto address = item.at("address").get<std::uint32_t>();
    std::array<std::uint8_t, 32> out{};
    // No key held yet: no session key.
    CHECK(crypto.session_key(view(nonce), address, protocol::MutableByteView(out)) ==
          HalError::invalid);
    board.set_key(key_of(item.at("deviceKey").get<std::string>()));
    REQUIRE(crypto.session_key(view(nonce), address, protocol::MutableByteView(out)) ==
            HalError::none);
    CHECK(to_hex(protocol::ByteView(out)) == item.at("sessionKey").get<std::string>());
    // The hub's and the phone's side gives the same.
    const host::SessionKey hub_side = host::derive_session_key(
        key_of(item.at("deviceKey").get<std::string>()), view(nonce), address);
    CHECK(hub_side == out);
    // Another address or nonce gives another key.
    std::array<std::uint8_t, 32> moved{};
    REQUIRE(crypto.session_key(view(nonce), address + 1, protocol::MutableByteView(moved)) ==
            HalError::none);
    CHECK(moved != out);
    std::array<std::uint8_t, 31> small{};
    CHECK(crypto.session_key(view(nonce), address, protocol::MutableByteView(small)) ==
          HalError::invalid);
  }
}

TEST_CASE("the Open tag is the HMAC's first 16 bytes, as the vectors say") {
  const json file = vectors("ble-update-session.json");
  host::HostBoard board;
  host::FakeUpdateCrypto& crypto = board.update_crypto;
  for (const json& item : file.at("openTags")) {
    CAPTURE(item.at("name").get<std::string>());
    const Bytes key_bytes = from_hex(item.at("sessionKey").get<std::string>());
    host::SessionKey session{};
    std::copy(key_bytes.begin(), key_bytes.end(), session.begin());
    const auto address = item.at("address").get<std::uint32_t>();
    const Bytes random_bytes = from_hex(item.at("deviceRandom").get<std::string>());
    const Bytes image_bytes = from_hex(item.at("imageId").get<std::string>());
    protocol::DeviceRandom random{};
    protocol::ImageId image{};
    std::copy(random_bytes.begin(), random_bytes.end(), random.begin());
    std::copy(image_bytes.begin(), image_bytes.end(), image.begin());
    const protocol::SessionTag tag = host::open_tag(session, address, random, image);
    CHECK(to_hex(protocol::ByteView(tag)) == item.at("tag").get<std::string>());
    // The device's way: HMAC-SHA256 over the same message through the crypto interface.
    Bytes message(protocol::kSessionOpenLabel.begin(), protocol::kSessionOpenLabel.end());
    for (std::size_t i = 0; i < 4; ++i) {
      message.push_back(static_cast<std::uint8_t>((address >> (8 * i)) & 0xFFu));
    }
    message.insert(message.end(), random.begin(), random.end());
    message.insert(message.end(), image.begin(), image.end());
    std::array<std::uint8_t, 32> mac{};
    REQUIRE(crypto.hmac_sha256(view(key_bytes), view(message), protocol::MutableByteView(mac)) ==
            HalError::none);
    CHECK(to_hex(protocol::ByteView(mac.data(), 16)) == item.at("tag").get<std::string>());
  }
  // RFC 4231 case 2: a short key.
  const Bytes jefe{'J', 'e', 'f', 'e'};
  const std::string text = "what do ya want for nothing?";
  const Bytes data(text.begin(), text.end());
  std::array<std::uint8_t, 32> mac{};
  REQUIRE(crypto.hmac_sha256(view(jefe), view(data), protocol::MutableByteView(mac)) ==
          HalError::none);
  CHECK(to_hex(protocol::ByteView(mac)) ==
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  std::array<std::uint8_t, 16> small{};
  CHECK(crypto.hmac_sha256(view(jefe), view(data), protocol::MutableByteView(small)) ==
        HalError::invalid);
}

TEST_CASE("an imported key is the one the cipher seals with and the session key derives from") {
  host::HostBoard board;
  const protocol::DeviceKey first{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15};
  const protocol::DeviceKey second{0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47,
                                   0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f};
  board.set_key(first);
  CHECK(board.key_import.imports == 0);  // the platform's own import is not the core's
  const auto sealed_under = [&board]() {
    const Bytes body{protocol::message_type::heartbeat, 0, 0, 0, 0, 0, 0};
    Bytes out(64);
    const auto size = protocol::seal_packet(
        board.cipher, protocol::PacketHeader{protocol::Direction::to_hub, 0x1A2B3C4D, 7},
        protocol::Binding::none(), view(body), protocol::PacketLimit::radio,
        protocol::MutableByteView(out.data(), out.size()));
    REQUIRE(size.ok());
    out.resize(size.value());
    return out;
  };
  const Bytes under_first = sealed_under();
  const Bytes nonce{1, 2, 3, 4, 5, 6, 7, 8};
  std::array<std::uint8_t, 32> before{};
  REQUIRE(board.update_crypto.session_key(view(nonce), 1, protocol::MutableByteView(before)) ==
          HalError::none);

  REQUIRE(board.key_import.import_key(second) == HalError::none);
  CHECK(board.key_import.imports == 1);
  const Bytes under_second = sealed_under();
  CHECK(under_second != under_first);
  std::array<std::uint8_t, 32> after{};
  REQUIRE(board.update_crypto.session_key(view(nonce), 1, protocol::MutableByteView(after)) ==
          HalError::none);
  CHECK(after == host::derive_session_key(second, view(nonce), 1));
  CHECK(after != before);

  // A refused import keeps the old key, in the cipher and for the session key.
  board.key_import.fail_next = true;
  CHECK(board.key_import.import_key(first) == HalError::io);
  CHECK(board.key_import.imports == 1);
  REQUIRE(board.key_import.key().has_value());
  CHECK(*board.key_import.key() == second);
  std::array<std::uint8_t, 32> kept{};
  REQUIRE(board.update_crypto.session_key(view(nonce), 1, protocol::MutableByteView(kept)) ==
          HalError::none);
  CHECK(kept == after);
  CHECK(sealed_under() == under_second);
}

}  // namespace
}  // namespace hsn::test
