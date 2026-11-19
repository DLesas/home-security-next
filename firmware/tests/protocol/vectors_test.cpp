// Every file and every top-level section of packages/protocol/vectors, checked against the core.
// A file or section the harness does not handle fails the run, unless it is listed in kSkipped,
// or is the app channel's (kAppVectorPrefix, kAppVectorFolder), which packages/protocol checks.

#include <psa/crypto.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "hsn/protocol/checksum.hpp"
#include "hsn/protocol/counters.hpp"
#include "hsn/protocol/framing.hpp"
#include "hsn/protocol/image.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/packet.hpp"
#include "hsn/protocol/radio.hpp"
#include "hsn/protocol/setup.hpp"
#include "hsn/protocol/transfer.hpp"
#include "hsn/protocol/units.hpp"
#include "hsn/psa/hub_identity.hpp"
#include "hsn/psa/psa_packet_cipher.hpp"
#include "hsn/psa/psa_update_crypto.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using protocol::Error;

// Sections the firmware deliberately does not implement: hub-only rules, or data that is not
// part of the protocol.
const std::set<std::pair<std::string, std::string>> kSkipped = {
    // The hub's restore jump of 2^24 (section 4): hub only.
    {"counters.json", "restore"},
    // The hub's 64-packet receive window (section 4): hub only; the host test hub's window is
    // checked against this section in tests/host/replay_window_test.cpp.
    {"counters.json", "replayWindow"},
    // The private key the signing keys derive from, kept for later firmware-signature tests.
    {"pairing-data.json", "signingPrivateKey"},
    // The hub's side of the image signature (m3-updates-design.md section 3): its key and its
    // signing parameters. Devices only verify, which the harness checks below with hsn_psa's
    // UpdateCrypto (the valid headers, RFC 6979's sample, and the checks' signature verdicts).
    {"image-header.json", "signingPrivateKey"},
    {"image-header.json", "signing"},
    // The Bluetooth session (section 5): the service's UUIDs and the advertised name are the
    // ESP-IDF platform's Bluetooth link (F1). The session key and the Open tag are checked below.
    {"ble-update-session.json", "serviceUuid"},
    {"ble-update-session.json", "rxUuid"},
    {"ble-update-session.json", "txUuid"},
    {"ble-update-session.json", "names"},
};

// Files in the vectors folder that are not vectors.
const std::set<std::string> kNotVectors = {"README.md"};

// The relay's vectors share the folder (m4-design.md; owner B1, in packages/protocol): its XN
// handshake, its frames and the sealing of pushes run between the hub, the relay and the phones,
// never on a device, so this harness does not handle them; packages/protocol's relay vector tests
// check them. Named one by one: a new file, relay's or not, still fails until it is listed here or
// handled.
const std::set<std::string> kRelayVectors = {"relay-xn.json", "relay-frames.json",
                                             "relay-push.json"};

// ESP-IDF Bluetooth pairing (owner: the board's Bluetooth engineer). These cover the board's
// advertisements, QR/script, and provisioning session, outside the device codec. The board is
// tested against these vectors separately. Each file is named so a new one still needs an owner.
const std::set<std::string> kPairingVectors = {
    "pairing-advert.json", "pairing-board-qr.json",          "pairing-board-script.json",
    "pairing-code.json",   "pairing-security2-counter.json", "pairing-security2.json",
    "pairing-srp.json"};

// The app channel's vectors share the folder (m2-design.md, the vectors' tooling): this harness
// answers for the device protocol's alone, so a file named with this prefix, and this folder, are
// not its to handle. packages/protocol's app vector tests and the independent verifier
// (packages/protocol/verify) check them.
const std::string kAppVectorPrefix = "app-";
const std::string kAppVectorFolder = "noise-published";

/** One vector file and the top-level sections its handler consumed. */
class VectorFile {
public:
  VectorFile(std::string name, json document)
      : name_(std::move(name)), document_(std::move(document)) {}

  /** Returns a section and marks it handled. */
  const json& section(const std::string& key) {
    handled_.insert(key);
    REQUIRE_MESSAGE(document_.contains(key), name_ << " has no section " << key);
    return document_.at(key);
  }

  /** Fails for every section neither handled nor skipped. */
  void check_all_handled() const {
    for (const auto& item : document_.items()) {
      const bool handled =
          handled_.count(item.key()) != 0 || kSkipped.count({name_, item.key()}) != 0;
      CHECK_MESSAGE(handled, name_ << ": section '" << item.key() << "' is not handled");
    }
  }

private:
  std::string name_;
  json document_;
  std::set<std::string> handled_;
};

Bytes hex_of(const json& item, const char* key) {
  return from_hex(item.at(key).get<std::string>());
}

std::string name_of(const json& item) {
  return item.contains("name") ? item.at("name").get<std::string>() : item.dump();
}

/** SHA-256 as a device takes it, in hsn_psa's three steps (the bytes added in two pieces). */
Bytes device_digest(psa::PsaUpdateCrypto& crypto, const Bytes& bytes) {
  const std::size_t half = bytes.size() / 2;
  REQUIRE(crypto.sha256_start() == device::HalError::none);
  REQUIRE(crypto.sha256_add(protocol::ByteView(bytes.data(), half)) == device::HalError::none);
  REQUIRE(crypto.sha256_add(protocol::ByteView(bytes.data() + half, bytes.size() - half)) ==
          device::HalError::none);
  Bytes digest(device::kSha256Size);
  REQUIRE(crypto.sha256_finish(protocol::MutableByteView(digest.data(), digest.size())) ==
          device::HalError::none);
  return digest;
}

void set_key(psa::PsaPacketCipher& cipher, const json& item) {
  const Bytes key = hex_of(item, "key");
  REQUIRE(key.size() == protocol::kKeySize);
  protocol::DeviceKey device_key{};
  std::copy(key.begin(), key.end(), device_key.begin());
  REQUIRE(cipher.set_key(device_key) == Error::none);
}

