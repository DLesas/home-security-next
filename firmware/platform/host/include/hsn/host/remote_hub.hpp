#pragma once

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "hsn/host/hub_log.hpp"
#include "hsn/host/link_wire.hpp"
#include "hsn/host/lockstep.hpp"
#include "hsn/host/packet_labels.hpp"
#include "hsn/host/sim_device.hpp"
#include "hsn/host/simulation.hpp"
#include "hsn/host/test_hub.hpp"
#include "hsn/protocol/binding.hpp"
#include "hsn/psa/psa_packet_cipher.hpp"

namespace hsn::host {

/** An image the real hub stored (`firmware.upload`), as RemoteHub::add_own_build gives it. */
struct RemoteImage {
  /** Its number on the hub (`firmware_images.id`). */
  std::int64_t id = 0;
  protocol::ImageId image{};
  protocol::FirmwareVersion version{};
  /** The file a device pulls: the header (made with the hub's seeded key) and the image. */
  Bytes file;
  /** Set once the hub served a header on a device's link: whether it was exactly this one. */
  std::optional<bool> header_matches;
};

/**
 * The real hub as one more actor in a Simulation (hub-design.md section 11, "Lockstep: the bench's
 * system tests against the real hub"): a hub process in lockstep mode on a fresh data folder,
 * removed afterwards, with the parts of TestHub's interface the system tests use.
 *
 * Stepping. Everything the hub learns (a link up or down, a frame, a command) is an input at the
 * simulation's current instant, and an advance to that instant follows in the same instant; the
 * hub's `wake` from each `idle` is a step scheduled at that time. So simulated time never passes a
 * hub wake, nothing reaches the hub in its past, and every frame the hub sends leaves at the
 * instant it is handed to the device's wire, which adds the link's latency (HubOptions::
 * link_latency) each way, as it does for the test hub.
 *
 * Boards. add_sensor, add_siren and add_gateway leave a board as it was made (unpaired, a
 * development build, its role stored) and plug it into the hub's USB 100 ms after its power-on;
 * the hub provisions it with real setup messages, a gateway by itself (D100), the others through
 * `hsn usb add`, one at a time. Once a board has accepted, its USB is unplugged (a sensor's USB
 * power off with it) unless GatewayConfig::usb keeps a gateway there, and its settings go as
 * `hsn sensor set` or `hsn siren set`. Commands asked for meanwhile (arm, disarm) wait until
 * every board added so far is paired, as the test hub's boards are paired before they boot.
 *
 * Records. Every question is answered from the records the hub streams in its `idle` answers,
 * never from its database: rx rows are received packets, tx rows sent ones (a LoRa packet's row
 * comes with its outcome; its time here is the instant its transmit request left, read from the
 * frame), decisions and the bench actions of section 6's `benchActions`, device log rows, and the
 * hub's records of the setup messages it exchanged (a packet of type 0, counter 0). To tell which
 * device a row's `deviceId` is, and to label packets on the timeline, this side reads what it
 * carries: the keys from the Provision messages the hub sends, and each gateway connection's
 * random values from its hello and welcome.
 *
 * What it cannot map it refuses, with SimulationError naming it: a site allowing more than one
 * data rate (the real hub gives a site one), settings with no command, a command the hub refuses.
 */
class RemoteHub final : public LinkPeer, public PacketLabeler {
public:
  /** Starts a hub on `sim` at its current time, sets the site from `options`. */
  RemoteHub(Simulation& sim, HubOptions options, lockstep::HubProgram program);
  RemoteHub(const RemoteHub&) = delete;
  RemoteHub& operator=(const RemoteHub&) = delete;
  ~RemoteHub();

  /** A board to provision as a sensor; it must not have booted. */
  void add_sensor(SimDevice& device, const SensorConfig& config = {});

  /** A board to provision as a siren; its network link to the hub when config.wifi. */
  void add_siren(SimDevice& device, const SirenConfig& config = {});

  /** A board to provision as a gateway; on its network link unless config.usb. */
  void add_gateway(SimDevice& device, const GatewayConfig& config = {});

  /**
   * `hsn arm --all`, with `--continue` for OpenDoors::arm_when_closed; returns the sensors whose
   * doors were open (refused, or armed when they close). Before every board is paired it waits
   * for them, and then a refusal throws.
   */
  std::vector<std::string> arm(OpenDoors open_doors = OpenDoors::refuse);

