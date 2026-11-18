#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "hsn/device/time.hpp"
#include "hsn/host/hub_log.hpp"
#include "hsn/host/hub_radio.hpp"
#include "hsn/host/link_wire.hpp"
#include "hsn/host/packet_labels.hpp"
#include "hsn/host/replay_window.hpp"
#include "hsn/host/sim_device.hpp"
#include "hsn/host/simulation.hpp"
#include "hsn/host/test_image.hpp"
#include "hsn/protocol/binding.hpp"
#include "hsn/protocol/image.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/packet.hpp"
#include "hsn/protocol/radio.hpp"
#include "hsn/protocol/transfer.hpp"
#include "hsn/psa/psa_packet_cipher.hpp"

namespace hsn::host {

/** How the hub reaches the radio. */
enum class HubMode : std::uint8_t {
  /** Its own ideal radio on the Medium stands in for a gateway: sensor and siren tests. */
  direct_radio,
  /** Real gateway roles carry every radio packet over their links: gateway and system tests. */
  gateway_link,
};

/**
 * The event listen time per sending data rate, read from the protocol's one table
 * (protocol::event_listen_milliseconds, section 8): a view, not a copy.
 */
struct EventListenTable {
  /** Milliseconds for a data rate; the slowest rate's for an unlisted one. */
  std::uint16_t operator[](std::size_t data_rate) const;
};

/** The hub's settings; timings default to protocol section 8. */
struct HubOptions {
  /** Its own radio, or the gateways'. */
  HubMode mode = HubMode::direct_radio;
  /** 0 = 868.1, 1 = 868.3, 2 = 868.5 MHz. */
  std::uint8_t site_channel = 1;
  /** The data rates the site allows, given to every device at pairing. */
  std::uint8_t allowed_data_rate_mask = 0x24;
  /** Direct radio: the data rates it hears, one bit each. */
  std::uint8_t listen_data_rates = 0x3F;
  /** Direct radio: power for replies and notices, and for siren commands. */
  std::int8_t reply_power_dbm = 22;
  std::int8_t siren_power_dbm = 22;
  /** Direct radio: from the end of a packet to the hub acting on it (a gateway's round trip). */
  device::Duration processing = device::milliseconds(50);
  /** One-way latency of every link (siren Wi-Fi, gateway USB or WebSocket). */
  device::Duration link_latency = device::milliseconds(25);
  /** Heartbeat reply moment: from a heartbeat's end to its reply's start. */
  device::Duration reply_moment = device::seconds(1);
  /** Event listen time per sending data rate, in milliseconds: the protocol's table. */
  EventListenTable event_listen_ms;
  /** The disarmed notice is sent twice, this far apart. */
  device::Duration disarmed_notice_gap = device::seconds(2);
  /** Siren commands repeat this often on Wi-Fi and on LoRa until confirmed, for this long. */
  device::Duration siren_wifi_repeat = device::seconds(2);
  device::Duration siren_lora_repeat = device::seconds(5);
  device::Duration siren_give_up = device::seconds(60);
  /** How long sirens sound for an alarm, their automatic stop (each capped by its settings). */
  std::uint16_t alarm_seconds = 180;
  /**
   * A sensor's log entry is marked as a repeat of one recorded from an earlier packet when their
   * made-at times are this close. The two estimates differ by the packets' waits for a clear
   * channel and their times on air, since an entry's age counts to when the packet was sealed.
   */
  device::Duration log_repeat_tolerance = device::seconds(15);
  /** Give each sensor a heartbeat slot in link-check replies (protocol section 7). */
  bool heartbeat_slots = false;
  /** Seeds the hub's own random values (welcome). */
  std::uint64_t seed = 7;
  /**
   * The hub computer's time zone, an IANA name, for M2's schedules: empty for none. The real hub
   * in lockstep is given it (RemoteHub, `start.zone`); the test hub has no schedules.
   */
  std::string time_zone;
  /**
   * Updates: give the go-ahead ("install now") as soon as a device reports its image verified and
   * the rules allow; otherwise only go_ahead() gives it.
   */
  bool auto_install = true;
  /** The Bluetooth window an offer gives, in units of 10 s (120 s, design section 5). */
  std::uint8_t bluetooth_window_units = 12;
  /** At most one Key change per device this often (m3-updates-design.md section 7). */
  device::Duration key_change_gap = device::seconds(10);
};

/** An image the test hub holds: the header it made and signed, and the file a device pulls. */
struct HubImage {
  protocol::ImageHeader header;
  /** The header's image id. */
  protocol::ImageId id{};
  /** The header's 128 bytes, then the image. */
  Bytes file;
};

/** How a device is offered an update (device_updates.method). */
enum class UpdateMethod : std::uint8_t {
  /** On its own link: a siren's or gateway's; a sensor has none, so it joins Wi-Fi. */
  own_link,
  /** A sensor joins Wi-Fi for it (offer action 2). */
  join_wifi,
  /** From a phone over Bluetooth (offer action 3), after open_bluetooth(). */
  bluetooth,
};

/** Where one device's update stands on the test hub (device_updates.state, design section 4). */
enum class UpdateState : std::uint8_t {
  none,
  /** Planned; not offered yet (a sensor: until its next query). */
  planned,
  offered,
  fetching,
  verified,
  installing,
  on_trial,
  confirmed,
  rolled_back,
  refused,
};

/** Returns the snake-case name of an update state. */
const char* update_state_name(UpdateState state);

/** One device's update, as the test hub holds it. */
struct DeviceUpdate {
  UpdateState state = UpdateState::none;
  protocol::ImageId image{};
  UpdateMethod method = UpdateMethod::own_link;
  /** Bytes of the file the hub served it in Data frames. */
  std::uint64_t bytes_served = 0;
  /** The reason the latest update status gave. */
  std::uint8_t reason = 0;
  /** After a rollback: the version that failed, as its Started said. */
  protocol::FirmwareVersion failed;
  /** The go-ahead has been given. */
  bool go_ahead = false;
  /** go_ahead() allowed it (with HubOptions::auto_install off). */
  bool allowed = false;
};

/**
 * A rollout's order (m3-updates-design.md section 4, "How a rollout proceeds"), as the test hub
 * keeps it: the devices in the order given, the first `pilots` one at a time, then the soak, then
 * the rest, sirens and gateways one at a time, sensors up to `sensors_at_once` at a time. A
 * rollback or a refusal (not a hold) pauses it.
 */
struct RolloutRules {
  std::size_t pilots = 0;
  device::Duration soak;
  std::size_t sensors_at_once = 4;
};

/**
 * The reason a rollout paused for a rollback, beyond a device's reasons (protocol::UpdateReason,
 * 1 to 17): the hub's `rollouts.paused_reason` code for it (hub core/model/rows.ts,
 * ROLLED_BACK_REASON).
 */
constexpr std::uint8_t kRolledBackReason = 20;

/** A Bluetooth session the hub hands a phone (firmware.bluetooth, design section 5). */
struct BluetoothSession {
  std::uint32_t address = 0;
  /** K: HKDF-SHA256 of the device key, the nonce and the address. Never printed. */
  std::array<std::uint8_t, 32> session_key{};
  std::array<std::uint8_t, 8> nonce{};
  std::uint8_t window_units = 0;
  protocol::ImageId image{};
  /** The file the phone serves: header and image. */
  Bytes file;
};

/** One Get the hub answered on a link. */
struct HubTransfer {
  device::Instant at;
  std::string device;
  std::uint32_t offset = 0;
  std::uint16_t length = 0;
  /** protocol::transfer_kind::data or ::gone. */
  std::uint8_t answer = 0;
  /** For a Gone, its reason (protocol::GoneReason). */
  std::uint8_t gone_reason = 0;
  /** The frame sent. */
  Bytes frame;
};

/**
 * What a backup of the test hub holds of its devices (keys, pending keys, replay windows, send
 * counters, settings versions), for TestHub::restore(). Opaque.
 */
class HubSnapshot {
public:
  struct Device {
    std::string name;
    protocol::DeviceKey key{};
    std::optional<protocol::DeviceKey> next_key;
    bool rekey = false;
    ReplayWindow window;
    std::uint32_t next_counter = 1;
    std::uint8_t version = 1;
  };
  std::vector<Device> devices;
};

/** What arming does with a sensor whose door is open (D50, D114). */
enum class OpenDoors : std::uint8_t {
  /** Nothing is armed; the open doors are named (`hsn arm`). */
  refuse,
  /** The rest are armed now, each open one when its door closes (`hsn arm --continue`). */
  arm_when_closed,
};

/** A sensor's settings as the hub holds them (protocol section 6, reply). */
struct SensorConfig {
  /** 0: the hub picks one. */
  std::uint32_t address = 0;
  std::uint8_t countdown_seconds = 30;
  std::uint8_t heartbeat_interval_units = 12;
  std::uint8_t link_check_every = 5;
  std::uint8_t send_data_rate = 5;
  std::uint8_t reply_data_rate = 5;
  std::int16_t clock_correction_ten_ppm = 0;
  /**
   * The sensor is in range of the home's Wi-Fi: the hub is at the other end of its network link,
   * which it uses only for updates (protocol section 10).
   */
  bool wifi_in_range = true;
};

/** A siren's settings (protocol section 6, siren settings). */
struct SirenConfig {
  std::uint32_t address = 0;
  std::uint8_t wifi_report_interval_seconds = 30;
  std::uint8_t lora_check_interval_units = 20;
  std::uint16_t max_sound_seconds = 300;
  std::uint8_t send_data_rate = 5;
  std::uint8_t command_data_rate = 5;
  /** The hub is at the other end of the siren's network link. */
  bool wifi = true;
};

/** A gateway's settings (protocol section 6, gateway settings) and how it is attached. */
struct GatewayConfig {
  std::uint32_t address = 0;
  std::uint8_t listen_data_rate_mask = 0x20;
  std::uint8_t status_interval_seconds = 30;
  std::uint8_t interference_threshold_db = 10;
  std::uint8_t interference_seconds = 30;
  std::int8_t default_tx_power_dbm = 14;
  std::int8_t siren_tx_power_dbm = 22;
  /** The hub is at the other end of the gateway's USB port; usb_host() then reads true. */
  bool usb = false;
  /** The hub is at the other end of the gateway's network link. */
  bool network = true;
};

/**
 * A move of the whole site to another channel, sending rate or both (protocol section 7, D115).
 * A setting left empty stays as it is.
 */
struct SiteMove {
  /** 0 = 868.1, 1 = 868.3, 2 = 868.5 MHz. */
  std::optional<std::uint8_t> site_channel;
  /** The one data rate every sensor and siren will send at and every gateway listen at. */
  std::optional<std::uint8_t> send_data_rate;
};

/** Where a move stands. */
enum class MoveStage : std::uint8_t {
  /** No move, or the last one is done or cancelled. */
  none,
  /** Every sensor's replies name the next settings; the hub waits for each to confirm. */
  announcing,
  /** Gateways and sirens have the new settings; sensors follow. */
  switched,
};

/**
 * The hub's side of the protocol, enough to drive every role test (design section 8). It holds
 * each device's key, address and settings, provisions the boards, and applies the hub's rules:
 * the 64-packet replay window; replies bound to the packet they answer; settings versions that
 * change with the armed state or the settings; heartbeat replies only on a version mismatch or
 * when asked, at the fixed reply moment; event replies as soon as possible within the sensor's
 * listening; a countdown per sensor counted from the opening, with late reports as protocol
 * section 7 says; the disarmed notice twice; siren commands and settings on both paths, repeated
 * until a report confirms them; log entries from every device on every path, kept with their
 * made-at times, a sensor's answered with a reply as soon as possible, a siren's and a gateway's
 * not; and for gateways the hello and welcome, settings, forwarded packets, transmit requests
 * and their results.
 *
 * In direct radio mode it has its own ideal radio on the Medium (HubRadio); in gateway link mode
 * every radio packet goes through the gateway roles' links. Siren Wi-Fi is the same in both.
 * Control calls act at the simulation's current time: call them between run_until()s or from
 * Simulation::schedule(). Everything received, sent and decided is kept, with true times.
 */
class TestHub final : public LinkPeer, public PacketLabeler {
public:
  /** A hub on `sim`, disarmed, knowing no device; in direct radio mode its radio listens. */
  TestHub(Simulation& sim, HubOptions options = {});
  TestHub(const TestHub&) = delete;
  TestHub& operator=(const TestHub&) = delete;
  ~TestHub();

