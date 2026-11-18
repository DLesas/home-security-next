// The two slots, otadata and the fake bootloader (m3-updates-design.md sections 2 and 6): what
// boots at every state of an image, and what a torn otadata write leaves; the test images and the
// hub's signing of their headers.

#include <doctest/doctest.h>

#include <cstdint>
#include <filesystem>

#include "hsn/host/fake_update.hpp"
#include "hsn/host/host_board.hpp"
#include "hsn/host/test_image.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using device::HalError;
using host::BootChoice;
using host::CutPoint;
using host::FakeFirmwareSlots;
using host::OtaEntry;
namespace ota = host::ota_state;

constexpr std::size_t kSector = device::kSlotSectorSize;
const protocol::FirmwareVersion kOld{0, 1, 0};
const protocol::FirmwareVersion kNew{1, 4, 0};

bool same(const protocol::FirmwareVersion& a, const protocol::FirmwareVersion& b) {
  return a.major == b.major && a.minor == b.minor && a.patch == b.patch;
}

/** Writes an image into the other slot through the interface, as UpdateService does. */
void write_other(FakeFirmwareSlots& slots, const Bytes& image) {
  for (std::uint32_t offset = 0; offset < image.size(); offset += kSector) {
    REQUIRE(slots.erase(offset) == HalError::none);
    const std::size_t length = std::min<std::size_t>(kSector, image.size() - offset);
    REQUIRE(slots.write(offset, protocol::ByteView(image.data() + offset, length)) ==
            HalError::none);
  }
}

/** A board as made (version 0.1.0 in slot 0, otadata blank) with 1.4.0 written and selected. */
struct Selected {
  Selected() {
    write_other(board.slots, host::make_test_image(kNew, 6000));
    REQUIRE(board.slots.select() == HalError::none);
  }
  host::HostBoard board;
};

TEST_CASE("a board as made runs slot 0, confirmed, and its boots write nothing") {
  host::HostBoard board;
  for (int i = 0; i < 3; ++i) {
    const BootChoice choice = board.run_bootloader();
    REQUIRE(choice.bootable);
    CHECK(choice.slot == 0);
    CHECK(same(choice.image.version, kOld));
    CHECK_FALSE(choice.image.on_trial);
    CHECK_FALSE(choice.image.rolled_back);
    CHECK_FALSE(choice.aborted_trial);
  }
  CHECK(board.slots.operations.empty());
  CHECK(board.slots.entry(0).blank());
  CHECK(board.slots.entry(1).blank());
  CHECK(board.slots.capacity() == host::kDefaultSlotSize);
}

TEST_CASE("a board as made follows a version set before its first boot") {
  host::HostBoard board;
  board.hal().build.version = protocol::FirmwareVersion{2, 3, 4};
  const BootChoice choice = board.run_bootloader();
  CHECK(same(choice.image.version, protocol::FirmwareVersion{2, 3, 4}));
  CHECK(same(board.slots.running().version, protocol::FirmwareVersion{2, 3, 4}));
  // Once anything has touched its slots, the image rules and the build follows it.
  write_other(board.slots, host::make_test_image(kNew, 3000));
  board.hal().build.version = protocol::FirmwareVersion{9, 9, 9};
  CHECK(same(board.run_bootloader().image.version, protocol::FirmwareVersion{2, 3, 4}));
  CHECK(same(board.hal().build.version, protocol::FirmwareVersion{2, 3, 4}));
}

