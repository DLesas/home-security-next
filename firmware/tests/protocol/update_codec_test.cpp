// The update messages, Started's appended fields, the transfer frames and the image header
// (m3-updates-design.md sections 3, 5 and 7), against bytes worked out by hand from the design's
// tables, independently of packages/protocol's vector files, which vectors_test.cpp checks.

#include <array>
#include <string>
#include <type_traits>

#include "hsn/protocol/checksum.hpp"
#include "hsn/protocol/image.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/packet.hpp"
#include "hsn/protocol/transfer.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using protocol::Error;
using protocol::MutableByteView;

/** Decodes `plaintext` (type byte, body) to `fields`, and encodes `fields` back to it. */
template <typename Message>
void check_message_bytes(const json& fields, const std::string& plaintext_hex) {
  INFO("plaintext " << plaintext_hex);
  const Bytes plaintext = from_hex(plaintext_hex);
  REQUIRE(!plaintext.empty());
  CHECK(plaintext[0] == Message::type);
  bool visited = false;
  const Error error =
      protocol::decode_message(plaintext[0], view(plaintext).subspan(1), [&](const auto& message) {
        visited = true;
        CHECK(std::is_same_v<std::decay_t<decltype(message)>, Message>);
        CHECK(to_json(message) == fields);
      });
  REQUIRE_MESSAGE(error == Error::none, error_name(error));
  CHECK(visited);
  Arena arena;
  const auto built = struct_from_json<Message>(fields, arena);
  Bytes out(protocol::kMaxLinkPacketSize);
  const auto size = protocol::encode_plaintext(built, MutableByteView(out.data(), out.size()));
  REQUIRE_MESSAGE(size.ok(), error_name(size.error()));
  out.resize(size.value());
  CHECK(to_hex(view(out)) == plaintext_hex);
}

/** Decodes a transfer frame to `fields`, and encodes `fields` back to it. */
template <typename Frame>
void check_frame_bytes(const json& fields, const std::string& bytes_hex) {
  INFO("frame " << bytes_hex);
  const Bytes bytes = from_hex(bytes_hex);
  bool visited = false;
  const Error error = protocol::decode_transfer(view(bytes), [&](const auto& frame) {
    visited = true;
    CHECK(std::is_same_v<std::decay_t<decltype(frame)>, Frame>);
    CHECK(to_json(frame) == fields);
  });
  REQUIRE_MESSAGE(error == Error::none, error_name(error));
  CHECK(visited);
  Arena arena;
  const auto built = struct_from_json<Frame>(fields, arena);
  Bytes out(protocol::kMaxLinkPacketSize);
  const auto size = protocol::encode_transfer(built, MutableByteView(out.data(), out.size()));
  REQUIRE_MESSAGE(size.ok(), error_name(size.error()));
  out.resize(size.value());
  CHECK(to_hex(view(out)) == bytes_hex);
}

Error frame_error(const std::string& bytes_hex) {
  return protocol::decode_transfer(view(from_hex(bytes_hex)), [](const auto&) {});
}

const json kVersion140 = {{"major", 1}, {"minor", 4}, {"patch", 0}};

TEST_CASE("update query (0x06): 15 bytes, 33 on air") {
  check_message_bytes<protocol::UpdateQuery>(
      {{"imageId", "0102030405060708"},
       {"held", 1},
       {"bytesHeld", 65536},
       {"batteryCode", 120},
       {"flags", {{"hasWifiDetails", true}, {"externalPower", false}}}},
      "06"
      "0102030405060708"
      "01"
      "00000100"
      "78"
      "01");
  check_message_bytes<protocol::UpdateQuery>(
      {{"imageId", "0000000000000000"},
       {"held", 0},
       {"bytesHeld", 0},
       {"batteryCode", 0},
       {"flags", {{"hasWifiDetails", false}, {"externalPower", true}}}},
      "06"
      "0000000000000000"
      "00"
      "00000000"
      "00"
      "02");
  CHECK(protocol::kPacketOverhead + 16 == 33);
}

