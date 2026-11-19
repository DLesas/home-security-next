#include "hsn/host/fake_update.hpp"

#include <algorithm>

#include "hsn/host/simulation_error.hpp"
#include "hsn/protocol/checksum.hpp"
#include "hsn/protocol/transfer.hpp"

namespace hsn::host {
namespace {

constexpr std::size_t kSector = device::kSlotSectorSize;
/** otadata: two copies of one sector each, before the slots. */
constexpr std::size_t kOtadataSize = 2 * kSector;

void zero(protocol::MutableByteView out) {
  std::fill(out.begin(), out.end(), std::uint8_t{0});
}

void put_u32(std::uint8_t* out, std::uint32_t value) {
  for (std::size_t i = 0; i < 4; ++i) {
    out[i] = static_cast<std::uint8_t>((value >> (8 * i)) & 0xFFu);
  }
}

std::uint32_t get_u32(const std::uint8_t* in) {
  return static_cast<std::uint32_t>(in[0]) | (static_cast<std::uint32_t>(in[1]) << 8) |
         (static_cast<std::uint32_t>(in[2]) << 16) | (static_cast<std::uint32_t>(in[3]) << 24);
}

/** HKDF-SHA256 through PSA into `out`; false on any failure. */
bool hkdf_sha256(protocol::ByteView key, protocol::ByteView salt, protocol::ByteView info,
                 protocol::MutableByteView out) {
  if (psa_crypto_init() != PSA_SUCCESS) {
    return false;
  }
  psa_key_derivation_operation_t derivation = PSA_KEY_DERIVATION_OPERATION_INIT;
  const bool ok =
      psa_key_derivation_setup(&derivation, PSA_ALG_HKDF(PSA_ALG_SHA_256)) == PSA_SUCCESS &&
      psa_key_derivation_input_bytes(&derivation, PSA_KEY_DERIVATION_INPUT_SALT, salt.data(),
                                     salt.size()) == PSA_SUCCESS &&
      psa_key_derivation_input_bytes(&derivation, PSA_KEY_DERIVATION_INPUT_SECRET, key.data(),
                                     key.size()) == PSA_SUCCESS &&
      psa_key_derivation_input_bytes(&derivation, PSA_KEY_DERIVATION_INPUT_INFO, info.data(),
                                     info.size()) == PSA_SUCCESS &&
      psa_key_derivation_output_bytes(&derivation, out.data(), out.size()) == PSA_SUCCESS;
  static_cast<void>(psa_key_derivation_abort(&derivation));
  return ok;
}

/** The session key's info: the label, then the address (u32 LE). */
std::array<std::uint8_t, protocol::kSessionKeyLabel.size() + 4> session_info(
    std::uint32_t address) {
  std::array<std::uint8_t, protocol::kSessionKeyLabel.size() + 4> info{};
  std::copy(protocol::kSessionKeyLabel.begin(), protocol::kSessionKeyLabel.end(), info.begin());
  put_u32(info.data() + protocol::kSessionKeyLabel.size(), address);
  return info;
}

/** HMAC-SHA256 through PSA into `out` (32 bytes); false on any failure. */
bool hmac(protocol::ByteView key, protocol::ByteView message, protocol::MutableByteView out) {
  if (key.empty() || out.size() != device::kSha256Size || psa_crypto_init() != PSA_SUCCESS) {
    return false;
  }
  psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
  psa_set_key_type(&attributes, PSA_KEY_TYPE_HMAC);
  psa_set_key_bits(&attributes, PSA_BYTES_TO_BITS(key.size()));
  psa_set_key_algorithm(&attributes, PSA_ALG_HMAC(PSA_ALG_SHA_256));
  psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_SIGN_MESSAGE);
  psa_key_id_t id = PSA_KEY_ID_NULL;
  const psa_status_t imported = psa_import_key(&attributes, key.data(), key.size(), &id);
  psa_reset_key_attributes(&attributes);
  if (imported != PSA_SUCCESS) {
    return false;
  }
  std::size_t length = 0;
  const psa_status_t status = psa_mac_compute(id, PSA_ALG_HMAC(PSA_ALG_SHA_256), message.data(),
                                              message.size(), out.data(), out.size(), &length);
  static_cast<void>(psa_destroy_key(id));
  return status == PSA_SUCCESS && length == out.size();
}

}  // namespace

