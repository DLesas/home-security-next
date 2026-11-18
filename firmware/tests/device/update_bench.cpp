#include "update_bench.hpp"

#include <psa/crypto.h>

#include <algorithm>
#include <cstring>
#include <type_traits>

#include "hsn/device/services/setup.hpp"
#include "hsn/protocol/checksum.hpp"
#include "support.hpp"

namespace hsn::test::update {
namespace {

void put_le32(Bytes& out, std::size_t at, std::uint32_t value) {
  for (std::size_t i = 0; i < 4; ++i) {
    out[at + i] = static_cast<std::uint8_t>((value >> (8 * i)) & 0xFFu);
  }
}

std::uint32_t le32(const Bytes& in, std::size_t at) {
  std::uint32_t value = 0;
  for (std::size_t i = 0; i < 4; ++i) {
    value |= static_cast<std::uint32_t>(in[at + i]) << (8 * i);
  }
  return value;
}

void psa_ready() {
  REQUIRE(psa_crypto_init() == PSA_SUCCESS);
}

}  // namespace

Bytes vector_hub_identity() {
  return from_hex("d6c23e2744a840cb");
}

Bytes vector_signing_key() {
  return from_hex(
      "60fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6"
      "7903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299");
}

Bytes vector_signing_private() {
  return from_hex("c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721");
}

const char* name_of(FlashOp::Kind kind) {
  switch (kind) {
    case FlashOp::Kind::slot_erase:
      return "slot erase";
    case FlashOp::Kind::slot_write:
      return "slot write";
    case FlashOp::Kind::slot_read:
      return "slot read";
    case FlashOp::Kind::select:
      return "select (otadata)";
    case FlashOp::Kind::confirm:
      return "confirm (otadata)";
    case FlashOp::Kind::reject:
      return "reject (otadata)";
    case FlashOp::Kind::record_write:
      return "record write";
    case FlashOp::Kind::record_erase:
      return "record erase";
  }
  return "?";
}

// ---- Power and flash ----

PowerSwitch::Outcome PowerSwitch::begin(const FlashOp& op) {
  if (!on) {
    return Outcome::off;
  }
  if (budget.has_value() && ops.size() >= *budget) {
    on = false;
    cut_in = op;
    return Outcome::cut;
  }
  ops.push_back(op);
  return Outcome::done;
}

device::HalResult<std::size_t> TestStorage::read(device::StoreKey key,
                                                 protocol::MutableByteView out) {
  if (!power_.on) {
    return HalError::io;
  }
  const auto found = records.find(key);
  if (found == records.end()) {
    return HalError::not_found;
  }
  if (out.size() < found->second.size()) {
    return HalError::invalid;
  }
  std::copy(found->second.begin(), found->second.end(), out.begin());
  return found->second.size();
}

HalError TestStorage::write(device::StoreKey key, protocol::ByteView value) {
  if (fail_writes) {
    return HalError::io;
  }
  if (value.size() > device::kMaxRecordSize) {
    return HalError::invalid;
  }
  FlashOp op;
  op.kind = FlashOp::Kind::record_write;
  op.key = key;
  op.size = value.size();
  if (power_.begin(op) != PowerSwitch::Outcome::done) {
    return HalError::io;  // whole or nothing (HN 7): a cut write leaves the old record
  }
  records[key] = Bytes(value.begin(), value.end());
  history.emplace_back(key, records[key]);
  return HalError::none;
}

HalError TestStorage::erase(device::StoreKey key) {
  FlashOp op;
  op.kind = FlashOp::Kind::record_erase;
  op.key = key;
  if (power_.begin(op) != PowerSwitch::Outcome::done) {
    return HalError::io;
  }
  records.erase(key);
  return HalError::none;
}

HalError TestStorage::erase_all_but_role() {
  FlashOp op;
  op.kind = FlashOp::Kind::record_erase;
  if (power_.begin(op) != PowerSwitch::Outcome::done) {
    return HalError::io;
  }
  for (auto it = records.begin(); it != records.end();) {
    it = it->first == device::StoreKey::role ? std::next(it) : records.erase(it);
  }
  return HalError::none;
}

Bytes make_image(protocol::FirmwareVersion version, std::size_t size, std::uint8_t seed) {
  REQUIRE(size >= 12);
  Bytes image(size);
  image[0] = 0xE9;
  image[1] = version.major;
  image[2] = version.minor;
  image[3] = version.patch;
  put_le32(image, 4, static_cast<std::uint32_t>(size));
  for (std::size_t i = 8; i + 4 < size; ++i) {
    image[i] = static_cast<std::uint8_t>((i * 31 + seed * 7 + (i >> 8)) & 0xFFu);
  }
  const std::uint32_t crc = protocol::crc32(protocol::ByteView(image.data(), size - 4));
  put_le32(image, size - 4, crc);
  return image;
}

bool image_works(const Bytes& slot) {
  if (slot.size() < 12 || slot[0] != 0xE9) {
    return false;
  }
  const std::uint32_t size = le32(slot, 4);
  if (size < 12 || size > slot.size()) {
    return false;
  }
  return protocol::crc32(protocol::ByteView(slot.data(), size - 4)) == le32(slot, size - 4);
}

protocol::FirmwareVersion image_version(const Bytes& slot) {
  return protocol::FirmwareVersion{slot[1], slot[2], slot[3]};
}

TestSlots::TestSlots(PowerSwitch& power, std::uint32_t capacity, const Bytes& running_image)
    : power_(power), capacity_(capacity) {
  // The flash behind each slot holds at least the running image, whatever capacity() says.
  const std::size_t size = std::max<std::size_t>(capacity, running_image.size());
  bytes[0] = Bytes(size, 0xFF);
  bytes[1] = Bytes(size, 0xFF);
  std::copy(running_image.begin(), running_image.end(), bytes[0].begin());
  states = {State::valid, State::empty};
}

device::BootImage TestSlots::running() {
  device::BootImage image;
  image.version = image_version(bytes[static_cast<std::size_t>(running_)]);
  image.on_trial = states[static_cast<std::size_t>(running_)] == State::pending;
  image.rolled_back = rolled_back_;
  image.failed = rolled_back_ ? failed_ : protocol::FirmwareVersion{};
  return image;
}

std::uint32_t TestSlots::capacity() {
  return capacity_;
}

HalError TestSlots::erase(std::uint32_t offset) {
  if (offset % device::kSlotSectorSize != 0 || offset >= capacity_) {
    return HalError::invalid;
  }
  if (fail_erase) {
    return HalError::io;
  }
  FlashOp op;
  op.kind = FlashOp::Kind::slot_erase;
  op.offset = offset;
  op.size = device::kSlotSectorSize;
  const PowerSwitch::Outcome outcome = power_.begin(op);
  if (outcome == PowerSwitch::Outcome::off) {
    return HalError::io;
  }
  Bytes& slot = bytes[static_cast<std::size_t>(other_slot())];
  const std::size_t sector = std::min<std::size_t>(device::kSlotSectorSize, capacity_ - offset);
  const std::size_t length = outcome == PowerSwitch::Outcome::cut ? sector / 2 : sector;
  std::fill_n(slot.begin() + offset, length, std::uint8_t{0xFF});
  return outcome == PowerSwitch::Outcome::done ? HalError::none : HalError::io;
}

HalError TestSlots::write(std::uint32_t offset, protocol::ByteView data) {
  if (data.size() > device::kSlotSectorSize || offset + data.size() > capacity_) {
    return HalError::invalid;
  }
  if (fail_write) {
    return HalError::io;
  }
  FlashOp op;
  op.kind = FlashOp::Kind::slot_write;
  op.offset = offset;
  op.size = data.size();
  const PowerSwitch::Outcome outcome = power_.begin(op);
  if (outcome == PowerSwitch::Outcome::off) {
    return HalError::io;
  }
  Bytes& slot = bytes[static_cast<std::size_t>(other_slot())];
  const std::size_t length = outcome == PowerSwitch::Outcome::cut ? data.size() / 2 : data.size();
  for (std::size_t i = 0; i < length; ++i) {
    slot[offset + i] = static_cast<std::uint8_t>(slot[offset + i] & data[i]);  // only clears bits
  }
  if (outcome != PowerSwitch::Outcome::done) {
    return HalError::io;
  }
  if (after_write) {
    after_write();
  }
  return HalError::none;
}

HalError TestSlots::read(std::uint32_t offset, protocol::MutableByteView out) {
  if (out.size() > device::kSlotSectorSize || offset + out.size() > capacity_) {
    return HalError::invalid;
  }
  FlashOp op;
  op.kind = FlashOp::Kind::slot_read;
  op.offset = offset;
  op.size = out.size();
  if (power_.begin(op) != PowerSwitch::Outcome::done) {
    return HalError::io;
  }
  const Bytes& slot = bytes[static_cast<std::size_t>(other_slot())];
  std::copy_n(slot.begin() + offset, out.size(), out.begin());
  return HalError::none;
}

HalError TestSlots::select() {
  select_calls += 1;
  if (!power_.on || fail_select_io) {
    return HalError::io;
  }
  if (!image_works(bytes[static_cast<std::size_t>(other_slot())])) {
    return HalError::invalid;  // esp_ota_set_boot_partition checks the image first
  }
  FlashOp op;
  op.kind = FlashOp::Kind::select;
  const PowerSwitch::Outcome outcome = power_.begin(op);
  if (outcome == PowerSwitch::Outcome::off) {
    return HalError::io;
  }
  if (outcome == PowerSwitch::Outcome::done || otadata_lands) {
    set_state(other_slot(), State::fresh);
    boot_ = other_slot();
  }
  return outcome == PowerSwitch::Outcome::done ? HalError::none : HalError::io;
}

HalError TestSlots::confirm() {
  confirm_calls += 1;
  if (fail_confirm) {
    return HalError::io;
  }
  FlashOp op;
  op.kind = FlashOp::Kind::confirm;
  const PowerSwitch::Outcome outcome = power_.begin(op);
  if (outcome == PowerSwitch::Outcome::off) {
    return HalError::io;
  }
  if (outcome == PowerSwitch::Outcome::done || otadata_lands) {
    set_state(running_, State::valid);
    rolled_back_ = false;
    failed_ = protocol::FirmwareVersion{};
  }
  return outcome == PowerSwitch::Outcome::done ? HalError::none : HalError::io;
}

HalError TestSlots::reject() {
  reject_calls += 1;
  FlashOp op;
  op.kind = FlashOp::Kind::reject;
  const PowerSwitch::Outcome outcome = power_.begin(op);
  if (outcome == PowerSwitch::Outcome::off) {
    return HalError::io;
  }
  if (outcome == PowerSwitch::Outcome::done || otadata_lands) {
    set_state(running_, State::invalid);
    rolled_back_ = true;
    failed_ = image_version(bytes[static_cast<std::size_t>(running_)]);
    boot_ = other_slot();
  }
  return outcome == PowerSwitch::Outcome::done ? HalError::none : HalError::io;
}

void TestSlots::set_state(int slot, State state) {
  states[static_cast<std::size_t>(slot)] = state;
}

void TestSlots::boot() {
  int candidate = boot_;
  for (int attempt = 0; attempt < 2; ++attempt) {
    const auto index = static_cast<std::size_t>(candidate);
    const State state = states[index];
    if (state == State::valid) {
      running_ = candidate;
      return;
    }
    if (state == State::fresh && image_works(bytes[index])) {
      set_state(candidate, State::pending);
      running_ = candidate;
      return;
    }
    if (state == State::fresh || state == State::pending) {
      // Not bootable (fresh) or reset while on trial (pending): roll back.
      set_state(candidate, state == State::pending ? State::aborted : State::invalid);
      rolled_back_ = true;
      failed_ = image_version(bytes[index]);
    }
    candidate = 1 - candidate;
    boot_ = candidate;
  }
  running_ = candidate;
}

bool TestSlots::running_works() const {
  const auto index = static_cast<std::size_t>(running_);
  return image_works(bytes[index]) &&
         (states[index] == State::valid || states[index] == State::pending);
}

// ---- Crypto ----

Bytes sha256(const Bytes& bytes) {
  psa_ready();
  Bytes out(32);
  std::size_t length = 0;
  REQUIRE(psa_hash_compute(PSA_ALG_SHA_256, bytes.data(), bytes.size(), out.data(), out.size(),
                           &length) == PSA_SUCCESS);
  return out;
}

Bytes hmac_sha256(const Bytes& key, const Bytes& message) {
  psa_ready();
  psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
  psa_set_key_type(&attributes, PSA_KEY_TYPE_HMAC);
  psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_SIGN_MESSAGE);
  psa_set_key_algorithm(&attributes, PSA_ALG_HMAC(PSA_ALG_SHA_256));
  psa_key_id_t id = 0;
  REQUIRE(psa_import_key(&attributes, key.data(), key.size(), &id) == PSA_SUCCESS);
  Bytes out(32);
  std::size_t length = 0;
  const psa_status_t status = psa_mac_compute(id, PSA_ALG_HMAC(PSA_ALG_SHA_256), message.data(),
                                              message.size(), out.data(), out.size(), &length);
  psa_destroy_key(id);
  REQUIRE(status == PSA_SUCCESS);
  return out;
}