  /** Pairs a board as a sensor (provisioning its flash) and registers it. Before its first boot. */
  void add_sensor(SimDevice& device, const SensorConfig& config = {});

  /** Pairs a board as a siren and registers it; attaches its network link when config.wifi. */
  void add_siren(SimDevice& device, const SirenConfig& config = {});

  /** Pairs a board as a gateway and registers it; attaches its links as config says. */
  void add_gateway(SimDevice& device, const GatewayConfig& config = {});

  /**
   * Arms every sensor, each getting a new settings version. A sensor whose door the hub last
   * heard open is armed only as `open_doors` says: by default nothing is armed and they are
   * named (D50); with OpenDoors::arm_when_closed it is armed when a packet shows it closed.
   * Returns the sensors whose doors were open.
   */
  std::vector<std::string> arm(OpenDoors open_doors = OpenDoors::refuse);

  /** Disarms: running countdowns end with two disarmed notices, sounding sirens are stopped. */
  void disarm();

  /** True while any sensor is armed. */
  bool armed() const {
    return armed_;
  }

  /** Changes a sensor's settings; its settings version changes. */
  void change_sensor(const std::string& name, const SensorConfig& config);

  /**
   * Changes a siren's settings and sends them on both paths until confirmed; while a command is
   * unconfirmed they wait for it (protocol section 7, siren command, step 5).
   */
  void change_siren(const std::string& name, const SirenConfig& config);

