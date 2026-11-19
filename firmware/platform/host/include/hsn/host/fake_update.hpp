#pragma once

#include <psa/crypto.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <vector>

#include "hsn/device/hal/clock.hpp"
#include "hsn/device/hal/firmware_slots.hpp"
#include "hsn/device/hal/key_import.hpp"
#include "hsn/device/hal/update_crypto.hpp"
#include "hsn/device/time.hpp"
#include "hsn/host/call_meter.hpp"
#include "hsn/host/sim_flash.hpp"
#include "hsn/host/test_image.hpp"
#include "hsn/protocol/cipher.hpp"
#include "hsn/protocol/transfer.hpp"
#include "hsn/psa/psa_packet_cipher.hpp"
#include "hsn/psa/psa_update_crypto.hpp"

namespace hsn::host {

// The update interfaces' fakes (m3-updates-design.md sections 2 and 8): two slots of a test size on
// a SimFlash, with otadata's two copies and a fake bootloader that chooses a slot at every reset by
// ESP-IDF's rules; the update crypto on PSA; and the key import into the board's packet cipher.

/** The slots' size on the bench: 64 KB (‡ in the design), sixteen sectors. */
constexpr std::size_t kDefaultSlotSize = 64 * 1024;

/** ESP-IDF's image states in otadata (esp_ota_img_states_t). */
namespace ota_state {
constexpr std::uint32_t new_image = 0;
constexpr std::uint32_t pending_verify = 1;
constexpr std::uint32_t valid = 2;
constexpr std::uint32_t invalid = 3;
constexpr std::uint32_t aborted = 4;
/** An image written before rollback existed, or a copy whose state was never set. */
constexpr std::uint32_t undefined = 0xFFFFFFFF;
}  // namespace ota_state

/**
 * One otadata copy, as ESP-IDF's esp_ota_select_entry_t lays it out: a sequence number (the
 * selected slot is (seq - 1) mod 2), a 20-byte label, the state, and a CRC of the sequence number.
 * The CRC here is the protocol's CRC-32 over the sequence number's four bytes, standing in for the
 * ROM's crc32_le; a copy is torn when it does not match.
 */
struct OtaEntry {
  static constexpr std::size_t kSize = 32;

  std::uint32_t seq = 0xFFFFFFFF;
  std::uint32_t state = ota_state::undefined;
  std::uint32_t crc = 0xFFFFFFFF;

  /** The CRC an entry with this sequence number carries. */
  static std::uint32_t crc_of(std::uint32_t seq);

  /** An entry with its CRC filled in. */
  static OtaEntry make(std::uint32_t seq, std::uint32_t state);

  /** Reads one from its 32 bytes. */
  static OtaEntry read(protocol::ByteView bytes);

  /** Its 32 bytes. */
  std::array<std::uint8_t, kSize> bytes() const;

  /** Erased, never written. */
  bool blank() const {
    return seq == 0xFFFFFFFF;
  }

  /** Written whole: not blank and its CRC matches. */
  bool intact() const {
    return !blank() && crc == crc_of(seq);
  }

  /** Bootable by the bootloader's rule: intact, and neither refused (INVALID) nor ABORTED. */
  bool usable() const {
    return intact() && state != ota_state::invalid && state != ota_state::aborted;
  }