SessionKey derive_session_key(const protocol::DeviceKey& key, protocol::ByteView nonce,
                              std::uint32_t address) {
  SessionKey out{};
  const auto info = session_info(address);
  if (!hkdf_sha256(protocol::ByteView(key), nonce, protocol::ByteView(info),
                   protocol::MutableByteView(out))) {
    throw SimulationError("PSA could not derive a session key");
  }
  return out;
}

protocol::SessionTag open_tag(const SessionKey& session_key, std::uint32_t address,
                              const protocol::DeviceRandom& device_random,
                              const protocol::ImageId& image) {
  Bytes message(protocol::kSessionOpenLabel.begin(), protocol::kSessionOpenLabel.end());
  for (std::size_t i = 0; i < 4; ++i) {
    message.push_back(static_cast<std::uint8_t>((address >> (8 * i)) & 0xFFu));
  }
  message.insert(message.end(), device_random.begin(), device_random.end());
  message.insert(message.end(), image.begin(), image.end());
  std::array<std::uint8_t, device::kSha256Size> mac{};
  if (!hmac(protocol::ByteView(session_key), protocol::ByteView(message.data(), message.size()),
            protocol::MutableByteView(mac))) {
    throw SimulationError("PSA could not compute an HMAC");
  }
  protocol::SessionTag tag{};
  std::copy_n(mac.begin(), tag.size(), tag.begin());
  return tag;
}

// ---- otadata ----

std::uint32_t OtaEntry::crc_of(std::uint32_t seq) {
  std::array<std::uint8_t, 4> bytes{};
  put_u32(bytes.data(), seq);
  return protocol::crc32(protocol::ByteView(bytes));
}

OtaEntry OtaEntry::make(std::uint32_t seq, std::uint32_t state) {
  OtaEntry entry;
  entry.seq = seq;
  entry.state = state;
  entry.crc = crc_of(seq);
  return entry;
}

OtaEntry OtaEntry::read(protocol::ByteView bytes) {
  OtaEntry entry;
  if (bytes.size() >= kSize) {
    entry.seq = get_u32(bytes.data());
    entry.state = get_u32(bytes.data() + 24);
    entry.crc = get_u32(bytes.data() + 28);
  }
  return entry;
}

std::array<std::uint8_t, OtaEntry::kSize> OtaEntry::bytes() const {
  std::array<std::uint8_t, kSize> out{};
  // The 20-byte label (bytes 4 to 23) is left empty, as esp_ota_ops leaves it.
  std::fill(out.begin() + 4, out.begin() + 24, std::uint8_t{0xFF});
  put_u32(out.data(), seq);
  put_u32(out.data() + 24, state);
  put_u32(out.data() + 28, crc);
  return out;
}

// ---- the slots ----

FakeFirmwareSlots::FakeFirmwareSlots(const device::Clock& clock, std::size_t slot_size,
                                     std::uint64_t seed)
    : flash(kOtadataSize + 2 * ((slot_size + kSector - 1) / kSector * kSector), seed),
      clock_(clock),
      slot_size_((slot_size + kSector - 1) / kSector * kSector) {}

std::uint32_t FakeFirmwareSlots::slot_base(std::uint8_t slot) const {
  return static_cast<std::uint32_t>(kOtadataSize + slot * slot_size_);
}

void FakeFirmwareSlots::record(Operation::Kind kind, std::uint32_t offset, std::uint32_t length,
                               std::uint32_t state, device::HalError result) {
  Operation operation;
  operation.at = clock_.now();
  operation.kind = kind;
  operation.offset = offset;
  operation.length = length;
  operation.state = state;
  operation.result = result;
  operation.on_trial = image.on_trial;
  operations.push_back(operation);
  as_made = false;
}

device::BootImage FakeFirmwareSlots::running() {
  tick();
  return image;
}

std::uint32_t FakeFirmwareSlots::capacity() {
  tick();
  return static_cast<std::uint32_t>(slot_size_);
}

device::HalError FakeFirmwareSlots::erase(std::uint32_t offset) {
  tick();
  device::HalError result = device::HalError::invalid;
  if (offset % kSector == 0 && offset < slot_size_) {
    selected_ids_[other()].reset();
    result = flash.erase(slot_base(other()) + offset, FlashOp::slot_erase);
  }
  record(Operation::Kind::erase, offset, static_cast<std::uint32_t>(kSector), 0, result);
  return result;
}