  /** Changes a gateway's settings and sends them if it is connected. */
  void change_gateway(const std::string& name, const GatewayConfig& config);

  /**
   * Sends a siren command (protocol::SirenAction) on both paths until a report confirms it; it
   * replaces whatever the siren had waiting.
   */
  void command_siren(const std::string& name, std::uint8_t action, std::uint16_t seconds);

  /**
   * Starts a move (protocol section 7, step 1, "Announce"): every sensor gets a settings version
   * whose replies name the next channel and rate. Throws while another move is in progress, or
   * when it would change nothing.
   */
  void announce_move(const SiteMove& move);

  /**
   * Step 2, "Switch", comes by itself once every sensor has confirmed (protocol section 7):
   * gateways get their new settings (in direct radio mode, the hub's radio retunes), then each
   * siren its settings with the new channel and rate on both paths; during a countdown or an
   * alarm it waits for them to end (`move_switch_waiting`). This call is the user's: with
   * `force`, the switch goes now (or when a countdown or alarm ends), naming each sensor that
   * has not confirmed as left behind; without, it only names them (`move_unconfirmed`) and
   * changes nothing. Returns true once the site has switched.
   */
  bool switch_move(bool force = false);

  /** Cancels a move before the switch: every sensor gets a version announcing nothing. */
  void cancel_move();