  /** The slot it selects: 0 or 1. */
  std::uint8_t slot() const {
    return static_cast<std::uint8_t>((seq - 1) % 2);
  }
};

/** What the fake bootloader chose at one reset. */
struct BootChoice {
  /** A slot held an image that passed its check. */
  bool bootable = false;
  /** The power was cut during one of the bootloader's own otadata writes: nothing booted. */
  bool cut = false;
  /** The slot it runs. */
  std::uint8_t slot = 0;
  /** What running() reports for this boot. */
  device::BootImage image;
  /** It found the selected image on trial (PENDING_VERIFY) and marked it ABORTED. */
  bool aborted_trial = false;
  /** The selected slot's image failed its check, and it ran the other. */
  bool fell_back = false;
};

/**
 * The two application slots on one SimFlash: otadata's two 4 KB copies at the start, then slot 0
 * (ota_0), then slot 1 (ota_1), each `slot_size` bytes. The slot not running is the one written:
 * its offsets count from its first byte, where the ESP application image starts (the update
 * record, not the slot, keeps the 128-byte header). A board is made with an image in slot 0 and
 * otadata blank, as the first serial flash leaves it, which boots slot 0 (design section 2).
 *
 * boot() is the fake bootloader, run by the SimDevice at every reset (a deep-sleep wake included)
 * before the device's objects are built:
 *
 * 1. The selected copy is the intact copy with the highest sequence number that is neither INVALID
 *    nor ABORTED; with none, slot 0.
 * 2. A selected image found PENDING_VERIFY was on trial at a reset: its copy is rewritten ABORTED,
 *    in place, and the choice is made again (a rollback).
 * 3. A selected image found NEW is rewritten PENDING_VERIFY, in place, and boots on trial.
 * 4. A selected image that fails its check (check_test_image) is passed over for the other slot's,
 *    without a write; when neither passes, nothing boots.
 * 5. The boot reports a rollback (BootImage::rolled_back, with the version the other slot's image
 *    names, zeros if none) while the newest intact copy, whatever its state, names the slot not
 *    booted: from the rollback until the next select() overwrites that copy.
 *
 * select() writes a NEW copy for the other slot into the copy not selected, with the next sequence
 * number; confirm() and reject() rewrite the running image's copy in place (VALID, INVALID), as
 * ESP-IDF does. Each of these writes, and each of the bootloader's, is one flash operation. A
 * torn write leaves a copy whose CRC fails: a torn select() leaves the old image selected; a torn
 * confirm() leaves the copy of the image before it selected, so that image boots without a
 * rollback reported (ESP-IDF's in-place write; the design's section 6 expects "still on trial,
 * then rolled back", which only a copy-on-write scheme could give).
 */
class FakeFirmwareSlots final : public device::FirmwareSlots, public Metered {
public:
  /** One call that changed (or tried to change) the slots or otadata. */
  struct Operation {
    enum class Kind { erase, write, select, confirm, reject, bootloader };
    device::Instant at;
    Kind kind = Kind::erase;
    std::uint32_t offset = 0;
    std::uint32_t length = 0;
    /** The state written, for otadata writes. */
    std::uint32_t state = 0;
    device::HalError result = device::HalError::none;
    /** The running image was on trial when it was made. */
    bool on_trial = false;
  };

  FakeFirmwareSlots(const device::Clock& clock, std::size_t slot_size = kDefaultSlotSize,
                    std::uint64_t seed = 1);

  device::BootImage running() override;
  std::uint32_t capacity() override;
  device::HalError erase(std::uint32_t offset) override;
  device::HalError write(std::uint32_t offset, protocol::ByteView bytes) override;
  device::HalError read(std::uint32_t offset, protocol::MutableByteView out) override;
  device::HalError select() override;
  device::HalError confirm() override;
  device::HalError reject() override;

  /** The fake bootloader: chooses this reset's slot by the rules above. */
  BootChoice boot();

  /**
   * Puts `image` at the start of `slot` as a factory programmer does over serial: not an
   * operation, never cut. Otadata is left as it is.
   */
  void install(std::uint8_t slot, protocol::ByteView image);

  /** Erases otadata as a serial flash does: the next boot runs slot 0. */
  void blank_otadata();

  /** Writes an otadata copy directly, as a factory programmer would: for tests of the rules. */
  void put_entry(std::size_t index, const OtaEntry& entry);

  /** Reads otadata copy 0 or 1. */
  OtaEntry entry(std::size_t index) const;

  /** The slot this boot runs. */
  std::uint8_t running_slot() const {
    return running_;
  }

  /** The bytes of `slot` (0 or 1), for tests. */
  protocol::ByteView slot_bytes(std::uint8_t slot) const;

  /** The image check of what `slot` holds, cached until its bytes change. */
  ImageCheck check(std::uint8_t slot) const;

  /** Erases and writes of the other slot made while the running image was on trial. */
  std::size_t writes_on_trial() const;

  /** What running() reports: set by boot(), and by a test that runs a board without one. */
  device::BootImage image;
  /**
   * True while the slots are as the board was made (HostBoard sets it): no operation, install or
   * otadata change since. Such a board's image follows a test's change to hal().build.version.
   */
  bool as_made = false;
  /** otadata's two copies, then slot 0, then slot 1. */
  SimFlash flash;
  std::vector<Operation> operations;

private:
  std::uint32_t slot_base(std::uint8_t slot) const;
  std::uint8_t other() const {
    return static_cast<std::uint8_t>(1 - running_);
  }
  int selected_entry() const;
  int newest_intact_entry() const;
  device::HalError write_entry(std::size_t index, const OtaEntry& entry, Operation::Kind kind);
  void record(Operation::Kind kind, std::uint32_t offset, std::uint32_t length, std::uint32_t state,
              device::HalError result);