protocol::Direction direction_from(const json& value) {
  const int direction = value.get<int>();
  REQUIRE((direction == 0 || direction == 1));
  return direction == 0 ? protocol::Direction::to_hub : protocol::Direction::from_hub;
}

/** What receiving a packet gave: the open step's result, then the body decoder's. */
struct Received {
  Error error = Error::none;
  protocol::OpenedPacket opened;
};

/** Opens `packet` as the vectors' README says, then decodes the body and visits it. */
template <typename Visitor>
Received receive(const json& item, const json& direction, Bytes& plaintext, Visitor&& visitor) {
  psa::PsaPacketCipher cipher;
  set_key(cipher, item);
  const Bytes packet = hex_of(item, "packet");
  plaintext.assign(protocol::kMaxLinkPacketSize, 0);
  const auto opened = protocol::open_packet(
      cipher, view(packet), direction_from(direction), binding_from_bytes(hex_of(item, "binding")),
      limit_from(item.at("maxLength").get<std::uint32_t>()),
      protocol::MutableByteView(plaintext.data(), plaintext.size()));
  Received received;
  if (!opened.ok()) {
    received.error = opened.error();
    return received;
  }
  received.opened = opened.value();
  received.error = protocol::decode_message(opened.value().type, opened.value().body, visitor);
  return received;
}

void check_message_case(const json& file, const json& item) {
  INFO("case: " << name_of(item));
  CHECK(item.at("messageType") == file.at("messageType"));
  CHECK(item.at("direction") == file.at("direction"));
  const bool canonical = item.at("canonical").get<bool>();
  const json& fields = item.at("fields");
  const Bytes expected_plaintext = hex_of(item, "plaintext");
  const Bytes expected_packet = hex_of(item, "packet");
  const protocol::Binding binding = binding_from_bytes(hex_of(item, "binding"));
  CHECK(to_hex(binding.view()) == item.at("binding").get<std::string>());
  const protocol::PacketHeader header{direction_from(item.at("direction")),
                                      item.at("address").get<std::uint32_t>(),
                                      item.at("counter").get<std::uint32_t>()};
  CHECK(to_hex(protocol::make_nonce(header)) == item.at("nonce").get<std::string>());
  CHECK(to_hex(protocol::make_associated_data(view(expected_packet), binding).view()) ==
        item.at("associatedData").get<std::string>());

  psa::PsaPacketCipher cipher;
  set_key(cipher, item);
  bool visited = false;
  Bytes plaintext;
  const Received received =
      receive(item, item.at("direction"), plaintext, [&](const auto& message) {
        using Message = std::decay_t<decltype(message)>;
        visited = true;
        CHECK(Message::type == item.at("messageType").get<int>());
        CHECK(to_json(message) == fields);
        if (!canonical) {
          return;
        }
        Arena arena;
        const auto built = struct_from_json<Message>(fields, arena);
        Bytes encoded(protocol::kMaxLinkPacketSize);
        const auto size = protocol::encode_plaintext(
            built, protocol::MutableByteView(encoded.data(), encoded.size()));
        REQUIRE_MESSAGE(size.ok(), error_name(size.error()));
        encoded.resize(size.value());
        CHECK(to_hex(view(encoded)) == to_hex(view(expected_plaintext)));
        Bytes sealed(protocol::kMaxLinkPacketSize);
        const auto sealed_size =
            protocol::seal_packet(cipher, header, binding, view(encoded),
                                  limit_from(item.at("maxLength").get<std::uint32_t>()),
                                  protocol::MutableByteView(sealed.data(), sealed.size()));
        REQUIRE_MESSAGE(sealed_size.ok(), error_name(sealed_size.error()));
        sealed.resize(sealed_size.value());
        CHECK(to_hex(view(sealed)) == to_hex(view(expected_packet)));
      });
  REQUIRE_MESSAGE(received.error == Error::none, error_name(received.error));
  CHECK(visited);
  CHECK(received.opened.header.address == header.address);
  CHECK(received.opened.header.counter == header.counter);
  CHECK(received.opened.type == item.at("messageType").get<int>());
  CHECK(to_hex(protocol::ByteView(plaintext.data(), expected_plaintext.size())) ==
        to_hex(view(expected_plaintext)));
}

void check_message_file(VectorFile& file) {
  const json header = {{"messageType", file.section("messageType")},
                       {"direction", file.section("direction")}};
  CHECK(file.section("name").is_string());
  const auto type = static_cast<std::uint8_t>(header.at("messageType").get<int>());
  CHECK(protocol::is_known_message_type(type));
  CHECK(protocol::direction_of_type(type) == direction_from(header.at("direction")));
  const json& cases = file.section("cases");
  REQUIRE(!cases.empty());
  for (const json& item : cases) {
    check_message_case(header, item);
  }
}

std::string sha256_hex(const Bytes& bytes) {
  REQUIRE(psa_crypto_init() == PSA_SUCCESS);
  std::array<std::uint8_t, 32> digest{};
  std::size_t length = 0;
  REQUIRE(psa_hash_compute(PSA_ALG_SHA_256, bytes.data(), bytes.size(), digest.data(),
                           digest.size(), &length) == PSA_SUCCESS);
  REQUIRE(length == digest.size());
  return to_hex(digest);
}

/**
 * Started with the image fields appended (m3-updates-design.md section 5). The file keeps them in
 * "image", beside the version-1 fields; null for an older device's 8-byte body.
 */