  /** Where the move stands. */
  MoveStage move_stage() const {
    return move_.stage;
  }

  /** Sensors that have not confirmed the move being announced, in pairing order. */
  std::vector<std::string> move_unconfirmed() const;

  /** True when a device has followed the switch. */
  bool move_followed(const std::string& name) const;

  /** The site channel now (it changes at a switch). */
  std::uint8_t site_channel() const {
    return options_.site_channel;
  }

  // ---- Firmware updates (m3-updates-design.md sections 4 and 5) ----

  /**
   * Stores an image: makes its 128-byte header (every role; the hub identity boards are paired
   * with, Provisioning's), signed with the hub's key, and keeps the file. Returns it; it stays
   * valid as long as the hub.
   */
  const HubImage& add_image(const Bytes& image, bool own_build = false);

  /** The hub's signing key, whose public half every board it pairs holds. */
  const HubSigningKey& signing_key() const {
    return signing_key_;
  }

  /**
   * Plans an update of one device to an image: a siren or gateway is offered it on its link
   * (action 1) as soon as it is connected; a sensor sees "update available" in its replies (and
   * every heartbeat is answered while it waits), and its Update query is answered with action 2
   * (join Wi-Fi and fetch), or action 1 when the query came over its link, or action 3 after
   * open_bluetooth(). Every Get on a link the hub granted is answered from the file.
   */
  void offer_update(const std::string& name, const protocol::ImageId& image,
                    UpdateMethod method = UpdateMethod::own_link);

  /**
   * Starts a rollout of `image` to `order` (its device names), by `rules`: offer_update() for each
   * device when its turn comes; the go-ahead only for a sensor that is disarmed, with no countdown
   * or alarm, and for a siren or gateway while no other siren or gateway installs or is on trial
   * and, for a gateway, no sensor is on trial.
   */
  void rollout(const protocol::ImageId& image, const std::vector<std::string>& order,
               const RolloutRules& rules = {});

  /** True while the rollout is paused by a rollback or a refusal; resume_rollout() goes on. */
  bool rollout_paused() const {
    return rollout_.paused;
  }
  /**
   * Why the rollout paused, as the hub's `rollouts.paused_reason`: the refusal's reason
   * (protocol::UpdateReason), or kRolledBackReason for a rollback; 0 while not paused.
   */
  std::uint8_t rollout_pause_reason() const {
    return rollout_.paused ? rollout_.paused_reason : 0;
  }
  void resume_rollout();

  /** True once every device of the rollout is confirmed. */
  bool rollout_done() const;

  /**
   * Gives the go-ahead to a device whose image is verified (with auto_install off): a siren or
   * gateway gets "install now" on its link at once, a sensor in answer to its next packet.
   */
  void go_ahead(const std::string& name);