Bytes hkdf_sha256(const Bytes& key, const Bytes& salt, const Bytes& info) {
  const Bytes prk = hmac_sha256(salt, key);
  Bytes expand = info;
  expand.push_back(0x01);
  return hmac_sha256(prk, expand);
}

Bytes session_key(const protocol::DeviceKey& key, const Bytes& nonce, std::uint32_t address) {
  Bytes info(protocol::kSessionKeyLabel.begin(), protocol::kSessionKeyLabel.end());
  for (std::size_t i = 0; i < 4; ++i) {
    info.push_back(static_cast<std::uint8_t>((address >> (8 * i)) & 0xFFu));
  }
  return hkdf_sha256(Bytes(key.begin(), key.end()), nonce, info);
}

protocol::SessionTag open_tag(const Bytes& key, std::uint32_t address,
                              const protocol::DeviceRandom& random, const protocol::ImageId& id) {
  Bytes message(protocol::kSessionOpenLabel.begin(), protocol::kSessionOpenLabel.end());
  for (std::size_t i = 0; i < 4; ++i) {
    message.push_back(static_cast<std::uint8_t>((address >> (8 * i)) & 0xFFu));
  }
  message.insert(message.end(), random.begin(), random.end());
  message.insert(message.end(), id.begin(), id.end());
  const Bytes mac = hmac_sha256(key, message);
  protocol::SessionTag tag{};
  std::copy_n(mac.begin(), tag.size(), tag.begin());
  return tag;
}

