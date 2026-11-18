#pragma once

#include <array>
#include <cstdint>

#include "hsn/device/events.hpp"
#include "hsn/device/hal/firmware_slots.hpp"
#include "hsn/device/hal/link.hpp"
#include "hsn/device/hal/update_crypto.hpp"
#include "hsn/device/role.hpp"
#include "hsn/device/services/record.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/image.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/transfer.hpp"

namespace hsn::device {

struct Hal;
class Health;
class LogBuffer;
class RandomSource;
class SetupService;

/**
 * The stuck-awake bound while an update is active or the running image is on trial: the larger of
 * the role's and this (m3-updates-design.md section 2), so a Bluetooth session and a ten-minute
 * trial are not taken for a stuck state machine.
 */
constexpr Duration kUpdateLongestAwake = seconds(40 * 60);

/** The update record's version byte (StoreKey::update). */
constexpr std::uint8_t kUpdateRecordVersion = 1;

/** The stage an update record holds. */
enum class UpdateRecordStage : std::uint8_t {
  /** Part of the image is written, up to the checkpoint. */
  partial = 1,
  /** The whole image is written and its SHA-256 read back equal to the header's. */
  verified = 2,
};

/**
 * An update in progress, as stored under StoreKey::update: with its version byte, 134 bytes. Every
 * image reads the fields it knows, and new ones are only ever added at the end (section 2).
 */
struct UpdateRecord {
  /** The image header, exactly as received and checked. */
  std::array<std::uint8_t, protocol::kImageHeaderSize> header{};
  /** See UpdateRecordStage. */
  std::uint8_t stage = 0;
  /** Bytes of the file written up to the last checkpoint, little-endian (no padding). */
  std::array<std::uint8_t, 4> bytes_written{};
};

/** How an update offer reached the device: action 1 fetches on that same path. */
enum class UpdatePath : std::uint8_t {
  radio,
  usb,
  network,
  bluetooth,
};

/** Which update packet a role must send. */
enum class UpdatePacketKind : std::uint8_t {
  none,
  /** An update query (0x06). */
  query,
  /** An update status (0x07). */
  status,
};

/** The update packet a role must seal and send next, if any. */
struct UpdatePacket {
  UpdatePacketKind kind = UpdatePacketKind::none;
  protocol::UpdateQuery query;
  protocol::UpdateStatus status;
  /** Progress, which goes on links only and never over LoRa (stage fetching, section 5). */
  bool links_only = false;
};

/**
 * Firmware updates on the device (m3-updates-design.md sections 2, 3 and 5): the offer, the
 * transfer frames and their windows, the sector buffers and checkpoints, the header's checks in
 * their order, the read-back hash, selecting the new image, the trial and its confirmation, and
 * the Bluetooth session. It has no clock: every call takes `now`, and next_wake() says when it must
 * run, which Device merges with the role's.
 *
 * The roles own the keys and the receiving rules (protocol section 4), so they open the hub's
 * packets and call the role-facing methods below; Device calls the rest. The device never writes
 * the other slot while its own image is on trial, and checks a header completely before it writes
 * a byte of the image.
 *
 * What it does, in the design's terms (provisional values ‡ are the private constants below):
 *
 * - An offer (UpdateAction) starts, resumes, waits for or stops a transfer; nothing starts while
 *   the running image is on trial (refused onTrial). "Fetch" pulls on the link the offer came by
 *   (never over LoRa); "join Wi-Fi" connects the network link and asks again on it; "open
 *   Bluetooth" opens the update window; "install now" reads the verified image back again, selects
 *   it, sends the status "installing" and restarts once the role has sent it.
 * - The pull: the header alone first, checked in section 3's order before anything is written;
 *   then the image in pieces that never cross a sector, never more than the current sector and the
 *   next, at most 4 Gets out on Wi-Fi and USB and 8 on Bluetooth, each asked again after 2 s (3 s).
 *   A Data that matches no Get, or fails its CRC-32, is dropped; a bad CRC is asked again at once.
 * - Each full sector is erased, then written; the record is written before the first erase, at
 *   every 64 KB, and when the image read back hashes to the header's SHA-256. A reset resumes at
 *   the checkpoint, a lost link where it stopped.
 * - The trial: confirmed on healthy(), rejected (and restarted) at the role's deadline.
 * - Every refusal is logged (log_code::update_refused, with the reason) and sent as a status.
 */
class UpdateService {
public:
  UpdateService(Hal& hal, const SetupService& setup, Health& health, RandomSource& random,
                LogBuffer& log);