device::HalError FakeFirmwareSlots::write(std::uint32_t offset, protocol::ByteView bytes) {
  tick();
  device::HalError result = device::HalError::invalid;
  if (bytes.size() <= kSector && offset <= slot_size_ && bytes.size() <= slot_size_ - offset) {
    selected_ids_[other()].reset();
    result = flash.program(slot_base(other()) + offset, bytes, FlashOp::slot_write);
  }
  record(Operation::Kind::write, offset, static_cast<std::uint32_t>(bytes.size()), 0, result);
  return result;
}

device::HalError FakeFirmwareSlots::read(std::uint32_t offset, protocol::MutableByteView out) {
  tick();
  if (out.size() > kSector || offset > slot_size_ || out.size() > slot_size_ - offset) {
    zero(out);
    return device::HalError::invalid;
  }
  flash.read(slot_base(other()) + offset, out);
  return device::HalError::none;
}

int FakeFirmwareSlots::selected_entry() const {
  int chosen = -1;
  for (int i = 0; i < 2; ++i) {
    const OtaEntry candidate = entry(static_cast<std::size_t>(i));
    if (candidate.usable() &&
        (chosen < 0 || candidate.seq > entry(static_cast<std::size_t>(chosen)).seq)) {
      chosen = i;
    }
  }
  return chosen;
}

int FakeFirmwareSlots::newest_intact_entry() const {
  int chosen = -1;
  for (int i = 0; i < 2; ++i) {
    const OtaEntry candidate = entry(static_cast<std::size_t>(i));
    if (candidate.intact() &&
        (chosen < 0 || candidate.seq > entry(static_cast<std::size_t>(chosen)).seq)) {
      chosen = i;
    }
  }
  return chosen;
}

OtaEntry FakeFirmwareSlots::entry(std::size_t index) const {
  std::array<std::uint8_t, OtaEntry::kSize> bytes{};
  flash.read(static_cast<std::uint32_t>(index * kSector), protocol::MutableByteView(bytes));
  return OtaEntry::read(protocol::ByteView(bytes));
}

device::HalError FakeFirmwareSlots::write_entry(std::size_t index, const OtaEntry& entry,
                                                Operation::Kind kind) {
  const auto bytes = entry.bytes();
  const device::HalError result = flash.rewrite(static_cast<std::uint32_t>(index * kSector),
                                                protocol::ByteView(bytes), FlashOp::otadata_write);
  record(kind, static_cast<std::uint32_t>(index), OtaEntry::kSize, entry.state, result);
  return result;
}

void FakeFirmwareSlots::put_entry(std::size_t index, const OtaEntry& entry) {
  as_made = false;
  const auto bytes = entry.bytes();
  flash.load(static_cast<std::uint32_t>(index * kSector), protocol::ByteView(bytes));
}

ImageCheck FakeFirmwareSlots::check(std::uint8_t slot) const {
  Cached& cached = cache_[slot & 1u];
  if (!cached.valid || cached.generation != flash.generation()) {
    cached.check = check_test_image(slot_bytes(slot));
    cached.generation = flash.generation();
    cached.valid = true;
  }
  return cached.check;
}

protocol::ByteView FakeFirmwareSlots::slot_bytes(std::uint8_t slot) const {
  return protocol::ByteView(flash.contents().data() + slot_base(slot & 1u), slot_size_);
}

