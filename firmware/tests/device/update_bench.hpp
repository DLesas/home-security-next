#pragma once

// A bench for UpdateService's tests (m3-updates-design.md section 8), independent of hsn_host's
// update fakes: its own flash with a fake bootloader and a power switch that cuts after the Nth
// operation, its own storage on the same switch, update crypto on real PSA (SHA-256, P-256,
// HMAC-SHA256 and the session key's HKDF), links that record what the device sends, a hub and a
// phone that serve a file, and a loop that drives the device between them.

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "device_support.hpp"
#include "hsn/device/device.hpp"
#include "hsn/device/hal/firmware_slots.hpp"
#include "hsn/device/hal/update_crypto.hpp"
#include "hsn/device/runner.hpp"
#include "hsn/device/services.hpp"
#include "hsn/device/services/update.hpp"
#include "hsn/protocol/image.hpp"
#include "hsn/protocol/transfer.hpp"
#include "hsn/psa/psa_packet_cipher.hpp"
#include "support.hpp"

namespace hsn::test::update {

using device::HalError;
using device::LinkKind;

/** The vectors' hub (image-header.json): its identity, signing key and private scalar. */
Bytes vector_hub_identity();
Bytes vector_signing_key();
Bytes vector_signing_private();

// ---- Power and flash ----

/** One operation on the board's flash, in the order the device made it. */
struct FlashOp {
  enum class Kind {
    slot_erase,
    slot_write,
    slot_read,
    select,
    confirm,
    reject,
    record_write,
    record_erase,
  };
  Kind kind = Kind::slot_erase;
  std::uint32_t offset = 0;
  std::size_t size = 0;
  device::StoreKey key = device::StoreKey::role;
};

const char* name_of(FlashOp::Kind kind);

/**
 * The board's supply. Every flash operation asks it first; with a budget, the operation after the
 * budget's last is cut part-way and everything after it finds the power off until the board is
 * started again.
 */
class PowerSwitch {
public:
  enum class Outcome {
    /** The operation runs in full. */
    done,
    /** The power fails during it. */
    cut,
    /** The power is already off. */
    off,
  };

  Outcome begin(const FlashOp& op);

  /** Power back on, with no budget: the board starts again. */
  void restore() {
    on = true;
    budget.reset();
  }

  bool on = true;
  std::optional<std::size_t> budget;
  /** Operations that ran in full since the bench was made. */
  std::vector<FlashOp> ops;
  /** The operation the power failed in. */
  std::optional<FlashOp> cut_in;
};

/** Records in flash, whole or nothing, on the power switch. */
class TestStorage final : public device::Storage {
public:
  explicit TestStorage(PowerSwitch& power) : power_(power) {}

  device::HalResult<std::size_t> read(device::StoreKey key, protocol::MutableByteView out) override;
  HalError write(device::StoreKey key, protocol::ByteView value) override;
  HalError erase(device::StoreKey key) override;
  HalError erase_all_but_role() override;

  bool has(device::StoreKey key) const {
    return records.count(key) != 0;
  }

  std::map<device::StoreKey, Bytes> records;
  /** Every record written, in order, with its key. */
  std::vector<std::pair<device::StoreKey, Bytes>> history;
  bool fail_writes = false;

private:
  PowerSwitch& power_;
};

/**
 * A firmware image as the fake bootloader knows them: 0xE9, the version, its length (u32 LE), a
 * pattern, and a CRC-32 of everything before it in the last four bytes. It "works" when all of
 * that holds.
 */
Bytes make_image(protocol::FirmwareVersion version, std::size_t size, std::uint8_t seed = 1);

/** True when `slot` starts with an image that works. */
bool image_works(const Bytes& slot);

/** The version of the image `slot` starts with. */
protocol::FirmwareVersion image_version(const Bytes& slot);

/**
 * Two application slots and ESP-IDF's bootloader with rollback, as section 2 describes them.
 * Writes go to the slot not running and only clear bits, as NOR flash does; an erase cut part-way
 * leaves its sector half erased, a write cut part-way writes half its bytes. A cut during an
 * otadata write (select, confirm, reject) leaves the old copy or the new one, as `otadata_lands`
 * says.
 */
class TestSlots final : public device::FirmwareSlots {
public:
  enum class State { empty, valid, fresh, pending, aborted, invalid };