void check_started_update(VectorFile& file) {
  const json header = {{"messageType", protocol::message_type::started}, {"direction", 0}};
  for (const json& item : file.section("valid")) {
    json whole = item;
    if (!item.at("image").is_null()) {
      whole["fields"]["image"] = item.at("image");
    }
    whole["canonical"] = true;
    check_message_case(header, whole);
  }
  for (const json& item : file.section("invalid")) {
    INFO("invalid: " << name_of(item));
    const Bytes plaintext = hex_of(item, "plaintext");
    REQUIRE(!plaintext.empty());
    CHECK(plaintext[0] == protocol::message_type::started);
    const Error error =
        protocol::decode_message(plaintext[0], view(plaintext).subspan(1), [](const auto&) {});
    CHECK(error_name(error) == item.at("error").get<std::string>());
  }
}

/** The transfer frames, their prefix and CRC-32 (m3-updates-design.md section 5). */
void check_transfer_frames(VectorFile& file) {
  CHECK(file.section("prefix") == protocol::kTransferMarker);
  for (const json& item : file.section("crc32")) {
    INFO("crc32: " << name_of(item));
    CHECK(protocol::crc32(view(hex_of(item, "data"))) == item.at("crc32").get<std::uint32_t>());
  }
  for (const json& item : file.section("valid")) {
    INFO("valid: " << name_of(item));
    const Bytes bytes = hex_of(item, "bytes");
    bool visited = false;
    const Error error = protocol::decode_transfer(view(bytes), [&](const auto& frame) {
      using Frame = std::decay_t<decltype(frame)>;
      visited = true;
      CHECK(Frame::kind == item.at("kind").get<int>());
      CHECK(to_json(frame) == item.at("fields"));
      if constexpr (std::is_same_v<Frame, protocol::transfer::Data>) {
        // A Data frame decodes whatever its CRC; the receiver checks the CRC and drops a bad one.
        CHECK((protocol::crc32(frame.data.bytes) == frame.crc32) == item.at("intact").get<bool>());
      }
      if (!item.at("canonical").get<bool>()) {
        return;
      }
      Arena arena;
      const auto built = struct_from_json<Frame>(item.at("fields"), arena);
      Bytes out(protocol::kMaxLinkPacketSize);
      const auto size =
          protocol::encode_transfer(built, protocol::MutableByteView(out.data(), out.size()));
      REQUIRE_MESSAGE(size.ok(), error_name(size.error()));
      CHECK(to_hex(protocol::ByteView(out.data(), size.value())) == to_hex(view(bytes)));
    });
    REQUIRE_MESSAGE(error == Error::none, error_name(error));
    CHECK(visited);
  }
  for (const json& item : file.section("invalid")) {
    INFO("invalid: " << name_of(item));
    const Bytes bytes = hex_of(item, "bytes");
    const Error error = protocol::decode_transfer(view(bytes), [](const auto&) {});
    CHECK(error_name(error) == item.at("error").get<std::string>());
    if (error == Error::unknown_type) {
      REQUIRE(bytes.size() >= 2);
      CHECK(bytes[1] == item.at("messageType").get<int>());
    }
  }
}

/** The device image header and the bytes its signature covers (m3-updates-design.md section 3). */
void check_image_header(VectorFile& file) {
  const std::string label = file.section("label").get<std::string>();
  const Bytes label_bytes(protocol::kImageSignatureLabel.begin(),
                          protocol::kImageSignatureLabel.end());
  // The label, then its zero byte.
  Bytes expected_label(label.begin(), label.end());
  expected_label.push_back(0);
  CHECK(label_bytes == expected_label);
  // The hub's identity is the hash of the key that verifies its images (protocol section 9).
  const Bytes key = from_hex(file.section("signingKey").get<std::string>());
  REQUIRE(key.size() == protocol::SigningKey{}.size());
  protocol::SigningKey signing_key{};
  std::copy(key.begin(), key.end(), signing_key.begin());
  protocol::HubIdentity identity{};
  REQUIRE(psa::compute_hub_identity(signing_key, identity) == Error::none);
  CHECK(to_hex(identity) == file.section("hubIdentity").get<std::string>());
  const std::string image_sha256 = sha256_hex(from_hex(file.section("image").get<std::string>()));
  for (const json& item : file.section("valid")) {
    INFO("valid: " << name_of(item));
    const Bytes header = hex_of(item, "header");
    REQUIRE(header.size() == protocol::kImageHeaderSize);
    protocol::ImageHeader decoded;
    REQUIRE(protocol::decode_image_header(view(header), decoded) == Error::none);
    json expected = item.at("fields");
    expected["signature"] = item.at("signature");
    CHECK(to_json(decoded) == expected);
    CHECK(to_hex(protocol::image_id_of(decoded)) == item.at("imageId").get<std::string>());
    CHECK(image_sha256 == item.at("fields").at("imageSha256").get<std::string>());
    Arena arena;
    const auto built = struct_from_json<protocol::ImageHeader>(expected, arena);
    Bytes out(protocol::kImageHeaderSize);
    const auto size =
        protocol::encode_image_header(built, protocol::MutableByteView(out.data(), out.size()));
    REQUIRE_MESSAGE(size.ok(), error_name(size.error()));
    CHECK(to_hex(view(out)) == to_hex(view(header)));
    Bytes signed_bytes = label_bytes;
    signed_bytes.insert(signed_bytes.end(), header.begin(),
                        header.begin() + protocol::kImageHeaderSignedSize);
    CHECK(to_hex(view(signed_bytes)) == item.at("signedBytes").get<std::string>());
    CHECK(sha256_hex(signed_bytes) == item.at("signedSha256").get<std::string>());
    // The device's own hash of those bytes, and the signature under the hub's key.
    psa::PsaUpdateCrypto crypto;
    const Bytes digest = device_digest(crypto, signed_bytes);
    CHECK(to_hex(view(digest)) == item.at("signedSha256").get<std::string>());
    CHECK(crypto.verify_p256(view(key), view(digest),
                             view(from_hex(item.at("signature").get<std::string>()))));
  }
  // RFC 6979's sample (A.2.5, SHA-256), whose s is above n / 2: a device verifies it as it is.
  const json& sample = file.section("rfc6979Sample");
  const Bytes message = hex_of(sample, "message");
  Bytes signature = hex_of(sample, "r");
  const Bytes s = hex_of(sample, "s");
  signature.insert(signature.end(), s.begin(), s.end());
  REQUIRE(signature.size() == 64);
  CHECK(s[0] >= 0x80);
  psa::PsaUpdateCrypto crypto;
  const Bytes sample_digest = device_digest(crypto, message);
  CHECK(crypto.verify_p256(view(key), view(sample_digest), view(signature)));
  Bytes altered = signature;
  altered[63] ^= 0x01;
  CHECK_FALSE(crypto.verify_p256(view(key), view(sample_digest), view(altered)));
  // The device's checks (section 3): their order is UpdateService's, checked against this section
  // in tests/device/update_vectors_test.cpp (U1). Here, the signature step alone: a header that
  // passes every check verifies under the paired key, and one refused badSignature does not.
  std::size_t verdicts = 0;
  for (const json& item : file.section("checks")) {
    INFO("checks: " << name_of(item));
    const auto reason = item.at("reason").get<std::uint8_t>();
    if (reason != protocol::UpdateReason::none && reason != protocol::UpdateReason::bad_signature) {
      continue;
    }
    const Bytes header = hex_of(item, "header");
    REQUIRE(header.size() == protocol::kImageHeaderSize);
    Bytes covered = label_bytes;
    covered.insert(covered.end(), header.begin(),
                   header.begin() + protocol::kImageHeaderSignedSize);
    const Bytes digest = device_digest(crypto, covered);
    const Bytes paired = from_hex(item.at("expect").at("signingKey").get<std::string>());
    const Bytes header_signature(header.begin() + protocol::kImageHeaderSignedSize, header.end());
    CHECK(crypto.verify_p256(view(paired), view(digest), view(header_signature)) ==
          (reason == protocol::UpdateReason::none));
    verdicts += 1;
  }
  CHECK(verdicts >= 5);
}