TEST_CASE("select marks the other slot NEW; its first boot is a trial; confirm makes it VALID") {
  Selected selected;
  FakeFirmwareSlots& slots = selected.board.slots;
  // Blank otadata: the first copy gets the sequence number that names slot 1.
  const OtaEntry written = slots.entry(0);
  CHECK(written.intact());
  CHECK(written.seq == 2);
  CHECK(written.slot() == 1);
  CHECK(written.state == ota::new_image);
  CHECK(slots.entry(1).blank());
  // A second select writes nothing more.
  const std::uint64_t selected_generation = slots.flash.generation();
  CHECK(slots.select() == HalError::none);
  CHECK(slots.entry(0).seq == 2);
  CHECK(slots.flash.generation() == selected_generation);

  BootChoice choice = selected.board.run_bootloader();
  REQUIRE(choice.bootable);
  CHECK(choice.slot == 1);
  CHECK(same(choice.image.version, kNew));
  CHECK(choice.image.on_trial);
  CHECK_FALSE(choice.image.rolled_back);
  CHECK(slots.entry(0).state == ota::pending_verify);
  CHECK(same(selected.board.hal().build.version, kNew));

  CHECK(slots.confirm() == HalError::none);
  CHECK(slots.entry(0).state == ota::valid);
  CHECK_FALSE(slots.running().on_trial);
  // Confirming again writes nothing.
  const std::uint64_t generation = slots.flash.generation();
  CHECK(slots.confirm() == HalError::none);
  CHECK(slots.flash.generation() == generation);

  choice = selected.board.run_bootloader();
  CHECK(choice.slot == 1);
  CHECK_FALSE(choice.image.on_trial);
  CHECK_FALSE(choice.image.rolled_back);
  CHECK(slots.flash.generation() == generation);
}

TEST_CASE("a reset on trial rolls back, and the rollback is reported until the next select") {
  Selected selected;
  FakeFirmwareSlots& slots = selected.board.slots;
  REQUIRE(selected.board.run_bootloader().image.on_trial);
  // Any reset: power cut, watchdog, deep-sleep wake — the bootloader runs again.
  BootChoice choice = selected.board.run_bootloader();
  CHECK(choice.aborted_trial);
  CHECK(choice.slot == 0);
  CHECK(same(choice.image.version, kOld));
  CHECK_FALSE(choice.image.on_trial);
  CHECK(choice.image.rolled_back);
  CHECK(same(choice.image.failed, kNew));
  CHECK(slots.entry(0).state == ota::aborted);
  CHECK(same(selected.board.hal().build.version, kOld));
  // Still reported at the next boot; no more writes.
  const std::uint64_t generation = slots.flash.generation();
  choice = selected.board.run_bootloader();
  CHECK(choice.image.rolled_back);
  CHECK_FALSE(choice.aborted_trial);
  CHECK(slots.flash.generation() == generation);
  // The next update overwrites the aborted copy, and the report ends.
  write_other(slots, host::make_test_image(protocol::FirmwareVersion{1, 4, 1}, 5000));
  CHECK(slots.select() == HalError::none);
  CHECK(slots.entry(0).state == ota::new_image);
  choice = selected.board.run_bootloader();
  CHECK(choice.slot == 1);
  CHECK(choice.image.on_trial);
  CHECK_FALSE(choice.image.rolled_back);
}

TEST_CASE("reject on trial marks the image INVALID: the next boot runs the other, rolled back") {
  Selected selected;
  FakeFirmwareSlots& slots = selected.board.slots;
  REQUIRE(selected.board.run_bootloader().image.on_trial);
  CHECK(slots.reject() == HalError::none);
  CHECK(slots.entry(0).state == ota::invalid);
  const BootChoice choice = selected.board.run_bootloader();
  CHECK(choice.slot == 0);
  CHECK_FALSE(choice.aborted_trial);
  CHECK(choice.image.rolled_back);
  CHECK(same(choice.image.failed, kNew));
}

TEST_CASE("reject needs an image to go back to; the factory image cannot be refused") {
  host::HostBoard board;
  CHECK(board.slots.reject() == HalError::invalid);
  CHECK(board.slots.entry(0).blank());
}

TEST_CASE("select refuses an image that fails its check, and writes nothing") {
  host::HostBoard board;
  Bytes image = host::make_test_image(kNew, 5000);
  image[2000] ^= 0x01;  // breaks the checksum and the appended hash
  write_other(board.slots, image);
  CHECK(board.slots.select() == HalError::invalid);
  CHECK(board.slots.entry(0).blank());
  CHECK(board.slots.entry(1).blank());
  // An erased slot is no image either.
  host::HostBoard empty;
  CHECK(empty.slots.select() == HalError::invalid);
}

TEST_CASE("a selected image damaged after select is passed over for the other, as a rollback") {
  Selected selected;
  FakeFirmwareSlots& slots = selected.board.slots;
  // Damage slot 1 behind the interface's back: its first sector erased.
  REQUIRE(slots.erase(0) == HalError::none);
  BootChoice choice = selected.board.run_bootloader();
  REQUIRE(choice.bootable);
  CHECK(choice.fell_back);
  CHECK(choice.slot == 0);
  CHECK_FALSE(choice.image.on_trial);
  CHECK(choice.image.rolled_back);
  // The failed image's version cannot be read: zeros.
  CHECK(same(choice.image.failed, protocol::FirmwareVersion{}));
  // Its copy was left on trial: the next boot aborts it, and still runs slot 0.
  choice = selected.board.run_bootloader();
  CHECK(choice.aborted_trial);
  CHECK(choice.slot == 0);
}