Bytes sign_p256(const Bytes& private_key, const Bytes& digest) {
  psa_ready();
  psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
  psa_set_key_type(&attributes, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1));
  psa_set_key_bits(&attributes, 256);
  psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_SIGN_HASH);
  psa_set_key_algorithm(&attributes, PSA_ALG_DETERMINISTIC_ECDSA(PSA_ALG_SHA_256));
  psa_key_id_t id = 0;
  REQUIRE(psa_import_key(&attributes, private_key.data(), private_key.size(), &id) == PSA_SUCCESS);
  Bytes signature(64);
  std::size_t length = 0;
  const psa_status_t status =
      psa_sign_hash(id, PSA_ALG_DETERMINISTIC_ECDSA(PSA_ALG_SHA_256), digest.data(), digest.size(),
                    signature.data(), signature.size(), &length);
  psa_destroy_key(id);
  REQUIRE(status == PSA_SUCCESS);
  REQUIRE(length == 64);
  return signature;
}

TestCrypto::TestCrypto() {
  psa_ready();
}

HalError TestCrypto::sha256_start() {
  sha_starts += 1;
  if (fail_sha) {
    return HalError::io;
  }
  hashing_ = true;
  hashed_.clear();
  return HalError::none;
}

HalError TestCrypto::sha256_add(protocol::ByteView bytes) {
  if (!hashing_ || fail_sha) {
    return HalError::invalid;
  }
  hashed_.insert(hashed_.end(), bytes.begin(), bytes.end());
  return HalError::none;
}