  /** `hsn disarm --all`, now or once every board is paired. */
  void disarm();

  /** A board's network link (Wi-Fi) takes `latency` each way from now: a slow or distant one. */
  void set_network_latency(const std::string& name, device::Duration latency);

  /** Ends a link's connection from the hub's side, as TestHub::drop_link does. */
  void drop_link(const std::string& name, device::LinkKind kind,
                 device::Duration noticed_after = device::Duration{});

  /** `hsn siren test <name> <s>`: the real hub's one direct siren command; other actions throw. */
  void command_siren(const std::string& name, std::uint8_t action, std::uint16_t seconds);

  /** `hsn gateway set`; an address or listening rates other than the site's throw. */
  void change_gateway(const std::string& name, const GatewayConfig& config);

  /**
   * The site move (§7, D115) through `hsn site change`: announce; switch (the real hub switches by
   * itself once every sensor has confirmed, so this is true then; before that it is `site change
   * force`, with `--yes` when `force`, and the hub names who has not confirmed); cancel. Each
   * acts at once: the hub's answer is had before it returns.
   */
  void announce_move(const SiteMove& move);
  bool switch_move(bool force = false);
  void cancel_move();

  /**
   * M2's arming (m2-design.md sections 6 and 7), as `hsn op` requests answered at once. Devices
   * are named as on the bench; the hub's numbers are found from its records. Each returns the
   * hub's reply's result and throws SimulationError, with the reply, when it is refused.
   * `arm()` and `disarm()` above are `hsn arm --all` and `hsn disarm --all`: switches to the fixed
   * modes Away and Disarmed (D90).
   */
  /** A group of sensors sounding the sirens named, or every siren when none is named (AL2a). */
  std::int64_t create_group(const std::string& name, const std::vector<std::string>& sensors,
                            const std::vector<std::string>& sirens = {});
  /** A mode holding the groups given; returns its number. */
  std::int64_t create_mode(const std::string& name, const std::vector<std::int64_t>& groups);
  /** A fixed mode's number: "away" or "disarmed" (D90), as the migration makes them. */
  std::int64_t fixed_mode(const std::string& which);
  /** `mode.switch`, `arm {group}`, `disarm {group}`: the arming result. */
  json::Value switch_mode(std::int64_t mode, bool confirm = false);
  json::Value arm_group(std::int64_t group, bool confirm = false);
  json::Value disarm_group(std::int64_t group);
  /**
   * `schedule.create`: `action` is "switchMode", "arm" or "disarm"; `target` {"mode": n},
   * {"group": n} or {"sensor": n}; `at` "HH:MM"; `days` a list, "everyDay" or {"date": …}. Returns
   * the entry, with its next time (`nextMs`, null when none is due).
   */
  json::Value create_schedule(const std::string& name, const std::string& action,
                              json::Value target, const std::string& at, json::Value days);
  /** The hub's number for a device of the bench. */
  std::int64_t device_number(const std::string& name) const;

  /** The wall clock (ms since 1970) the hub reads at a true instant, as this side started it. */
  std::int64_t wall_at(device::Instant at) const;

  /** From now the hub's wall clock reads `wall_ms`, trusted or not (the wire's `clock`). */
  void set_clock(std::int64_t wall_ms, bool trusted);

  /** A decision the hub recorded, of any kind by its name (M2's too), with its fields. */
  struct NamedDecision {
    device::Instant at;
    std::string device;
    std::optional<std::int64_t> value;
    Bytes detail;
  };
  std::vector<NamedDecision> decisions_named(const std::string& kind,
                                             const std::string& device = "") const;

  /** Where the move stands, from the hub's move decisions. */
  MoveStage move_stage() const;

  /** Sensors still to confirm the move being announced (`hsn site change status`). */
  std::vector<std::string> move_unconfirmed();

  /** True when a device has followed the switch of the latest move (`device_followed`). */
  bool move_followed(const std::string& name) const;

  /** The site channel now, from the moves the hub switched. */
  std::uint8_t site_channel() const;

  /** True while a sensor's countdown runs, from the hub's decisions. */
  bool countdown_running(const std::string& name) const;

  // ---- Firmware updates (m3-updates-design.md sections 4, 5 and 8) ----

