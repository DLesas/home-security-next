#include "hsn/device/services/update.hpp"

#include <type_traits>

#include "hsn/device/services.hpp"

namespace hsn::device {

// UpdateService, part one: boot, offers, the packets the role sends, the trial, and the wake
// (m3-updates-design.md sections 2 to 6). The pull and the checks are in update_transfer.cpp, the
// Bluetooth session in update_session.cpp.

static_assert(std::has_unique_object_representations_v<UpdateRecord>, "a record has no padding");
static_assert(sizeof(UpdateRecord) + 1 == 134, "the update record is 134 bytes with its version");

namespace {

std::uint32_t from_le(const std::array<std::uint8_t, 4>& bytes) {
  std::uint32_t value = 0;
  for (std::size_t i = 0; i < bytes.size(); ++i) {
    value |= static_cast<std::uint32_t>(bytes[i]) << (8 * i);
  }
  return value;
}

std::array<std::uint8_t, 4> to_le(std::uint32_t value) {
  std::array<std::uint8_t, 4> bytes{};
  for (std::size_t i = 0; i < bytes.size(); ++i) {
    bytes[i] = static_cast<std::uint8_t>((value >> (8 * i)) & 0xFFu);
  }
  return bytes;
}

/** A version as one number for a log entry: major·65536 + minor·256 + patch. */
std::int32_t version_number(const protocol::FirmwareVersion& version) {
  return static_cast<std::int32_t>((static_cast<std::uint32_t>(version.major) << 16) |
                                   (static_cast<std::uint32_t>(version.minor) << 8) |
                                   version.patch);
}

bool same_version(const protocol::FirmwareVersion& a, const protocol::FirmwareVersion& b) {
  return a.major == b.major && a.minor == b.minor && a.patch == b.patch;
}

/** The image id a stored header carries: its bytes 16 to 23. */
protocol::ImageId stored_id(const UpdateRecord& record) {
  protocol::ImageId id{};
  for (std::size_t i = 0; i < id.size(); ++i) {
    id[i] = record.header[16 + i];
  }
  return id;
}

/** The reconnect gaps of a link the service joined itself (protocol section 7). */
constexpr std::array<std::int64_t, 6> kReconnectSeconds{1, 2, 4, 8, 15, 30};

}  // namespace

UpdateService::UpdateService(Hal& hal, const SetupService& setup, Health& health,
                             RandomSource& random, LogBuffer& log)
    : hal_(hal),
      setup_(setup),
      health_(health),
      random_(random),
      log_(log),
      record_(hal.storage, StoreKey::update, kUpdateRecordVersion, UpdateRecord{}) {}

// ---- Boot and the record ----

void UpdateService::boot(Instant now) {
  running_ = hal_.slots.running();
  health_.running_image(running_);
  if (running_.rolled_back) {
    log_.add(now, LogLevel::warning, log_code::update_rolled_back, "rolled back",
             version_number(running_.failed));
  }
  load_record(now);
  if (running_.on_trial) {
    const Duration trial = setup_.role() == protocol::Role::sensor ? kTrialSensor : kTrialOther;
    trial_deadline_ = now + trial;
    return;
  }
  if (!record_.stored()) {
    return;
  }
  if (record_.get().stage == static_cast<std::uint8_t>(UpdateRecordStage::verified) &&
      ((running_.rolled_back && same_version(header_.version, running_.failed)) ||
       same_version(header_.version, running_.version))) {
    // The verified image is the one that just failed its trial, or the one now running (confirmed
    // before its record could be erased): nothing to offer the hub.
    erase_record(now);
    forget_progress();
    return;
  }
  query_wanted_ = true;
}

void UpdateService::load_record(Instant now) {
  forget_progress();
  const HalError error = record_.load();
  if (error == HalError::not_found) {
    return;
  }
  if (error != HalError::none) {
    log_.add(now, LogLevel::warning, log_code::storage_failed, "update record",
             static_cast<std::int32_t>(error));
    if (error == HalError::invalid) {
      erase_record(now);
    }
    return;
  }
  const UpdateRecord& record = record_.get();
  protocol::ImageHeader header;
  bool valid = protocol::decode_image_header(protocol::ByteView(record.header), header) ==
               protocol::Error::none;
  valid = valid && header.image_bytes <= hal_.slots.capacity();
  const std::uint32_t bytes = from_le(record.bytes_written);
  const std::uint32_t total =
      static_cast<std::uint32_t>(protocol::kImageHeaderSize) + (valid ? header.image_bytes : 0);
  if (record.stage == static_cast<std::uint8_t>(UpdateRecordStage::partial)) {
    valid = valid && bytes >= protocol::kImageHeaderSize && bytes <= total &&
            (bytes - protocol::kImageHeaderSize) % kCheckpointBytes == 0;
  } else if (record.stage == static_cast<std::uint8_t>(UpdateRecordStage::verified)) {
    valid = valid && bytes == total;
  } else {
    valid = false;
  }
  if (!valid) {
    log_.add(now, LogLevel::warning, log_code::storage_failed, "update record");
    erase_record(now);
    return;
  }
  select_image(stored_id(record));
}

bool UpdateService::record_holds(const protocol::ImageId& id) const {
  return record_.stored() && stored_id(record_.get()) == id;
}

bool UpdateService::record_verified(const protocol::ImageId& id) const {
  return record_holds(id) &&
         record_.get().stage == static_cast<std::uint8_t>(UpdateRecordStage::verified);
}

std::uint32_t UpdateService::record_bytes() const {
  return record_.stored() ? from_le(record_.get().bytes_written) : 0;
}

HalError UpdateService::write_record(UpdateRecordStage stage, std::uint32_t bytes, Instant now) {
  UpdateRecord record;
  record.header = header_bytes_;
  record.stage = static_cast<std::uint8_t>(stage);
  record.bytes_written = to_le(bytes);
  const HalError error = record_.update(record);
  if (error != HalError::none) {
    log_.add(now, LogLevel::warning, log_code::storage_failed, "update record",
             static_cast<std::int32_t>(error));
  }
  return error;
}

void UpdateService::erase_record(Instant now) {
  if (!record_.stored()) {
    return;
  }
  const HalError error = record_.erase();
  if (error != HalError::none) {
    log_.add(now, LogLevel::warning, log_code::storage_failed, "update record",
             static_cast<std::int32_t>(error));
  }
}

void UpdateService::select_image(const protocol::ImageId& id) {
  if (have_header_ && image_id_ == id) {
    return;
  }
  image_id_ = id;
  forget_progress();
  if (!record_holds(id)) {
    return;
  }
  const UpdateRecord& record = record_.get();
  if (protocol::decode_image_header(protocol::ByteView(record.header), header_) !=
      protocol::Error::none) {
    return;
  }
  header_bytes_ = record.header;
  have_header_ = true;
  const std::uint32_t image =
      from_le(record.bytes_written) - static_cast<std::uint32_t>(protocol::kImageHeaderSize);
  sector_ = record.stage == static_cast<std::uint8_t>(UpdateRecordStage::verified)
                ? sector_count()
                : image / static_cast<std::uint32_t>(kSlotSectorSize);
  progress_mark_ = written_bytes();
}

void UpdateService::forget_progress() {
  have_header_ = false;
  sector_ = 0;
  progress_mark_ = 0;
}

// ---- Refusals, statuses, links ----

void UpdateService::refuse(std::uint8_t reason, bool keep_part, Instant now) {
  log_.add(now, LogLevel::warning, log_code::update_refused, "update refused", reason);
  if (session_ == Session::open) {
    send_done(protocol::DoneResult::refused, reason);
  }
  close_session();
  stop_transfer();
  leave_wifi();
  phase_ = Phase::idle;
  std::uint32_t bytes = 0;
  if (keep_part && record_holds(image_id_)) {
    bytes = record_bytes();
  } else if (!keep_part) {
    if (record_holds(image_id_)) {
      erase_record(now);
    }
    forget_progress();
  }
  if (!record_holds(image_id_)) {
    forget_progress();
  }
  send_status(image_id_, protocol::UpdateStage::refused, reason, bytes, false);
}

void UpdateService::refuse_offer(const protocol::UpdateOffer& offer, std::uint8_t reason,
                                 Instant now) {
  log_.add(now, LogLevel::warning, log_code::update_refused, "update refused", reason);
  send_status(offer.image_id, protocol::UpdateStage::refused, reason, 0, false);
}

void UpdateService::send_status(const protocol::ImageId& id, std::uint8_t stage,
                                std::uint8_t reason, std::uint32_t bytes, bool links_only) {
  status_.image_id = id;
  status_.stage = stage;
  status_.reason = reason;
  status_.bytes_written = bytes;
  status_links_only_ = links_only;
  status_pending_ = true;
}

void UpdateService::leave_wifi() {
  if (joined_wifi_ && hal_.network != nullptr) {
    hal_.network->disconnect();
  }
  joined_wifi_ = false;
  reconnect_at_ = Instant::never();
  reconnects_ = 0;
}

void UpdateService::stop_transfer() {
  ask_count_ = 0;
  received_ = {};
  send_retry_at_ = Instant::never();
  link_deadline_ = Instant::never();
  if (phase_ == Phase::header || phase_ == Phase::image || phase_ == Phase::waiting ||
      phase_ == Phase::joining || phase_ == Phase::hashing) {
    phase_ = Phase::idle;
  }
}

Link* UpdateService::link_for(LinkKind kind) const {
  switch (kind) {
    case LinkKind::usb:
      return hal_.usb;
    case LinkKind::network:
      return hal_.network;
    case LinkKind::bluetooth:
      return hal_.bluetooth;
  }
  return nullptr;
}

// ---- Device ----

void UpdateService::poll(Instant now) {
  if (restart_) {
    return;
  }
  if (running_.on_trial && now >= trial_deadline_) {
    log_.add(now, LogLevel::error, log_code::update_trial_failed, "trial deadline");
    const HalError error = hal_.slots.reject();
    if (error != HalError::none) {
      // A restart on trial rolls back all the same (section 2).
      log_.add(now, LogLevel::error, log_code::update_trial_failed, "reject",
               static_cast<std::int32_t>(error));
    }
    restart_ = true;
    return;
  }
  switch (phase_) {
    case Phase::installing:
      if (now >= install_deadline_) {
        restart_ = true;
      }
      return;
    case Phase::hashing:
    case Phase::install_hash:
      if (now >= step_at_) {
        hash_step(now);
      }
      break;
    case Phase::joining:
    case Phase::waiting:
      poll_links(now);
      break;
    case Phase::header:
    case Phase::image:
      if (phase_ == Phase::image && !writes_allowed() && now - last_written_ >= kBusyBound) {
        // The gateway's gate held every write for the bound: stop, keep the part (section 5).
        refuse(protocol::UpdateReason::radio_busy, true, now);
      } else if (link_ != LinkKind::bluetooth && ask_count_ > 0 &&
                 now - last_progress_ >= kLinkLostAfter) {
        refuse(protocol::UpdateReason::link_lost, true, now);
      } else {
        reask(now);
      }
      break;
    case Phase::idle:
      break;
  }
  poll_session(now);
}

void UpdateService::poll_links(Instant now) {
  Link* network = hal_.network;
  if (phase_ == Phase::waiting && joined_wifi_ && network != nullptr && now >= reconnect_at_) {
    if (network->connect(setup_.pairing().link_target()) != HalError::none) {
      log_.add(now, LogLevel::debug, log_code::transfer_dropped, "wifi connect");
    }
    reconnect_at_ = now + seconds(kReconnectSeconds[reconnects_ < kReconnectSeconds.size()
                                                        ? reconnects_
                                                        : kReconnectSeconds.size() - 1]);
    reconnects_ = static_cast<std::uint8_t>(reconnects_ < 0xFF ? reconnects_ + 1 : reconnects_);
  }
  if (now < link_deadline_) {
    return;
  }
  std::uint8_t reason = protocol::UpdateReason::link_lost;
  if (phase_ == Phase::joining && (network == nullptr || !network->up())) {
    // Associated with the network (a signal) but no hub: hubNotFound; not even that: noWifi.
    reason = network != nullptr && network->signal_dbm() != 0
                 ? protocol::UpdateReason::hub_not_found
                 : protocol::UpdateReason::no_wifi;
  }
  refuse(reason, true, now);
}

void UpdateService::frame(LinkKind link, protocol::ByteView frame, Instant now) {
  const protocol::Error error = protocol::decode_transfer(frame, [&](const auto& decoded) {
    using Frame = std::decay_t<decltype(decoded)>;
    if constexpr (std::is_same_v<Frame, protocol::transfer::Data>) {
      on_data(link, decoded, now);
    } else if constexpr (std::is_same_v<Frame, protocol::transfer::Gone>) {
      on_gone(link, decoded, now);
    } else if constexpr (std::is_same_v<Frame, protocol::transfer::Open>) {
      on_open(link, decoded, now);
    } else {
      // Get, Hello and Done go from the device, never to it: an echo, dropped without a word.
      static_cast<void>(decoded);
    }
  });
  if (error != protocol::Error::none) {
    log_.add(now, LogLevel::debug, log_code::transfer_dropped, "frame not valid",
             static_cast<std::int32_t>(error));
  }
}

void UpdateService::link_changed(LinkKind link, bool up, Instant now) {
  if (link == LinkKind::bluetooth) {
    if (up) {
      session_up(now);
    } else {
      session_down(now);
    }
    return;
  }
  if (up) {
    if (phase_ == Phase::joining && link == LinkKind::network) {
      // Joined: ask on the new link, which identifies it to the hub (section 5).
      query_wanted_ = true;
      link_deadline_ = now + kJoinTime;
    } else if (phase_ == Phase::waiting) {
      // The transfer's link, or another one (a gateway back on Wi-Fi rather than USB): ask on it.
      query_wanted_ = true;
      reconnect_at_ = Instant::never();
      link_deadline_ = now + kLinkLostAfter;
    } else if (phase_ == Phase::idle && record_.stored() && !running_.on_trial) {
      query_wanted_ = true;
    }
    return;
  }
  if (link != link_ || (phase_ != Phase::header && phase_ != Phase::image)) {
    return;
  }
  // The transfer's link went down: keep what is written, and wait for it (section 5, "A break").
  const Phase was = phase_;
  stop_transfer();
  next_offset_ = was == Phase::header ? 0
                                      : static_cast<std::uint32_t>(protocol::kImageHeaderSize) +
                                            sector_ * static_cast<std::uint32_t>(kSlotSectorSize);
  phase_ = Phase::waiting;
  link_deadline_ = now + kLinkLostAfter;
  if (joined_wifi_) {
    reconnects_ = 0;
    reconnect_at_ = now + seconds(kReconnectSeconds[0]);
  }
}

Wake UpdateService::next_wake() const {
  Wake wake;
  if (restart_) {
    wake.restart = true;
    return wake;
  }
  Instant at = Instant::never();
  SleepDepth depth = SleepDepth::deep;
  const auto need = [&at, &depth](Instant when, SleepDepth deepest) {
    at = earliest(at, when);
    depth = deepest < depth ? deepest : depth;
  };
  if (running_.on_trial) {
    need(trial_deadline_, SleepDepth::light);
  }
  switch (phase_) {
    case Phase::joining:
    case Phase::waiting:
      need(link_deadline_, SleepDepth::light);
      if (joined_wifi_ && phase_ == Phase::waiting) {
        need(reconnect_at_, SleepDepth::light);
      }
      break;
    case Phase::header:
    case Phase::image:
      need(transfer_due(), link_ == LinkKind::bluetooth ? SleepDepth::awake : SleepDepth::light);
      break;
    case Phase::hashing:
    case Phase::install_hash:
      need(step_at_, SleepDepth::awake);
      break;
    case Phase::installing:
      need(install_deadline_, SleepDepth::light);
      break;
    case Phase::idle:
      break;
  }
  if (session_ != Session::closed) {
    // Bluetooth does not share light sleep with the RC slow clock (HN 6): the chip stays awake.
    need(session_due(), SleepDepth::awake);
  }
  wake.at = at;
  wake.deepest = depth;
  return wake;
}

bool UpdateService::active() const {
  return phase_ != Phase::idle || session_ != Session::closed ||
         (record_.stored() &&
          record_.get().stage == static_cast<std::uint8_t>(UpdateRecordStage::verified));
}

// ---- Roles ----

void UpdateService::update_flag(const protocol::Reply& reply, Instant now) {
  static_cast<void>(now);
  if (!reply.flags.update_available || running_.on_trial || restart_) {
    return;
  }
  if (phase_ != Phase::idle || session_ != Session::closed) {
    // Already about it: a query now would only bring the same offer again.
    return;
  }
  query_wanted_ = true;
}

void UpdateService::offer(const protocol::UpdateOffer& offer, UpdatePath path, Instant now) {
  if (restart_ || phase_ == Phase::install_hash || phase_ == Phase::installing) {
    // The go-ahead is being carried out; nothing changes it now.
    return;
  }
  const std::uint8_t action = offer.action;
  if (action == protocol::UpdateAction::nothing) {
    if (!running_.on_trial) {
      cancel(now);
    }
    return;
  }
  if (action == protocol::UpdateAction::wait) {
    if (!running_.on_trial) {
      close_session();
      stop_transfer();
      leave_wifi();
    }
    return;
  }
  if (!protocol::is_known<protocol::UpdateAction>(action)) {
    log_.add(now, LogLevel::warning, log_code::unknown_type, "update action", action);
    return;
  }
  if (running_.on_trial) {
    // The other slot holds the confirmed image while this one is on trial (section 2).
    refuse_offer(offer, protocol::UpdateReason::on_trial, now);
    return;
  }
  switch (action) {
    case protocol::UpdateAction::fetch:
      offer_fetch(offer, path, false, now);
      return;
    case protocol::UpdateAction::forced_fetch:
      offer_fetch(offer, path, true, now);
      return;
    case protocol::UpdateAction::join_wifi_and_fetch:
      offer_join(offer, now);
      return;
    case protocol::UpdateAction::open_bluetooth:
      offer_bluetooth(offer, now);
      return;
    case protocol::UpdateAction::install_now:
      offer_install(offer, now);
      return;
    default:
      return;
  }
}

void UpdateService::offer_fetch(const protocol::UpdateOffer& offer, UpdatePath path, bool forced,
                                Instant now) {
  if (path == UpdatePath::radio || path == UpdatePath::bluetooth) {
    // Nothing is pulled over LoRa (section 5), and Bluetooth starts only with action 3.
    log_.add(now, LogLevel::warning, log_code::transfer_dropped, "fetch not on a link");
    return;
  }
  const LinkKind kind = path == UpdatePath::usb ? LinkKind::usb : LinkKind::network;
  if (link_for(kind) == nullptr) {
    log_.add(now, LogLevel::warning, log_code::transfer_dropped, "fetch on no link");
    return;
  }
  // Forced for this image (action 6) until another image is offered or the update is cancelled;
  // a later action 1 for the same image does not take it back.
  if (forced) {
    forced_ = true;
    forced_id_ = offer.image_id;
  } else if (forced_id_ != offer.image_id) {
    forced_ = false;
  }
  if (record_verified(offer.image_id)) {
    close_session();
    stop_transfer();
    select_image(offer.image_id);
    send_status(image_id_, protocol::UpdateStage::verified, protocol::UpdateReason::none,
                record_bytes(), false);
    return;
  }
  if ((phase_ == Phase::header || phase_ == Phase::image || phase_ == Phase::hashing) &&
      link_ == kind && image_id_ == offer.image_id) {
    // The same grant again: the pull goes on as it is (writing now, if it was just forced).
    if (phase_ == Phase::image) {
      advance(now);
    }
    return;
  }
  close_session();
  start_fetch(offer.image_id, kind, now);
}

void UpdateService::offer_join(const protocol::UpdateOffer& offer, Instant now) {
  if (record_verified(offer.image_id)) {
    close_session();
    stop_transfer();
    select_image(offer.image_id);
    send_status(image_id_, protocol::UpdateStage::verified, protocol::UpdateReason::none,
                record_bytes(), false);
    return;
  }
  Link* network = hal_.network;
  if (network == nullptr || !setup_.paired() || setup_.pairing().wifi_name_size == 0) {
    refuse_offer(offer, protocol::UpdateReason::no_wifi, now);
    return;
  }
  close_session();
  stop_transfer();
  select_image(offer.image_id);
  phase_ = Phase::joining;
  link_deadline_ = now + kJoinTime;
  if (network->up()) {
    // Already on the network (a siren): ask on it at once.
    query_wanted_ = true;
    return;
  }
  if (network->connect(setup_.pairing().link_target()) != HalError::none) {
    refuse(protocol::UpdateReason::no_wifi, true, now);
    return;
  }
  joined_wifi_ = true;
}

void UpdateService::offer_install(const protocol::UpdateOffer& offer, Instant now) {
  if (!record_verified(offer.image_id) || phase_ != Phase::idle) {
    // Not verified (or not this image): tell the hub what is held instead.
    query_wanted_ = true;
    return;
  }
  close_session();
  select_image(offer.image_id);
  start_hash(Phase::install_hash, now);
}

void UpdateService::cancel(Instant now) {
  const bool held = record_.stored() || phase_ != Phase::idle || session_ != Session::closed;
  const protocol::ImageId id = record_.stored() ? stored_id(record_.get()) : image_id_;
  close_session();
  stop_transfer();
  leave_wifi();
  phase_ = Phase::idle;
  forced_ = false;
  erase_record(now);
  forget_progress();
  if (held) {
    send_status(id, protocol::UpdateStage::cancelled, protocol::UpdateReason::none, 0, false);
  }
}

void UpdateService::healthy(Instant now) {
  if (!running_.on_trial || restart_) {
    return;
  }
  const HalError error = hal_.slots.confirm();
  if (error != HalError::none) {
    // Still on trial: the next healthy() tries again, and the deadline still holds.
    log_.add(now, LogLevel::error, log_code::update_trial_failed, "confirm",
             static_cast<std::int32_t>(error));
    return;
  }
  running_.on_trial = false;
  running_.rolled_back = false;
  running_.failed = protocol::FirmwareVersion{};
  trial_deadline_ = Instant::never();
  health_.running_image(running_);
  log_.add(now, LogLevel::info, log_code::update_confirmed, "confirmed",
           version_number(running_.version));
  const protocol::ImageId id = record_.stored() ? stored_id(record_.get()) : protocol::ImageId{};
  const std::uint32_t bytes = record_bytes();
  erase_record(now);
  forget_progress();
  send_status(id, protocol::UpdateStage::confirmed, protocol::UpdateReason::none, bytes, false);
}

UpdatePacket UpdateService::next_packet(Instant now) const {
  static_cast<void>(now);
  UpdatePacket packet;
  if (status_pending_) {
    packet.kind = UpdatePacketKind::status;
    packet.status = status_;
    packet.links_only = status_links_only_;
    return packet;
  }
  if (!query_wanted_) {
    return packet;
  }
  packet.kind = UpdatePacketKind::query;
  if (record_.stored()) {
    packet.query.image_id = stored_id(record_.get());
    packet.query.held =
        record_.get().stage == static_cast<std::uint8_t>(UpdateRecordStage::verified)
            ? protocol::UpdateHeld::verified
            : protocol::UpdateHeld::part;
    packet.query.bytes_held = record_bytes();
  }
  packet.query.flags.has_wifi_details = setup_.paired() && setup_.pairing().wifi_name_size > 0;
  packet.query.flags.external_power = hal_.power.external_power();
  return packet;
}

void UpdateService::hold_writes(bool held, Instant now) {
  if (held == writes_held_) {
    return;
  }
  writes_held_ = held;
  if (held) {
    return;
  }
  // Released: the sectors waiting are written now. The bound still counts from the last sector
  // written, so a gate that opens and shuts without a write between does not reset it.
  if (phase_ == Phase::image) {
    advance(now);
  }
}

void UpdateService::packet_sent(Instant now) {
  static_cast<void>(now);
  if (status_pending_) {
    status_pending_ = false;
    if (status_.stage == protocol::UpdateStage::installing && phase_ == Phase::installing) {
      // The status that announces the restart is out: restart (the platform lets the links
      // finish sending first, design section 3).
      restart_ = true;
    }
    return;
  }
  query_wanted_ = false;
}

}  // namespace hsn::device