HalError TestCrypto::sha256_finish(protocol::MutableByteView digest) {
  if (!hashing_ || digest.size() != 32) {
    return HalError::invalid;
  }
  hashing_ = false;
  const Bytes out = sha256(hashed_);
  std::copy(out.begin(), out.end(), digest.begin());
  return HalError::none;
}

bool TestCrypto::verify_p256(protocol::ByteView public_xy, protocol::ByteView digest,
                             protocol::ByteView signature_rs) {
  verifies += 1;
  if (public_xy.size() != 64 || digest.size() != 32 || signature_rs.size() != 64) {
    return false;
  }
  Bytes point{0x04};
  point.insert(point.end(), public_xy.begin(), public_xy.end());
  psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
  psa_set_key_type(&attributes, PSA_KEY_TYPE_ECC_PUBLIC_KEY(PSA_ECC_FAMILY_SECP_R1));
  psa_set_key_bits(&attributes, 256);
  psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_VERIFY_HASH);
  psa_set_key_algorithm(&attributes, PSA_ALG_ECDSA(PSA_ALG_SHA_256));
  psa_key_id_t id = 0;
  if (psa_import_key(&attributes, point.data(), point.size(), &id) != PSA_SUCCESS) {
    return false;
  }
  const psa_status_t status =
      psa_verify_hash(id, PSA_ALG_ECDSA(PSA_ALG_SHA_256), digest.data(), digest.size(),
                      signature_rs.data(), signature_rs.size());
  psa_destroy_key(id);
  return status == PSA_SUCCESS;
}