  /**
   * `hsn firmware add <file> --own --version <v>`: the raw image sent in `fileChunk` lines, then
   * `firmware.upload` with the confirmation the console asks for (D35, D84). The hub checks and
   * stages it, makes and signs its header; the returned file is the one a device pulls, made here
   * with the hub's own seeded signing key (RFC 6979, so the hub's header byte for byte), and
   * `header_matches` says whether the hub served exactly that header to a device on its link.
   */
  const RemoteImage& add_own_build(const Bytes& image, const protocol::FirmwareVersion& version);

  /**
   * A version 2 operation `hsn` carries (`hsn op`), answered at once: its reply's body, or a
   * SimulationError with the reply when the hub refuses it. `operation_reply` returns the whole
   * reply, refused or not.
   */
  json::Value operation(const std::string& name, json::Value body);
  json::Value operation_reply(const std::string& name, json::Value body);

  /**
   * `rollout.start`: the image, the devices (every device of its roles when empty), the pilots
   * (the hub's choice when empty). Returns the rollout's number.
   */
  std::int64_t rollout_start(std::int64_t image, const std::vector<std::string>& devices = {},
                             const std::vector<std::string>& pilots = {});
  /** `rollout.status`: the rollout (null when none) and every planned device. */
  json::Value rollout_status();
  /** `rollout.pause`, `rollout.resume` (a device, forced for a gateway held as always busy). */
  json::Value rollout_pause();
  json::Value rollout_resume(const std::string& device = "", bool force = false);
  json::Value rollout_cancel();
  /** One planned device's row of `rollout.status` (its state, held, method, bytes…). */
  json::Value update_of(const std::string& name);
  /** Its state's name in `rollout.status` ("fetching", "confirmed"…), or "" when not planned. */
  std::string update_state(const std::string& name);

  /**
   * `firmware.bluetooth`: the session the hub hands a phone, for ScriptPhone; the file is the one
   * add_own_build made for the image the hub names.
   */
  BluetoothSession firmware_bluetooth(const std::string& name);

  /** Every transfer frame the hub sent a device on its link: Data and Gone, in order. */
  const std::vector<HubTransfer>& transfers() const {
    return transfers_;
  }

  // ---- Backups and the key change after a restore (m3-updates-design.md section 7) ----

  /**
   * `backup.settings {folder}` (once), then `backup.now`: the backup written at once into
   * `folder`, under the backup key the lockstep hub made from the seed. Returns its path.
   */
  std::string backup_now(const std::string& folder);

  /**
   * `benchRestore {file, key}` with the backup key made from the seed, then the restart that puts
   * the restored database in place: a clean stop and a new process (with a seed of its own: a
   * restored database counts its boots again from 1). Throws when the hub refuses it.
   */
  void restore(const std::string& file);
  /** The hub's answer to `benchRestore` with a given key, refused or not; nothing restarts. */
  json::Value bench_restore_reply(const std::string& file, const std::string& key);

  /** The backup key the lockstep hub made from its seed, as base64url (never printed). */
  std::string seeded_backup_key() const;

  /** The clean stop (`stop`): the hub commits and exits; its links drop. */
  void stop();

  /**
   * Each clean stop's figures of that run (the lockstep hub's `lockstep-stats.json`): commits,
   * `commitsByReason`, `walFrames`, `walBytes`, `longestTurnUs`, `longestTransferUs`.
   */
  const std::vector<json::Value>& run_stats() const {
    return run_stats_;
  }

  /** `kill -9`: nothing more is committed; its links drop. */
  void kill();

  /** A new hub process on the same data folder, at the current time; USB links come up again. */
  void start();

  /** True while a hub process runs. */
  bool running() const {
    return up_;
  }

  /** The current run's boot (`boots.id`). */
  std::int64_t boot() const {
    return boot_;
  }

  /** Every packet received, in order, accepted or not (reject rows as one packet each). */
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

  /** Every decision named by a HubAction, in order. */
  const std::vector<HubDecision>& decisions() const {
    return decisions_;
  }

  /** Decisions of one kind, optionally for one device. */
  std::vector<HubDecision> decisions(HubAction action, const std::string& device = "") const;

  /** Every log entry received, in order. */
  const std::vector<HubLogEntry>& log_entries() const {
    return log_entries_;
  }