  TestSlots(PowerSwitch& power, std::uint32_t capacity, const Bytes& running_image);

  device::BootImage running() override;
  std::uint32_t capacity() override;
  HalError erase(std::uint32_t offset) override;
  HalError write(std::uint32_t offset, protocol::ByteView bytes) override;
  HalError read(std::uint32_t offset, protocol::MutableByteView out) override;
  HalError select() override;
  HalError confirm() override;
  HalError reject() override;

  /** The bootloader, at every power-up and reset: picks the slot to run. */
  void boot();

  int running_slot() const {
    return running_;
  }
  int other_slot() const {
    return 1 - running_;
  }
  /** True when the slot now running holds an image that works. */
  bool running_works() const;

  std::array<Bytes, 2> bytes;
  std::array<State, 2> states{};
  bool otadata_lands = false;
  bool fail_erase = false;
  bool fail_write = false;
  bool fail_select_io = false;
  bool fail_confirm = false;
  /** Called after each successful write, to damage the slot on purpose. */
  std::function<void()> after_write;
  std::uint32_t select_calls = 0;
  std::uint32_t confirm_calls = 0;
  std::uint32_t reject_calls = 0;

private:
  void set_state(int slot, State state);

  PowerSwitch& power_;
  std::uint32_t capacity_;
  int running_ = 0;
  int boot_ = 0;
  bool rolled_back_ = false;
  protocol::FirmwareVersion failed_;
};

// ---- Crypto ----

/** HMAC-SHA256 through PSA. */
Bytes hmac_sha256(const Bytes& key, const Bytes& message);

/** HKDF-SHA256 (RFC 5869) of 32 bytes, through HMAC. */
Bytes hkdf_sha256(const Bytes& key, const Bytes& salt, const Bytes& info);

/** SHA-256 through PSA. */
Bytes sha256(const Bytes& bytes);

/** The session key and Open tag as protocol section 10 defines them. */
Bytes session_key(const protocol::DeviceKey& key, const Bytes& nonce, std::uint32_t address);
protocol::SessionTag open_tag(const Bytes& session_key, std::uint32_t address,
                              const protocol::DeviceRandom& random, const protocol::ImageId& id);

/** ECDSA P-256 over SHA-256, r then s, under the vectors' private key. */
Bytes sign_p256(const Bytes& private_key, const Bytes& digest);

/** UpdateCrypto on PSA, holding the device key the platform would hold, recording its calls. */
class TestCrypto final : public device::UpdateCrypto {
public:
  TestCrypto();

  HalError sha256_start() override;
  HalError sha256_add(protocol::ByteView bytes) override;
  HalError sha256_finish(protocol::MutableByteView digest) override;
  bool verify_p256(protocol::ByteView public_xy, protocol::ByteView digest,
                   protocol::ByteView signature_rs) override;
  HalError session_key(protocol::ByteView nonce, std::uint32_t address,
                       protocol::MutableByteView out) override;
  HalError hmac_sha256(protocol::ByteView key, protocol::ByteView message,
                       protocol::MutableByteView out) override;

  protocol::DeviceKey device_key = kKey;
  std::uint32_t sha_starts = 0;
  std::uint32_t verifies = 0;
  std::uint32_t session_keys = 0;
  bool fail_session_key = false;
  bool fail_sha = false;

private:
  bool hashing_ = false;
  Bytes hashed_;
};

// ---- Links ----

/** A link that records what the device sends and whether it is connected. */
class TestLink final : public device::Link {
public:
  explicit TestLink(LinkKind kind) : kind_(kind) {}

  LinkKind kind() const override {
    return kind_;
  }
  HalError connect(const device::LinkTarget& target) override;
  void disconnect() override;
  HalError send(protocol::ByteView packet) override;
  bool up() const override {
    return is_up;
  }
  std::int8_t signal_dbm() const override {
    return signal;
  }
  std::uint16_t largest_packet() const override {
    return largest;
  }