/**
 * The Bluetooth session (m3-updates-design.md section 5): the HKDF info's bytes (the core's
 * kSessionKeyLabel, then the address), the session key a device derives from its key with hsn_psa's
 * UpdateCrypto, and the Open tag, the first 16 bytes of its HMAC-SHA256.
 */
void check_ble_session(VectorFile& file) {
  for (const json& item : file.section("sessionKeys")) {
    INFO("sessionKeys: " << name_of(item));
    Bytes info(protocol::kSessionKeyLabel.begin(), protocol::kSessionKeyLabel.end());
    const auto address = item.at("address").get<std::uint32_t>();
    for (int i = 0; i < 4; ++i) {
      info.push_back(static_cast<std::uint8_t>((address >> (8 * i)) & 0xFFu));
    }
    CHECK(to_hex(view(info)) == item.at("info").get<std::string>());
    const Bytes key = hex_of(item, "deviceKey");
    REQUIRE(key.size() == protocol::kKeySize);
    protocol::DeviceKey device_key{};
    std::copy(key.begin(), key.end(), device_key.begin());
    psa::PsaUpdateCrypto crypto;
    REQUIRE(crypto.set_device_key(device_key) == device::HalError::none);
    std::array<std::uint8_t, device::kSessionKeySize> session{};
    REQUIRE(crypto.session_key(view(hex_of(item, "nonce")), address,
                               protocol::MutableByteView(session)) == device::HalError::none);
    CHECK(to_hex(protocol::ByteView(session)) == item.at("sessionKey").get<std::string>());
  }
  for (const json& item : file.section("openTags")) {
    INFO("openTags: " << name_of(item));
    Bytes message(protocol::kSessionOpenLabel.begin(), protocol::kSessionOpenLabel.end());
    const auto address = item.at("address").get<std::uint32_t>();
    for (int i = 0; i < 4; ++i) {
      message.push_back(static_cast<std::uint8_t>((address >> (8 * i)) & 0xFFu));
    }
    const Bytes random = hex_of(item, "deviceRandom");
    const Bytes image = hex_of(item, "imageId");
    REQUIRE(random.size() == protocol::DeviceRandom{}.size());
    REQUIRE(image.size() == protocol::ImageId{}.size());
    message.insert(message.end(), random.begin(), random.end());
    message.insert(message.end(), image.begin(), image.end());
    psa::PsaUpdateCrypto crypto;
    std::array<std::uint8_t, device::kSha256Size> mac{};
    REQUIRE(crypto.hmac_sha256(view(hex_of(item, "sessionKey")), view(message),
                               protocol::MutableByteView(mac)) == device::HalError::none);
    CHECK(to_hex(protocol::ByteView(mac.data(), protocol::SessionTag{}.size())) ==
          item.at("tag").get<std::string>());
  }
}

std::string verdict_name(protocol::CounterVerdict verdict) {
  switch (verdict) {
    case protocol::CounterVerdict::accepted:
      return "accepted";
    case protocol::CounterVerdict::duplicate:
      return "duplicate";
    case protocol::CounterVerdict::too_old:
      return "tooOld";
  }
  return "unknown verdict";
}