device::HalError FakeFirmwareSlots::select() {
  tick();
  const std::uint8_t target = other();
  const ImageCheck checked = check(target);
  if (!checked.ok) {
    record(Operation::Kind::select, target, 0, ota_state::new_image, device::HalError::invalid);
    return device::HalError::invalid;
  }
  const int selected = selected_entry();
  if (selected >= 0) {
    const OtaEntry current = entry(static_cast<std::size_t>(selected));
    if (current.slot() == target && current.state == ota_state::new_image) {
      // Already selected: nothing to write.
      record(Operation::Kind::select, target, 0, ota_state::new_image, device::HalError::none);
      return device::HalError::none;
    }
  }
  // The next sequence number that names the target, written into the copy not selected (with
  // blank otadata, the first copy), as esp_ota_set_boot_partition does.
  const std::uint32_t base = selected >= 0 ? entry(static_cast<std::size_t>(selected)).seq : 0;
  std::uint32_t seq = base + 1;
  if ((seq - 1) % 2 != target) {
    seq += 1;
  }
  const std::size_t index = selected >= 0 ? static_cast<std::size_t>(1 - selected) : 0;
  const auto result =
      write_entry(index, OtaEntry::make(seq, ota_state::new_image), Operation::Kind::select);
  // Use the copy that actually landed, including a simulator cut that left it intact.
  const OtaEntry written = entry(index);
  if (written.intact() && written.seq == seq && written.state == ota_state::new_image) {
    protocol::ImageHeader header;
    header.image_sha256 = sha256_of(slot_bytes(target).first(checked.bytes));
    selected_ids_[target] = protocol::image_id_of(header);
  }
  return result;
}

device::HalError FakeFirmwareSlots::confirm() {
  tick();
  if (running_entry_ < 0) {
    // Blank otadata: the factory image needs no confirming.
    record(Operation::Kind::confirm, 0, 0, ota_state::valid, device::HalError::none);
    return device::HalError::none;
  }
  const OtaEntry current = entry(static_cast<std::size_t>(running_entry_));
  if (!current.intact() || current.slot() != running_ ||
      current.state != ota_state::pending_verify) {
    // Nothing on trial: confirming changes nothing.
    record(Operation::Kind::confirm, static_cast<std::uint32_t>(running_entry_), 0,
           ota_state::valid, device::HalError::none);
    return device::HalError::none;
  }
  const device::HalError result =
      write_entry(static_cast<std::size_t>(running_entry_),
                  OtaEntry::make(current.seq, ota_state::valid), Operation::Kind::confirm);
  if (result == device::HalError::none) {
    image.on_trial = false;
  }
  return result;
}

device::HalError FakeFirmwareSlots::reject() {
  tick();
  // Only with a working image to go back to (esp_ota_check_rollback_is_possible).
  if (running_entry_ < 0 || !check(other()).ok) {
    record(Operation::Kind::reject, 0, 0, ota_state::invalid, device::HalError::invalid);
    return device::HalError::invalid;
  }
  const OtaEntry current = entry(static_cast<std::size_t>(running_entry_));
  return write_entry(static_cast<std::size_t>(running_entry_),
                     OtaEntry::make(current.seq, ota_state::invalid), Operation::Kind::reject);
}

BootChoice FakeFirmwareSlots::boot() {
  BootChoice choice;
  int selected = -1;
  bool on_trial = false;
  // At most one ABORTED and one PENDING_VERIFY write: three passes always settle.
  for (int pass = 0; pass < 3; ++pass) {
    selected = selected_entry();
    if (selected < 0) {
      break;
    }
    const OtaEntry current = entry(static_cast<std::size_t>(selected));
    if (current.state == ota_state::pending_verify) {
      // A reset while on trial: roll back.
      choice.aborted_trial = true;
      const device::HalError result =
          write_entry(static_cast<std::size_t>(selected),
                      OtaEntry::make(current.seq, ota_state::aborted), Operation::Kind::bootloader);
      if (flash.power_gone()) {
        choice.cut = true;
        return choice;
      }
      if (result != device::HalError::none) {
        // The copy could not be marked: run the other slot without marking it.
        selected = -2;
        break;
      }
      continue;
    }
    if (current.state == ota_state::new_image) {
      const device::HalError result = write_entry(
          static_cast<std::size_t>(selected),
          OtaEntry::make(current.seq, ota_state::pending_verify), Operation::Kind::bootloader);
      if (flash.power_gone()) {
        choice.cut = true;
        return choice;
      }
      static_cast<void>(result);
      on_trial = true;
    }
    break;
  }
  std::uint8_t slot = 0;
  if (selected >= 0) {
    slot = entry(static_cast<std::size_t>(selected)).slot();
  } else if (selected == -2) {
    const int stuck = selected_entry();
    slot = stuck >= 0 ? static_cast<std::uint8_t>(1 - entry(static_cast<std::size_t>(stuck)).slot())
                      : std::uint8_t{0};
  }
  if (!check(slot).ok) {
    const std::uint8_t fallback = static_cast<std::uint8_t>(1 - slot);
    if (!check(fallback).ok) {
      return choice;
    }
    slot = fallback;
    on_trial = false;
    choice.fell_back = true;
    selected = -1;
  }
  choice.bootable = true;
  choice.slot = slot;
  choice.image.version = check(slot).version;
  choice.image.id = selected_ids_[slot];
  choice.image.on_trial = on_trial;
  const int newest = newest_intact_entry();
  if (newest >= 0) {
    const OtaEntry last = entry(static_cast<std::size_t>(newest));
    if (last.slot() != slot) {
      choice.image.rolled_back = true;
      choice.image.failed =
          version_in_image(slot_bytes(last.slot())).value_or(protocol::FirmwareVersion{});
      choice.image.failed_id = selected_ids_[last.slot()];
    }
  }
  running_ = slot;
  // The copy that selected this slot, for confirm() and reject(): only a usable one naming it.
  running_entry_ = -1;
  const int now_selected = selected_entry();
  if (now_selected >= 0 && entry(static_cast<std::size_t>(now_selected)).slot() == slot) {
    running_entry_ = now_selected;
  }
  image = choice.image;
  return choice;
}