  bool is_up = false;
  std::int8_t signal = 0;
  /** What largest_packet() says: on Bluetooth the agreed MTU less 3; 0 for "not known". */
  std::uint16_t largest = 0;
  HalError send_error = HalError::none;
  /** True between connect() and disconnect(): for Bluetooth, the window is open. */
  bool connecting = false;
  std::uint32_t connects = 0;
  std::uint32_t disconnects = 0;
  std::string last_wifi_name;
  std::vector<Bytes> sent;
  /** How many of `sent` the bench has answered. */
  std::size_t handled = 0;

private:
  LinkKind kind_;
};

// ---- The rest of the hardware ----

class QuietRadio final : public device::Radio {
public:
  HalError transmit(const device::RadioChannel&, std::int8_t, protocol::ByteView) override {
    return HalError::none;
  }
  HalError receive(const device::RxParams&) override {
    return HalError::none;
  }
  HalError detect_activity(const device::CadParams&) override {
    return HalError::none;
  }
  device::HalResult<std::int16_t> noise_dbm() override {
    return std::int16_t{-120};
  }
  HalError sleep(bool) override {
    return HalError::none;
  }
  HalError recover() override {
    return HalError::none;
  }
};

class TestRetained final : public device::RetainedMemory {
public:
  protocol::MutableByteView block() override {
    return protocol::MutableByteView(block_);
  }
  protocol::MutableByteView breadcrumb() override {
    return protocol::MutableByteView(crumb_);
  }

private:
  std::array<std::uint8_t, device::kRetainedBlockSize> block_{};
  std::array<std::uint8_t, device::kBreadcrumbSize> crumb_{};
};

class CountingRandom final : public device::Random {
public:
  void fill(protocol::MutableByteView out) override;

private:
  std::uint8_t next_ = 0x40;
};

class TestPower final : public device::Power {
public:
  bool external_power() override {
    return external;
  }
  bool external = false;
};

class NoKeyImport final : public device::KeyImport {
public:
  HalError import_key(const protocol::DeviceKey&) override {
    return HalError::unsupported;
  }
};

class TestWatchdog final : public device::Watchdog {
public:
  void start(std::uint32_t) override {}
  void feed() override {}
};

// ---- The bench ----

/** What the file served to the device holds: the signed header, then the image. */
struct ImageFile {
  protocol::ImageHeader header;
  Bytes header_bytes;
  Bytes image;
  protocol::ImageId id{};

  Bytes file() const;
};

/**
 * Makes and signs (with the vectors' key) a header for `image`. `adjust` changes the header's
 * fields before signing.
 */
ImageFile make_file(const Bytes& image, std::uint8_t roles = 0x0E,
                    const std::function<void(protocol::ImageHeader&)>& adjust = nullptr);

/** One boot's device objects. */
struct Instance {
  Instance(device::Hal& hal, device::Watchdog& watchdog, std::uint8_t role_id)
      : services(hal), role(services, role_id), device(services, &role), runner(device, watchdog) {}

  device::Services services;
  TestRole role;
  device::Device device;
  device::Runner runner;
};

/** Options for a bench. */
struct BenchOptions {
  std::uint8_t role = protocol::Role::sensor;
  std::uint32_t capacity = 160 * 1024;
  protocol::FirmwareVersion old_version{1, 0, 0};
  bool wifi_details = true;
  bool bluetooth = true;
  Bytes hub_identity = vector_hub_identity();
  Bytes signing_key = vector_signing_key();
};

/** A paired board with its hardware, booted and rebooted by the test. */
class Bench {
public:
  explicit Bench(const BenchOptions& options = BenchOptions());

  /** Starts the board: the bootloader picks a slot, the device objects are built, boot runs. */
  void boot(device::BootKind kind = device::BootKind::power_on);

  device::Services& services() {
    return instance->services;
  }
  device::UpdateService& update() {
    return instance->services.update;
  }

  /** Delivers an event at the bench's time. */
  void deliver_link(LinkKind kind, device::LinkEventKind event, const Bytes& packet = Bytes());