  /** Log entries from one device, in order. */
  std::vector<HubLogEntry> log_entries_from(const std::string& name) const;

  /**
   * Packets from a device that the hub counted as duplicates (a copy another gateway forwarded
   * first, or a replay) in `rejects`, where they have no row of their own (section 6, D110).
   */
  std::size_t duplicates_counted(const std::string& name) const {
    const auto found = duplicates_.find(name);
    return found == duplicates_.end() ? 0 : found->second;
  }

  /**
   * How long after the instant the hub decides each frame it sends leaves it: what a real hub
   * spends, its commit above all, where the lockstep hub answers in zero time. 10 ms unless set,
   * or the environment's HSN_HUB_DELAY_MS.
   */
  void set_send_delay(device::Duration delay) {
    send_delay_ = delay;
  }
  device::Duration send_delay() const {
    return send_delay_;
  }

  /** Every record the hub streamed, as it came, with the instant of its idle. */
  const std::vector<std::pair<device::Instant, json::Value>>& records() const {
    return records_;
  }

  /** The links the hub closed itself (`idle.closed`), each as "<link>: <reason>", in order. */
  const std::vector<std::pair<device::Instant, std::string>>& closed_links() const {
    return closes_;
  }

  /** The hub on the timeline. */
  ActorId actor() const {
    return actor_;
  }

  /** Lockstep steps taken (advances) and the real time spent waiting on the hub. */
  std::size_t steps() const {
    return steps_;
  }
  std::chrono::steady_clock::duration hub_time() const {
    return hub_time_;
  }

  /** Everything received, logged, sent and decided, and the hub's own events, in time order. */
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

  /** One board the hub provisions, and what this side learns of it. */
  struct Board {
    std::string name;
    /** Its name on the hub: the same, but for a gateway the hub added by itself (D100). */
    std::string hub_name;
    SimDevice* device = nullptr;
    std::uint8_t role = 0;
    SensorConfig sensor;
    SirenConfig siren;
    GatewayConfig gateway;
    /** Plugged into the hub's USB now; on mains of its own, unplugged. */
    bool usb = false;
    bool own_power = false;
    /** Its network link's wire is attached to this hub, with this latency each way. */
    bool network = false;
    device::Duration network_latency{};
    bool identity_seen = false;
    bool paired = false;
    /** From the Provision the hub sent it. */
    bool keyed = false;
    std::uint32_t address = 0;
    std::unique_ptr<psa::PsaPacketCipher> cipher;
    /** Its device number and address on the hub, as the hub's records state them. */
    std::optional<std::int64_t> hub_id;
    std::uint32_t hub_address = 0;
    /** A gateway connection, as its hello and welcome set it. */
    bool hello_seen = false;
    bool session_open = false;
    protocol::RandomValue gateway_random{};
    protocol::RandomValue hub_random{};
    /** Its latest packets' counters, newest last: what the hub's packets to it are bound to. */
    std::deque<std::uint32_t> recent;
    /** The new key a Key change gave it (D141), until a packet of its own comes under it. */
    std::unique_ptr<psa::PsaPacketCipher> next_cipher;
  };

  /** A transmit request seen leaving for a gateway. */
  struct Handover {
    device::Instant at;
    Bytes packet;
    std::size_t gateway = kNone;
  };

  /** A command waiting for its answer, and what to do then. */
  struct Pending {
    std::string kind;
    std::size_t board = kNone;
    /** Asked by command_now(): its answer is kept for it, refused or not. */
    bool now = false;
  };

  Board& add_board(SimDevice& device, std::uint8_t role);
  void plug(std::size_t index);
  void unplug(std::size_t index);
  void after_paired(std::size_t index);
  void next_add();
  bool all_paired() const;
  void command_or_hold(json::Value command);
  std::string board_name_of_hub_name(const std::string& hub_name) const;
  void send_command(json::Value command, std::size_t board);
  json::Value command_now(json::Value command);
  static json::Value answer_or_throw(const json::Value& reply);
  static json::Value gateway_set(const std::string& hub_name, const GatewayConfig& config);