  const device::Clock& clock_;
  std::size_t slot_size_;
  std::uint8_t running_ = 0;
  /** The otadata copy this boot's image was selected by; -1 when otadata was blank. */
  int running_entry_ = -1;
  /** IDs of OTA selections that landed. A simulated reset keeps these with the slot contents. */
  std::array<std::optional<protocol::ImageId>, 2> selected_ids_{};
  struct Cached {
    std::uint64_t generation = 0;
    bool valid = false;
    ImageCheck check;
  };
  mutable std::array<Cached, 2> cache_{};
};

/**
 * The device key the board's platform holds: the one its packet cipher uses and the Bluetooth
 * session key is derived from. KeyImport replaces it (the key change after a restore). The key is
 * kept in memory only, never printed.
 */
class FakeKeyImport final : public device::KeyImport, public Metered {
public:
  explicit FakeKeyImport(psa::PsaPacketCipher& cipher) : cipher_(cipher) {}

  /** Imports the key into the cipher; HalError::io (and the old key kept) when refused. */
  device::HalError import_key(const protocol::DeviceKey& key) override;

  /** The platform's own import at start-up (not a call of the core): HostBoard::set_key. */
  bool load(const protocol::DeviceKey& key);

  /** The key held, if any. */
  const std::optional<protocol::DeviceKey>& key() const {
    return key_;
  }

  /** Successful imports by the core (not the platform's own at start-up). */
  std::size_t imports = 0;
  /** Fault switch: the next import is refused. */
  bool fail_next = false;

private:
  psa::PsaPacketCipher& cipher_;
  std::optional<protocol::DeviceKey> key_;
};

/**
 * The update crypto, computed for real by hsn_psa's PsaUpdateCrypto, the code the board runs (on
 * TF-PSA-Crypto, which the host build links): SHA-256, P-256 verification, the Bluetooth session
 * key (HKDF-SHA256) from the key the board holds, and HMAC-SHA256. This adds the call meter and
 * the counts, and hands PsaUpdateCrypto the key FakeKeyImport holds before each session key.
 */
class FakeUpdateCrypto final : public device::UpdateCrypto, public Metered {
public:
  explicit FakeUpdateCrypto(const FakeKeyImport& keys) : keys_(keys) {}
  ~FakeUpdateCrypto() = default;
  FakeUpdateCrypto(const FakeUpdateCrypto&) = delete;
  FakeUpdateCrypto& operator=(const FakeUpdateCrypto&) = delete;

  device::HalError sha256_start() override;
  device::HalError sha256_add(protocol::ByteView bytes) override;
  device::HalError sha256_finish(protocol::MutableByteView digest) override;
  bool verify_p256(protocol::ByteView public_xy, protocol::ByteView digest,
                   protocol::ByteView signature_rs) override;
  device::HalError session_key(protocol::ByteView nonce, std::uint32_t address,
                               protocol::MutableByteView out) override;
  device::HalError hmac_sha256(protocol::ByteView key, protocol::ByteView message,
                               protocol::MutableByteView out) override;

  /** Signature checks made, and how many passed. */
  std::size_t verifications = 0;
  std::size_t verified = 0;

private:
  const FakeKeyImport& keys_;
  psa::PsaUpdateCrypto psa_;
};

/** A Bluetooth session key: 32 bytes. */
using SessionKey = std::array<std::uint8_t, device::kSessionKeySize>;

/**
 * The hub's and the phone's side of the session (m3-updates-design.md section 5), on the same PSA
 * path as FakeUpdateCrypto: K = HKDF-SHA256(key, salt = nonce, info = label, address u32 LE).
 * Throws SimulationError if PSA fails.
 */
SessionKey derive_session_key(const protocol::DeviceKey& key, protocol::ByteView nonce,
                              std::uint32_t address);

/**
 * An Open frame's tag: the first 16 bytes of HMAC-SHA256(K, "hsn-ble-open/1", a zero byte, the
 * address u32 LE, the device random, the image id). Throws SimulationError if PSA fails.
 */
protocol::SessionTag open_tag(const SessionKey& session_key, std::uint32_t address,
                              const protocol::DeviceRandom& device_random,
                              const protocol::ImageId& image);

}  // namespace hsn::host