  /** Moves the clock to `at` and lets the runner wake there. */
  void advance_to(Instant at);
  void advance(device::Duration by) {
    advance_to(now + by);
  }

  /** The update packet the role would send now, if any; packet_sent() is called for it. */
  std::optional<device::UpdatePacket> take_packet();

  /** The codes (and numbers) of every kept log entry, oldest first; the log is left as it is. */
  std::vector<std::uint16_t> log_codes();
  /** The number logged with the newest entry of `code`, if any. */
  std::optional<std::int32_t> log_value(std::uint16_t code);

  TestLink& link(LinkKind kind);

  BenchOptions options;
  Instant now = at_seconds(1000);
  PowerSwitch power;
  TestStorage storage{power};
  TestSlots slots;
  TestCrypto crypto;
  QuietRadio radio;
  TestRetained retained;
  CountingRandom random;
  TestPower supply;
  NoKeyImport key_import;
  TestWatchdog watchdog;
  TestLink usb{LinkKind::usb};
  TestLink network{LinkKind::network};
  TestLink bluetooth{LinkKind::bluetooth};
  psa::PsaPacketCipher cipher;
  device::Hal hal;
  std::optional<Instance> instance;
};

/** What a source does with each Get. */
struct ServeRules {
  /** Gets left unanswered, by their offset (each once only, unless `always`). */
  std::vector<std::uint32_t> ignore_once;
  bool ignore_always = false;
  /** Gets answered with a wrong CRC once, by offset. */
  std::vector<std::uint32_t> bad_crc_once;
  /** Answer every Get with Gone and this reason. */
  std::optional<std::uint8_t> gone;
};

/**
 * The hub's (or the phone's) side of the pull: answers each Get the device sent on `kind` with
 * the bytes of `file`, as Data, or as its rules say.
 */
class Source {
public:
  Source(Bench& bench, LinkKind kind, Bytes file) : bench_(bench), kind_(kind), file_(file) {}

  /**
   * Answers the frames the device had sent when it was called (not those its answers make the
   * device send); returns how many it handled.
   */
  std::size_t serve();

  /** Serves until the device sends nothing more. */
  void serve_all() {
    while (serve() > 0) {
    }
  }

  ServeRules rules;
  /** Every Get the device sent, in order. */
  std::vector<protocol::transfer::Get> gets;
  /** Every other frame the device sent on this link (Hello, Done), raw. */
  std::vector<Bytes> other;

private:
  Bench& bench_;
  LinkKind kind_;
  Bytes file_;
};

/** Decodes a Get frame, or fails the test. */
protocol::transfer::Get decode_get(const Bytes& frame);

/** Builds a Data frame for `offset` of `file`, `length` bytes. */
Bytes data_frame(const protocol::ImageId& id, const Bytes& file, std::uint32_t offset,
                 std::uint16_t length, bool bad_crc = false);

/** An update offer. */
protocol::UpdateOffer make_offer(std::uint8_t action, const ImageFile& file);

/**
 * Runs the device until `done` holds, nothing more can happen, the power fails, or a restart is
 * asked for: each turn serves the source's Gets, else moves to the device's next wake. Packets
 * the role must send are passed to `on_packet` (and marked sent). Returns false when it stopped
 * for another reason than `done`.
 */
bool run(Bench& bench, Source& source, const std::function<bool()>& done,
         const std::function<void(const device::UpdatePacket&)>& on_packet = nullptr,
         int max_turns = 20000);

/** Packets the role sent, as the hub saw them. */
using Packets = std::vector<device::UpdatePacket>;

/** True when `packets` hold a status with `stage`. */
bool has_stage(const Packets& packets, std::uint8_t stage);

/** Offers `file` on the network link and pulls it until the status "verified". */
void fetch_to_verified(Bench& bench, Source& hub, const ImageFile& file, Packets& packets);

/**
 * From a verified image: "install now", until the restart is asked for with "installing" sent;
 * then the board restarts (the bootloader runs the new image on trial).
 */
void install_and_restart(Bench& bench, Source& hub, const ImageFile& file, Packets& packets);

}  // namespace hsn::test::update
