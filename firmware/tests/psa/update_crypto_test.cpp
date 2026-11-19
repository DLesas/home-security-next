// hsn_psa's update crypto and device key import (m3-updates-design.md sections 3, 5 and 7) on
// TF-PSA-Crypto: SHA-256 in three steps, P-256 verification with low and high s, the Bluetooth
// session key and HMAC-SHA256 against packages/protocol's vectors and RFC test values, and every
// PSA call made to fail in turn (hsn/psa/fault_injection.hpp): each failure is a HalError (false
// for a verification), an output it could not fill is zeroed, and nothing is left half-done.

#include <doctest/doctest.h>

#include <array>
#include <filesystem>
#include <string>

#include "hsn/device/hal/update_crypto.hpp"
#include "hsn/protocol/packet.hpp"
#include "hsn/protocol/transfer.hpp"
#include "hsn/psa/fault_injection.hpp"
#include "hsn/psa/psa_packet_cipher.hpp"
#include "hsn/psa/psa_update_crypto.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using device::HalError;
namespace faults = psa::fault_injection;

json vectors(const char* name) {
  return load_json(std::filesystem::path(HSN_VECTORS_DIR) / name);
}

protocol::DeviceKey device_key(const std::string& hex) {
  const Bytes bytes = from_hex(hex);
  protocol::DeviceKey key{};
  REQUIRE(bytes.size() == key.size());
  std::copy(bytes.begin(), bytes.end(), key.begin());
  return key;
}

using Digest = std::array<std::uint8_t, device::kSha256Size>;

/** SHA-256 in `pieces` adds; the digest, or zeros with `error` set on a failure. */
Digest sha(psa::PsaUpdateCrypto& crypto, const Bytes& bytes, std::size_t pieces,
           HalError* error = nullptr) {
  Digest digest{};
  digest.fill(0xAA);
  HalError first = crypto.sha256_start();
  const std::size_t step = pieces == 0 ? bytes.size() : (bytes.size() + pieces - 1) / pieces;
  for (std::size_t at = 0; at < bytes.size() && step > 0; at += step) {
    const HalError added =
        crypto.sha256_add(protocol::ByteView(bytes.data() + at, std::min(step, bytes.size() - at)));
    first = first == HalError::none ? added : first;
  }
  const HalError finished = crypto.sha256_finish(protocol::MutableByteView(digest));
  first = first == HalError::none ? finished : first;
  if (error != nullptr) {
    *error = first;
  }
  return digest;
}

Digest digest_of(const std::string& hex) {
  const Bytes bytes = from_hex(hex);
  Digest digest{};
  REQUIRE(bytes.size() == digest.size());
  std::copy(bytes.begin(), bytes.end(), digest.begin());
  return digest;
}

/**
 * Makes each PSA call of `call` fail in turn, until a run makes fewer calls than the one armed,
 * and hands `check` each result and whether a failure was injected (PSA is left alone while it
 * checks). Returns the number of calls made to fail.
 */
template <typename Call, typename Check>
std::uint32_t fail_each_call(Call call, Check check) {
  for (std::uint32_t nth = 1; nth < 64; ++nth) {
    CAPTURE(nth);
    faults::arm(nth);
    const auto result = call();
    const bool fired = faults::fired();
    faults::disarm();
    check(result, fired);
    if (!fired) {
      return nth - 1;
    }
  }
  FAIL("a call made more than 63 PSA calls");
  return 0;
}

// ---- SHA-256 ----