void check_rejected_packets(VectorFile& file) {
  const auto ignore = [](const auto&) {};
  for (const json& item : file.section("packets")) {
    INFO("case: " << name_of(item));
    Bytes plaintext;
    const Received received = receive(item, item.at("expectedDirection"), plaintext, ignore);
    CHECK(error_name(received.error) == item.at("error").get<std::string>());
    if (received.error == Error::unknown_type) {
      CHECK(received.opened.type == item.at("messageType").get<int>());
    }
  }
  for (const json& item : file.section("replayed")) {
    INFO("case: " << name_of(item));
    Bytes plaintext;
    const Received received = receive(item, item.at("expectedDirection"), plaintext, ignore);
    REQUIRE_MESSAGE(received.error == Error::none, error_name(received.error));
    const std::string rule = item.at("rule").get<std::string>();
    if (rule == "replayWindow") {
      // The hub's 64-packet window is not in the firmware (see kSkipped); the packet must still
      // open, which is checked above.
      continue;
    }
    REQUIRE(rule == "strictlyHigher");
    protocol::StrictlyHigherCounter counter(item.at("stateBefore").get<std::uint32_t>());
    CHECK(verdict_name(counter.accept(received.opened.header.counter)) ==
          item.at("rejection").get<std::string>());
  }
}

protocol::CounterStep step_from(const json& value) {
  const auto step = value.get<std::uint32_t>();
  REQUIRE((step == 64 || step == 1024));
  return step == 64 ? protocol::CounterStep::sensor : protocol::CounterStep::siren_or_gateway;
}

void check_counters(VectorFile& file) {
  for (const json& item : file.section("take")) {
    INFO("take: " << item.dump());
    protocol::SendCounter counter(step_from(item.at("step")), item.at("next").get<std::uint32_t>(),
                                  item.at("resumePoint").get<std::uint32_t>());
    const auto taken = counter.take();
    if (item.contains("error")) {
      CHECK(error_name(taken.error()) == item.at("error").get<std::string>());
      CHECK(counter.next() == item.at("next").get<std::uint32_t>());
      CHECK(counter.resume_point() == item.at("resumePoint").get<std::uint32_t>());
      continue;
    }
    REQUIRE_MESSAGE(taken.ok(), error_name(taken.error()));
    CHECK(taken.value().counter == item.at("counter").get<std::uint32_t>());
    if (item.at("saveResumePoint").is_null()) {
      CHECK_FALSE(taken.value().save_resume_point);
    } else {
      CHECK(taken.value().save_resume_point);
      CHECK(taken.value().resume_point == item.at("saveResumePoint").get<std::uint32_t>());
    }
    CHECK(counter.next() == item.at("nextAfter").get<std::uint32_t>());
    CHECK(counter.resume_point() == item.at("resumePointAfter").get<std::uint32_t>());
  }

  for (const json& sequence : file.section("powerLoss")) {
    INFO("powerLoss: " << sequence.dump());
    const protocol::CounterStep step = step_from(sequence.at("step"));
    protocol::SendCounter counter = protocol::SendCounter::paired(step);
    std::uint32_t flash = counter.resume_point();
    CHECK(flash == sequence.at("initialResumePoint").get<std::uint32_t>());
    for (const json& event : sequence.at("events")) {
      if (event.at("event") == "powerLoss") {
        counter = protocol::SendCounter::resumed(step, flash);
        CHECK(counter.next() == event.at("resumeFrom").get<std::uint32_t>());
        continue;
      }
      REQUIRE(event.at("event") == "send");
      std::vector<std::uint32_t> counters;
      std::vector<std::uint32_t> saved;
      for (int i = 0; i < event.at("count").get<int>(); ++i) {
        const auto taken = counter.take();
        REQUIRE(taken.ok());
        counters.push_back(taken.value().counter);
        if (taken.value().save_resume_point) {
          flash = taken.value().resume_point;
          saved.push_back(flash);
        }
      }
      CHECK(counters.front() == event.at("firstCounter").get<std::uint32_t>());
      CHECK(counters.back() == event.at("lastCounter").get<std::uint32_t>());
      CHECK(saved == event.at("savedResumePoints").get<std::vector<std::uint32_t>>());
    }
  }

  for (const json& sequence : file.section("strictlyHigher")) {
    INFO("strictlyHigher: " << name_of(sequence));
    protocol::StrictlyHigherCounter counter;
    for (const json& step : sequence.at("steps")) {
      CHECK(counter.last_accepted() == step.at("lastAccepted").get<std::uint32_t>());
      const auto verdict = counter.accept(step.at("counter").get<std::uint32_t>());
      CHECK((verdict == protocol::CounterVerdict::accepted) == step.at("accepted").get<bool>());
      if (!step.at("accepted").get<bool>()) {
        CHECK(verdict_name(verdict) == step.at("rejection").get<std::string>());
      }
    }
  }
}

/** Index of the last COBS block's code byte, to know whether it was a full block. */
std::uint8_t last_code(const Bytes& encoded) {
  std::size_t index = 0;
  std::uint8_t code = 0;
  while (index < encoded.size()) {
    code = encoded[index];
    index += code;
  }
  return code;
}