  // ---- Device ----

  /**
   * Called once at boot, before the role's boot event: reads the running image and the update
   * record, tells Health the image fields Started carries, and starts the trial's deadline.
   */
  void boot(Instant now);

  /**
   * Works through the service's due deadlines (Get re-asks, the Bluetooth window, the Wi-Fi join,
   * the trial deadline). Device calls it on every event of an active device, before the role.
   */
  void poll(Instant now);

  /**
   * A transfer frame (first byte 0xF2) that arrived on `link`. Device passes every such frame
   * here, and none reaches the role.
   */
  void frame(LinkKind link, protocol::ByteView frame, Instant now);

  /**
   * A link came up or went down. Device calls it for every link: for Bluetooth (a phone connected
   * and subscribed) instead of the role, and for USB and the network beside the role, which still
   * gets those events. A link that comes back while a part is held, or during a transfer, makes
   * the service ask for an update query on it (section 5, "A break"). Roles need not call it.
   */
  void link_changed(LinkKind link, bool up, Instant now);

  /**
   * Returns when the service must run next and how deeply the chip may sleep until then. With
   * nothing under way: never, and deep, so it changes nothing in the role's wake.
   */
  Wake next_wake() const;

  /**
   * Returns what this boot is running, as read at boot.
   */
  const BootImage& running() const {
    return running_;
  }

  /**
   * True while the running image is on trial: Device then caps the chip at light sleep.
   */
  bool on_trial() const {
    return running_.on_trial;
  }

  /**
   * True while an update is under way (a download, a verified image waiting for the go-ahead, a
   * Bluetooth window or session): Device then lengthens the stuck-awake bound.
   */
  bool active() const;

  // ---- Roles ----

  /**
   * A reply arrived (a sensor): its "update available" flag. When set, the service asks for an
   * update query through next_packet().
   */
  void update_flag(const protocol::Reply& reply, Instant now);

  /**
   * An update offer the role opened under its receiving rule, and the path it came by.
   */
  void offer(const protocol::UpdateOffer& offer, UpdatePath path, Instant now);

  /**
   * The role's health condition is met (section 2): for a sensor, the reply to its Started; for a
   * siren, a hub packet opened and one LoRa transmission done; for a gateway, welcomed, settings
   * opened and its receive started. Confirms an image on trial; nothing otherwise.
   */
  void healthy(Instant now);

  /**
   * Returns the update query or status the role must send next, if any. The role fills a
   * query's battery code; a status marked links_only goes on a link, never over LoRa.
   */
  UpdatePacket next_packet(Instant now) const;

  /**
   * The role sent what next_packet() returned.
   */
  void packet_sent(Instant now);

  /**
   * A gateway's write gate (m3-updates-design.md section 5, "A site so busy that a transmission
   * is always waiting"): while held, no sector of the other slot is erased or written, and no more
   * pieces are asked for than the two sector buffers hold. Released, the waiting sectors are
   * written and the pull goes on. If no sector is written for 10 minutes while writes are held, the
   * fetch stops, keeps its part and checkpoint, and is refused radioBusy. An image offered with
   * action 6 (forced_fetch) ignores the gate. Other roles never hold writes.
   */
  void hold_writes(bool held, Instant now);

private:
  /** What the service is doing about an image. */
  enum class Phase : std::uint8_t {
    /** Nothing under way; a part or a verified image may be held (the record). */
    idle,
    /** Joining Wi-Fi for an offer "join Wi-Fi and fetch", or joined and waiting for its grant. */
    joining,
    /** The transfer's link went down: waiting for it to come back, and then for an offer. */
    waiting,
    /** Pulling the 128-byte header. */
    header,
    /** Pulling the image into the sector buffers and writing it. */
    image,
    /** Reading the whole image back after its last byte, for the SHA-256. */
    hashing,
    /** Reading it back again before select(), on "install now". */
    install_hash,
    /** Selected: the status "installing" is out (or going), then the restart. */
    installing,
  };

  /** The Bluetooth update session (m3-updates-design.md section 5). */
  enum class Session : std::uint8_t {
    closed,
    /** The window is open (advertising), nobody connected. */
    advertising,
    /** A phone is connected and has Hello; Open is awaited. */
    connected,
    /** Open's tag was right: the transfer runs over Bluetooth. */
    open,
  };