TEST_CASE("when neither slot holds a good image, nothing boots") {
  host::HostBoard board;
  board.slots.install(0, protocol::ByteView());
  const BootChoice choice = board.run_bootloader();
  CHECK_FALSE(choice.bootable);
}

TEST_CASE("the newest usable copy selects; INVALID and ABORTED copies never do") {
  host::HostBoard board;
  FakeFirmwareSlots& slots = board.slots;
  const Bytes image = host::make_test_image(kNew, 3000);
  slots.install(1, view(image));
  slots.put_entry(0, OtaEntry::make(5, ota::valid));  // slot 0
  slots.put_entry(1, OtaEntry::make(6, ota::valid));  // slot 1, newer
  CHECK(board.run_bootloader().slot == 1);
  slots.put_entry(1, OtaEntry::make(6, ota::invalid));
  BootChoice choice = board.run_bootloader();
  CHECK(choice.slot == 0);
  CHECK(choice.image.rolled_back);
  slots.put_entry(1, OtaEntry::make(6, ota::aborted));
  CHECK(board.run_bootloader().slot == 0);
  // A copy whose CRC fails is ignored: the older one selects, with no rollback to report.
  OtaEntry torn = OtaEntry::make(7, ota::valid);
  torn.crc ^= 1u;
  slots.put_entry(1, torn);
  choice = board.run_bootloader();
  CHECK(choice.slot == 0);
  CHECK_FALSE(choice.image.rolled_back);
  // An image of the old days (UNDEFINED) boots as confirmed.
  slots.put_entry(1, OtaEntry::make(8, ota::undefined));
  choice = board.run_bootloader();
  CHECK(choice.slot == 1);
  CHECK_FALSE(choice.image.on_trial);
}

TEST_CASE("two updates in turn alternate the slots and the copies") {
  host::HostBoard board;
  FakeFirmwareSlots& slots = board.slots;
  write_other(slots, host::make_test_image(kNew, 3000));
  REQUIRE(slots.select() == HalError::none);
  REQUIRE(board.run_bootloader().slot == 1);
  REQUIRE(slots.confirm() == HalError::none);
  const protocol::FirmwareVersion third{1, 5, 0};
  write_other(slots, host::make_test_image(third, 3000));
  REQUIRE(slots.select() == HalError::none);
  // Into the copy not selected, with the next sequence number, which names slot 0.
  CHECK(slots.entry(0).seq == 2);
  CHECK(slots.entry(0).state == ota::valid);
  CHECK(slots.entry(1).seq == 3);
  CHECK(slots.entry(1).slot() == 0);
  CHECK(slots.entry(1).state == ota::new_image);
  const BootChoice choice = board.run_bootloader();
  CHECK(choice.slot == 0);
  CHECK(same(choice.image.version, third));
  CHECK(choice.image.on_trial);
  // A rollback from it goes back to slot 1's confirmed image.
  const BootChoice back = board.run_bootloader();
  CHECK(back.slot == 1);
  CHECK(same(back.image.version, kNew));
  CHECK(back.image.rolled_back);
  CHECK(same(back.image.failed, third));
}

TEST_CASE("a torn select leaves the old image selected, with no rollback") {
  host::HostBoard board;
  write_other(board.slots, host::make_test_image(kNew, 3000));
  board.power_cut.arm(1, CutPoint::during);
  CHECK(board.slots.select() == HalError::io);
  board.power_cut.restore();
  CHECK_FALSE(board.slots.entry(0).intact());
  const BootChoice choice = board.run_bootloader();
  CHECK(choice.slot == 0);
  CHECK_FALSE(choice.image.on_trial);
  CHECK_FALSE(choice.image.rolled_back);
  // The same select again goes through.
  CHECK(board.slots.select() == HalError::none);
  CHECK(board.run_bootloader().slot == 1);
}