  /**
   * firmware.bluetooth: a session for a phone to update `name` with `image` over Bluetooth. The
   * hub draws a nonce, derives the session key from the device key, and plans action 3 for the
   * device's next Update query.
   */
  BluetoothSession open_bluetooth(const std::string& name, const protocol::ImageId& image);

  /** One device's update. */
  const DeviceUpdate& update_of(const std::string& name) const;

  /** Every Get the hub answered, in order. */
  const std::vector<HubTransfer>& transfers() const {
    return transfers_;
  }

  // ---- The key change after a restore (m3-updates-design.md section 7) ----

  /** What a backup taken now would hold of the devices. */
  HubSnapshot snapshot() const;

  /**
   * Restores the devices' state from `backup` (keys, pending keys, replay windows, settings
   * versions; the send counters moved by 2^24) and marks every device: from now on the hub acts
   * on no packet under a device's old key. It answers each with a Key change (a new key made at the
   * first such packet, sealed under the old one, at most one per device every key_change_gap): to a
   * sensor bound to the packet, to a siren under the strictly-higher rule on both paths, to a
   * gateway's hello in place of the welcome. Every siren gets one at once, as at the restored
   * hub's first start. The first packet under the new key switches the device to it.
   */
  void restore(const HubSnapshot& backup);

  /** True while a device has not been heard under its new key since a restore. */
  bool rekey_pending(const std::string& name) const;

  /** The key the hub holds for a device now (for a test's own sealing). Never print it. */
  const protocol::DeviceKey& key_of(const std::string& name) const;

  /** The new key the hub made for a device, if any, not yet confirmed. Never print it. */
  std::optional<protocol::DeviceKey> next_key_of(const std::string& name) const;

  /** Ends a link's connection from the hub's side (a siren's Wi-Fi, a gateway's link). */
  void drop_link(const std::string& name, device::LinkKind kind,
                 device::Duration noticed_after = device::Duration{});

  /** Every packet received, in order. */
  const std::vector<HubPacket>& received() const {
    return received_;
  }

  /** Accepted packets from one device, of one type (0: any). */
  std::vector<HubPacket> received_from(const std::string& name, std::uint8_t type = 0) const;

  /** Every packet sent or handed to a gateway, in order. */
  const std::vector<HubSent>& sent() const {
    return sent_;
  }

  /** Packets for one device, of one type (0: any). */
  std::vector<HubSent> sent_to(const std::string& name, std::uint8_t type = 0) const;

  /** Every decision, in order. */
  const std::vector<HubDecision>& decisions() const {
    return decisions_;
  }

  /** Decisions of one kind, optionally for one device. */
  std::vector<HubDecision> decisions(HubAction action, const std::string& device = "") const;

  /** Every log entry received, in order, repeats included (HubLogEntry::repeat_of). */
  const std::vector<HubLogEntry>& log_entries() const {
    return log_entries_;
  }

  /** Log entries from one device, in order. */
  std::vector<HubLogEntry> log_entries_from(const std::string& name) const;

  /** A device's current settings version. */
  std::uint8_t settings_version(const std::string& name) const;

  /** A sensor's or siren's replay window. */
  const ReplayWindow& window(const std::string& name) const;

  /** True while a sensor's countdown runs. */
  bool countdown_running(const std::string& name) const;

  /** The hub on the timeline. */
  ActorId actor() const {
    return actor_;
  }

  /** The hub's radio's station in direct radio mode, for path losses; throws otherwise. */
  StationId station() const;

  /** Received packets, log entries, sent packets and decisions as text, in time order. */
  std::string dump() const;

  // LinkPeer
  void link_up(LinkWire& wire) override;
  void link_down(LinkWire& wire) override;
  void link_packet(LinkWire& wire, const Bytes& packet) override;

  // PacketLabeler
  std::optional<std::uint8_t> message_type(protocol::ByteView packet,
                                           const protocol::PacketHeader& header) override;

private:
  static constexpr std::size_t kNone = static_cast<std::size_t>(-1);

  /** A countdown for one sensor's opening. */
  struct Countdown {
    bool active = false;
    device::Instant opened_at;
    device::Instant ends_at;
    /** The newest accepted report of the opening: the disarmed notice's binding. */
    std::uint32_t newest_counter = 0;
    /** The rate and gateway its replies went by. */
    std::uint8_t reply_data_rate = 5;
    std::size_t gateway = kNone;
    std::uint64_t generation = 0;
  };

  /** A siren command or settings packet waiting for a report. */
  struct Pending {
    bool active = false;
    Bytes packet;
    std::uint32_t counter = 0;
    std::uint8_t type = 0;
    device::Instant issued;
    std::uint64_t generation = 0;
  };