void check_cobs(VectorFile& file) {
  for (const json& item : file.section("valid")) {
    INFO("valid: " << name_of(item));
    const Bytes data = hex_of(item, "data");
    const Bytes encoded = hex_of(item, "encoded");
    Bytes out(2 * protocol::kMaxEncodedFrameSize);
    const auto size =
        protocol::cobs_encode(view(data), protocol::MutableByteView(out.data(), out.size()));
    REQUIRE(size.ok());
    CHECK(to_hex(protocol::ByteView(out.data(), size.value())) ==
          item.at("encoded").get<std::string>());
    const auto frame_size =
        protocol::encode_frame(view(data), protocol::MutableByteView(out.data(), out.size()));
    REQUIRE(frame_size.ok());
    CHECK(to_hex(protocol::ByteView(out.data(), frame_size.value())) ==
          item.at("frame").get<std::string>());

    Bytes decoded(protocol::kMaxFrameDataSize);
    const protocol::MutableByteView decoded_view(decoded.data(), decoded.size());
    const auto decoded_size = protocol::cobs_decode(view(encoded), decoded_view);
    REQUIRE_MESSAGE(decoded_size.ok(), error_name(decoded_size.error()));
    CHECK(to_hex(protocol::ByteView(decoded.data(), decoded_size.value())) == to_hex(view(data)));
    if (last_code(encoded) == 0xFF) {
      // Decoders also accept the empty block after a final full block (section 10).
      Bytes padded = encoded;
      padded.push_back(0x01);
      const auto padded_size = protocol::cobs_decode(view(padded), decoded_view);
      REQUIRE(padded_size.ok());
      CHECK(to_hex(protocol::ByteView(decoded.data(), padded_size.value())) == to_hex(view(data)));
    }
  }
  for (const json& item : file.section("invalid")) {
    INFO("invalid: " << name_of(item));
    Bytes decoded(protocol::kMaxFrameDataSize);
    const auto result = protocol::cobs_decode(
        view(hex_of(item, "encoded")), protocol::MutableByteView(decoded.data(), decoded.size()));
    CHECK(error_name(result.error()) == item.at("error").get<std::string>());
  }
  for (const json& item : file.section("streams")) {
    INFO("stream: " << name_of(item));
    std::array<std::uint8_t, protocol::kMaxFrameDataSize> storage{};
    protocol::FrameDecoder decoder(storage);
    json frames = json::array();
    for (const json& chunk : item.at("chunks")) {
      for (const std::uint8_t byte : from_hex(chunk.get<std::string>())) {
        const protocol::FrameEvent event = decoder.push(byte);
        if (event.status == protocol::FrameStatus::frame) {
          frames.push_back({{"data", to_hex(event.data)}});
        } else if (event.status == protocol::FrameStatus::dropped) {
          frames.push_back({{"error", error_name(event.error)}});
        }
      }
    }
    CHECK(frames == item.at("frames"));
  }
}

void check_setup_messages(VectorFile& file) {
  for (const json& item : file.section("valid")) {
    INFO("valid: " << name_of(item));
    const Bytes bytes = hex_of(item, "bytes");
    bool visited = false;
    const Error error = protocol::decode_setup(view(bytes), [&](const auto& message) {
      using Message = std::decay_t<decltype(message)>;
      visited = true;
      CHECK(Message::type == item.at("setupType").get<int>());
      CHECK(to_json(message) == item.at("fields"));
      if (!item.at("canonical").get<bool>()) {
        return;
      }
      Arena arena;
      const auto built = struct_from_json<Message>(item.at("fields"), arena);
      Bytes out(256);
      const auto size =
          protocol::encode_setup(built, protocol::MutableByteView(out.data(), out.size()));
      REQUIRE(size.ok());
      CHECK(to_hex(protocol::ByteView(out.data(), size.value())) == to_hex(view(bytes)));
    });
    REQUIRE_MESSAGE(error == Error::none, error_name(error));
    CHECK(visited);
    // The USB frame carries exactly these bytes.
    const Bytes frame = hex_of(item, "frame");
    REQUIRE(!frame.empty());
    CHECK(frame.back() == 0);
    Bytes decoded(protocol::kMaxFrameDataSize);
    const auto size =
        protocol::cobs_decode(protocol::ByteView(frame.data(), frame.size() - 1),
                              protocol::MutableByteView(decoded.data(), decoded.size()));
    REQUIRE(size.ok());
    CHECK(to_hex(protocol::ByteView(decoded.data(), size.value())) == to_hex(view(bytes)));
    if (item.at("canonical").get<bool>()) {
      Bytes encoded(protocol::kMaxEncodedFrameSize + 1);
      const auto frame_size = protocol::encode_frame(
          view(bytes), protocol::MutableByteView(encoded.data(), encoded.size()));
      REQUIRE(frame_size.ok());
      CHECK(to_hex(protocol::ByteView(encoded.data(), frame_size.value())) == to_hex(view(frame)));
    }
  }
  for (const json& item : file.section("invalid")) {
    INFO("invalid: " << name_of(item));
    const Bytes bytes = hex_of(item, "bytes");
    const Error error = protocol::decode_setup(view(bytes), [](const auto&) {});
    CHECK(error_name(error) == item.at("error").get<std::string>());
    if (error == Error::unknown_type) {
      REQUIRE(bytes.size() >= 2);
      CHECK(bytes[1] == item.at("messageType").get<int>());
    }
  }
}

void check_pairing_data(VectorFile& file) {
  for (const json& item : file.section("valid")) {
    INFO("valid: " << name_of(item));
    const Bytes bytes = hex_of(item, "bytes");
    protocol::PairingData decoded;
    const Error error = protocol::decode_pairing_data(view(bytes), decoded);
    REQUIRE_MESSAGE(error == Error::none, error_name(error));
    CHECK(to_json(decoded) == item.at("fields"));
    if (item.at("canonical").get<bool>()) {
      Arena arena;
      const auto built = struct_from_json<protocol::PairingData>(item.at("fields"), arena);
      Bytes out(256);
      const auto size =
          protocol::encode_pairing_data(built, protocol::MutableByteView(out.data(), out.size()));
      REQUIRE(size.ok());
      CHECK(to_hex(protocol::ByteView(out.data(), size.value())) == to_hex(view(bytes)));
    }
  }
  for (const json& item : file.section("hubIdentity")) {
    INFO("hubIdentity: " << name_of(item));
    const Bytes key = hex_of(item, "firmwareSigningKey");
    REQUIRE(key.size() == protocol::SigningKey{}.size());
    protocol::SigningKey signing_key{};
    std::copy(key.begin(), key.end(), signing_key.begin());
    protocol::HubIdentity identity{};
    REQUIRE(psa::compute_hub_identity(signing_key, identity) == Error::none);
    CHECK(to_hex(identity) == item.at("hubIdentity").get<std::string>());
  }
  for (const json& item : file.section("invalid")) {
    INFO("invalid: " << name_of(item));
    protocol::PairingData decoded;
    const Error error = protocol::decode_pairing_data(view(hex_of(item, "bytes")), decoded);
    CHECK(error_name(error) == item.at("error").get<std::string>());
  }
}