TEST_CASE("a torn confirm boots the image before it, as ESP-IDF's in-place write would") {
  Selected selected;
  host::HostBoard& board = selected.board;
  REQUIRE(board.run_bootloader().image.on_trial);
  board.power_cut.arm(1, CutPoint::during);
  CHECK(board.slots.confirm() == HalError::io);
  CHECK(board.slots.running().on_trial);
  board.power_cut.restore();
  const BootChoice choice = board.run_bootloader();
  REQUIRE(choice.bootable);
  CHECK(choice.slot == 0);
  CHECK(same(choice.image.version, kOld));
  // The torn copy left no trace of the trial: no rollback is reported (see FakeFirmwareSlots).
  CHECK_FALSE(choice.image.rolled_back);
  // A confirm cut after its write is whole: the new image stays.
  Selected again;
  REQUIRE(again.board.run_bootloader().image.on_trial);
  again.board.power_cut.arm(1, CutPoint::after);
  CHECK(again.board.slots.confirm() == HalError::none);
  again.board.power_cut.restore();
  CHECK(again.board.run_bootloader().slot == 1);
}

TEST_CASE("a cut during the bootloader's own write is reported and boots the old image after") {
  // Cutting the NEW → PENDING_VERIFY write.
  Selected selected;
  host::HostBoard& board = selected.board;
  board.power_cut.arm(1, CutPoint::during);
  BootChoice choice = board.run_bootloader();
  CHECK(choice.cut);
  CHECK_FALSE(choice.bootable);
  board.power_cut.restore();
  choice = board.run_bootloader();
  CHECK(choice.slot == 0);
  CHECK_FALSE(choice.image.on_trial);
  // Cutting the PENDING_VERIFY → ABORTED write: the copy is torn, and slot 0 runs.
  Selected trial;
  REQUIRE(trial.board.run_bootloader().image.on_trial);
  trial.board.power_cut.arm(1, CutPoint::during);
  CHECK(trial.board.run_bootloader().cut);
  trial.board.power_cut.restore();
  choice = trial.board.run_bootloader();
  CHECK(choice.slot == 0);
  CHECK_FALSE(choice.image.on_trial);
}

TEST_CASE("the slots check their arguments and write only the slot not running") {
  host::HostBoard board;
  FakeFirmwareSlots& slots = board.slots;
  const std::uint32_t capacity = slots.capacity();
  Bytes big(kSector + 1, 0);
  Bytes small(16, 0x42);
  Bytes out(16);
  CHECK(slots.erase(1) == HalError::invalid);
  CHECK(slots.erase(capacity) == HalError::invalid);
  CHECK(slots.erase(capacity - kSector) == HalError::none);
  CHECK(slots.write(0, view(big)) == HalError::invalid);
  CHECK(slots.write(capacity - 15, view(small)) == HalError::invalid);
  CHECK(slots.write(capacity - 16, view(small)) == HalError::none);
  CHECK(slots.read(capacity - 15, protocol::MutableByteView(out.data(), out.size())) ==
        HalError::invalid);
  CHECK(slots.read(capacity - 16, protocol::MutableByteView(out.data(), out.size())) ==
        HalError::none);
  CHECK(out == small);
  // The running slot (0) is untouched: its image still passes.
  CHECK(slots.check(0).ok);
  CHECK(slots.slot_bytes(1)[capacity - 16] == 0x42);
  // Erases and writes made on trial are counted (the design allows none).
  CHECK(slots.writes_on_trial() == 0);
  slots.image.on_trial = true;
  CHECK(slots.erase(0) == HalError::none);
  CHECK(slots.writes_on_trial() == 1);
}