  /** A gateway connection. */
  struct Session {
    bool open = false;
    protocol::RandomValue gateway_random{};
    protocol::RandomValue hub_random{};
    std::uint32_t last_accepted = 0;
    LinkWire* wire = nullptr;
  };

  /** Everything the hub keeps about one device. */
  struct Known {
    std::string name;
    std::uint8_t role = 0;
    std::uint32_t address = 0;
    protocol::DeviceKey key{};
    SimDevice* device = nullptr;
    std::unique_ptr<psa::PsaPacketCipher> cipher;
    std::uint8_t version = 1;
    /** Armed; or to be armed when its door closes (D114); and its door as last heard. */
    bool armed = false;
    bool arm_when_closed = false;
    bool door_open = false;
    /** The hub's send counter for this key; it starts at 1 (protocol section 4). */
    std::uint32_t next_counter = 1;
    ReplayWindow window;
    SensorConfig sensor;
    /** The rate a sensor listens at, or a siren hears commands at, under each settings version. */
    std::map<std::uint8_t, std::uint8_t> reply_rate_of_version;
    /** The settings version a siren last said it holds; 0 before it has said. */
    std::uint8_t held_version = 0;
    /**
     * How a sensor listens after a packet that does not say (log entries): at the reply rate of
     * the settings version in the latest reply the hub sent it (0: none yet, so at its sending
     * rate), or at its sending rate while its latest status packet had flag bit 7 and no reply
     * has gone since.
     */
    std::uint8_t replied_version = 0;
    bool listening_at_send_rate = false;
    /** A siren's new settings wait for its unconfirmed command (protocol section 7). */
    bool settings_waiting = false;
    /**
     * Until when a siren was last commanded to sound for an alarm; while it is, another door's
     * countdown ending does not command it again (protocol section 7, "Siren command"). An off
     * command clears it.
     */
    device::Instant sounding_until;
    /** The move: versions whose replies name the next settings, and how far it got. */
    std::map<std::uint8_t, bool> version_announces;
    /** The version and sending rate its replies had while the move was announced. */
    std::uint8_t announce_version = 0;
    std::uint8_t announce_send_rate = 0;
    bool move_confirmed = false;
    bool move_followed = false;
    Countdown countdown;
    SirenConfig siren;
    Pending pending;
    std::size_t best_gateway = kNone;
    std::int16_t best_rssi = 0;
    GatewayConfig gateway;
    Session session;
    /** Its update. */
    DeviceUpdate update;
    /** A Bluetooth session waiting for its next Update query. */
    std::optional<BluetoothSession> bluetooth;
    /** The key change after a restore: required, the new key (and its cipher), the last sent. */
    bool rekey = false;
    std::optional<protocol::DeviceKey> next_key;
    std::unique_ptr<psa::PsaPacketCipher> next_cipher;
    device::Instant last_key_change = device::Instant::never();
  };

  /** A packet that reached the hub over the air: directly, or forwarded by a gateway. */
  struct Arrival {
    Bytes packet;
    HubPath path = HubPath::radio;
    std::size_t gateway = kNone;
    /** The hub's best knowledge of when the packet finished arriving (true time). */
    device::Instant ended_at;
    /** The gateway's clock at that moment (gateway link mode). */
    std::uint32_t gateway_time = 0;
    std::int16_t rssi_dbm = 0;
    std::int8_t snr_quarter_db = 0;
    std::uint8_t data_rate = 0;
    /** The site channel it arrived on: the hub radio's, or as the gateway forwarded it. */
    std::uint8_t site_channel = 0;
    /** The device's own link it came by (HubPath::link), else null. */
    LinkWire* wire = nullptr;
  };

  /** The site's move (protocol section 7, D115). */
  struct Move {
    MoveStage stage = MoveStage::none;
    SiteMove target;
    /** The channel and rate the site is moving to, every setting filled in. */
    std::uint8_t to_channel = 0;
    std::uint8_t to_rate = 0;
    /** A switch asked during a countdown or an alarm, and whether it was forced. */
    bool switch_waiting = false;
    bool force = false;
  };

  /** A packet the hub opened. */
  struct Opened {
    std::uint32_t counter = 0;
    std::uint8_t type = 0;
    Bytes body;
  };