HalError TestCrypto::session_key(protocol::ByteView nonce, std::uint32_t address,
                                 protocol::MutableByteView out) {
  session_keys += 1;
  if (fail_session_key || nonce.size() != 8 || out.size() != device::kSessionKeySize) {
    return HalError::io;
  }
  const Bytes key = update::session_key(device_key, Bytes(nonce.begin(), nonce.end()), address);
  std::copy(key.begin(), key.end(), out.begin());
  return HalError::none;
}

HalError TestCrypto::hmac_sha256(protocol::ByteView key, protocol::ByteView message,
                                 protocol::MutableByteView out) {
  if (out.size() != 32) {
    return HalError::invalid;
  }
  const Bytes mac =
      update::hmac_sha256(Bytes(key.begin(), key.end()), Bytes(message.begin(), message.end()));
  std::copy(mac.begin(), mac.end(), out.begin());
  return HalError::none;
}

// ---- Links and the rest ----

HalError TestLink::connect(const device::LinkTarget& target) {
  connects += 1;
  connecting = true;
  last_wifi_name.assign(target.wifi_name.begin(), target.wifi_name.end());
  return HalError::none;
}

void TestLink::disconnect() {
  disconnects += 1;
  connecting = false;
  is_up = false;
}

HalError TestLink::send(protocol::ByteView packet) {
  if (send_error != HalError::none) {
    return send_error;
  }
  sent.emplace_back(packet.begin(), packet.end());
  return HalError::none;
}

void CountingRandom::fill(protocol::MutableByteView out) {
  for (std::uint8_t& byte : out) {
    byte = next_;
    next_ = static_cast<std::uint8_t>(next_ + 1);
  }
}

// ---- The file, the bench, the source ----