void check_time_on_air(VectorFile& file) {
  for (const json& item : file.section("cases")) {
    INFO("time on air: " << item.dump());
    const auto data_rate = item.at("dataRate").get<std::uint8_t>();
    const auto spreading_factor = protocol::spreading_factor(data_rate);
    REQUIRE(spreading_factor.has_value());
    CHECK(*spreading_factor == item.at("spreadingFactor").get<int>());
    const auto time =
        protocol::time_on_air_microseconds(data_rate, item.at("length").get<std::size_t>());
    REQUIRE(time.ok());
    CHECK(time.value() == item.at("microseconds").get<std::uint32_t>());
    CHECK(std::fabs(time.value() / 1000.0 - item.at("milliseconds").get<double>()) < 1e-9);
  }
  int rates = 0;
  for (const json& item : file.section("eventListen")) {
    INFO("event listen: " << item.dump());
    const auto data_rate = item.at("dataRate").get<std::uint8_t>();
    const auto spreading_factor = protocol::spreading_factor(data_rate);
    REQUIRE(spreading_factor.has_value());
    CHECK(*spreading_factor == item.at("spreadingFactor").get<int>());
    const auto listen = protocol::event_listen_milliseconds(data_rate);
    REQUIRE(listen.ok());
    CHECK(listen.value() == item.at("milliseconds").get<int>());
    rates += 1;
  }
  CHECK(rates == static_cast<int>(protocol::DataRate::known.size()));
}

void check_units(VectorFile& file) {
  for (const json& item : file.section("batteryEncode")) {
    CHECK(protocol::battery_code_from_millivolts(item.at("millivolts").get<std::uint32_t>()) ==
          item.at("byte").get<int>());
  }
  for (const json& item : file.section("batteryDecode")) {
    CHECK(protocol::millivolts_from_battery_code(item.at("byte").get<std::uint8_t>()) ==
          item.at("millivolts").get<int>());
  }
  for (const json& item : file.section("fifteenSecondDecode")) {
    CHECK(protocol::seconds_from_fifteen_second_units(item.at("units").get<std::uint8_t>()) ==
          item.at("seconds").get<int>());
  }
  for (const json& item : file.section("fifteenSecondEncode")) {
    const auto units =
        protocol::fifteen_second_units_from_seconds(item.at("seconds").get<std::uint32_t>());
    if (item.at("units").is_null()) {
      CHECK_FALSE(units.has_value());
    } else {
      REQUIRE(units.has_value());
      CHECK(*units == item.at("units").get<int>());
    }
  }
  for (const json& item : file.section("tenthsDecode")) {
    CHECK(protocol::milliseconds_from_tenths(item.at("tenths").get<std::uint16_t>()) ==
          item.at("milliseconds").get<std::uint32_t>());
  }
  for (const json& item : file.section("tenthsEncode")) {
    const auto tenths =
        protocol::tenths_from_milliseconds(item.at("milliseconds").get<std::uint32_t>());
    if (item.at("tenths").is_null()) {
      CHECK_FALSE(tenths.has_value());
    } else {
      REQUIRE(tenths.has_value());
      CHECK(*tenths == item.at("tenths").get<int>());
    }
  }
  for (const json& item : file.section("clockCorrectionDecode")) {
    CHECK(protocol::ppm_from_clock_correction(item.at("units").get<std::int16_t>()) ==
          item.at("ppm").get<std::int32_t>());
  }
  for (const json& item : file.section("clockCorrectionEncode")) {
    const auto units = protocol::clock_correction_from_ppm(item.at("ppm").get<std::int32_t>());
    if (item.at("units").is_null()) {
      CHECK_FALSE(units.has_value());
    } else {
      REQUIRE(units.has_value());
      CHECK(*units == item.at("units").get<int>());
    }
  }
  for (const json& item : file.section("snrDecode")) {
    // The core gives hundredths of a decibel, exactly.
    const auto hundredths =
        protocol::snr_hundredths_db_from_quarters(item.at("quarterDecibels").get<std::int8_t>());
    CHECK(hundredths == std::lround(item.at("decibels").get<double>() * 100));
    CHECK(hundredths / 100.0 == item.at("decibels").get<double>());
  }
  for (const json& item : file.section("airtimeDecode")) {
    // The wire value already is the core's unit, hundredths of a percent.
    const auto hundredths = item.at("hundredthsOfPercent").get<std::uint16_t>();
    CHECK(std::fabs(hundredths / 100.0 - item.at("percent").get<double>()) < 1e-9);
  }
}

using Handler = void (*)(VectorFile&);

const std::map<std::string, Handler>& handlers() {
  static const std::map<std::string, Handler> map = {
      {"heartbeat.json", check_message_file},
      {"door-changed.json", check_message_file},
      {"cover-changed.json", check_message_file},
      {"button.json", check_message_file},
      {"started.json", check_message_file},
      {"started-update.json", check_started_update},
      {"update-query.json", check_message_file},
      {"update-status.json", check_message_file},
      {"update-offer.json", check_message_file},
      {"key-change.json", check_message_file},
      {"transfer-frames.json", check_transfer_frames},
      {"image-header.json", check_image_header},
      {"ble-update-session.json", check_ble_session},
      {"siren-report.json", check_message_file},
      {"hello.json", check_message_file},
      {"forwarded-packet.json", check_message_file},
      {"gateway-status.json", check_message_file},
      {"transmit-result.json", check_message_file},
      {"interference.json", check_message_file},
      {"log-entries.json", check_message_file},
      {"reply.json", check_message_file},
      {"disarmed-notice.json", check_message_file},
      {"siren-command.json", check_message_file},
      {"siren-settings.json", check_message_file},
      {"welcome.json", check_message_file},
      {"transmit-request.json", check_message_file},
      {"gateway-settings.json", check_message_file},
      {"rejected-packets.json", check_rejected_packets},
      {"counters.json", check_counters},
      {"cobs.json", check_cobs},
      {"setup-messages.json", check_setup_messages},
      {"pairing-data.json", check_pairing_data},
      {"time-on-air.json", check_time_on_air},
      {"units.json", check_units},
  };
  return map;
}