TEST_CASE("SHA-256 in three steps gives the known digests, in any number of pieces") {
  psa::PsaUpdateCrypto crypto;
  const Bytes abc{'a', 'b', 'c'};
  CHECK(sha(crypto, abc, 1) ==
        digest_of("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
  CHECK(sha(crypto, Bytes{}, 0) ==
        digest_of("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));
  // FIPS 180-2's two-block message, whole and in odd pieces.
  const std::string two = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
  const Bytes two_blocks(two.begin(), two.end());
  for (const std::size_t pieces : {std::size_t{1}, std::size_t{3}, std::size_t{56}}) {
    CHECK(sha(crypto, two_blocks, pieces) ==
          digest_of("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"));
  }
  // A start discards the hash under way.
  REQUIRE(crypto.sha256_start() == HalError::none);
  REQUIRE(crypto.sha256_add(view(two_blocks)) == HalError::none);
  CHECK(sha(crypto, abc, 1) ==
        digest_of("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
}

TEST_CASE("SHA-256 refuses steps out of order, and a digest of the wrong size, zeroing it") {
  psa::PsaUpdateCrypto crypto;
  const Bytes abc{'a', 'b', 'c'};
  CHECK(crypto.sha256_add(view(abc)) == HalError::invalid);
  Digest digest{};
  digest.fill(0xAA);
  CHECK(crypto.sha256_finish(protocol::MutableByteView(digest)) == HalError::invalid);
  CHECK(digest == Digest{});
  // A digest of 31 or 33 bytes is refused and zeroed; the hash goes on.
  REQUIRE(crypto.sha256_start() == HalError::none);
  REQUIRE(crypto.sha256_add(view(abc)) == HalError::none);
  std::array<std::uint8_t, 31> small{};
  small.fill(0xAA);
  CHECK(crypto.sha256_finish(protocol::MutableByteView(small)) == HalError::invalid);
  CHECK(small == std::array<std::uint8_t, 31>{});
  std::array<std::uint8_t, 33> large{};
  large.fill(0xAA);
  CHECK(crypto.sha256_finish(protocol::MutableByteView(large)) == HalError::invalid);
  CHECK(large == std::array<std::uint8_t, 33>{});
  REQUIRE(crypto.sha256_finish(protocol::MutableByteView(digest)) == HalError::none);
  CHECK(digest == digest_of("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
  // A finish ends it.
  CHECK(crypto.sha256_add(view(abc)) == HalError::invalid);
  CHECK(crypto.sha256_finish(protocol::MutableByteView(digest)) == HalError::invalid);
}

TEST_CASE("SHA-256: each PSA call failing is an error, a zeroed digest, and the next hash works") {
  psa::PsaUpdateCrypto crypto;
  const std::string two = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
  const Bytes message(two.begin(), two.end());
  const Digest expected =
      digest_of("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  struct Result {
    HalError error;
    Digest digest;
  };
  const std::uint32_t failed = fail_each_call(
      [&]() {
        Result result{};
        result.digest = sha(crypto, message, 2, &result.error);
        return result;
      },
      [&](const Result& result, bool fired) {
        if (fired) {
          CHECK(result.error == HalError::io);
          CHECK(result.digest == Digest{});
        } else {
          CHECK(result.error == HalError::none);
          CHECK(result.digest == expected);
        }
        // Whatever happened, a new hash starts clean.
        CHECK(sha(crypto, message, 1) == expected);
      });
  // init and set-up at the start, two adds, one finish.
  CHECK(failed == 5);
}

// ---- P-256 ----

/** The order n of P-256's group, big-endian. */
constexpr std::array<std::uint8_t, 32> kOrder{
    0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xBC, 0xE6, 0xFA, 0xAD, 0xA7, 0x17, 0x9E, 0x84, 0xF3, 0xB9, 0xCA, 0xC2, 0xFC, 0x63, 0x25, 0x51};

/** n − s for a 32-byte big-endian s: the other s of the same signature. */
Bytes negated_s(const Bytes& signature) {
  Bytes out = signature;
  int borrow = 0;
  for (std::size_t i = 32; i-- > 0;) {
    const int difference = kOrder[i] - signature[32 + i] - borrow;
    borrow = difference < 0 ? 1 : 0;
    out[32 + i] = static_cast<std::uint8_t>(difference + (borrow != 0 ? 256 : 0));
  }
  return out;
}

bool high_s(const Bytes& signature) {
  // Above n / 2 exactly when n − s is below s.
  const Bytes other = negated_s(signature);
  return std::lexicographical_compare(other.begin() + 32, other.end(), signature.begin() + 32,
                                      signature.end());
}

TEST_CASE("P-256: the vectors' headers verify, with their s and with n − s; any change fails") {
  const json file = vectors("image-header.json");
  const Bytes public_key = from_hex(file.at("signingKey").get<std::string>());
  psa::PsaUpdateCrypto crypto;
  std::size_t highs = 0;
  std::size_t lows = 0;
  for (const json& valid : file.at("valid")) {
    CAPTURE(valid.at("name").get<std::string>());
    // The digest a device computes over the signed bytes, in pieces.
    const Bytes signed_bytes = from_hex(valid.at("signedBytes").get<std::string>());
    const Digest computed = sha(crypto, signed_bytes, 3);
    CHECK(to_hex(protocol::ByteView(computed)) == valid.at("signedSha256").get<std::string>());
    const Bytes digest(computed.begin(), computed.end());
    const Bytes signature = from_hex(valid.at("signature").get<std::string>());
    CHECK(crypto.verify_p256(view(public_key), view(digest), view(signature)));
    // Not normalised by the hub: the twin with n − s verifies too.
    const Bytes twin = negated_s(signature);
    CHECK(twin != signature);
    CHECK(crypto.verify_p256(view(public_key), view(digest), view(twin)));
    (high_s(signature) ? highs : lows) += 1;
    (high_s(twin) ? highs : lows) += 1;
    for (const std::size_t at :
         {std::size_t{0}, std::size_t{31}, std::size_t{32}, std::size_t{63}}) {
      Bytes broken = signature;
      broken[at] ^= 0x01;
      CHECK_FALSE(crypto.verify_p256(view(public_key), view(digest), view(broken)));
    }
    Bytes other_digest = digest;
    other_digest[31] ^= 0x80;
    CHECK_FALSE(crypto.verify_p256(view(public_key), view(other_digest), view(signature)));
    // Another valid point: X and Y swapped is not on the curve; Y negated is another key.
    Bytes swapped(public_key.begin() + 32, public_key.end());
    swapped.insert(swapped.end(), public_key.begin(), public_key.begin() + 32);
    CHECK_FALSE(crypto.verify_p256(view(swapped), view(digest), view(signature)));
  }
  CHECK(highs > 0);
  CHECK(lows > 0);
}

TEST_CASE("P-256: wrong sizes, r or s of zero, and s of n or more never verify") {
  const json file = vectors("image-header.json");
  const Bytes public_key = from_hex(file.at("signingKey").get<std::string>());
  const json& valid = file.at("valid")[0];
  const Bytes digest = from_hex(valid.at("signedSha256").get<std::string>());
  const Bytes signature = from_hex(valid.at("signature").get<std::string>());
  psa::PsaUpdateCrypto crypto;
  REQUIRE(crypto.verify_p256(view(public_key), view(digest), view(signature)));
  Bytes prefixed{0x04};
  prefixed.insert(prefixed.end(), public_key.begin(), public_key.end());
  CHECK_FALSE(crypto.verify_p256(view(prefixed), view(digest), view(signature)));
  CHECK_FALSE(
      crypto.verify_p256(protocol::ByteView(public_key.data(), 63), view(digest), view(signature)));
  CHECK_FALSE(
      crypto.verify_p256(view(public_key), protocol::ByteView(digest.data(), 31), view(signature)));
  Bytes long_digest = digest;
  long_digest.push_back(0);
  CHECK_FALSE(crypto.verify_p256(view(public_key), view(long_digest), view(signature)));
  CHECK_FALSE(
      crypto.verify_p256(view(public_key), view(digest), protocol::ByteView(signature.data(), 63)));
  Bytes long_signature = signature;
  long_signature.push_back(0);
  CHECK_FALSE(crypto.verify_p256(view(public_key), view(digest), view(long_signature)));
  Bytes zero_r = signature;
  std::fill(zero_r.begin(), zero_r.begin() + 32, std::uint8_t{0});
  CHECK_FALSE(crypto.verify_p256(view(public_key), view(digest), view(zero_r)));
  Bytes zero_s = signature;
  std::fill(zero_s.begin() + 32, zero_s.end(), std::uint8_t{0});
  CHECK_FALSE(crypto.verify_p256(view(public_key), view(digest), view(zero_s)));
  Bytes order_s = signature;
  std::copy(kOrder.begin(), kOrder.end(), order_s.begin() + 32);
  CHECK_FALSE(crypto.verify_p256(view(public_key), view(digest), view(order_s)));
  Bytes zero_key(64, 0);
  CHECK_FALSE(crypto.verify_p256(view(zero_key), view(digest), view(signature)));
}

TEST_CASE("P-256: each PSA call failing is no verification, and the next one works") {
  const json file = vectors("image-header.json");
  const Bytes public_key = from_hex(file.at("signingKey").get<std::string>());
  const json& valid = file.at("valid")[0];
  const Bytes digest = from_hex(valid.at("signedSha256").get<std::string>());
  const Bytes signature = from_hex(valid.at("signature").get<std::string>());
  psa::PsaUpdateCrypto crypto;
  const std::uint32_t failed = fail_each_call(
      [&]() { return crypto.verify_p256(view(public_key), view(digest), view(signature)); },
      [&](bool verified, bool fired) {
        CHECK(verified == !fired);
        CHECK(crypto.verify_p256(view(public_key), view(digest), view(signature)));
      });
  // init, the key's import, the verification.
  CHECK(failed == 3);
}

// ---- The session key and HMAC ----

TEST_CASE("the session key: the vectors, from the device key held, and nothing without one") {
  const json file = vectors("ble-update-session.json");
  for (const json& item : file.at("sessionKeys")) {
    CAPTURE(item.at("name").get<std::string>());
    psa::PsaUpdateCrypto crypto;
    const Bytes nonce = from_hex(item.at("nonce").get<std::string>());
    const auto address = item.at("address").get<std::uint32_t>();
    std::array<std::uint8_t, device::kSessionKeySize> out{};
    out.fill(0xAA);
    CHECK_FALSE(crypto.has_device_key());
    CHECK(crypto.session_key(view(nonce), address, protocol::MutableByteView(out)) ==
          HalError::invalid);
    CHECK(out == std::array<std::uint8_t, device::kSessionKeySize>{});
    REQUIRE(crypto.set_device_key(device_key(item.at("deviceKey").get<std::string>())) ==
            HalError::none);
    CHECK(crypto.has_device_key());
    REQUIRE(crypto.session_key(view(nonce), address, protocol::MutableByteView(out)) ==
            HalError::none);
    CHECK(to_hex(protocol::ByteView(out)) == item.at("sessionKey").get<std::string>());
    // Another address, another nonce: another key.
    std::array<std::uint8_t, device::kSessionKeySize> moved{};
    REQUIRE(crypto.session_key(view(nonce), address ^ 1u, protocol::MutableByteView(moved)) ==
            HalError::none);
    CHECK(moved != out);
    Bytes other_nonce = nonce;
    other_nonce[7] ^= 0x01;
    REQUIRE(crypto.session_key(view(other_nonce), address, protocol::MutableByteView(moved)) ==
            HalError::none);
    CHECK(moved != out);
  }
}

TEST_CASE("the session key refuses a nonce not 8 bytes and an output not 32, zeroing it") {
  const json item = vectors("ble-update-session.json").at("sessionKeys")[0];
  psa::PsaUpdateCrypto crypto;
  REQUIRE(crypto.set_device_key(device_key(item.at("deviceKey").get<std::string>())) ==
          HalError::none);
  const Bytes nonce = from_hex(item.at("nonce").get<std::string>());
  const auto address = item.at("address").get<std::uint32_t>();
  std::array<std::uint8_t, 32> out{};
  for (const std::size_t size : {std::size_t{0}, std::size_t{7}, std::size_t{9}}) {
    CAPTURE(size);
    Bytes resized = nonce;
    resized.resize(size, 0x5A);
    out.fill(0xAA);
    CHECK(crypto.session_key(view(resized), address, protocol::MutableByteView(out)) ==
          HalError::invalid);
    CHECK(out == std::array<std::uint8_t, 32>{});
  }
  std::array<std::uint8_t, 31> small{};
  small.fill(0xAA);
  CHECK(crypto.session_key(view(nonce), address, protocol::MutableByteView(small)) ==
        HalError::invalid);
  CHECK(small == std::array<std::uint8_t, 31>{});
  std::array<std::uint8_t, 33> large{};
  large.fill(0xAA);
  CHECK(crypto.session_key(view(nonce), address, protocol::MutableByteView(large)) ==
        HalError::invalid);
  CHECK(large == std::array<std::uint8_t, 33>{});
}

TEST_CASE("the session key: each PSA call failing is an error and a zeroed key; the next works") {
  const json item = vectors("ble-update-session.json").at("sessionKeys")[0];
  psa::PsaUpdateCrypto crypto;
  REQUIRE(crypto.set_device_key(device_key(item.at("deviceKey").get<std::string>())) ==
          HalError::none);
  const Bytes nonce = from_hex(item.at("nonce").get<std::string>());
  const auto address = item.at("address").get<std::uint32_t>();
  const std::string expected = item.at("sessionKey").get<std::string>();
  using Key = std::array<std::uint8_t, device::kSessionKeySize>;
  struct Result {
    HalError error;
    Key key;
  };
  const std::uint32_t failed = fail_each_call(
      [&]() {
        Result result{};
        result.key.fill(0xAA);
        result.error =
            crypto.session_key(view(nonce), address, protocol::MutableByteView(result.key));
        return result;
      },
      [&](const Result& result, bool fired) {
        if (fired) {
          CHECK(result.error == HalError::io);
          CHECK(result.key == Key{});
        } else {
          CHECK(result.error == HalError::none);
          CHECK(to_hex(protocol::ByteView(result.key)) == expected);
        }
        Key again{};
        REQUIRE(crypto.session_key(view(nonce), address, protocol::MutableByteView(again)) ==
                HalError::none);
        CHECK(to_hex(protocol::ByteView(again)) == expected);
      });
  // init, set-up, salt, secret, info, output.
  CHECK(failed == 6);
}

TEST_CASE("HMAC-SHA256: RFC 4231's cases and the vectors' Open tags") {
  psa::PsaUpdateCrypto crypto;
  std::array<std::uint8_t, 32> out{};
  // RFC 4231, test cases 1 and 2.
  const Bytes key1(20, 0x0B);
  const std::string hi = "Hi There";
  REQUIRE(crypto.hmac_sha256(view(key1), view(Bytes(hi.begin(), hi.end())),
                             protocol::MutableByteView(out)) == HalError::none);
  CHECK(to_hex(protocol::ByteView(out)) ==
        "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  const std::string jefe = "Jefe";
  const std::string want = "what do ya want for nothing?";
  REQUIRE(crypto.hmac_sha256(view(Bytes(jefe.begin(), jefe.end())),
                             view(Bytes(want.begin(), want.end())),
                             protocol::MutableByteView(out)) == HalError::none);
  CHECK(to_hex(protocol::ByteView(out)) ==
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  // The Open tag: the first 16 bytes over the label, the address, the device random, the image.
  const json file = vectors("ble-update-session.json");
  for (const json& item : file.at("openTags")) {
    CAPTURE(item.at("name").get<std::string>());
    Bytes message(protocol::kSessionOpenLabel.begin(), protocol::kSessionOpenLabel.end());
    const auto address = item.at("address").get<std::uint32_t>();
    for (int i = 0; i < 4; ++i) {
      message.push_back(static_cast<std::uint8_t>((address >> (8 * i)) & 0xFFu));
    }
    const Bytes random = from_hex(item.at("deviceRandom").get<std::string>());
    const Bytes image = from_hex(item.at("imageId").get<std::string>());
    message.insert(message.end(), random.begin(), random.end());
    message.insert(message.end(), image.begin(), image.end());
    const Bytes session = from_hex(item.at("sessionKey").get<std::string>());
    REQUIRE(crypto.hmac_sha256(view(session), view(message), protocol::MutableByteView(out)) ==
            HalError::none);
    CHECK(to_hex(protocol::ByteView(out.data(), 16)) == item.at("tag").get<std::string>());
  }
}

TEST_CASE("HMAC-SHA256 refuses an empty key and an output not 32 bytes, zeroing it") {
  psa::PsaUpdateCrypto crypto;
  const Bytes key(32, 0x11);
  const Bytes message{1, 2, 3};
  std::array<std::uint8_t, 32> out{};
  out.fill(0xAA);
  CHECK(crypto.hmac_sha256(protocol::ByteView(), view(message), protocol::MutableByteView(out)) ==
        HalError::invalid);
  CHECK(out == std::array<std::uint8_t, 32>{});
  std::array<std::uint8_t, 16> small{};
  small.fill(0xAA);
  CHECK(crypto.hmac_sha256(view(key), view(message), protocol::MutableByteView(small)) ==
        HalError::invalid);
  CHECK(small == std::array<std::uint8_t, 16>{});
  // An empty message is fine.
  CHECK(crypto.hmac_sha256(view(key), protocol::ByteView(), protocol::MutableByteView(out)) ==
        HalError::none);
}

TEST_CASE("HMAC-SHA256: each PSA call failing is an error and a zeroed output; the next works") {
  psa::PsaUpdateCrypto crypto;
  const std::string jefe = "Jefe";
  const std::string want = "what do ya want for nothing?";
  const Bytes key(jefe.begin(), jefe.end());
  const Bytes message(want.begin(), want.end());
  const std::string expected = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
  using Mac = std::array<std::uint8_t, 32>;
  struct Result {
    HalError error;
    Mac mac;
  };
  const std::uint32_t failed = fail_each_call(
      [&]() {
        Result result{};
        result.mac.fill(0xAA);
        result.error =
            crypto.hmac_sha256(view(key), view(message), protocol::MutableByteView(result.mac));
        return result;
      },
      [&](const Result& result, bool fired) {
        if (fired) {
          CHECK(result.error == HalError::io);
          CHECK(result.mac == Mac{});
        } else {
          CHECK(result.error == HalError::none);
          CHECK(to_hex(protocol::ByteView(result.mac)) == expected);
        }
        Mac again{};
        REQUIRE(crypto.hmac_sha256(view(key), view(message), protocol::MutableByteView(again)) ==
                HalError::none);
        CHECK(to_hex(protocol::ByteView(again)) == expected);
      });
  // init, the key's import, the MAC.
  CHECK(failed == 3);
}

// ---- The device key: the packet cipher and the session secret together ----

constexpr protocol::DeviceKey kOld{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15};
constexpr protocol::DeviceKey kNew{0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47,
                                   0x48, 0x49, 0x4A, 0x4B, 0x4C, 0x4D, 0x4E, 0x4F};

/** A packet to the hub sealed by `cipher`, opened under `key`: true when it opens. */
bool sealed_under(const psa::PsaPacketCipher& cipher, const protocol::DeviceKey& key) {
  const protocol::Heartbeat heartbeat;
  Bytes plaintext(protocol::kMaxLinkPacketSize);
  const auto size = protocol::encode_plaintext(
      heartbeat, protocol::MutableByteView(plaintext.data(), plaintext.size()));
  REQUIRE(size.ok());
  Bytes packet(protocol::kMaxLinkPacketSize);
  const auto sealed = protocol::seal_packet(
      cipher, {protocol::Direction::to_hub, 0x1A2B3C4D, 77}, protocol::Binding::none(),
      protocol::ByteView(plaintext.data(), size.value()), protocol::PacketLimit::radio,
      protocol::MutableByteView(packet.data(), packet.size()));
  REQUIRE(sealed.ok());
  psa::PsaPacketCipher opener;
  REQUIRE(opener.set_key(key) == protocol::Error::none);
  Bytes out(protocol::kMaxLinkPacketSize);
  return protocol::open_packet(opener, protocol::ByteView(packet.data(), sealed.value()),
                               protocol::Direction::to_hub, protocol::Binding::none(),
                               protocol::PacketLimit::radio,
                               protocol::MutableByteView(out.data(), out.size()))
      .ok();
}

/** The session key `crypto` derives now, as hex; empty when it derives none. */
std::string session_hex(psa::PsaUpdateCrypto& crypto) {
  const Bytes nonce{0x5A, 0x5B, 0x5C, 0x5D, 0x5E, 0x5F, 0x60, 0x61};
  std::array<std::uint8_t, 32> out{};
  if (crypto.session_key(view(nonce), 439041101u, protocol::MutableByteView(out)) !=
      HalError::none) {
    return "";
  }
  return to_hex(protocol::ByteView(out));
}

TEST_CASE("the key import gives the packet cipher and the session key the new key together") {
  psa::PsaPacketCipher cipher;
  psa::PsaUpdateCrypto crypto;
  psa::PsaKeyImport keys(cipher, crypto);
  CHECK(session_hex(crypto).empty());
  REQUIRE(keys.import_key(kOld) == HalError::none);
  CHECK(sealed_under(cipher, kOld));
  // The vectors' first session key is the one of this key, nonce and address.
  const std::string old_session = session_hex(crypto);
  CHECK(
      old_session ==
      vectors("ble-update-session.json").at("sessionKeys")[0].at("sessionKey").get<std::string>());
  REQUIRE(keys.import_key(kNew) == HalError::none);
  CHECK(sealed_under(cipher, kNew));
  CHECK_FALSE(sealed_under(cipher, kOld));
  CHECK_FALSE(session_hex(crypto).empty());
  CHECK(session_hex(crypto) != old_session);
}

TEST_CASE("the key import: each PSA call failing leaves both on the old key") {
  psa::PsaPacketCipher cipher;
  psa::PsaUpdateCrypto crypto;
  psa::PsaKeyImport keys(cipher, crypto);
  REQUIRE(keys.import_key(kOld) == HalError::none);
  const std::string old_session = session_hex(crypto);
  psa::PsaPacketCipher reference_cipher;
  psa::PsaUpdateCrypto reference_crypto;
  psa::PsaKeyImport reference(reference_cipher, reference_crypto);
  REQUIRE(reference.import_key(kNew) == HalError::none);
  const std::string new_session = session_hex(reference_crypto);
  bool on_new = false;
  const std::uint32_t failed =
      fail_each_call([&]() { return keys.import_key(on_new ? kOld : kNew); },
                     [&](HalError error, bool fired) {
                       const protocol::DeviceKey before = on_new ? kNew : kOld;
                       const protocol::DeviceKey asked = on_new ? kOld : kNew;
                       if (fired) {
                         CHECK(error == HalError::io);
                         CHECK(sealed_under(cipher, before));
                         CHECK(session_hex(crypto) == (on_new ? new_session : old_session));
                       } else {
                         CHECK(error == HalError::none);
                         CHECK(sealed_under(cipher, asked));
                         CHECK(session_hex(crypto) == (on_new ? old_session : new_session));
                         on_new = !on_new;
                       }
                     });
  // init and import for the cipher, init and import for the session secret.
  CHECK(failed == 4);
}

TEST_CASE("the packet cipher and the session secret each keep their key when an import fails") {
  psa::PsaPacketCipher cipher;
  REQUIRE(cipher.set_key(kOld) == protocol::Error::none);
  const std::uint32_t cipher_failed = fail_each_call(
      [&]() { return cipher.set_key(kNew); },
      [&](protocol::Error error, bool fired) {
        CHECK(error == (fired ? protocol::Error::cipher_failure : protocol::Error::none));
        CHECK(sealed_under(cipher, fired ? kOld : kNew));
        REQUIRE(cipher.set_key(kOld) == protocol::Error::none);
      });
  CHECK(cipher_failed == 2);
  psa::PsaUpdateCrypto crypto;
  REQUIRE(crypto.set_device_key(kOld) == HalError::none);
  const std::string old_session = session_hex(crypto);
  const std::uint32_t crypto_failed =
      fail_each_call([&]() { return crypto.set_device_key(kNew); },
                     [&](HalError error, bool fired) {
                       CHECK(error == (fired ? HalError::io : HalError::none));
                       CHECK((session_hex(crypto) == old_session) == fired);
                       REQUIRE(crypto.set_device_key(kOld) == HalError::none);
                     });
  CHECK(crypto_failed == 2);
}

TEST_CASE("the packet cipher: a failing seal or open is a cipher failure with a zeroed output") {
  psa::PsaPacketCipher cipher;
  REQUIRE(cipher.set_key(kOld) == protocol::Error::none);
  const protocol::Nonce nonce{};
  const Bytes plaintext{1, 2, 3, 4};
  Bytes sealed(plaintext.size() + protocol::kTagSize);
  REQUIRE(cipher.seal(nonce, protocol::ByteView(), view(plaintext),
                      protocol::MutableByteView(sealed.data(), sealed.size())) ==
          protocol::Error::none);
  faults::arm(1);
  Bytes out(sealed.size(), 0xAA);
  CHECK(cipher.seal(nonce, protocol::ByteView(), view(plaintext),
                    protocol::MutableByteView(out.data(), out.size())) ==
        protocol::Error::cipher_failure);
  CHECK(faults::fired());
  CHECK(out == Bytes(out.size(), 0));
  faults::arm(1);
  Bytes opened(plaintext.size(), 0xAA);
  CHECK(cipher.open(nonce, protocol::ByteView(), view(sealed),
                    protocol::MutableByteView(opened.data(), opened.size())) ==
        protocol::Error::cipher_failure);
  CHECK(faults::fired());
  CHECK(opened == Bytes(opened.size(), 0));
  // A failure reported as a bad tag is a bad tag.
  faults::arm(1, PSA_ERROR_INVALID_SIGNATURE);
  CHECK(cipher.open(nonce, protocol::ByteView(), view(sealed),
                    protocol::MutableByteView(opened.data(), opened.size())) ==
        protocol::Error::bad_tag);
  faults::disarm();
  CHECK(cipher.open(nonce, protocol::ByteView(), view(sealed),
                    protocol::MutableByteView(opened.data(), opened.size())) ==
        protocol::Error::none);
  CHECK(opened == plaintext);
}

TEST_CASE("the fault switch counts every call and fails only the one armed") {
  psa::PsaUpdateCrypto crypto;
  faults::arm(0);
  CHECK(crypto.sha256_start() == HalError::none);
  CHECK(faults::calls() == 2);
  CHECK_FALSE(faults::fired());
  faults::arm(2, PSA_ERROR_INSUFFICIENT_MEMORY);
  CHECK(crypto.sha256_start() == HalError::io);
  CHECK(faults::fired());
  CHECK(faults::calls() == 2);
  CHECK(crypto.sha256_start() == HalError::none);
  CHECK(faults::calls() == 4);
  faults::disarm();
}

}  // namespace
}  // namespace hsn::test