TEST_CASE("a test image passes the check; any broken part fails it") {
  const Bytes image = host::make_test_image(protocol::FirmwareVersion{1, 22, 3}, 5000, 9);
  CHECK(image.size() >= 5000);
  CHECK(image.size() <= 5018);
  const host::ImageCheck check = host::check_test_image(view(image));
  REQUIRE(check.ok);
  CHECK(same(check.version, protocol::FirmwareVersion{1, 22, 3}));
  CHECK(check.bytes == image.size());
  CHECK(image[0] == host::kEspImageMagic);
  CHECK(image[12] == 9);
  // Trailing bytes in the slot do not matter.
  Bytes slot = image;
  slot.resize(image.size() + 4096, 0xFF);
  CHECK(host::check_test_image(view(slot)).ok);
  // Each part checked: magic, chip, the app description's magic, a data byte, the hash.
  for (const std::size_t at : {std::size_t{0}, std::size_t{12}, std::size_t{32}, std::size_t{48},
                               std::size_t{3000}, image.size() - 33, image.size() - 1}) {
    CAPTURE(at);
    Bytes broken = image;
    broken[at] ^= 0x01;
    CHECK_FALSE(host::check_test_image(view(broken)).ok);
  }
  host::TestImageSpec other_chip;
  other_chip.version = protocol::FirmwareVersion{1, 0, 0};
  other_chip.chip_id = 4;
  CHECK_FALSE(host::check_test_image(view(host::make_test_image(other_chip))).ok);
  CHECK_FALSE(host::check_test_image(protocol::ByteView(image.data(), 100)).ok);
  CHECK_FALSE(host::check_test_image(protocol::ByteView()).ok);
  // A version is still read from a broken image.
  Bytes broken = image;
  broken[3000] ^= 0x01;
  const auto version = host::version_in_image(view(broken));
  REQUIRE(version.has_value());
  CHECK(same(*version, protocol::FirmwareVersion{1, 22, 3}));
  CHECK_FALSE(host::version_in_image(view(Bytes(600, 0xFF))).has_value());
  // Two seeds of one version differ.
  CHECK(host::make_test_image(kNew, 3000, 1) != host::make_test_image(kNew, 3000, 2));
}

TEST_CASE("the hub's signing key signs headers as the vectors do") {
  const json file = load_json(std::filesystem::path(HSN_VECTORS_DIR) / "image-header.json");
  host::SigningScalar scalar{};
  const Bytes private_key = from_hex(file.at("signingPrivateKey").get<std::string>());
  REQUIRE(private_key.size() == scalar.size());
  std::copy(private_key.begin(), private_key.end(), scalar.begin());
  CHECK(scalar == host::kRfc6979TestKey);
  const host::HubSigningKey key(scalar);
  CHECK(to_hex(protocol::ByteView(key.public_key())) == file.at("signingKey").get<std::string>());
  CHECK(to_hex(protocol::ByteView(key.identity())) == file.at("hubIdentity").get<std::string>());
  for (const json& valid : file.at("valid")) {
    CAPTURE(valid.at("name").get<std::string>());
    const Bytes header_bytes = from_hex(valid.at("header").get<std::string>());
    protocol::ImageHeader header;
    REQUIRE(protocol::decode_image_header(view(header_bytes), header) == protocol::Error::none);
    CHECK(to_hex(protocol::ByteView(host::HubSigningKey::signed_digest(header))) ==
          valid.at("signedSha256").get<std::string>());
    protocol::ImageHeader resigned = header;
    resigned.signature = {};
    key.sign(resigned);
    // Deterministic (RFC 6979): the same signature, byte for byte.
    CHECK(to_hex(protocol::ByteView(resigned.signature)) ==
          valid.at("signature").get<std::string>());
    CHECK(host::header_bytes(resigned) == header_bytes);
  }
}

TEST_CASE("header_for describes the image and its file is the header then the image") {
  const host::HubSigningKey key;
  const Bytes image = host::make_test_image(kNew, 4000);
  const protocol::ImageHeader header = key.header_for(view(image), true);
  CHECK(header.flags.own_build);
  CHECK(header.roles == 0x0E);
  CHECK(header.target == protocol::kImageTargetEsp32s3);
  CHECK(same(header.version, kNew));
  CHECK(header.image_bytes == image.size());
  CHECK(header.image_sha256 == host::sha256_of(view(image)));
  CHECK(header.hub_identity == key.identity());
  const Bytes file = host::image_file(header, view(image));
  CHECK(file.size() == protocol::kImageHeaderSize + image.size());
  CHECK(Bytes(file.begin() + protocol::kImageHeaderSize, file.end()) == image);
  // The signature verifies under the public key, through the device's own crypto.
  host::HostBoard board;
  const protocol::Sha256Digest digest = host::HubSigningKey::signed_digest(header);
  CHECK(board.update_crypto.verify_p256(protocol::ByteView(key.public_key()),
                                        protocol::ByteView(digest),
                                        protocol::ByteView(header.signature)));
}

}  // namespace
}  // namespace hsn::test