TEST_CASE("update status (0x07): 14 bytes, 32 on air") {
  check_message_bytes<protocol::UpdateStatus>({{"imageId", "a1a2a3a4a5a6a7a8"},
                                               {"stage", protocol::UpdateStage::refused},
                                               {"reason", protocol::UpdateReason::bad_signature},
                                               {"bytesWritten", 0}},
                                              "07"
                                              "a1a2a3a4a5a6a7a8"
                                              "03"
                                              "0a"
                                              "00000000");
  check_message_bytes<protocol::UpdateStatus>({{"imageId", "a1a2a3a4a5a6a7a8"},
                                               {"stage", protocol::UpdateStage::fetching},
                                               {"reason", protocol::UpdateReason::none},
                                               {"bytesWritten", 262144}},
                                              "07"
                                              "a1a2a3a4a5a6a7a8"
                                              "01"
                                              "00"
                                              "00000400");
  CHECK(protocol::kPacketOverhead + 15 == 32);
  // The reasons are numbered as the design's table lists them.
  CHECK(protocol::UpdateReason::radio_busy == 17);
  CHECK(protocol::UpdateReason::known.size() == 18);
  for (std::size_t i = 0; i < protocol::UpdateReason::known.size(); ++i) {
    CHECK(protocol::UpdateReason::known[i] == i);
  }
}

TEST_CASE("update offer (0x83): 25 bytes, 43 on air") {
  check_message_bytes<protocol::UpdateOffer>({{"action", protocol::UpdateAction::open_bluetooth},
                                              {"imageId", "1112131415161718"},
                                              {"fileBytes", 1572992},
                                              {"version", kVersion140},
                                              {"bluetoothNonce", "c0c1c2c3c4c5c6c7"},
                                              {"bluetoothWindowUnits", 12}},
                                             "83"
                                             "03"
                                             "1112131415161718"
                                             "80001800"
                                             "010400"
                                             "c0c1c2c3c4c5c6c7"
                                             "0c");
  CHECK(protocol::kPacketOverhead + 26 == 43);
  CHECK(protocol::direction_of_type(protocol::message_type::update_offer) ==
        protocol::Direction::from_hub);
}

TEST_CASE("key change (0x84): the new key, 34 on air") {
  check_message_bytes<protocol::KeyChange>({{"newKey", "00112233445566778899aabbccddeeff"}},
                                           "84"
                                           "00112233445566778899aabbccddeeff");
  CHECK(protocol::kPacketOverhead + 17 == 34);
  CHECK(protocol::direction_of_type(protocol::message_type::key_change) ==
        protocol::Direction::from_hub);
  protocol::KeyChange short_body{};
  CHECK(protocol::decode_body(view(from_hex("00112233445566778899aabbccddee")), short_body) ==
        Error::truncated);
}

TEST_CASE("Started's image fields: on trial, rolled back, and the older body") {
  const json base = {{"role", 1},
                     {"firmwareVersion", {{"major", 1}, {"minor", 2}, {"patch", 3}}},
                     {"resetCause", 1},
                     {"lastFatalError", 0},
                     {"settingsVersion", 3}};
  json on_trial = base;
  on_trial["image"] = {{"flags", {{"onTrial", true}, {"rolledBack", false}}},
                       {"failedVersion", {{"major", 0}, {"minor", 0}, {"patch", 0}}}};
  check_message_bytes<protocol::Started>(on_trial,
                                         "05"
                                         "01"
                                         "010203"
                                         "01"
                                         "0000"
                                         "03"
                                         "01"
                                         "000000");
  json rolled_back = base;
  rolled_back["image"] = {{"flags", {{"onTrial", false}, {"rolledBack", true}}},
                          {"failedVersion", {{"major", 1}, {"minor", 2}, {"patch", 2}}}};
  check_message_bytes<protocol::Started>(rolled_back,
                                         "05"
                                         "01"
                                         "010203"
                                         "01"
                                         "0000"
                                         "03"
                                         "02"
                                         "010202");
  // Without the image fields, exactly the body every Started had before.
  check_message_bytes<protocol::Started>(base,
                                         "05"
                                         "01"
                                         "010203"
                                         "01"
                                         "0000"
                                         "03");
  // Part of the image fields is no body at all.
  protocol::Started started{};
  CHECK(protocol::decode_body(view(from_hex("010102030100000301")), started) == Error::truncated);
  CHECK(protocol::decode_body(view(from_hex("01010203010000030102")), started) == Error::truncated);
}

TEST_CASE("CRC-32: the check value, empty input, and continuing a CRC") {
  const std::string digits = "123456789";
  const Bytes bytes(digits.begin(), digits.end());
  CHECK(protocol::crc32(view(bytes)) == 0xCBF43926u);
  CHECK(protocol::crc32(protocol::ByteView()) == 0u);
  CHECK(protocol::crc32(view(bytes).subspan(4), protocol::crc32(view(bytes).first(4))) ==
        0xCBF43926u);
}

