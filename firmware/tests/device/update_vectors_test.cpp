// UpdateService against packages/protocol's vectors: the device's checks of an image header in
// their order (image-header.json, "checks", which vectors_test.cpp leaves to UpdateService), with
// real P-256 verification; and the session key and Open tag (ble-update-session.json) through the
// bench's helpers, which the Bluetooth tests use to play the phone.

#include <filesystem>

#include "update_bench.hpp"

namespace hsn::test::update {
namespace {

const std::filesystem::path kVectors = HSN_VECTORS_DIR;

Bytes hex_at(const json& item, const char* key) {
  return from_hex(item.at(key).get<std::string>());
}

TEST_CASE("vectors: image-header.json checks, in their order, on the device") {
  const json document = load_json(kVectors / "image-header.json");
  const json& checks = document.at("checks");
  REQUIRE(checks.size() >= 19);
  std::size_t passed = 0;
  for (const json& check : checks) {
    const std::string name = check.at("name").get<std::string>();
    CAPTURE(name);
    const json& expect = check.at("expect");
    BenchOptions options;
    options.hub_identity = hex_at(expect, "hubIdentity");
    options.signing_key = hex_at(expect, "signingKey");
    options.role = expect.at("role").get<std::uint8_t>();
    options.capacity = expect.at("capacity").get<std::uint32_t>();
    Bench bench(options);
    bench.boot();
    const Bytes header = hex_at(check, "header");
    protocol::UpdateOffer offer;
    offer.action = protocol::UpdateAction::fetch;
    for (std::size_t i = 0; i < offer.image_id.size() && 16 + i < header.size(); ++i) {
      offer.image_id[i] = header[16 + i];
    }
    const std::size_t ops = bench.power.ops.size();
    bench.update().offer(offer, device::UpdatePath::network, bench.now);
    REQUIRE(bench.network.sent.size() == 1);
    CHECK(decode_get(bench.network.sent[0]).length == 128);
    bench.deliver_link(
        LinkKind::network, device::LinkEventKind::packet,
        data_frame(offer.image_id, header, 0, static_cast<std::uint16_t>(header.size())));
    const auto reason = check.at("reason").get<std::uint8_t>();
    if (reason == protocol::UpdateReason::none) {
      // Passed: the record is written and the image is asked for.
      passed += 1;
      CHECK_FALSE(bench.take_packet().has_value());
      REQUIRE(bench.network.sent.size() > 1);
      CHECK(decode_get(bench.network.sent[1]).offset == 128);
      CHECK(bench.storage.has(device::StoreKey::update));
    } else {
      const auto packet = bench.take_packet();
      REQUIRE(packet.has_value());
      CHECK(packet->status.stage == protocol::UpdateStage::refused);
      CHECK(packet->status.reason == reason);
      CHECK(bench.power.ops.size() == ops);
      CHECK(bench.network.sent.size() == 1);
    }
  }
  CHECK(passed == 3);
}

TEST_CASE("vectors: ble-update-session.json session keys and Open tags, as the phone makes them") {
  const json document = load_json(kVectors / "ble-update-session.json");
  for (const json& item : document.at("sessionKeys")) {
    CAPTURE(item.at("name").get<std::string>());
    const Bytes key = hex_at(item, "deviceKey");
    protocol::DeviceKey device_key{};
    std::copy(key.begin(), key.end(), device_key.begin());
    CHECK(to_hex(view_of(session_key(device_key, hex_at(item, "nonce"),
                                     item.at("address").get<std::uint32_t>()))) ==
          item.at("sessionKey").get<std::string>());
    // The bench's UpdateCrypto, holding that device key, derives the same.
    TestCrypto crypto;
    crypto.device_key = device_key;
    std::array<std::uint8_t, device::kSessionKeySize> out{};
    const Bytes nonce = hex_at(item, "nonce");
    REQUIRE(crypto.session_key(protocol::ByteView(nonce.data(), nonce.size()),
                               item.at("address").get<std::uint32_t>(),
                               protocol::MutableByteView(out)) == HalError::none);
    CHECK(to_hex(protocol::ByteView(out)) == item.at("sessionKey").get<std::string>());
  }
  for (const json& item : document.at("openTags")) {
    CAPTURE(item.at("name").get<std::string>());
    const Bytes random = hex_at(item, "deviceRandom");
    const Bytes id = hex_at(item, "imageId");
    protocol::DeviceRandom device_random{};
    protocol::ImageId image_id{};
    std::copy(random.begin(), random.end(), device_random.begin());
    std::copy(id.begin(), id.end(), image_id.begin());
    const protocol::SessionTag tag =
        open_tag(hex_at(item, "sessionKey"), item.at("address").get<std::uint32_t>(), device_random,
                 image_id);
    CHECK(to_hex(protocol::ByteView(tag)) == item.at("tag").get<std::string>());
  }
}

TEST_CASE("action 6, the forced fetch: listed, and its offer's bytes worked out by hand") {
  CHECK(protocol::is_known<protocol::UpdateAction>(protocol::UpdateAction::forced_fetch));
  CHECK(protocol::UpdateAction::forced_fetch == 6);
  CHECK_FALSE(protocol::is_known<protocol::UpdateAction>(7));
  protocol::UpdateOffer offer;
  offer.action = protocol::UpdateAction::forced_fetch;
  offer.image_id = {0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88};
  offer.file_bytes = 0x00012345;
  offer.version = protocol::FirmwareVersion{1, 2, 3};
  Bytes plaintext(64);
  const auto size = protocol::encode_plaintext(
      offer, protocol::MutableByteView(plaintext.data(), plaintext.size()));
  REQUIRE(size.ok());
  plaintext.resize(size.value());
  // Type 0x83, action 6, the image id, the file's bytes (u32 LE), the version, no nonce, no
  // window: section 6's table, field by field.
  CHECK(to_hex(view_of(plaintext)) ==
        "83"
        "06"
        "1122334455667788"
        "45230100"
        "010203"
        "0000000000000000"
        "00");
  protocol::UpdateOffer decoded;
  REQUIRE(protocol::decode_body(protocol::ByteView(plaintext.data() + 1, plaintext.size() - 1),
                                decoded) == protocol::Error::none);
  CHECK(decoded.action == 6);
  CHECK(decoded.file_bytes == 0x00012345);
}

}  // namespace
}  // namespace hsn::test::update