  /** One Get out: the piece it asks for, and when it went (or that it is still to go). */
  struct Ask {
    std::uint32_t offset = 0;
    std::uint16_t length = 0;
    bool sent = false;
    Instant at;
  };

  // Provisional values (‡ in the design), each to be measured.
  static constexpr std::uint8_t kGetsOnLinks = 4;
  static constexpr std::uint8_t kGetsOnBluetooth = 8;
  static constexpr Duration kReaskOnLinks = seconds(2);
  static constexpr Duration kReaskOnBluetooth = seconds(3);
  /** Data bytes per piece on Wi-Fi and USB (protocol::kMaxTransferData). */
  static constexpr std::uint16_t kPieceOnLinks = 1000;
  /**
   * Data bytes per piece on Bluetooth when the link does not say what the phone agreed: an ATT
   * payload at an MTU of 185 less the Data frame's 18 bytes. Otherwise a piece is the link's
   * largest_packet() less those 18 bytes, at most kPieceOnLinks.
   */
  static constexpr std::uint16_t kPieceOnBluetooth = 164;
  /** A gateway whose writes are held writes no sector for this long: refused radioBusy. */
  static constexpr Duration kBusyBound = seconds(10 * 60);
  /** A checkpoint (the record) every this many image bytes: 16 sectors. */
  static constexpr std::uint32_t kCheckpointBytes = 64 * 1024;
  /** An Update status "fetching" every this many image bytes, on links only. */
  static constexpr std::uint32_t kProgressBytes = 256 * 1024;
  /** Joining Wi-Fi and finding the hub (a sensor, action 2). */
  static constexpr Duration kJoinTime = seconds(30);
  /** A lost link (or no Data at all on an up one) for this long ends the transfer: linkLost. */
  static constexpr Duration kLinkLostAfter = seconds(120);
  /** Sectors read back per step of the hash, so no event holds the chip for long. */
  static constexpr std::uint32_t kHashSectorsPerStep = 4;
  /** The pause between steps of the hash: a real wait, so Runner sees no busy loop. */
  static constexpr Duration kHashStepGap = milliseconds(1);
  /** A Get the link would not take is offered to it again after this. */
  static constexpr Duration kSendRetry = milliseconds(100);
  /** After select(), the restart comes once "installing" is sent, or after this at the latest. */
  static constexpr Duration kInstallSendBound = seconds(10);
  static constexpr Duration kTrialSensor = seconds(10 * 60);
  static constexpr Duration kTrialOther = seconds(5 * 60);
  /** The Bluetooth window when the offer gives none. */
  static constexpr Duration kWindowDefault = seconds(120);
  static constexpr Duration kSessionLife = seconds(15 * 60);
  static constexpr Duration kSessionNoProgress = seconds(30);
  static constexpr std::uint8_t kWrongTagsAllowed = 5;

  // update.cpp: boot, the record, offers, packets, the trial, wakes.
  void load_record(Instant now);
  bool record_holds(const protocol::ImageId& id) const;
  bool record_verified(const protocol::ImageId& id) const;
  std::uint32_t record_bytes() const;
  HalError write_record(UpdateRecordStage stage, std::uint32_t bytes, Instant now);
  void erase_record(Instant now);
  void select_image(const protocol::ImageId& id);
  void forget_progress();
  void refuse(std::uint8_t reason, bool keep_part, Instant now);
  void refuse_offer(const protocol::UpdateOffer& offer, std::uint8_t reason, Instant now);
  void send_status(const protocol::ImageId& id, std::uint8_t stage, std::uint8_t reason,
                   std::uint32_t bytes, bool links_only);
  void leave_wifi();
  void stop_transfer();
  Link* link_for(LinkKind kind) const;
  void poll_links(Instant now);
  void offer_fetch(const protocol::UpdateOffer& offer, UpdatePath path, bool forced, Instant now);
  void offer_join(const protocol::UpdateOffer& offer, Instant now);
  void offer_install(const protocol::UpdateOffer& offer, Instant now);
  void cancel(Instant now);