TEST_CASE("transfer frames: each kind, from the design's table") {
  check_frame_bytes<protocol::transfer::Get>(
      {{"imageId", "0102030405060708"}, {"offset", 128}, {"length", 1000}},
      "f2"
      "01"
      "0102030405060708"
      "80000000"
      "e803");
  // The data is "123456789", whose CRC-32 is 0xCBF43926.
  check_frame_bytes<protocol::transfer::Data>({{"imageId", "0102030405060708"},
                                               {"offset", 4096},
                                               {"crc32", 0xCBF43926u},
                                               {"data", "313233343536373839"}},
                                              "f2"
                                              "02"
                                              "0102030405060708"
                                              "00100000"
                                              "2639f4cb"
                                              "313233343536373839");
  check_frame_bytes<protocol::transfer::Gone>(
      {{"imageId", "0102030405060708"}, {"reason", protocol::GoneReason::paused}},
      "f2"
      "03"
      "0102030405060708"
      "02");
  check_frame_bytes<protocol::transfer::Hello>({{"address", 0x1A2B3C4D},
                                                {"deviceRandom", "c0c1c2c3c4c5c6c7"},
                                                {"imageId", "0102030405060708"},
                                                {"bytesHeld", 65536},
                                                {"largestData", 164}},
                                               "f2"
                                               "10"
                                               "4d3c2b1a"
                                               "c0c1c2c3c4c5c6c7"
                                               "0102030405060708"
                                               "00000100"
                                               "a400");
  check_frame_bytes<protocol::transfer::Open>({{"tag", "000102030405060708090a0b0c0d0e0f"}},
                                              "f2"
                                              "11"
                                              "000102030405060708090a0b0c0d0e0f");
  check_frame_bytes<protocol::transfer::Done>({{"imageId", "0102030405060708"},
                                               {"result", protocol::DoneResult::refused},
                                               {"reason", protocol::UpdateReason::hash_mismatch}},
                                              "f2"
                                              "12"
                                              "0102030405060708"
                                              "01"
                                              "0b");
}

TEST_CASE("transfer frames: sizes, limits and refusals") {
  // A Data frame's header is 18 bytes, so 1,000 bytes of data fit a 1,024-byte link buffer.
  Arena arena;
  protocol::transfer::Data data{};
  data.data.bytes = arena.keep(Bytes(protocol::kMaxTransferData, 0x5A));
  Bytes out(protocol::kMaxLinkPacketSize + 8);
  const MutableByteView out_view(out.data(), out.size());
  const auto size = protocol::encode_transfer(data, out_view);
  REQUIRE(size.ok());
  CHECK(size.value() == protocol::kTransferDataHeaderSize + protocol::kMaxTransferData);
  CHECK(size.value() <= protocol::kMaxLinkPacketSize);
  data.data.bytes = arena.keep(Bytes(protocol::kMaxTransferData + 1, 0x5A));
  CHECK(protocol::encode_transfer(data, out_view).error() == Error::too_long);
  data.data.bytes = protocol::ByteView();
  CHECK(protocol::encode_transfer(data, out_view).error() == Error::truncated);
  // A Get asks for 1 to 1,000 bytes.
  protocol::transfer::Get get{};
  CHECK(protocol::encode_transfer(get, out_view).error() == Error::bad_value);
  get.length = 1001;
  CHECK(protocol::encode_transfer(get, out_view).error() == Error::bad_value);
  CHECK(frame_error("f2"
                    "01"
                    "0102030405060708"
                    "00000000"
                    "0000") == Error::bad_value);
  CHECK(frame_error("f2"
                    "01"
                    "0102030405060708"
                    "00000000"
                    "e903") == Error::bad_value);
  CHECK(frame_error("f2"
                    "02"
                    "0102030405060708"
                    "00000000"
                    "00000000") == Error::truncated);
  CHECK(frame_error("f2"
                    "01"
                    "0102030405060708"
                    "00000000"
                    "e8") == Error::truncated);
  // Not a frame, an unknown kind, too short to say.
  CHECK(frame_error("f101") == Error::bad_value);
  CHECK(frame_error("1001") == Error::bad_value);
  CHECK(frame_error("f204") == Error::unknown_type);
  CHECK(frame_error("f2") == Error::truncated);
  CHECK(frame_error("") == Error::truncated);
  // Bytes after a frame's fields are ignored, as after a body's.
  CHECK(frame_error("f2"
                    "03"
                    "0102030405060708"
                    "02"
                    "eeff") == Error::none);
  // No packet and no setup message starts with the marker.
  CHECK(protocol::kTransferMarker != protocol::kSetupMarker);
  CHECK((protocol::kTransferMarker & 0xF0) != 0x10);
}