  /** A radio packet to put on 869.525 MHz, by the hub's radio or a gateway. */
  struct Downlink {
    Bytes packet;
    std::uint8_t type = 0;
    std::uint32_t counter = 0;
    std::size_t to = kNone;
    std::uint8_t data_rate = 5;
    bool siren_command = false;
    /** At a fixed moment after the packet answered ended, or as soon as possible. */
    bool fixed_moment = false;
    /** As soon as possible, starting no later than `offset` after the packet answered ended. */
    bool limited = false;
    device::Duration offset;
    device::Instant ended_at;
    std::uint32_t gateway_time = 0;
    std::size_t gateway = kNone;
  };

  /** A direct send or a transmit request waiting for its result. */
  struct Outstanding {
    std::size_t to = kNone;
    std::uint8_t type = 0;
    std::uint32_t counter = 0;
    std::uint8_t data_rate = 0;
    Bytes packet;
  };

  // test_hub.cpp: registry, sealing, opening, paths, records.
  Known& add_known(SimDevice& device, std::uint8_t role, std::uint32_t address);
  Known& known(const std::string& name);
  const Known& known(const std::string& name) const;
  std::size_t index_of_address(std::uint32_t address) const;
  std::size_t index_of_wire(const LinkWire& wire) const;
  Bytes seal_plaintext(Known& device, protocol::ByteView plaintext, std::uint8_t type,
                       const protocol::Binding& binding, protocol::PacketLimit limit);
  template <typename Message>
  Bytes seal(Known& device, const Message& message, const protocol::Binding& binding,
             protocol::PacketLimit limit);
  std::optional<Opened> open(Known& device, protocol::ByteView packet,
                             const protocol::Binding& binding, protocol::PacketLimit limit);
  void on_arrival(const Arrival& arrival);
  void send_radio(const Downlink& downlink);
  void send_link(Known& device, LinkWire& wire, const Bytes& packet, std::uint8_t type);
  void on_radio_result(std::uint64_t tag, HubRadio::Outcome outcome, std::uint8_t data_rate);
  void record_received(const Known* device, const Arrival& arrival, HubVerdict verdict,
                       const Opened* opened);
  void decide(HubAction action, const std::string& device, std::int64_t value = 0);
  void on_log_entries(std::size_t index, const Opened& opened, const Arrival& arrival);
  std::size_t connected_gateway(std::size_t preferred) const;
  static void bump(std::uint8_t& version);
  void random_bytes(protocol::RandomValue& out);

  // hub_sensors.cpp: replies, countdowns, disarmed notices.
  void on_sensor_packet(std::size_t index, const Opened& opened, const Arrival& arrival);
  void reply_to_sensor(std::size_t index, const Arrival& arrival, std::uint8_t held_version,
                       std::uint32_t answered, bool heartbeat, bool at_arrival_rate);
  void arm_sensor(Known& sensor);
  void door_opened(std::size_t index, const protocol::SensorStatus& status, std::uint32_t counter,
                   const Arrival& arrival);
  void countdown_ended(std::size_t index, std::uint64_t generation);
  void send_disarmed_notice(std::size_t index, std::uint32_t bound_to, std::uint8_t data_rate,
                            std::size_t gateway);
  std::uint8_t reply_rate(const Known& sensor, std::uint8_t held_version, std::uint8_t arrival_rate,
                          bool at_arrival_rate) const;
  std::uint16_t next_heartbeat_tenths(std::size_t index, device::Instant ended_at) const;
  void sound_sirens(std::uint16_t seconds);
  device::Duration event_listen_time(std::uint8_t data_rate) const;

  // hub_sirens.cpp: commands, settings, repeats, reports.
  void on_siren_packet(std::size_t index, const Opened& opened, const Arrival& arrival);
  void issue_to_siren(std::size_t index, Bytes packet, std::uint8_t type);
  void send_siren_settings(std::size_t index);
  void repeat_on_wifi(std::size_t index, std::uint64_t generation);
  void repeat_on_lora(std::size_t index, std::uint64_t generation);
  std::uint8_t command_rate(const Known& siren) const;

  // hub_move.cpp: moving the site (protocol section 7, "Changing the site's channel or rate").
  void new_sensor_version(Known& sensor);
  bool arrived_on_new(const Arrival& arrival) const;
  void note_confirmation(Known& sensor, std::uint8_t held_version);
  void note_followed(Known& device);
  bool alarm_running() const;
  bool switch_blocked();
  void switch_when_free(bool forced);
  void retry_waiting_switch();
  void do_switch(bool forced);
  void note_followed_all_done();
  void fill_move(const Known& sensor, const Arrival& arrival, protocol::Reply& reply) const;

  // hub_gateways.cpp: connection, settings, forwarded packets, transmit requests and results.
  void on_gateway_packet(std::size_t index, LinkWire& wire, const Bytes& packet);
  void send_gateway_settings(std::size_t index);
  void request_transmit(const Downlink& downlink);

