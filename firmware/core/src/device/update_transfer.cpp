#include <cstring>

#include "hsn/device/services.hpp"
#include "hsn/device/services/update.hpp"
#include "hsn/protocol/checksum.hpp"

namespace hsn::device {

// UpdateService, part two: the pull (protocol section 10, "Firmware transfer frames"), the header's
// checks in their order (section 10, "The image header"), the sectors written in order with their
// checkpoints, and the read-back hash.

namespace {

constexpr std::uint32_t kHeader = static_cast<std::uint32_t>(protocol::kImageHeaderSize);
constexpr std::uint32_t kSector = static_cast<std::uint32_t>(kSlotSectorSize);

std::uint32_t smaller(std::uint32_t a, std::uint32_t b) {
  return a < b ? a : b;
}

}  // namespace

std::uint32_t UpdateService::sector_count() const {
  return have_header_ ? (header_.image_bytes + kSector - 1) / kSector : 0;
}

std::uint32_t UpdateService::sector_length(std::uint32_t sector) const {
  const std::uint32_t start = sector * kSector;
  return header_.image_bytes > start ? smaller(kSector, header_.image_bytes - start) : 0;
}

bool UpdateService::writes_allowed() const {
  return !writes_held_ || (forced_ && forced_id_ == image_id_);
}

std::uint32_t UpdateService::file_bytes() const {
  return kHeader + (have_header_ ? header_.image_bytes : 0);
}

std::uint32_t UpdateService::written_bytes() const {
  return have_header_ ? smaller(sector_ * kSector, header_.image_bytes) : 0;
}

void UpdateService::start_fetch(const protocol::ImageId& id, LinkKind kind, Instant now) {
  stop_transfer();
  select_image(id);
  link_ = kind;
  const bool bluetooth = kind == LinkKind::bluetooth;
  piece_ = bluetooth ? bluetooth_piece_ : kPieceOnLinks;
  window_ = bluetooth ? kGetsOnBluetooth : kGetsOnLinks;
  reask_ = bluetooth ? kReaskOnBluetooth : kReaskOnLinks;
  last_progress_ = now;
  last_written_ = now;
  if (!have_header_) {
    phase_ = Phase::header;
    next_offset_ = 0;
  } else if (sector_ >= sector_count()) {
    // Everything is written: only the hash is left (a link that dropped as the last sector went).
    start_hash(Phase::hashing, now);
    return;
  } else {
    // Resume where the slot was written to: the checkpoint after a reset, further within a boot.
    phase_ = Phase::image;
    next_offset_ = kHeader + sector_ * kSector;
    progress_mark_ = written_bytes();
  }
  fill(now);
}

bool UpdateService::send_get(Ask& ask, Instant now) {
  Link* link = link_for(link_);
  protocol::transfer::Get get;
  get.image_id = image_id_;
  get.offset = ask.offset;
  get.length = ask.length;
  const auto size = protocol::encode_transfer(get, protocol::MutableByteView(frame_out_));
  if (link == nullptr || !size.ok() ||
      link->send(protocol::ByteView(frame_out_).first(size.value())) != HalError::none) {
    ask.sent = false;
    send_retry_at_ = now + kSendRetry;
    return false;
  }
  ask.sent = true;
  ask.at = now;
  return true;
}

void UpdateService::fill(Instant now) {
  for (std::uint8_t i = 0; i < ask_count_; ++i) {
    if (!asks_[i].sent && !send_get(asks_[i], now)) {
      return;
    }
  }
  if (phase_ == Phase::header) {
    if (ask_count_ == 0) {
      asks_[0] = Ask{0, static_cast<std::uint16_t>(kHeader), false, now};
      ask_count_ = 1;
      next_offset_ = kHeader;
      static_cast<void>(send_get(asks_[0], now));
    }
    return;
  }
  if (phase_ != Phase::image) {
    return;
  }
  // Never past the sector after the current one: two buffers hold everything asked for.
  const std::uint32_t ahead = kHeader + (sector_ + 2) * kSector;
  const std::uint32_t limit = smaller(file_bytes(), ahead);
  if (ask_count_ == 0 && next_offset_ < limit) {
    // Nothing was out (a held gate, a fresh grant): a silent source counts from now.
    last_progress_ = now;
  }
  while (ask_count_ < window_ && next_offset_ < limit) {
    const std::uint32_t sector = (next_offset_ - kHeader) / kSector;
    const std::uint32_t sector_end = kHeader + sector * kSector + sector_length(sector);
    const std::uint32_t length = smaller(piece_, sector_end - next_offset_);
    Ask& ask = asks_[ask_count_];
    ask = Ask{next_offset_, static_cast<std::uint16_t>(length), false, now};
    ask_count_ = static_cast<std::uint8_t>(ask_count_ + 1);
    next_offset_ += length;
    if (!send_get(ask, now)) {
      return;
    }
  }
}

void UpdateService::reask(Instant now) {
  for (std::uint8_t i = 0; i < ask_count_; ++i) {
    if (asks_[i].sent && now - asks_[i].at >= reask_) {
      asks_[i].sent = false;
    }
  }
  if (now >= send_retry_at_) {
    send_retry_at_ = Instant::never();
  }
  fill(now);
}

Instant UpdateService::transfer_due() const {
  Instant due = Instant::never();
  for (std::uint8_t i = 0; i < ask_count_; ++i) {
    due = earliest(due, asks_[i].sent ? asks_[i].at + reask_ : send_retry_at_);
  }
  if (link_ != LinkKind::bluetooth && ask_count_ > 0) {
    due = earliest(due, last_progress_ + kLinkLostAfter);
  }
  if (phase_ == Phase::image && !writes_allowed()) {
    due = earliest(due, last_written_ + kBusyBound);
  }
  return due;
}

void UpdateService::on_data(LinkKind kind, const protocol::transfer::Data& data, Instant now) {
  const bool pulling = phase_ == Phase::header || phase_ == Phase::image;
  const bool session_ok = kind != LinkKind::bluetooth || session_ == Session::open;
  std::uint8_t index = ask_count_;
  if (pulling && session_ok && kind == link_ && data.image_id == image_id_) {
    for (std::uint8_t i = 0; i < ask_count_; ++i) {
      if (asks_[i].offset == data.offset) {
        index = i;
      }
    }
  }
  if (index == ask_count_) {
    log_.add(now, LogLevel::debug, log_code::transfer_dropped, "data not asked for");
    return;
  }
  const protocol::ByteView bytes = data.data.bytes;
  const bool header = phase_ == Phase::header;
  if (protocol::crc32(bytes) != data.crc32 || (!header && bytes.size() != asks_[index].length)) {
    // Dropped and asked again at once (section 3, check 6).
    log_.add(now, LogLevel::debug, log_code::transfer_dropped, "data damaged");
    asks_[index].sent = false;
    fill(now);
    return;
  }
  const Ask ask = asks_[index];
  for (std::uint8_t i = index; i + 1 < ask_count_; ++i) {
    asks_[i] = asks_[i + 1];
  }
  ask_count_ = static_cast<std::uint8_t>(ask_count_ - 1);
  last_progress_ = now;
  if (header) {
    on_header(bytes, now);
    return;
  }
  const std::uint32_t image_offset = ask.offset - kHeader;
  const std::uint32_t sector = image_offset / kSector;
  const std::uint32_t within = image_offset % kSector;
  std::memcpy(sectors_[sector % 2].data() + within, bytes.data(), bytes.size());
  received_[sector % 2] += static_cast<std::uint32_t>(bytes.size());
  advance(now);
}

void UpdateService::advance(Instant now) {
  // Whole sectors are written in order, unless the gateway's gate holds the writes; while it
  // does, fill() asks for nothing past the two buffers, so nothing more is asked than is written.
  while (phase_ == Phase::image && sector_ < sector_count() && writes_allowed() &&
         received_[sector_ % 2] == sector_length(sector_)) {
    if (!flush_sector(now)) {
      return;
    }
  }
  if (phase_ != Phase::image) {
    return;
  }
  if (sector_ >= sector_count()) {
    start_hash(Phase::hashing, now);
    return;
  }
  fill(now);
}

void UpdateService::on_gone(LinkKind kind, const protocol::transfer::Gone& gone, Instant now) {
  if ((phase_ != Phase::header && phase_ != Phase::image) || kind != link_ ||
      gone.image_id != image_id_) {
    log_.add(now, LogLevel::debug, log_code::transfer_dropped, "gone not asked for");
    return;
  }
  log_.add(now, LogLevel::info, log_code::transfer_dropped, "gone", gone.reason);
  if (kind == LinkKind::bluetooth) {
    // The phone cannot serve the file: the session cannot go on.
    refuse(protocol::UpdateReason::link_lost, true, now);
    return;
  }
  // Not granted, paused or gone: keep what is written, and wait for the hub's next offer, which
  // resumes it (section 4, "While a countdown or alarm runs").
  stop_transfer();
}

std::uint8_t UpdateService::check_header(protocol::ByteView bytes) {
  // 1. Magic, format, target, zero bytes (and the header of the image offered).
  protocol::ImageHeader header;
  if (bytes.size() != protocol::kImageHeaderSize ||
      protocol::decode_image_header(bytes, header) != protocol::Error::none ||
      header.target != protocol::kImageTargetEsp32s3 ||
      protocol::image_id_of(header) != image_id_) {
    return protocol::UpdateReason::bad_header;
  }
  // 2. The paired hub signed it.
  const PairingRecord& pairing = setup_.pairing();
  if (header.hub_identity != pairing.hub_identity) {
    return protocol::UpdateReason::wrong_hub;
  }
  // 3. It is for this role.
  if ((header.roles & protocol::image_role_bit(setup_.role())) == 0) {
    return protocol::UpdateReason::wrong_role;
  }
  // 4. It fits the other slot.
  if (header.image_bytes > hal_.slots.capacity()) {
    return protocol::UpdateReason::too_large;
  }
  // 5. The signature, over SHA-256 of the label and bytes 0 to 63.
  UpdateCrypto& crypto = hal_.update_crypto;
  std::array<std::uint8_t, kSha256Size> digest{};
  if (crypto.sha256_start() != HalError::none ||
      crypto.sha256_add(protocol::ByteView(protocol::kImageSignatureLabel)) != HalError::none ||
      crypto.sha256_add(bytes.first(protocol::kImageHeaderSignedSize)) != HalError::none ||
      crypto.sha256_finish(protocol::MutableByteView(digest)) != HalError::none ||
      !crypto.verify_p256(protocol::ByteView(pairing.firmware_signing_key),
                          protocol::ByteView(digest), protocol::ByteView(header.signature))) {
    return protocol::UpdateReason::bad_signature;
  }
  header_ = header;
  return protocol::UpdateReason::none;
}

void UpdateService::on_header(protocol::ByteView bytes, Instant now) {
  const std::uint8_t reason = check_header(bytes);
  if (reason != protocol::UpdateReason::none) {
    // Nothing of this image has been written: a part of another image, if held, stays.
    refuse(reason, true, now);
    return;
  }
  // Nothing was written before this point (section 3). The record comes first, before the first
  // erase, so a reset from here on resumes this image, not the one held before.
  std::memcpy(header_bytes_.data(), bytes.data(), header_bytes_.size());
  have_header_ = true;
  sector_ = 0;
  progress_mark_ = 0;
  if (write_record(UpdateRecordStage::partial, kHeader, now) != HalError::none) {
    refuse(protocol::UpdateReason::flash, true, now);
    return;
  }
  received_ = {};
  phase_ = Phase::image;
  next_offset_ = kHeader;
  if (sector_count() == 0) {
    start_hash(Phase::hashing, now);
    return;
  }
  fill(now);
}

bool UpdateService::flush_sector(Instant now) {
  const std::uint32_t offset = sector_ * kSector;
  const std::uint32_t length = sector_length(sector_);
  FirmwareSlots& slots = hal_.slots;
  // Erased first, then written: flash only ever clears bits.
  if (slots.erase(offset) != HalError::none ||
      slots.write(offset, protocol::ByteView(sectors_[sector_ % 2]).first(length)) !=
          HalError::none) {
    refuse(protocol::UpdateReason::flash, true, now);
    return false;
  }
  received_[sector_ % 2] = 0;
  sector_ += 1;
  last_written_ = now;
  const std::uint32_t written = written_bytes();
  if (sector_ >= sector_count()) {
    return true;
  }
  if (written % kCheckpointBytes == 0 &&
      write_record(UpdateRecordStage::partial, kHeader + written, now) != HalError::none) {
    refuse(protocol::UpdateReason::flash, true, now);
    return false;
  }
  if (link_ != LinkKind::bluetooth && written - progress_mark_ >= kProgressBytes) {
    progress_mark_ = written;
    send_status(image_id_, protocol::UpdateStage::fetching, protocol::UpdateReason::none,
                kHeader + written, true);
  }
  return true;
}

void UpdateService::start_hash(Phase phase, Instant now) {
  ask_count_ = 0;
  received_ = {};
  send_retry_at_ = Instant::never();
  if (hal_.update_crypto.sha256_start() != HalError::none) {
    refuse(protocol::UpdateReason::flash, true, now);
    return;
  }
  phase_ = phase;
  hash_sector_ = 0;
  hash_step(now);
}

void UpdateService::hash_step(Instant now) {
  const std::uint32_t count = sector_count();
  for (std::uint32_t step = 0; step < kHashSectorsPerStep && hash_sector_ < count; ++step) {
    const protocol::MutableByteView buffer =
        protocol::MutableByteView(sectors_[0]).first(sector_length(hash_sector_));
    if (hal_.slots.read(hash_sector_ * kSector, buffer) != HalError::none ||
        hal_.update_crypto.sha256_add(buffer) != HalError::none) {
      refuse(protocol::UpdateReason::flash, true, now);
      return;
    }
    hash_sector_ += 1;
  }
  if (hash_sector_ < count) {
    step_at_ = now + kHashStepGap;
    return;
  }
  step_at_ = Instant::never();
  std::array<std::uint8_t, kSha256Size> digest{};
  if (hal_.update_crypto.sha256_finish(protocol::MutableByteView(digest)) != HalError::none) {
    refuse(protocol::UpdateReason::flash, true, now);
    return;
  }
  hashed(digest == header_.image_sha256, now);
}

void UpdateService::hashed(bool equal, Instant now) {
  if (!equal) {
    // Check 7: the download starts again from zero.
    refuse(protocol::UpdateReason::hash_mismatch, false, now);
    return;
  }
  if (phase_ == Phase::hashing) {
    if (write_record(UpdateRecordStage::verified, file_bytes(), now) != HalError::none) {
      refuse(protocol::UpdateReason::flash, true, now);
      return;
    }
    phase_ = Phase::idle;
    // Joined only for the pull: the go-ahead comes as any offer does, and may wait (armed) for
    // days, which a cell cannot spend on Wi-Fi.
    leave_wifi();
    if (session_ == Session::open) {
      send_done(protocol::DoneResult::verified, protocol::UpdateReason::none);
      close_session();
    }
    send_status(image_id_, protocol::UpdateStage::verified, protocol::UpdateReason::none,
                file_bytes(), false);
    return;
  }
  // Check 8, at "install now".
  const HalError error = hal_.slots.select();
  if (error != HalError::none) {
    const bool bad_image = error == HalError::invalid;
    refuse(bad_image ? protocol::UpdateReason::image_check : protocol::UpdateReason::flash,
           !bad_image, now);
    return;
  }
  phase_ = Phase::installing;
  install_deadline_ = now + kInstallSendBound;
  send_status(image_id_, protocol::UpdateStage::installing, protocol::UpdateReason::none,
              file_bytes(), false);
}

}  // namespace hsn::device