const std::filesystem::path kVectorsDir = HSN_VECTORS_DIR;

}  // namespace

/**
 * The entries of a vectors folder this harness neither handles nor leaves to the app channel's
 * own tests: each one is a device vector file nobody checks.
 */
std::vector<std::string> unhandled_entries(const std::filesystem::path& folder) {
  std::vector<std::string> unhandled;
  for (const auto& entry : std::filesystem::directory_iterator(folder)) {
    const std::string name = entry.path().filename().string();
    const bool app_channel = (entry.is_directory() && name == kAppVectorFolder) ||
                             (entry.is_regular_file() && name.rfind(kAppVectorPrefix, 0) == 0);
    if (!app_channel && handlers().count(name) == 0 && kNotVectors.count(name) == 0 &&
        kRelayVectors.count(name) == 0 && kPairingVectors.count(name) == 0) {
      unhandled.push_back(name);
    }
  }
  return unhandled;
}

TEST_CASE("the vectors folder holds only files the harness handles") {
  REQUIRE(std::filesystem::is_directory(kVectorsDir));
  for (const std::string& name : unhandled_entries(kVectorsDir)) {
    CHECK_MESSAGE(false, "vector file '" << name << "' is not handled by the harness");
  }
  for (const auto& entry : handlers()) {
    CHECK_MESSAGE(std::filesystem::exists(kVectorsDir / entry.first), "missing " << entry.first);
  }
}

TEST_CASE("the folder check leaves the app channel's vectors alone, and no device file") {
  // A copy of the rule's cases in a folder of its own: a stray device-side file is caught; a new
  // app vector file, the published Noise folder and the README are not.
  const char* temporary = std::getenv("TMPDIR");
  std::string pattern =
      std::string(temporary != nullptr ? temporary : "/tmp") + "/hsn-vectors-XXXXXX";
  REQUIRE(mkdtemp(pattern.data()) != nullptr);
  const std::filesystem::path folder = pattern;
  for (const char* name :
       {"foo.json", "app-x.json", "README.md", "cobs.json", "relay-xn.json", "relay-other.json"}) {
    std::ofstream(folder / name) << "{}";
  }
  std::filesystem::create_directory(folder / kAppVectorFolder);
  // A device-side folder of that prefix is no app vector file.
  std::filesystem::create_directory(folder / "app-folder");
  std::vector<std::string> unhandled = unhandled_entries(folder);
  std::sort(unhandled.begin(), unhandled.end());
  // The relay's files are listed by name: one not listed is caught like any other.
  CHECK(unhandled == std::vector<std::string>{"app-folder", "foo.json", "relay-other.json"});
  std::ofstream(folder / "pairing-board-qr.json") << "{}";
  std::ofstream(folder / "pairing-other.json") << "{}";
  unhandled = unhandled_entries(folder);
  std::sort(unhandled.begin(), unhandled.end());
  CHECK(unhandled == std::vector<std::string>{"app-folder", "foo.json", "pairing-other.json",
                                              "relay-other.json"});
  std::error_code ignored;
  std::filesystem::remove_all(folder, ignored);
}

/** Runs every file whose handler is `handler`, each in its own subcase. */
void run_files(Handler handler) {
  int files = 0;
  for (const auto& entry : handlers()) {
    if (entry.second != handler) {
      continue;
    }
    files += 1;
    SUBCASE(entry.first.c_str()) {
      VectorFile file(entry.first, load_json(kVectorsDir / entry.first));
      CHECK(file.section("schemaVersion") == 1);
      CHECK(file.section("protocolVersion") == 1);
      entry.second(file);
      file.check_all_handled();
    }
  }
  CHECK(files > 0);
}

// One test case per handler, so a fatal failure in one file cannot hide the others' results.
TEST_CASE("vectors: message files") {
  run_files(check_message_file);
}

TEST_CASE("vectors: rejected-packets.json") {
  run_files(check_rejected_packets);
}

TEST_CASE("vectors: counters.json") {
  run_files(check_counters);
}

TEST_CASE("vectors: cobs.json") {
  run_files(check_cobs);
}

TEST_CASE("vectors: setup-messages.json") {
  run_files(check_setup_messages);
}

TEST_CASE("vectors: pairing-data.json") {
  run_files(check_pairing_data);
}

TEST_CASE("vectors: time-on-air.json") {
  run_files(check_time_on_air);
}

TEST_CASE("vectors: units.json") {
  run_files(check_units);
}

TEST_CASE("vectors: started-update.json") {
  run_files(check_started_update);
}

TEST_CASE("vectors: transfer-frames.json") {
  run_files(check_transfer_frames);
}

TEST_CASE("vectors: image-header.json") {
  run_files(check_image_header);
}

TEST_CASE("vectors: ble-update-session.json") {
  run_files(check_ble_session);
}

TEST_CASE("vectors: every handler has a test case") {
  // A handler added to the map must also get a TEST_CASE above.
  const std::set<Handler> run = {
      check_message_file,   check_rejected_packets, check_counters,     check_cobs,
      check_setup_messages, check_pairing_data,     check_time_on_air,  check_units,
      check_started_update, check_transfer_frames,  check_image_header, check_ble_session};
  for (const auto& entry : handlers()) {
    CHECK_MESSAGE(run.count(entry.second) != 0, entry.first << " has no test case");
  }
}

}  // namespace hsn::test