  // update_transfer.cpp: the pull, the header's checks, the sectors and the hash.
  void start_fetch(const protocol::ImageId& id, LinkKind kind, Instant now);
  bool send_get(Ask& ask, Instant now);
  void fill(Instant now);
  void reask(Instant now);
  Instant transfer_due() const;
  void on_data(LinkKind kind, const protocol::transfer::Data& data, Instant now);
  void on_gone(LinkKind kind, const protocol::transfer::Gone& gone, Instant now);
  std::uint8_t check_header(protocol::ByteView bytes);
  void on_header(protocol::ByteView bytes, Instant now);
  bool flush_sector(Instant now);
  std::uint32_t sector_count() const;
  std::uint32_t sector_length(std::uint32_t sector) const;
  std::uint32_t file_bytes() const;
  std::uint32_t written_bytes() const;
  void start_hash(Phase phase, Instant now);
  void hash_step(Instant now);
  void hashed(bool equal, Instant now);
  void advance(Instant now);
  bool writes_allowed() const;

  // update_session.cpp: the Bluetooth session.
  void offer_bluetooth(const protocol::UpdateOffer& offer, Instant now);
  void session_up(Instant now);
  void session_down(Instant now);
  void on_open(LinkKind link, const protocol::transfer::Open& open, Instant now);
  void send_done(std::uint8_t result, std::uint8_t reason);
  void close_session();
  void poll_session(Instant now);
  Instant session_due() const;

  Hal& hal_;
  const SetupService& setup_;
  Health& health_;
  RandomSource& random_;
  LogBuffer& log_;
  BootImage running_;
  Record<UpdateRecord> record_;

  Phase phase_ = Phase::idle;
  bool restart_ = false;
  Instant trial_deadline_ = Instant::never();
  Instant install_deadline_ = Instant::never();

  // The image of the transfer under way or last offered.
  protocol::ImageId image_id_{};
  /** The checked header of image_id_, from the transfer or the record, and its bytes. */
  protocol::ImageHeader header_;
  std::array<std::uint8_t, protocol::kImageHeaderSize> header_bytes_{};
  bool have_header_ = false;
  /** The first sector not yet written; sectors before it are in the slot. */
  std::uint32_t sector_ = 0;
  /** The next file offset to ask for. */
  std::uint32_t next_offset_ = 0;
  /** Image bytes at the last status "fetching". */
  std::uint32_t progress_mark_ = 0;

  // The pull.
  LinkKind link_ = LinkKind::usb;
  std::uint16_t piece_ = kPieceOnLinks;
  std::uint8_t window_ = kGetsOnLinks;
  Duration reask_ = kReaskOnLinks;
  std::array<Ask, kGetsOnBluetooth> asks_{};
  std::uint8_t ask_count_ = 0;
  /** When a Get the link refused is offered again; never when none waits. */
  Instant send_retry_at_ = Instant::never();
  /** The last accepted Data (or the start): no progress for too long ends the transfer. */
  Instant last_progress_;
  /** Two sector buffers: the current sector and the next (section 5, "Order"). */
  std::array<std::array<std::uint8_t, kSlotSectorSize>, 2> sectors_{};
  /** Bytes received per buffer; each piece is taken once, so the sector is whole at its size. */
  std::array<std::uint32_t, 2> received_{};
  /** The piece size on the Bluetooth connection that is up, from the link when it says. */
  std::uint16_t bluetooth_piece_ = kPieceOnBluetooth;
  /** The gateway's write gate, and when a sector was last written (or the pull began). */
  bool writes_held_ = false;
  Instant last_written_;
  /** An image offered with action 6: the gate does not hold its writes. */
  bool forced_ = false;
  protocol::ImageId forced_id_{};
  std::array<std::uint8_t, 32> frame_out_{};

  // The read-back hash.
  std::uint32_t hash_sector_ = 0;
  Instant step_at_ = Instant::never();

  // Links.
  Instant link_deadline_ = Instant::never();
  bool joined_wifi_ = false;
  Instant reconnect_at_ = Instant::never();
  std::uint8_t reconnects_ = 0;

  // Packets for the role.
  bool query_wanted_ = false;
  bool status_pending_ = false;
  bool status_links_only_ = false;
  protocol::UpdateStatus status_;

  // The Bluetooth session.
  Session session_ = Session::closed;
  std::array<std::uint8_t, 8> nonce_{};
  std::array<std::uint8_t, kSessionKeySize> session_key_{};
  protocol::DeviceRandom device_random_{};
  Instant window_end_ = Instant::never();
  Instant session_end_ = Instant::never();
  bool session_opened_ = false;
  std::uint8_t wrong_tags_ = 0;
};

}  // namespace hsn::device