Bytes ImageFile::file() const {
  Bytes out = header_bytes;
  out.insert(out.end(), image.begin(), image.end());
  return out;
}

ImageFile make_file(const Bytes& image, std::uint8_t roles,
                    const std::function<void(protocol::ImageHeader&)>& adjust) {
  ImageFile file;
  file.image = image;
  file.header.roles = roles;
  file.header.target = protocol::kImageTargetEsp32s3;
  file.header.version = image_version(image);
  file.header.image_bytes = static_cast<std::uint32_t>(image.size());
  const Bytes digest = sha256(image);
  std::copy(digest.begin(), digest.end(), file.header.image_sha256.begin());
  const Bytes hub = vector_hub_identity();
  std::copy(hub.begin(), hub.end(), file.header.hub_identity.begin());
  if (adjust) {
    adjust(file.header);
  }
  file.header_bytes = Bytes(protocol::kImageHeaderSize);
  REQUIRE(protocol::encode_image_header(file.header,
                                        protocol::MutableByteView(file.header_bytes.data(), 128))
              .ok());
  Bytes signed_bytes(protocol::kImageSignatureLabel.begin(), protocol::kImageSignatureLabel.end());
  signed_bytes.insert(signed_bytes.end(), file.header_bytes.begin(),
                      file.header_bytes.begin() + 64);
  const Bytes signature = sign_p256(vector_signing_private(), sha256(signed_bytes));
  std::copy(signature.begin(), signature.end(), file.header.signature.begin());
  REQUIRE(protocol::encode_image_header(file.header,
                                        protocol::MutableByteView(file.header_bytes.data(), 128))
              .ok());
  file.id = protocol::image_id_of(file.header);
  return file;
}

Bench::Bench(const BenchOptions& options_in)
    : options(options_in),
      slots(power, options_in.capacity, make_image(options_in.old_version, 30000, 7)),
      hal{storage,
          retained,
          radio,
          random,
          supply,
          slots,
          crypto,
          key_import,
          &usb,
          &network,
          options_in.bluetooth ? &bluetooth : nullptr,
          cipher,
          device::BuildInfo{}} {
  hal.build.version = options.old_version;
  hal.build.development = true;
  // Paired, as Set role and Provision leave a board (protocol section 10).
  storage.records[device::StoreKey::role] = Bytes{device::kRoleRecordVersion, options.role};
  device::PairingRecord pairing;
  pairing.address = kAddress;
  pairing.key = kKey;
  std::copy(options.hub_identity.begin(), options.hub_identity.end(), pairing.hub_identity.begin());
  std::copy(options.signing_key.begin(), options.signing_key.end(),
            pairing.firmware_signing_key.begin());
  pairing.site_channel = 1;
  pairing.allowed_data_rate_mask = 0x24;
  if (options.wifi_details) {
    pairing.wifi_name_size = 4;
    pairing.wifi_name = {'h', 'o', 'm', 'e'};
    pairing.wifi_password_size = 2;
    pairing.wifi_password = {'p', 'w'};
  }
  Bytes record(1 + sizeof(pairing));
  record[0] = device::kPairingRecordVersion;
  std::memcpy(record.data() + 1, &pairing, sizeof(pairing));
  storage.records[device::StoreKey::pairing] = record;
  const auto step = static_cast<std::uint32_t>(device::counter_step(options.role));
  Bytes resume(4);
  put_le32(resume, 0, step);
  storage.records[device::StoreKey::counter_resume] = resume;
  REQUIRE(cipher.set_key(kKey) == protocol::Error::none);
}

void Bench::boot(device::BootKind kind) {
  REQUIRE(power.on);
  slots.boot();
  hal.build.version = image_version(slots.bytes[static_cast<std::size_t>(slots.running_slot())]);
  for (TestLink* each : {&usb, &network, &bluetooth}) {
    each->is_up = false;
    each->connecting = false;
    each->handled = each->sent.size();
  }
  instance.reset();
  instance.emplace(hal, watchdog, options.role);
  instance->role.wake.deepest = device::SleepDepth::deep;
  device::BootInfo info;
  info.kind = kind;
  info.reset_cause = kind == device::BootKind::power_on ? 1 : 3;
  instance->runner.start(device::Event::booted(now, info));
}