  void queue(lockstep::ToHub message);
  void schedule_step(device::Instant when);
  void step();
  void take(const lockstep::FromHub& idle);
  void on_frame_out(const lockstep::FrameOut& frame);
  void on_closed(const lockstep::ClosedLink& closed);
  void on_record(const json::Value& record);
  void on_reply(const lockstep::Reply& reply);
  void on_hub_event(const json::Value& row);
  void on_rx(const json::Value& row);
  void on_tx(const json::Value& row, bool routine);
  void on_decision(const json::Value& row);
  void on_device_log(const json::Value& row);
  void on_reject(const json::Value& row);
  void bench_actions(const json::Value& row, bool routine);
  void hub_down();

  std::size_t board_named(const std::string& name) const;
  std::size_t board_of_link(const std::string& link, device::LinkKind* kind = nullptr) const;
  std::size_t board_of_wire(const LinkWire& wire) const;
  std::size_t board_of_address(std::uint32_t address) const;
  std::size_t board_of_id(std::int64_t id) const;
  std::size_t board_of_hub_address(std::uint32_t address) const;
  std::string name_of_id(const json::Value& id) const;
  void learn_id(std::int64_t id, std::size_t board, std::uint32_t address);
  static std::string link_name(const Board& board, device::LinkKind kind);
  void remember_counter(Board& board, std::uint32_t counter);
  std::optional<protocol::OpenedPacket> open(const Board& board, protocol::ByteView packet,
                                             protocol::Direction direction,
                                             const protocol::Binding& binding,
                                             protocol::PacketLimit limit, Bytes& plaintext) const;
  void tap_from_device(std::size_t index, const Bytes& packet);
  void tap_to_device(std::size_t index, const Bytes& packet);
  device::Instant true_of_wall(std::int64_t wall_ms) const;
  json::Value op(const std::string& name, json::Value body);
  void on_transfer_frame(std::size_t index, const Bytes& frame);
  void learn_key_change(Board& board, const protocol::OpenedPacket& opened);
  void key_seen_from(Board& board, protocol::ByteView packet);
  void learn_from_hub_packet(Board& board, protocol::ByteView packet);
  void firmware_actions(const json::Value& row, bool received);
  std::int64_t current_rollout();
  Bytes seed() const;
  Bytes seed_of_first_run() const;
  /** The wall clock as last set: it reads `wall_base_` at `wall_from_` and runs with true time. */
  std::int64_t wall_base_ = 0;
  device::Instant wall_from_;

  Simulation& sim_;
  HubOptions options_;
  ActorId actor_;
  lockstep::RunFolder folder_;
  std::unique_ptr<lockstep::HubProcess> process_;
  bool up_ = false;
  std::int64_t boot_ = 0;
  std::vector<Board> boards_;
  /** Boards waiting for their `usb add`, in the order added; the one being added. */
  std::deque<std::size_t> to_add_;
  std::size_t adding_ = kNone;
  /** Commands waiting for every board to be paired. */
  std::vector<json::Value> held_;
  std::int64_t next_id_ = 1;
  std::map<std::int64_t, Pending> pending_;
  std::map<std::int64_t, json::Value> answers_;
  std::map<std::int64_t, std::size_t> ids_;
  std::vector<lockstep::ToHub> inputs_;
  std::set<std::int64_t> scheduled_;
  /** The frames of this idle on each board's link: the packets its tx rows are about. */
  std::vector<std::pair<std::size_t, Bytes>> link_frames_;
  std::map<std::pair<std::uint32_t, std::uint32_t>, Handover> handovers_;
  std::vector<std::pair<device::Instant, json::Value>> records_;
  /** The links the hub closed itself, with why. */
  std::vector<std::pair<device::Instant, std::string>> closes_;
  std::vector<HubPacket> received_;
  std::vector<HubSent> sent_;
  std::vector<HubDecision> decisions_;
  std::vector<HubLogEntry> log_entries_;
  std::map<std::string, std::size_t> duplicates_;
  std::size_t rejects_ = 0;
  device::Duration send_delay_;
  /** Images stored, the upload jobs numbered for them, the latest rollout started. */
  std::deque<RemoteImage> images_;
  std::int64_t next_upload_ = 1;
  std::int64_t rollout_ = 0;
  std::vector<HubTransfer> transfers_;
  /** The backup folder set, and restores done (each restart after one takes a new seed). */
  std::string backup_folder_;
  std::uint32_t restores_ = 0;
  std::vector<json::Value> run_stats_;
  std::size_t steps_ = 0;
  std::chrono::steady_clock::duration hub_time_{};
};

}  // namespace hsn::host