TEST_CASE("the Bluetooth session's labels") {
  const std::string session = "hsn-ble-update/1";
  const std::string open = "hsn-ble-open/1";
  Bytes session_label(session.begin(), session.end());
  session_label.push_back(0);
  Bytes open_label(open.begin(), open.end());
  open_label.push_back(0);
  CHECK(Bytes(protocol::kSessionKeyLabel.begin(), protocol::kSessionKeyLabel.end()) ==
        session_label);
  CHECK(Bytes(protocol::kSessionOpenLabel.begin(), protocol::kSessionOpenLabel.end()) ==
        open_label);
}

/** An own build of 1.4.0 for every role: the design's table, offset by offset. */
const std::string kHeaderHex =
    "48534e49"                                                           // 0: HSNI
    "01"                                                                 // 4: format 1
    "01"                                                                 // 5: flags, own build
    "0e"                                                                 // 6: roles 1, 2, 3
    "01"                                                                 // 7: target 1
    "010400"                                                             // 8: version 1.4.0
    "00"                                                                 // 11: zero
    "00001800"                                                           // 12: 1,572,864 bytes
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f"   // 16: SHA-256
    "0807060504030201"                                                   // 48: hub identity
    "0000000000000000"                                                   // 56: zero
    "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f"   // 64: r
    "606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f";  // 96: s

TEST_CASE("the image header: 128 bytes, its image id, and the bytes the hub signs") {
  const Bytes bytes = from_hex(kHeaderHex);
  REQUIRE(bytes.size() == protocol::kImageHeaderSize);
  protocol::ImageHeader header;
  REQUIRE(protocol::decode_image_header(view(bytes), header) == Error::none);
  const json fields = {
      {"flags", {{"ownBuild", true}}},
      {"roles", 14},
      {"target", 1},
      {"version", kVersion140},
      {"imageBytes", 1572864},
      {"imageSha256", "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f"},
      {"hubIdentity", "0807060504030201"},
      {"signature",
       "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f"
       "606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f"}};
  CHECK(to_json(header) == fields);
  CHECK(to_hex(protocol::image_id_of(header)) == "2021222324252627");
  Bytes out(protocol::kImageHeaderSize);
  const auto size = protocol::encode_image_header(header, MutableByteView(out.data(), out.size()));
  REQUIRE(size.ok());
  CHECK(size.value() == protocol::kImageHeaderSize);
  CHECK(to_hex(view(out)) == kHeaderHex);
  // The roles: bit n for role n.
  for (const std::uint8_t role : protocol::Role::known) {
    CHECK((header.roles & protocol::image_role_bit(role)) != 0);
  }
  CHECK(protocol::image_role_bit(protocol::Role::sensor) == 0x02);
  CHECK(protocol::image_role_bit(0) == 0);
  CHECK(protocol::image_role_bit(8) == 0);
  // The signed bytes: "hsn-image/1", a zero byte, then bytes 0 to 63.
  const std::string label = "hsn-image/1";
  Bytes expected_label(label.begin(), label.end());
  expected_label.push_back(0);
  CHECK(Bytes(protocol::kImageSignatureLabel.begin(), protocol::kImageSignatureLabel.end()) ==
        expected_label);
  CHECK(protocol::kImageHeaderSignedSize == 64);
}

TEST_CASE("the image header refuses a wrong magic, format, zero byte or length") {
  const auto with_byte = [](std::size_t at, std::uint8_t value) {
    Bytes bytes = from_hex(kHeaderHex);
    bytes[at] = value;
    return bytes;
  };
  protocol::ImageHeader header;
  CHECK(protocol::decode_image_header(view(with_byte(3, 'X')), header) == Error::bad_value);
  CHECK(protocol::decode_image_header(view(with_byte(4, 2)), header) == Error::bad_version);
  CHECK(protocol::decode_image_header(view(with_byte(11, 1)), header) == Error::bad_value);
  for (std::size_t at = 56; at < 64; ++at) {
    CHECK(protocol::decode_image_header(view(with_byte(at, 1)), header) == Error::bad_value);
  }
  const Bytes bytes = from_hex(kHeaderHex);
  CHECK(protocol::decode_image_header(view(bytes).first(127), header) == Error::truncated);
  // A target this version does not list still decodes: refusing it is the device's check.
  CHECK(protocol::decode_image_header(view(with_byte(7, 2)), header) == Error::none);
  CHECK(header.target == 2);
}

}  // namespace
}  // namespace hsn::test