void Bench::deliver_link(LinkKind kind, device::LinkEventKind event, const Bytes& packet) {
  device::LinkEvent link;
  link.link = kind;
  link.kind = event;
  link.packet = protocol::ByteView(packet.data(), packet.size());
  instance->runner.deliver(device::Event::from_link(now, link));
}

void Bench::advance_to(Instant at) {
  if (at > now) {
    now = at;
  }
  instance->runner.timed_out(now);
}

std::optional<device::UpdatePacket> Bench::take_packet() {
  const device::UpdatePacket packet = update().next_packet(now);
  if (packet.kind == device::UpdatePacketKind::none) {
    return std::nullopt;
  }
  update().packet_sent(now);
  return packet;
}

std::vector<std::uint16_t> Bench::log_codes() {
  protocol::LogEntries entries;
  std::vector<std::uint16_t> codes;
  if (services().log.prepare(now, entries) == 0) {
    return codes;
  }
  protocol::LogEntryReader reader(entries.entries);
  protocol::LogEntry entry;
  while (reader.next(entry)) {
    codes.push_back(entry.code);
  }
  return codes;
}

std::optional<std::int32_t> Bench::log_value(std::uint16_t code) {
  protocol::LogEntries entries;
  std::optional<std::int32_t> value;
  if (services().log.prepare(now, entries) == 0) {
    return value;
  }
  protocol::LogEntryReader reader(entries.entries);
  protocol::LogEntry entry;
  while (reader.next(entry)) {
    if (entry.code != code) {
      continue;
    }
    const std::string text(entry.text.bytes.begin(), entry.text.bytes.end());
    const std::size_t space = text.rfind(' ');
    value = space == std::string::npos
                ? std::optional<std::int32_t>()
                : std::optional<std::int32_t>(std::stoi(text.substr(space + 1)));
  }
  return value;
}

TestLink& Bench::link(LinkKind kind) {
  switch (kind) {
    case LinkKind::usb:
      return usb;
    case LinkKind::network:
      return network;
    case LinkKind::bluetooth:
      return bluetooth;
  }
  return usb;
}

protocol::transfer::Get decode_get(const Bytes& frame) {
  protocol::transfer::Get get;
  bool decoded = false;
  const protocol::Error error = protocol::decode_transfer(
      protocol::ByteView(frame.data(), frame.size()), [&](const auto& value) {
        if constexpr (std::is_same_v<std::decay_t<decltype(value)>, protocol::transfer::Get>) {
          get = value;
          decoded = true;
        }
      });
  REQUIRE(error == protocol::Error::none);
  REQUIRE(decoded);
  return get;
}

Bytes data_frame(const protocol::ImageId& id, const Bytes& file, std::uint32_t offset,
                 std::uint16_t length, bool bad_crc) {
  REQUIRE(offset + length <= file.size());
  protocol::transfer::Data data;
  data.image_id = id;
  data.offset = offset;
  data.data.bytes = protocol::ByteView(file.data() + offset, length);
  data.crc32 = protocol::crc32(data.data.bytes) ^ (bad_crc ? 1u : 0u);
  Bytes frame(protocol::kTransferDataHeaderSize + length);
  const auto size =
      protocol::encode_transfer(data, protocol::MutableByteView(frame.data(), frame.size()));
  REQUIRE(size.ok());
  frame.resize(size.value());
  return frame;
}

protocol::UpdateOffer make_offer(std::uint8_t action, const ImageFile& file) {
  protocol::UpdateOffer offer;
  offer.action = action;
  offer.image_id = file.id;
  offer.file_bytes = static_cast<std::uint32_t>(file.header_bytes.size() + file.image.size());
  offer.version = file.header.version;
  return offer;
}