  // hub_updates.cpp: images, offers, serving Gets, statuses, the go-ahead, the rollout.
  const HubImage* image(const protocol::ImageId& id) const;
  void on_transfer_frame(std::size_t index, LinkWire& wire, const Bytes& frame);
  void answer_get(std::size_t index, LinkWire& wire, const protocol::transfer::Get& get);
  void send_frame(std::size_t index, LinkWire& wire, const Bytes& frame);
  /** A sensor's, siren's or gateway's update packet; true when the sensor was answered. */
  bool on_update_packet(std::size_t index, const Opened& opened, const Arrival& arrival,
                        LinkWire* wire);
  void on_update_started(std::size_t index, const protocol::Started& started);
  protocol::UpdateOffer offer_for(const Known& device, std::uint8_t action) const;
  void send_offer(std::size_t index, std::uint8_t action, const Arrival* answering,
                  std::uint32_t answered, LinkWire* wire);
  void push_offer(std::size_t index);
  bool may_install(std::size_t index) const;
  void push_go_aheads();
  void advance_rollout();
  void advance_rollout_once();
  void set_update_state(std::size_t index, UpdateState state);
  bool offer_waiting(std::size_t index) const;
  /** Sends a sensor a packet bound to one it sent: on the link it came by, else as soon as
   * possible within its event listening, at the rate it listens at. */
  void answer_sensor(std::size_t index, const Arrival& arrival, const Bytes& packet,
                     std::uint8_t type);

  // hub_rekey.cpp: snapshots, restores and Key changes.
  enum class KeyUsed : std::uint8_t { none, current, next };
  KeyUsed open_any(Known& device, protocol::ByteView packet, const protocol::Binding& binding,
                   protocol::PacketLimit limit, std::optional<Opened>& opened);
  void switch_key(Known& device);
  void answer_old_key(std::size_t index, const Opened& opened, const Arrival& arrival,
                      LinkWire* wire, const protocol::RandomValue* hello_random);
  const protocol::DeviceKey& make_next_key(Known& device);

  Simulation& sim_;
  HubOptions options_;
  ActorId actor_;
  std::uint32_t site_frequency_hz_;
  std::vector<Known> known_;
  std::unique_ptr<HubRadio> radio_;
  bool armed_ = false;
  bool alarm_ = false;
  /** When the alarm's sounding time ends: an alarm runs until then, or a disarm. */
  device::Instant alarm_until_;
  Move move_;
  std::uint64_t random_state_;
  std::uint64_t next_tag_ = 1;
  std::map<std::uint64_t, Outstanding> outstanding_;
  std::map<Bytes, std::uint8_t> sealed_types_;
  std::vector<HubPacket> received_;
  std::vector<HubSent> sent_;
  std::vector<HubDecision> decisions_;
  std::vector<HubLogEntry> log_entries_;
  HubSigningKey signing_key_;
  std::deque<HubImage> images_;
  /** Links the hub has granted, and for which image. */
  std::map<const LinkWire*, protocol::ImageId> grants_;
  std::vector<HubTransfer> transfers_;
  struct Rollout {
    /** Its number, from 1, as the hub's `rollouts.id`. */
    std::uint32_t id = 0;
    bool active = false;
    bool paused = false;
    /** As rollout_pause_reason(), while paused. */
    std::uint8_t paused_reason = 0;
    protocol::ImageId image{};
    std::vector<std::string> order;
    RolloutRules rules;
    /** Which devices of the order have been offered their update. */
    std::vector<bool> offered;
    bool done_recorded = false;
    bool advancing = false;
    bool again = false;
    /** The soak ends then; never until the pilots are confirmed. */
    device::Instant soak_until = device::Instant::never();
  };
  Rollout rollout_;
  /** The number the next rollout() takes. */
  std::uint32_t next_rollout_ = 1;
};

template <typename Message>
Bytes TestHub::seal(Known& device, const Message& message, const protocol::Binding& binding,
                    protocol::PacketLimit limit) {
  Bytes plaintext(protocol::kMaxLinkPacketSize);
  const auto size = protocol::encode_plaintext(
      message, protocol::MutableByteView(plaintext.data(), plaintext.size()));
  if (!size.ok()) {
    throw SimulationError("the test hub could not encode a message for " + device.name);
  }
  return seal_plaintext(device, protocol::ByteView(plaintext.data(), size.value()), Message::type,
                        binding, limit);
}

}  // namespace hsn::host