void FakeFirmwareSlots::install(std::uint8_t slot, protocol::ByteView image_bytes) {
  as_made = false;
  selected_ids_[slot & 1u].reset();
  flash.blank(slot_base(slot & 1u), slot_size_);
  flash.load(slot_base(slot & 1u),
             image_bytes.first(std::min<std::size_t>(image_bytes.size(), slot_size_)));
}

void FakeFirmwareSlots::blank_otadata() {
  as_made = false;
  flash.blank(0, kOtadataSize);
}

std::size_t FakeFirmwareSlots::writes_on_trial() const {
  return static_cast<std::size_t>(
      std::count_if(operations.begin(), operations.end(), [](const Operation& operation) {
        return operation.on_trial && (operation.kind == Operation::Kind::erase ||
                                      operation.kind == Operation::Kind::write);
      }));
}

// ---- the key ----

bool FakeKeyImport::load(const protocol::DeviceKey& key) {
  if (cipher_.set_key(key) != protocol::Error::none) {
    return false;
  }
  key_ = key;
  return true;
}

device::HalError FakeKeyImport::import_key(const protocol::DeviceKey& key) {
  tick();
  if (fail_next) {
    fail_next = false;
    return device::HalError::io;
  }
  if (!load(key)) {
    // The cipher refused it: the old key goes back in, so seals and opens go on as before.
    if (key_.has_value()) {
      static_cast<void>(cipher_.set_key(*key_));
    }
    return device::HalError::io;
  }
  imports += 1;
  return device::HalError::none;
}

// ---- the crypto: hsn_psa's PsaUpdateCrypto, metered and counted ----

device::HalError FakeUpdateCrypto::sha256_start() {
  tick();
  return psa_.sha256_start();
}

device::HalError FakeUpdateCrypto::sha256_add(protocol::ByteView bytes) {
  tick();
  return psa_.sha256_add(bytes);
}

device::HalError FakeUpdateCrypto::sha256_finish(protocol::MutableByteView digest) {
  tick();
  return psa_.sha256_finish(digest);
}

bool FakeUpdateCrypto::verify_p256(protocol::ByteView public_xy, protocol::ByteView digest,
                                   protocol::ByteView signature_rs) {
  tick();
  verifications += 1;
  const bool ok = psa_.verify_p256(public_xy, digest, signature_rs);
  verified += ok ? 1 : 0;
  return ok;
}

device::HalError FakeUpdateCrypto::session_key(protocol::ByteView nonce, std::uint32_t address,
                                               protocol::MutableByteView out) {
  tick();
  if (!keys_.key().has_value()) {
    zero(out);
    return device::HalError::invalid;
  }
  // The board's key may have changed since the last call (FakeKeyImport): PSA gets it each time.
  if (psa_.set_device_key(*keys_.key()) != device::HalError::none) {
    zero(out);
    return device::HalError::io;
  }
  return psa_.session_key(nonce, address, out);
}

device::HalError FakeUpdateCrypto::hmac_sha256(protocol::ByteView key, protocol::ByteView message,
                                               protocol::MutableByteView out) {
  tick();
  return psa_.hmac_sha256(key, message, out);
}

}  // namespace hsn::host