std::size_t Source::serve() {
  TestLink& link = bench_.link(kind_);
  std::size_t processed = 0;
  const std::size_t end = link.sent.size();
  while (link.handled < end && bench_.power.on && bench_.instance.has_value()) {
    const Bytes frame = link.sent[link.handled];
    link.handled += 1;
    processed += 1;
    if (frame.size() < 2 || frame[0] != protocol::kTransferMarker ||
        frame[1] != protocol::transfer_kind::get) {
      other.push_back(frame);
      continue;
    }
    const protocol::transfer::Get get = decode_get(frame);
    gets.push_back(get);
    auto ignored = std::find(rules.ignore_once.begin(), rules.ignore_once.end(), get.offset);
    if (rules.ignore_always || ignored != rules.ignore_once.end()) {
      if (ignored != rules.ignore_once.end()) {
        rules.ignore_once.erase(ignored);
      }
      continue;
    }
    if (rules.gone.has_value()) {
      protocol::transfer::Gone gone;
      gone.image_id = get.image_id;
      gone.reason = *rules.gone;
      Bytes out(16);
      const auto size =
          protocol::encode_transfer(gone, protocol::MutableByteView(out.data(), out.size()));
      REQUIRE(size.ok());
      out.resize(size.value());
      bench_.deliver_link(kind_, device::LinkEventKind::packet, out);
      continue;
    }
    if (get.offset + get.length > file_.size()) {
      continue;
    }
    auto bad = std::find(rules.bad_crc_once.begin(), rules.bad_crc_once.end(), get.offset);
    const bool corrupt = bad != rules.bad_crc_once.end();
    if (corrupt) {
      rules.bad_crc_once.erase(bad);
    }
    bench_.deliver_link(kind_, device::LinkEventKind::packet,
                        data_frame(get.image_id, file_, get.offset, get.length, corrupt));
  }
  return processed;
}

bool run(Bench& bench, Source& source, const std::function<bool()>& done,
         const std::function<void(const device::UpdatePacket&)>& on_packet, int max_turns) {
  for (int turn = 0; turn < max_turns; ++turn) {
    if (done && done()) {
      return true;
    }
    if (!bench.power.on || !bench.instance.has_value()) {
      return false;
    }
    if (const auto packet = bench.take_packet()) {
      if (on_packet) {
        on_packet(*packet);
      }
      continue;
    }
    if (source.serve() > 0) {
      continue;
    }
    const device::Wake wake = bench.instance->device.next_wake();
    if (wake.restart || wake.at.is_never()) {
      return done && done();
    }
    bench.advance_to(wake.at);
  }
  FAIL("the run did not settle");
  return false;
}

bool has_stage(const Packets& packets, std::uint8_t stage) {
  return std::any_of(packets.begin(), packets.end(), [&](const device::UpdatePacket& packet) {
    return packet.kind == device::UpdatePacketKind::status && packet.status.stage == stage;
  });
}

void fetch_to_verified(Bench& bench, Source& hub, const ImageFile& file, Packets& packets) {
  bench.update().offer(make_offer(protocol::UpdateAction::fetch, file), device::UpdatePath::network,
                       bench.now);
  REQUIRE(run(
      bench, hub, [&] { return has_stage(packets, protocol::UpdateStage::verified); },
      [&](const device::UpdatePacket& packet) { packets.push_back(packet); }));
}

void install_and_restart(Bench& bench, Source& hub, const ImageFile& file, Packets& packets) {
  bench.update().offer(make_offer(protocol::UpdateAction::install_now, file),
                       device::UpdatePath::network, bench.now);
  REQUIRE_FALSE(run(
      bench, hub, [] { return false; },
      [&](const device::UpdatePacket& packet) { packets.push_back(packet); }));
  REQUIRE(has_stage(packets, protocol::UpdateStage::installing));
  REQUIRE(bench.instance->device.next_wake().restart);
  bench.boot(device::BootKind::other_reset);
}

}  // namespace hsn::test::update
