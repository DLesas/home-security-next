#include "hsn/host/remote_hub.hpp"

#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <utility>

#include "hsn/host/provisioning.hpp"
#include "hsn/host/sim_time.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/setup.hpp"

namespace hsn::host {
namespace {

using json::Value;
using lockstep::FromHub;
using lockstep::ToHub;

/** The run's wall clock at true time zero: 2026-11-13 00:00 UTC, as the recorded sessions. */
constexpr std::int64_t kWallAtZero = 1794528000000;
/** A board is plugged into the hub's USB this long after its power-on: it has booted by then. */
constexpr device::Duration kPlugDelay = device::milliseconds(100);
/** The site's Wi-Fi, given to every board at pairing. */
constexpr const char* kWifiName = "bench";
constexpr const char* kWifiPassword = "benchpass1";
/** How many of a board's latest packet counters are kept to open the hub's answers to them. */
constexpr std::size_t kRecentCounters = 64;

/** `PacketPath` (hub-design.md section 6): how a row's packet came or went. */
constexpr std::int64_t kPathLora = 0;
/** `TxOutcome` (section 6). */
constexpr std::int64_t kSent = 0;
constexpr std::int64_t kTooLate = 1;
constexpr std::int64_t kNotValid = 4;
constexpr std::int64_t kHeldBack = 7;
constexpr std::int64_t kSendFailed = 8;

HubPath path_of(std::int64_t path) {
  return path == kPathLora ? HubPath::gateway : HubPath::link;
}

const char* path_text(HubPath path) {
  switch (path) {
    case HubPath::radio:
      return "radio";
    case HubPath::gateway:
      return "gateway";
    case HubPath::link:
      return "link";
  }
  return "?";
}

std::optional<HubAction> action_named(const std::string& name) {
  for (int i = 0; i <= static_cast<int>(HubAction::key_changed); ++i) {
    const auto action = static_cast<HubAction>(i);
    if (name == hub_action_name(action)) {
      return action;
    }
  }
  return std::nullopt;
}

std::int64_t int_or(const Value& row, const char* key, std::int64_t otherwise = 0) {
  const Value& value = row.at(key);
  return value.is_null() ? otherwise : value.as_int();
}

std::uint8_t as_u8(std::int64_t value) {
  return static_cast<std::uint8_t>(value & 0xFF);
}

std::uint32_t as_u32(std::int64_t value) {
  return static_cast<std::uint32_t>(value & 0xFFFFFFFF);
}

/** True when a data-rate mask has the bit of `rate` (unsigned throughout: no promotion to int). */
bool mask_allows(std::uint8_t mask, std::uint8_t rate) {
  return rate < 8 && ((static_cast<unsigned>(mask) >> static_cast<unsigned>(rate)) & 1u) != 0;
}

/** The hub's delay before a frame leaves: HSN_HUB_DELAY_MS, or 10 ms. */
device::Duration default_delay() {
  const char* set = std::getenv("HSN_HUB_DELAY_MS");
  return device::milliseconds(set != nullptr ? std::atoll(set) : 10);
}

/** An instant as the wire's whole microseconds. */
std::int64_t micros(device::Instant at) {
  return static_cast<std::int64_t>(at.us);
}

Value sensor_target_all() {
  return Value("all");
}

}  // namespace

RemoteHub::RemoteHub(Simulation& sim, HubOptions options, lockstep::HubProgram program)
    : sim_(sim), options_(options), actor_(sim.add_actor("hub")), send_delay_(default_delay()) {
  if (options_.mode != HubMode::gateway_link) {
    throw SimulationError("the real hub has no radio of its own: only gateway link mode");
  }
  const std::uint8_t mask = options_.allowed_data_rate_mask;
  const unsigned bits = mask;
  if (bits == 0 || (bits & (bits - 1u)) != 0) {
    throw SimulationError(
        "the real hub gives a site one data rate (hsn site set rate=), so it cannot allow the "
        "data rates of mask 0x" +
        [mask]() {
          std::ostringstream text;
          text << std::hex << static_cast<int>(mask);
          return text.str();
        }());
  }
  std::uint8_t rate = 0;
  while (!mask_allows(mask, rate)) {
    ++rate;
  }
  wall_base_ = kWallAtZero + micros(sim_.now()) / 1000;
  wall_from_ = sim_.now();
  process_ =
      std::make_unique<lockstep::HubProcess>(std::move(program), folder_.data(), folder_.socket());
  sim_.labels().add(*this);
  start();
  // The site, before any board is plugged in.
  send_command(Value::object()
                   .set("kind", "siteSet")
                   .set("channel", static_cast<int>(options_.site_channel))
                   .set("rate", static_cast<int>(rate))
                   .set("countdown", 30)
                   .set("autoStop", static_cast<int>(options_.alarm_seconds)),
               kNone);
  send_command(
      Value::object().set("kind", "siteWifi").set("name", kWifiName).set("password", kWifiPassword),
      kNone);
}

RemoteHub::~RemoteHub() {
  sim_.labels().remove(*this);
  for (Board& board : boards_) {
    for (const device::LinkKind kind :
         {device::LinkKind::usb, device::LinkKind::network, device::LinkKind::bluetooth}) {
      LinkWire& wire = board.device->wire(kind);
      if (board_of_wire(wire) != kNone && wire.attached()) {
        wire.detach();
      }
    }
  }
}

std::int64_t RemoteHub::wall_at(device::Instant at) const {
  return wall_base_ + (micros(at) - micros(wall_from_)) / 1000;
}

void RemoteHub::set_clock(std::int64_t wall_ms, bool trusted) {
  wall_base_ = wall_ms;
  wall_from_ = sim_.now();
  queue(ToHub::clock(micros(sim_.now()), wall_ms, trusted));
}

Value RemoteHub::op(const std::string& name, Value body) {
  // An operation's answer is {kind: "op", body: <the operation's reply>}.
  return answer_or_throw(
             command_now(
                 Value::object().set("kind", "op").set("op", name).set("body", std::move(body))))
      .at("body");
}

std::int64_t RemoteHub::device_number(const std::string& name) const {
  const Board& board = boards_.at(board_named(name));
  if (!board.hub_id.has_value()) {
    throw SimulationError(name + " has no number on the hub yet: it is not paired");
  }
  return *board.hub_id;
}

std::int64_t RemoteHub::create_group(const std::string& name,
                                     const std::vector<std::string>& sensors,
                                     const std::vector<std::string>& sirens) {
  Value members = Value::array();
  for (const std::string& sensor : sensors) {
    members.push(device_number(sensor));
  }
  Value choice = Value::array();
  for (const std::string& siren : sirens) {
    choice.push(device_number(siren));
  }
  return op("group.create", Value::object()
                                .set("name", name)
                                .set("sensors", std::move(members))
                                .set("sirens", sirens.empty() ? Value("all") : std::move(choice)))
      .at("id")
      .as_int();
}

std::int64_t RemoteHub::create_mode(const std::string& name,
                                    const std::vector<std::int64_t>& groups) {
  Value members = Value::array();
  for (const std::int64_t group : groups) {
    members.push(group);
  }
  return op("mode.create", Value::object().set("name", name).set("groups", std::move(members)))
      .at("id")
      .as_int();
}

std::int64_t RemoteHub::fixed_mode(const std::string& which) {
  // The migration makes the two fixed modes first (m2-design.md section 4): Away is mode 1 and
  // Disarmed mode 2, the values `mode_switched` names for `hsn arm --all` and `hsn disarm --all`
  // (section 11). `snapshot`, which lists the modes, is refused on the lockstep hub.
  if (which == "away") {
    return 1;
  }
  if (which == "disarmed") {
    return 2;
  }
  throw SimulationError("there is no fixed mode " + which + ": only away and disarmed (D90)");
}

Value RemoteHub::switch_mode(std::int64_t mode, bool confirm) {
  Value body = Value::object().set("mode", mode);
  if (confirm) {
    body.set("confirm", Value::object().set("openDoors", true).set("lowBattery", true));
  }
  return op("mode.switch", std::move(body));
}

Value RemoteHub::arm_group(std::int64_t group, bool confirm) {
  Value body = Value::object().set("target", Value::object().set("group", group));
  if (confirm) {
    body.set("confirm", Value::object().set("openDoors", true).set("lowBattery", true));
  }
  return op("arm", std::move(body));
}

Value RemoteHub::disarm_group(std::int64_t group) {
  return op("disarm", Value::object().set("target", Value::object().set("group", group)));
}

Value RemoteHub::create_schedule(const std::string& name, const std::string& action, Value target,
                                 const std::string& at, Value days) {
  return op("schedule.create", Value::object()
                                   .set("name", name)
                                   .set("action", action)
                                   .set("target", std::move(target))
                                   .set("at", at)
                                   .set("days", std::move(days))
                                   .set("enabled", true));
}

std::vector<RemoteHub::NamedDecision> RemoteHub::decisions_named(const std::string& kind,
                                                                 const std::string& device) const {
  std::vector<NamedDecision> found;
  for (const auto& record : records_) {
    if (record.second.at("kind").as_string() != "decision") {
      continue;
    }
    const Value& row = record.second.at("row");
    if (row.at("kind").as_string() != kind) {
      continue;
    }
    NamedDecision decision;
    decision.at = record.first;
    decision.device = name_of_id(row.at("deviceId"));
    if (!device.empty() && decision.device != device) {
      continue;
    }
    if (!row.at("value").is_null()) {
      decision.value = row.at("value").as_int();
    }
    if (!row.at("detail").is_null()) {
      decision.detail = json::from_hex(row.at("detail").as_string());
    }
    found.push_back(std::move(decision));
  }
  return found;
}

device::Instant RemoteHub::true_of_wall(std::int64_t wall_ms) const {
  return device::Instant{} + device::microseconds((wall_ms - kWallAtZero) * 1000);
}

std::string RemoteHub::link_name(const Board& board, device::LinkKind kind) {
  switch (kind) {
    case device::LinkKind::usb:
      return board.name + ":usb";
    case device::LinkKind::network:
      return board.name + ":network";
    case device::LinkKind::bluetooth:
      return board.name + ":bluetooth";
  }
  return board.name + ":?";
}

// Boards and provisioning.

RemoteHub::Board& RemoteHub::add_board(SimDevice& device, std::uint8_t role) {
  if (device.boots() > 0) {
    throw SimulationError(device.name() + " has booted already: add it before its first boot");
  }
  for (const Board& other : boards_) {
    if (other.name == device.name()) {
      throw SimulationError("the hub has " + device.name() + " already");
    }
  }
  // As it leaves the factory: unpaired, a development build, its role stored (D103).
  make_board(device.board(), role);
  Board board;
  board.name = device.name();
  board.hub_name = device.name();
  // On the hub's USB it has USB power, so it waits for the hub instead of sleeping deep; its own
  // supply is what it was given, which it keeps once unplugged.
  board.own_power = device.board().power.external;
  device.board().power.external = true;
  board.device = &device;
  board.role = role;
  boards_.push_back(std::move(board));
  const std::size_t index = boards_.size() - 1;
  const device::Instant plug_at = std::max(sim_.now(), device.spec().power_on + kPlugDelay);
  sim_.schedule(plug_at, [this, index]() { plug(index); });
  if (role != protocol::Role::gateway) {
    to_add_.push_back(index);
  }
  return boards_.back();
}

void RemoteHub::add_sensor(SimDevice& device, const SensorConfig& config) {
  if (config.address != 0) {
    throw SimulationError("the real hub chooses addresses: " + device.name() + " asks for one");
  }
  if (!mask_allows(options_.allowed_data_rate_mask, config.send_data_rate)) {
    throw SimulationError(device.name() + "'s sending rate is not the site's");
  }
  Board& board = add_board(device, protocol::Role::sensor);
  board.sensor = config;
  if (config.wifi_in_range) {
    // Its Wi-Fi, which it uses only for updates (protocol section 10), reaches this hub.
    device.wire(device::LinkKind::network).attach(*this, options_.link_latency);
    board.network = true;
    board.network_latency = options_.link_latency;
  }
}

void RemoteHub::add_siren(SimDevice& device, const SirenConfig& config) {
  const SirenConfig defaults;
  if (config.address != 0) {
    throw SimulationError("the real hub chooses addresses: " + device.name() + " asks for one");
  }
  if (config.wifi_report_interval_seconds != defaults.wifi_report_interval_seconds ||
      config.lora_check_interval_units != defaults.lora_check_interval_units ||
      !mask_allows(options_.allowed_data_rate_mask, config.send_data_rate) ||
      config.command_data_rate != config.send_data_rate) {
    throw SimulationError("the real hub has no command for " + device.name() +
                          "'s report intervals or rates");
  }
  Board& board = add_board(device, protocol::Role::siren);
  board.siren = config;
  if (config.wifi) {
    device.wire(device::LinkKind::network).attach(*this, options_.link_latency);
    board.network = true;
    board.network_latency = options_.link_latency;
  }
}

void RemoteHub::add_gateway(SimDevice& device, const GatewayConfig& config) {
  if (config.address != 0 || config.listen_data_rate_mask != options_.allowed_data_rate_mask) {
    throw SimulationError(
        "the real hub chooses a gateway's address and listens at the site's "
        "rate: " +
        device.name() + " asks otherwise");
  }
  Board& board = add_board(device, protocol::Role::gateway);
  board.gateway = config;
  if (config.network) {
    device.wire(device::LinkKind::network).attach(*this, options_.link_latency);
    board.network = true;
    board.network_latency = options_.link_latency;
  }
}

void RemoteHub::plug(std::size_t index) {
  Board& board = boards_[index];
  board.usb = true;
  board.device->wire(device::LinkKind::usb).attach(*this, options_.link_latency);
  board.device->board().gateway_io.host = true;
  if (up_) {
    queue(ToHub::link_up(link_name(board, device::LinkKind::usb), "usb", micros(sim_.now())));
  }
}

void RemoteHub::unplug(std::size_t index) {
  Board& board = boards_[index];
  board.usb = false;
  board.device->wire(device::LinkKind::usb).detach();
  board.device->board().gateway_io.host = false;
  if (!board.own_power) {
    // Its USB power goes with the cable: from now it runs on its cell.
    board.device->set_input(device::Input::external_power, false, sim_.now());
  }
  if (up_) {
    queue(ToHub::link_down(link_name(board, device::LinkKind::usb), micros(sim_.now())));
  }
}

void RemoteHub::after_paired(std::size_t index) {
  Board& board = boards_[index];
  board.paired = true;
  if (!(board.role == protocol::Role::gateway && board.gateway.usb)) {
    unplug(index);
  }
  if (board.role == protocol::Role::sensor) {
    const SensorConfig& c = board.sensor;
    send_command(Value::object()
                     .set("kind", "sensorSet")
                     .set("name", board.name)
                     .set("countdown", static_cast<int>(c.countdown_seconds))
                     .set("heartbeat", static_cast<int>(c.heartbeat_interval_units))
                     .set("linkCheck", static_cast<int>(c.link_check_every))
                     .set("replyRate", static_cast<int>(c.reply_data_rate))
                     .set("correction", static_cast<int>(c.clock_correction_ten_ppm)),
                 index);
  } else if (board.role == protocol::Role::gateway) {
    send_command(gateway_set(board.hub_name, board.gateway), index);
  } else if (board.role == protocol::Role::siren) {
    send_command(Value::object()
                     .set("kind", "sirenSet")
                     .set("name", board.name)
                     .set("max", static_cast<int>(board.siren.max_sound_seconds)),
                 index);
  }
}

void RemoteHub::next_add() {
  if (adding_ == kNone && !to_add_.empty() && boards_[to_add_.front()].identity_seen) {
    adding_ = to_add_.front();
    to_add_.pop_front();
    const Board& board = boards_[adding_];
    send_command(Value::object()
                     .set("kind", "usbAdd")
                     .set("port", link_name(board, device::LinkKind::usb))
                     .set("name", board.name),
                 adding_);
  }
  if (all_paired() && !held_.empty()) {
    std::vector<Value> commands;
    commands.swap(held_);
    for (Value& held : commands) {
      send_command(std::move(held), kNone);
    }
  }
}

bool RemoteHub::all_paired() const {
  return std::all_of(boards_.begin(), boards_.end(), [](const Board& b) { return b.paired; }) &&
         adding_ == kNone && to_add_.empty();
}

void RemoteHub::command_or_hold(Value command) {
  if (!all_paired()) {
    held_.push_back(std::move(command));
    return;
  }
  send_command(std::move(command), kNone);
}

void RemoteHub::send_command(Value command, std::size_t board) {
  const std::int64_t id = next_id_++;
  pending_[id] = Pending{command.at("kind").as_string(), board};
  queue(ToHub::control(micros(sim_.now()), id, "bench", std::move(command)));
}

std::vector<std::string> RemoteHub::arm(OpenDoors open_doors) {
  Value command = Value::object()
                      .set("kind", "arm")
                      .set("sensors", sensor_target_all())
                      .set("continue", open_doors == OpenDoors::arm_when_closed);
  std::vector<std::string> open;
  if (!all_paired()) {
    // Before every board is paired it waits for them, as the test hub's boards are paired before
    // they boot; a refusal then throws, since nobody is there to be told the names.
    command_or_hold(std::move(command));
    return open;
  }
  const Value reply = command_now(std::move(command));
  if (reply.at("ok").as_bool()) {
    for (const Value& name : reply.at("result").at("waitsForDoorToClose").as_array()) {
      open.push_back(board_name_of_hub_name(name.as_string()));
    }
    return open;
  }
  const Value& error = reply.at("error");
  if (error.at("code").as_string() != "doorsOpen") {
    throw SimulationError("the hub refused arm: " + json::write(reply));
  }
  for (const Value& name : error.at("names").as_array()) {
    open.push_back(board_name_of_hub_name(name.as_string()));
  }
  return open;
}

std::string RemoteHub::board_name_of_hub_name(const std::string& hub_name) const {
  for (const Board& board : boards_) {
    if (board.hub_name == hub_name) {
      return board.name;
    }
  }
  return hub_name;
}

void RemoteHub::disarm() {
  command_or_hold(Value::object().set("kind", "disarm").set("sensors", sensor_target_all()));
}

void RemoteHub::drop_link(const std::string& name, device::LinkKind kind,
                          device::Duration noticed_after) {
  boards_.at(board_named(name)).device->wire(kind).drop(noticed_after);
}

Value RemoteHub::gateway_set(const std::string& hub_name, const GatewayConfig& config) {
  return Value::object()
      .set("kind", "gatewaySet")
      .set("name", hub_name)
      .set("statusS", static_cast<int>(config.status_interval_seconds))
      .set("interferenceDb", static_cast<int>(config.interference_threshold_db))
      .set("interferenceS", static_cast<int>(config.interference_seconds))
      .set("powerDbm", static_cast<int>(config.default_tx_power_dbm))
      .set("sirenPowerDbm", static_cast<int>(config.siren_tx_power_dbm));
}

void RemoteHub::command_siren(const std::string& name, std::uint8_t action, std::uint16_t seconds) {
  if (action != protocol::SirenAction::test) {
    throw SimulationError("the real hub has no command to send " + name + " siren action " +
                          std::to_string(action) + ": only a test (hsn siren test)");
  }
  answer_or_throw(command_now(Value::object()
                                  .set("kind", "sirenTest")
                                  .set("name", boards_.at(board_named(name)).hub_name)
                                  .set("seconds", static_cast<int>(seconds))));
}

void RemoteHub::change_gateway(const std::string& name, const GatewayConfig& config) {
  Board& board = boards_.at(board_named(name));
  if (config.address != board.gateway.address ||
      config.listen_data_rate_mask != options_.allowed_data_rate_mask) {
    throw SimulationError("the real hub has no command to change " + name +
                          "'s address or listening rates");
  }
  board.gateway = config;
  answer_or_throw(command_now(gateway_set(board.hub_name, config)));
}

Value RemoteHub::command_now(Value command) {
  if (!all_paired()) {
    throw SimulationError("a command while the hub still pairs the boards: run the simulation on");
  }
  const std::int64_t id = next_id_++;
  const std::string kind = command.at("kind").as_string();
  pending_[id] = Pending{kind, kNone, true};
  queue(ToHub::control(micros(sim_.now()), id, "bench", std::move(command)));
  step();
  const auto found = answers_.find(id);
  if (found == answers_.end()) {
    throw SimulationError("the hub did not answer " + kind + " at once");
  }
  Value answer = found->second;
  answers_.erase(found);
  return answer;
}

Value RemoteHub::answer_or_throw(const Value& reply) {
  if (!reply.at("ok").as_bool()) {
    throw SimulationError("the hub refused: " + json::write(reply));
  }
  return reply.at("result");
}

void RemoteHub::announce_move(const SiteMove& move) {
  Value command = Value::object().set("kind", "siteChange");
  if (move.site_channel.has_value()) {
    command.set("channel", static_cast<int>(*move.site_channel));
  }
  if (move.send_data_rate.has_value()) {
    command.set("rate", static_cast<int>(*move.send_data_rate));
  }
  answer_or_throw(command_now(std::move(command)));
}

bool RemoteHub::switch_move(bool force) {
  if (move_stage() == MoveStage::switched) {
    // The real hub switches by itself once every sensor has confirmed (§7, step 2).
    return true;
  }
  const Value result = answer_or_throw(
      command_now(Value::object().set("kind", "siteChangeForce").set("yes", force)));
  return result.at("switched").as_bool() && move_stage() == MoveStage::switched;
}

void RemoteHub::cancel_move() {
  answer_or_throw(command_now(Value::object().set("kind", "siteChangeCancel")));
}

MoveStage RemoteHub::move_stage() const {
  MoveStage stage = MoveStage::none;
  for (const HubDecision& decision : decisions_) {
    if (decision.action == HubAction::move_requested) {
      stage = MoveStage::announcing;
    } else if (decision.action == HubAction::move_switched) {
      stage = MoveStage::switched;
    } else if (decision.action == HubAction::move_done ||
               decision.action == HubAction::move_cancelled) {
      stage = MoveStage::none;
    }
  }
  return stage;
}

std::vector<std::string> RemoteHub::move_unconfirmed() {
  const Value result =
      answer_or_throw(command_now(Value::object().set("kind", "siteChangeStatus")));
  std::vector<std::string> names;
  const Value& move = result.at("move");
  if (move.is_null() || move.at("stage").as_string() != "announcing") {
    return names;
  }
  for (const Value& waiting : move.at("waiting").as_array()) {
    names.push_back(board_name_of_hub_name(waiting.at("name").as_string()));
  }
  return names;
}

bool RemoteHub::move_followed(const std::string& name) const {
  bool followed = false;
  for (const HubDecision& decision : decisions_) {
    if (decision.action == HubAction::move_requested) {
      followed = false;
    } else if (decision.action == HubAction::device_followed && decision.device == name) {
      followed = true;
    }
  }
  return followed;
}

std::uint8_t RemoteHub::site_channel() const {
  std::uint8_t channel = options_.site_channel;
  std::int64_t target = -1;
  for (const HubDecision& decision : decisions_) {
    if (decision.action == HubAction::move_requested) {
      target = decision.value;
    } else if (decision.action == HubAction::move_switched && target >= 0 &&
               ((target >> 8) & 0xFF) != 0xFF) {
      channel = static_cast<std::uint8_t>((target >> 8) & 0xFF);
    }
  }
  return channel;
}

bool RemoteHub::countdown_running(const std::string& name) const {
  bool running = false;
  for (const HubDecision& decision : decisions_) {
    if (decision.device != name) {
      continue;
    }
    if (decision.action == HubAction::countdown_started) {
      running = true;
    } else if (decision.action == HubAction::alarm || decision.action == HubAction::disarmed) {
      running = false;
    }
  }
  return running;
}

// The hub process.

void RemoteHub::start() {
  if (up_) {
    throw SimulationError("the hub runs already");
  }
  const device::Instant now = sim_.now();
  const auto began = std::chrono::steady_clock::now();
  ToHub start = ToHub::start(micros(now), wall_at(now), true, seed());
  start.zone = options_.time_zone;
  const auto answers = process_->send(start);
  hub_time_ += std::chrono::steady_clock::now() - began;
  if (answers.size() != 1 || answers[0].type != FromHub::Type::idle) {
    throw SimulationError("the hub did not start: " +
                          (answers.empty() ? std::string("no answer") : answers[0].message));
  }
  up_ = true;
  take(answers[0]);
  // Every cable still plugged in comes up again for the new hub; network links can connect to it
  // again, which each device does on its own back-off.
  for (Board& board : boards_) {
    if (board.usb) {
      queue(ToHub::link_up(link_name(board, device::LinkKind::usb), "usb", micros(now)));
    }
    LinkWire& wire = board.device->wire(device::LinkKind::network);
    if (board.network && !wire.attached()) {
      wire.attach(*this, board.network_latency);
    }
  }
}

void RemoteHub::stop() {
  if (!up_) {
    throw SimulationError("no hub runs to stop");
  }
  const auto began = std::chrono::steady_clock::now();
  const auto answers = process_->send(ToHub::stop(micros(sim_.now())));
  hub_time_ += std::chrono::steady_clock::now() - began;
  if (answers.size() != 2 || answers[0].type != FromHub::Type::idle ||
      answers[1].type != FromHub::Type::stopped) {
    throw SimulationError("the hub did not stop cleanly");
  }
  take(answers[0]);
  hub_down();
  // The run's figures, which the lockstep hub writes at its clean stop (shell/lockstep/files.ts).
  std::ifstream figures(folder_.data() + "/lockstep-stats.json");
  if (figures) {
    std::stringstream text;
    text << figures.rdbuf();
    run_stats_.push_back(json::parse(text.str()));
  }
}

void RemoteHub::kill() {
  process_->kill();
  hub_down();
}

void RemoteHub::hub_down() {
  up_ = false;
  inputs_.clear();
  // Every connection to the hub closes with it; the boards notice at once. While no hub runs a
  // WebSocket cannot connect: the wire has no far end until the next start().
  for (Board& board : boards_) {
    board.session_open = false;
    board.hello_seen = false;
    LinkWire& wire = board.device->wire(device::LinkKind::network);
    if (board.network && wire.connected()) {
      wire.drop();
    }
    if (board.network && wire.attached()) {
      wire.detach();
    }
  }
}

void RemoteHub::set_network_latency(const std::string& name, device::Duration latency) {
  Board& board = boards_.at(board_named(name));
  if (!board.network) {
    throw SimulationError(name + " has no network link to this hub");
  }
  board.network_latency = latency;
  LinkWire& wire = board.device->wire(device::LinkKind::network);
  if (wire.attached()) {
    wire.detach();
    wire.attach(*this, latency);
  }
}

// Stepping.

void RemoteHub::queue(ToHub message) {
  if (!up_) {
    return;
  }
  inputs_.push_back(std::move(message));
  schedule_step(sim_.now());
}

void RemoteHub::schedule_step(device::Instant when) {
  if (scheduled_.insert(micros(when)).second) {
    sim_.schedule(when, [this, when]() {
      scheduled_.erase(micros(when));
      step();
    });
  }
}

void RemoteHub::step() {
  if (!up_) {
    inputs_.clear();
    return;
  }
  const auto began = std::chrono::steady_clock::now();
  std::vector<ToHub> inputs;
  inputs.swap(inputs_);
  for (const ToHub& input : inputs) {
    static_cast<void>(process_->send(input));
  }
  const auto answers = process_->send(ToHub::advance(micros(sim_.now())));
  hub_time_ += std::chrono::steady_clock::now() - began;
  steps_ += 1;
  if (answers.size() != 1 || answers[0].type != FromHub::Type::idle) {
    up_ = false;
    throw SimulationError("the hub refused a line at " + format_instant(sim_.now()) + " s: " +
                          (answers.empty() ? std::string("no answer")
                                           : answers[0].message + " (" + answers[0].line + ")"));
  }
  take(answers[0]);
}

void RemoteHub::take(const FromHub& idle) {
  const device::Instant now = sim_.now();
  if (idle.to != micros(now)) {
    throw SimulationError("the hub's idle covers " + std::to_string(idle.to) + " us, not now");
  }
  boot_ = idle.boot;
  link_frames_.clear();
  for (const lockstep::FrameOut& frame : idle.frames) {
    on_frame_out(frame);
  }
  for (const lockstep::ClosedLink& closed : idle.closed) {
    on_closed(closed);
  }
  for (const Value& record : idle.records) {
    records_.emplace_back(now, record);
    on_record(record);
  }
  for (const lockstep::Reply& reply : idle.replies) {
    on_reply(reply);
  }
  if (idle.wake.has_value()) {
    if (*idle.wake <= micros(now)) {
      throw SimulationError("the hub's next wake is not after the time it reached");
    }
    schedule_step(device::Instant{} + device::microseconds(*idle.wake));
  }
  next_add();
}

void RemoteHub::on_frame_out(const lockstep::FrameOut& frame) {
  if (frame.at != micros(sim_.now())) {
    throw SimulationError("the hub sent a frame on " + frame.link + " at " +
                          std::to_string(frame.at) + " us, in the past");
  }
  device::LinkKind kind = device::LinkKind::usb;
  const std::size_t index = board_of_link(frame.link, &kind);
  if (index == kNone) {
    return;
  }
  if (!frame.bytes.empty() && frame.bytes[0] == protocol::kTransferMarker) {
    on_transfer_frame(index, frame.bytes);
  } else {
    tap_to_device(index, frame.bytes);
  }
  link_frames_.emplace_back(index, frame.bytes);
  // It leaves the hub after the hub's delay, then the wire adds the link's latency.
  const Bytes bytes = frame.bytes;
  const auto deliver = [this, index, kind, bytes]() {
    LinkWire& wire = boards_[index].device->wire(kind);
    if (wire.attached()) {
      wire.send_to_device(bytes);
    }
  };
  if (send_delay_ == device::Duration{}) {
    deliver();
  } else {
    sim_.schedule(sim_.now() + send_delay_, deliver);
  }
}

void RemoteHub::on_closed(const lockstep::ClosedLink& closed) {
  device::LinkKind kind = device::LinkKind::usb;
  const std::size_t index = board_of_link(closed.link, &kind);
  closes_.emplace_back(sim_.now(), closed.link + ": " + closed.reason);
  if (index == kNone) {
    return;
  }
  Board& board = boards_[index];
  board.hello_seen = false;
  board.session_open = false;
  LinkWire& wire = board.device->wire(kind);
  if (kind != device::LinkKind::usb) {
    // The hub closed the WebSocket: the device sees it go down at once and connects again by
    // itself, as a real one does (section 11, "A link the hub closed"). A Bluetooth link is never
    // the hub's, but would be closed the same way.
    if (wire.connected()) {
      wire.drop();
    }
    return;
  }
  // The hub closed the port: the board has no host there until it is plugged in again.
  board.usb = false;
  if (wire.attached()) {
    wire.detach();
  }
  board.device->board().gateway_io.host = false;
}

// What this side reads of what it carries.

std::optional<protocol::OpenedPacket> RemoteHub::open(const Board& board, protocol::ByteView packet,
                                                      protocol::Direction direction,
                                                      const protocol::Binding& binding,
                                                      protocol::PacketLimit limit,
                                                      Bytes& plaintext) const {
  if (!board.keyed) {
    return std::nullopt;
  }
  plaintext.assign(protocol::kMaxLinkPacketSize, 0);
  const auto opened =
      protocol::open_packet(*board.cipher, packet, direction, binding, limit,
                            protocol::MutableByteView(plaintext.data(), plaintext.size()));
  if (opened.ok()) {
    return opened.value();
  }
  // After a Key change (D141), its packets may be under the new key before this side has seen one.
  if (board.next_cipher != nullptr) {
    const auto again =
        protocol::open_packet(*board.next_cipher, packet, direction, binding, limit,
                              protocol::MutableByteView(plaintext.data(), plaintext.size()));
    if (again.ok()) {
      return again.value();
    }
  }
  return std::nullopt;
}

void RemoteHub::remember_counter(Board& board, std::uint32_t counter) {
  board.recent.push_back(counter);
  if (board.recent.size() > kRecentCounters) {
    board.recent.pop_front();
  }
}

void RemoteHub::tap_from_device(std::size_t index, const Bytes& packet) {
  Board& board = boards_[index];
  const protocol::ByteView view(packet.data(), packet.size());
  if (!packet.empty() && packet[0] == protocol::kSetupMarker) {
    return;
  }
  const auto header =
      protocol::read_header(view, protocol::Direction::to_hub, protocol::PacketLimit::link);
  if (!header.ok()) {
    return;
  }
  remember_counter(board, header.value().counter);
  key_seen_from(board, view);
  if (board.role != protocol::Role::gateway) {
    return;
  }
  Bytes plaintext;
  const auto hello = open(board, view, protocol::Direction::to_hub, protocol::Binding::none(),
                          protocol::PacketLimit::link, plaintext);
  if (hello.has_value() && hello->type == protocol::message_type::hello) {
    protocol::Hello body;
    if (protocol::decode_body(hello->body, body) == protocol::Error::none) {
      board.hello_seen = true;
      board.session_open = false;
      board.gateway_random = body.gateway_random;
    }
    return;
  }
  if (!board.session_open) {
    return;
  }
  const auto opened = open(board, view, protocol::Direction::to_hub,
                           protocol::Binding::session(board.gateway_random, board.hub_random),
                           protocol::PacketLimit::link, plaintext);
  if (!opened.has_value() || opened->type != protocol::message_type::forwarded_packet) {
    return;
  }
  protocol::ForwardedPacket forwarded;
  if (protocol::decode_body(opened->body, forwarded) != protocol::Error::none) {
    return;
  }
  const auto inner = protocol::read_header(forwarded.packet.bytes, protocol::Direction::to_hub,
                                           protocol::PacketLimit::link);
  if (!inner.ok()) {
    return;
  }
  const std::size_t from = board_of_address(inner.value().address);
  if (from != kNone) {
    remember_counter(boards_[from], inner.value().counter);
    key_seen_from(boards_[from], forwarded.packet.bytes);
  }
}

void RemoteHub::tap_to_device(std::size_t index, const Bytes& packet) {
  Board& board = boards_[index];
  const protocol::ByteView view(packet.data(), packet.size());
  if (packet.size() > 2 && packet[0] == protocol::kSetupMarker &&
      packet[1] == protocol::setup_type::provision) {
    protocol::Provision provision;
    if (protocol::decode_setup_body(view.subspan(2), provision) == protocol::Error::none) {
      board.address = provision.pairing.address;
      board.cipher = std::make_unique<psa::PsaPacketCipher>();
      board.keyed = board.cipher->set_key(provision.pairing.key) == protocol::Error::none;
    }
    return;
  }
  if (board.role != protocol::Role::gateway) {
    // A Key change on its own link (a siren's Wi-Fi, a sensor's while it updates).
    const auto header =
        protocol::read_header(view, protocol::Direction::from_hub, protocol::PacketLimit::link);
    if (header.ok()) {
      if (const auto type = message_type(view, header.value());
          type.has_value() && *type == protocol::message_type::key_change) {
        learn_from_hub_packet(board, view);
      }
    }
    return;
  }
  if (!board.hello_seen) {
    return;
  }
  Bytes plaintext;
  if (!board.session_open) {
    const auto welcome = open(board, view, protocol::Direction::from_hub,
                              protocol::Binding::hello(board.gateway_random),
                              protocol::PacketLimit::link, plaintext);
    if (welcome.has_value() && welcome->type == protocol::message_type::key_change) {
      // In place of the welcome, after a restore (D141): it says hello again under the new key.
      learn_key_change(board, *welcome);
      return;
    }
    protocol::Welcome body;
    if (welcome.has_value() && welcome->type == protocol::message_type::welcome &&
        protocol::decode_body(welcome->body, body) == protocol::Error::none) {
      board.hub_random = body.hub_random;
      board.session_open = true;
    }
    return;
  }
  const auto opened = open(board, view, protocol::Direction::from_hub,
                           protocol::Binding::session(board.gateway_random, board.hub_random),
                           protocol::PacketLimit::link, plaintext);
  if (!opened.has_value() || opened->type != protocol::message_type::transmit_request) {
    return;
  }
  protocol::TransmitRequest request;
  if (protocol::decode_body(opened->body, request) != protocol::Error::none) {
    return;
  }
  const auto inner = protocol::read_header(request.packet.bytes, protocol::Direction::from_hub,
                                           protocol::PacketLimit::link);
  if (inner.ok()) {
    handovers_[{inner.value().address, inner.value().counter}] =
        Handover{sim_.now() + send_delay_,
                 Bytes(request.packet.bytes.begin(), request.packet.bytes.end()), index};
    const std::size_t to = board_of_address(inner.value().address);
    if (to != kNone) {
      const auto type = message_type(request.packet.bytes, inner.value());
      if (type.has_value() && *type == protocol::message_type::key_change) {
        learn_from_hub_packet(boards_[to], request.packet.bytes);
      }
    }
  }
}

std::optional<std::uint8_t> RemoteHub::message_type(protocol::ByteView packet,
                                                    const protocol::PacketHeader& header) {
  const std::size_t index = board_of_address(header.address);
  if (index == kNone) {
    return std::nullopt;
  }
  const Board& board = boards_[index];
  Bytes plaintext;
  const auto try_open = [&](const protocol::Binding& binding) {
    return open(board, packet, header.direction, binding, protocol::PacketLimit::link, plaintext);
  };
  if (const auto plain = try_open(protocol::Binding::none())) {
    return plain->type;
  }
  if (board.role == protocol::Role::gateway) {
    if (header.direction == protocol::Direction::from_hub && board.hello_seen) {
      if (const auto welcome = try_open(protocol::Binding::hello(board.gateway_random))) {
        return welcome->type;
      }
    }
    if (board.hello_seen) {
      if (const auto bound =
              try_open(protocol::Binding::session(board.gateway_random, board.hub_random))) {
        return bound->type;
      }
    }
    return std::nullopt;
  }
  if (header.direction == protocol::Direction::from_hub) {
    // The hub's packets to a sensor are bound to the packet they answer: one of its latest.
    for (auto it = board.recent.rbegin(); it != board.recent.rend(); ++it) {
      if (const auto bound = try_open(protocol::Binding::sensor_packet(*it))) {
        return bound->type;
      }
    }
  }
  return std::nullopt;
}

// Records.

void RemoteHub::on_record(const Value& record) {
  const std::string& kind = record.at("kind").as_string();
  const Value& row = record.at("row");
  if (kind == "rx") {
    on_rx(row);
  } else if (kind == "tx") {
    on_tx(row, record.at("table").as_string() == "routine");
  } else if (kind == "decision") {
    on_decision(row);
  } else if (kind == "deviceLog") {
    on_device_log(row);
  } else if (kind == "hubEvent") {
    on_hub_event(row);
  } else if (kind == "reject") {
    on_reject(row);
  }
}

void RemoteHub::on_hub_event(const Value& row) {
  const std::string& code = row.at("code").as_string();
  const Value& raw = row.at("detail");
  // A hub event's detail is a JSON object of its fields (hub-design.md section 6); its message is
  // for people and is never read here.
  const Value detail = raw.is_null() ? Value::object() : json::parse(raw.as_string());
  const auto board_of_detail_link = [&]() {
    const Value* link = detail.find("link");
    return link == nullptr ? kNone : board_of_link(link->as_string());
  };
  const auto setup_message = [&](std::size_t index) {
    // The hub's record of a setup message it had from the board: a packet of type 0, counter 0.
    HubPacket packet;
    packet.at = sim_.now();
    packet.from = boards_[index].name;
    packet.path = HubPath::link;
    received_.push_back(std::move(packet));
  };
  if (code == "usb_identity") {
    const std::size_t index = board_of_detail_link();
    if (index != kNone) {
      boards_[index].identity_seen = true;
      setup_message(index);
    }
  } else if (code == "provision_accepted") {
    const std::size_t index = board_of_detail_link();
    if (index != kNone) {
      learn_id(detail.at("device").as_int(), index, as_u32(detail.at("address").as_int()));
      boards_[index].hub_name = detail.at("name").as_string();
      setup_message(index);
      after_paired(index);
    }
  } else if (code == "provision_refused" || code == "provision_unsettled" ||
             code == "provision_orphaned" || code == "automatic_add_failed" ||
             code == "usb_unexpected") {
    throw SimulationError("the hub's provisioning failed: " + code + " " + json::write(detail));
  }
}

void RemoteHub::learn_id(std::int64_t id, std::size_t board, std::uint32_t address) {
  if (boards_[board].hub_id.has_value() && *boards_[board].hub_id != id) {
    throw SimulationError(boards_[board].name + " has two device numbers on the hub");
  }
  boards_[board].hub_id = id;
  boards_[board].hub_address = address;
  ids_[id] = board;
}

std::string RemoteHub::name_of_id(const Value& id) const {
  if (id.is_null()) {
    return "";
  }
  const std::size_t index = board_of_id(id.as_int());
  return index == kNone ? "#" + std::to_string(id.as_int()) : boards_[index].name;
}

void RemoteHub::on_rx(const Value& row) {
  HubPacket packet;
  packet.at = sim_.now();
  packet.from = name_of_id(row.at("deviceId"));
  packet.path = path_of(row.at("path").as_int());
  packet.via = name_of_id(row.at("gatewayId"));
  const Value* old_key = row.find("oldKey");
  packet.verdict =
      old_key != nullptr && old_key->as_bool() ? HubVerdict::old_key : HubVerdict::accepted;
  packet.counter = as_u32(row.at("counter").as_int());
  packet.type = as_u8(row.at("type").as_int());
  packet.body = json::from_hex(row.at("body").as_string());
  packet.rssi_dbm = static_cast<std::int16_t>(int_or(row, "rssi"));
  packet.snr_quarter_db = static_cast<std::int8_t>(int_or(row, "snrQ"));
  packet.data_rate = as_u8(int_or(row, "rate"));
  received_.push_back(std::move(packet));
  firmware_actions(row, true);
  // The gateway's forwarded packet that carried it is found by this row (section 6, D110).
  const Value& carrier = row.at("gwCounter");
  if (!carrier.is_null()) {
    HubPacket forwarded;
    forwarded.at = sim_.now();
    forwarded.from = name_of_id(row.at("gatewayId"));
    forwarded.path = HubPath::link;
    forwarded.counter = as_u32(carrier.as_int());
    forwarded.type = protocol::message_type::forwarded_packet;
    received_.push_back(std::move(forwarded));
  }
}

void RemoteHub::on_tx(const Value& row, bool routine) {
  const std::int64_t id = row.at("deviceId").as_int();
  const std::uint32_t counter = as_u32(row.at("counter").as_int());
  const std::int64_t path = row.at("path").as_int();
  const std::int64_t outcome = row.at("outcome").as_int();
  HubSent sent;
  sent.at = sim_.now();
  sent.path = path_of(path);
  sent.via = name_of_id(row.at("gatewayId"));
  sent.counter = counter;
  sent.type = as_u8(row.at("type").as_int());
  sent.data_rate = as_u8(int_or(row, "rate"));
  if (path != kPathLora) {
    // The bytes are the frame this idle carried on the device's link with this counter; it left
    // after the hub's delay.
    const std::size_t to = board_of_id(id);
    for (const auto& frame : link_frames_) {
      if (frame.first != to) {
        continue;
      }
      const auto header =
          protocol::read_header(protocol::ByteView(frame.second.data(), frame.second.size()),
                                protocol::Direction::from_hub, protocol::PacketLimit::link);
      if (header.ok() && header.value().counter == counter) {
        sent.at = sim_.now() + send_delay_;
        sent.packet = frame.second;
        break;
      }
    }
  } else {
    const std::size_t to = board_of_id(id);
    if (to != kNone) {
      const auto found = handovers_.find({boards_[to].hub_address, counter});
      if (found != handovers_.end()) {
        // Handed to the gateway then; the row comes with the gateway's result.
        sent.at = found->second.at;
        sent.packet = found->second.packet;
        handovers_.erase(found);
      }
    }
  }
  sent.to = name_of_id(row.at("deviceId"));
  if (outcome != kHeldBack && outcome != kSendFailed) {
    sent_.push_back(std::move(sent));
  }
  // The gateway's transmit result that reported the outcome is found by this row (D110).
  const Value& result = row.at("resultCounter");
  if (!result.is_null()) {
    HubPacket reported;
    reported.at = sim_.now();
    reported.from = name_of_id(row.at("gatewayId"));
    reported.path = HubPath::link;
    reported.counter = as_u32(result.as_int());
    reported.type = protocol::message_type::transmit_result;
    received_.push_back(std::move(reported));
  }
  firmware_actions(row, false);
  bench_actions(row, routine);
}

void RemoteHub::bench_actions(const Value& row, bool routine) {
  // hub/src/core/model/bench-actions.ts: a LoRa tx row's outcome as the bench's HubActions.
  if (row.at("path").as_int() != kPathLora) {
    return;
  }
  const std::int64_t outcome = row.at("outcome").as_int();
  const std::string device = name_of_id(row.at("deviceId"));
  const bool heartbeat_reply = routine && row.at("type").as_int() == protocol::message_type::reply;
  const auto decide = [&](HubAction action, std::int64_t value) {
    decisions_.push_back(HubDecision{sim_.now(), action, device, value});
  };
  if (heartbeat_reply) {
    decide(HubAction::reply, row.at("counter").as_int());
  }
  if (outcome >= kSent && outcome <= kNotValid) {
    decide(HubAction::transmit_result, outcome);
  }
  if (outcome == kTooLate) {
    decide(HubAction::too_late, 0);
  } else if (heartbeat_reply && outcome != kSent) {
    decide(HubAction::reply_skipped, 0);
  }
}

void RemoteHub::on_decision(const Value& row) {
  const std::optional<HubAction> action = action_named(row.at("kind").as_string());
  if (!action.has_value()) {
    return;
  }
  std::int64_t value = int_or(row, "value");
  if (*action == HubAction::siren_confirmed) {
    // The hub's value is a PacketPath; the bench's a HubPath.
    value = static_cast<std::int64_t>(path_of(value));
  } else if (*action == HubAction::late_report_notification) {
    // The hub's value is the opening's wall time in seconds; the bench's its true time.
    value = (value * 1000 - kWallAtZero) / 1000;
  } else if (*action == HubAction::siren_command || *action == HubAction::move_requested) {
    // The bench's value packs the protocol bytes the hub keeps as the detail: a siren command's
    // action and seconds (action × 65,536 + seconds), a move's channel and rate (× 256 +).
    const Value& raw = row.at("detail");
    const Bytes detail = raw.is_null() ? Bytes{} : json::from_hex(raw.as_string());
    if (*action == HubAction::siren_command && detail.size() == 3) {
      value = detail[0] * 65536 + (detail[1] | (detail[2] << 8));
    } else if (*action == HubAction::move_requested && detail.size() == 2) {
      value = detail[0] * 256 + detail[1];
    } else {
      throw SimulationError("the hub's " + row.at("kind").as_string() +
                            " decision has no protocol detail");
    }
  }
  decisions_.push_back(HubDecision{sim_.now(), *action, name_of_id(row.at("deviceId")), value});
}

void RemoteHub::on_device_log(const Value& row) {
  HubLogEntry entry;
  entry.at = sim_.now();
  entry.from = name_of_id(row.at("deviceId"));
  entry.counter = as_u32(row.at("counter").as_int());
  entry.made_at = true_of_wall(row.at("madeMs").as_int());
  entry.age_tenths = static_cast<std::uint32_t>(
      std::max<std::int64_t>(0, (row.at("atMs").as_int() - row.at("madeMs").as_int()) / 100));
  entry.level = as_u8(row.at("level").as_int());
  entry.code = static_cast<std::uint16_t>(row.at("code").as_int());
  const Bytes text = json::from_hex(row.at("text").as_string());
  entry.text.assign(text.begin(), text.end());
  entry.repeat_of = as_u32(int_or(row, "repeatOf"));
  // The packet that carried it, for its path. A log entries packet has no rx row of its own: its
  // device_log rows are the hub's record of it, so the first stands for the packet received.
  bool carried = false;
  for (auto it = received_.rbegin(); it != received_.rend(); ++it) {
    if (it->from == entry.from && it->counter == entry.counter) {
      entry.path = it->path;
      entry.via = it->via;
      carried = true;
      break;
    }
  }
  if (!carried) {
    HubPacket packet;
    packet.at = entry.at;
    packet.from = entry.from;
    packet.path = HubPath::link;
    packet.counter = entry.counter;
    packet.type = protocol::message_type::log_entries;
    received_.push_back(std::move(packet));
  }
  log_entries_.push_back(std::move(entry));
}

void RemoteHub::on_reject(const Value& row) {
  // Counted per minute, not one row a packet (section 6). A duplicate under a gateway is how its
  // packets with no row are found (D110).
  const std::string& via = row.at("via").as_string();
  const std::string prefix = "device:";
  const std::size_t count = static_cast<std::size_t>(row.at("count").as_int());
  rejects_ += count;
  if (row.at("reason").as_string() != "duplicate" || via.rfind(prefix, 0) != 0) {
    return;
  }
  const std::size_t gateway = board_of_id(std::stoll(via.substr(prefix.size())));
  if (gateway == kNone) {
    return;
  }
  duplicates_[boards_[gateway].name] += count;
  // The sample is the first copy's bytes: which packet the duplicates were of. With one copy
  // counted, the row is that copy's record; with more, they were of packets the row does not name.
  if (count != 1) {
    return;
  }
  // The sample is the packet's start (16 bytes): its clear part names it, the counter after the
  // flags byte and the address (§3).
  const Bytes sample = json::from_hex(row.at("sample").as_string());
  const Value& address = row.at("address");
  if (sample.size() < protocol::kClearSize || address.is_null()) {
    return;
  }
  std::uint32_t counter = 0;
  for (std::size_t i = 0; i < 4; ++i) {
    counter |= static_cast<std::uint32_t>(sample[5 + i]) << (8 * i);
  }
  HubPacket copy;
  copy.at = sim_.now();
  const std::size_t from = board_of_hub_address(as_u32(address.as_int()));
  copy.from = from == kNone ? "" : boards_[from].name;
  copy.path = HubPath::gateway;
  copy.via = boards_[gateway].name;
  copy.verdict = HubVerdict::duplicate;
  copy.counter = counter;
  received_.push_back(std::move(copy));
}

void RemoteHub::on_reply(const lockstep::Reply& reply) {
  const auto found = pending_.find(reply.id);
  if (found == pending_.end()) {
    return;
  }
  const Pending pending = found->second;
  pending_.erase(found);
  if (pending.now) {
    answers_[reply.id] = reply.reply;
    return;
  }
  if (!reply.reply.at("ok").as_bool()) {
    throw SimulationError("the hub refused " + pending.kind + ": " + json::write(reply.reply));
  }
  if (pending.kind == "usbAdd" && pending.board == adding_) {
    adding_ = kNone;
  }
}

// Links.

void RemoteHub::link_up(LinkWire& wire) {
  const std::size_t index = board_of_wire(wire);
  if (index == kNone || wire.link().kind() != device::LinkKind::network) {
    // A USB cable is up while plugged in, whatever the board does; a Bluetooth link is a phone's.
    return;
  }
  Board& board = boards_[index];
  board.hello_seen = false;
  board.session_open = false;
  queue(ToHub::link_up(link_name(board, device::LinkKind::network), "network", micros(sim_.now())));
}

void RemoteHub::link_down(LinkWire& wire) {
  const std::size_t index = board_of_wire(wire);
  if (index == kNone || wire.link().kind() != device::LinkKind::network) {
    return;
  }
  Board& board = boards_[index];
  board.hello_seen = false;
  board.session_open = false;
  queue(ToHub::link_down(link_name(board, device::LinkKind::network), micros(sim_.now())));
}

void RemoteHub::link_packet(LinkWire& wire, const Bytes& packet) {
  const std::size_t index = board_of_wire(wire);
  if (index == kNone || !up_) {
    return;
  }
  tap_from_device(index, packet);
  queue(ToHub::frame(link_name(boards_[index], wire.link().kind()), micros(sim_.now()), packet));
}

// Lookups.

std::size_t RemoteHub::board_named(const std::string& name) const {
  for (std::size_t i = 0; i < boards_.size(); ++i) {
    if (boards_[i].name == name) {
      return i;
    }
  }
  throw SimulationError("the hub has no device named " + name);
}

std::size_t RemoteHub::board_of_link(const std::string& link, device::LinkKind* kind) const {
  for (std::size_t i = 0; i < boards_.size(); ++i) {
    for (const device::LinkKind k :
         {device::LinkKind::usb, device::LinkKind::network, device::LinkKind::bluetooth}) {
      if (link_name(boards_[i], k) == link) {
        if (kind != nullptr) {
          *kind = k;
        }
        return i;
      }
    }
  }
  return kNone;
}

std::size_t RemoteHub::board_of_wire(const LinkWire& wire) const {
  for (std::size_t i = 0; i < boards_.size(); ++i) {
    if (&boards_[i].device->wire(device::LinkKind::usb) == &wire ||
        &boards_[i].device->wire(device::LinkKind::network) == &wire ||
        &boards_[i].device->wire(device::LinkKind::bluetooth) == &wire) {
      return i;
    }
  }
  return kNone;
}

std::size_t RemoteHub::board_of_address(std::uint32_t address) const {
  for (std::size_t i = 0; i < boards_.size(); ++i) {
    if (boards_[i].keyed && boards_[i].address == address) {
      return i;
    }
  }
  return kNone;
}

std::size_t RemoteHub::board_of_hub_address(std::uint32_t address) const {
  for (std::size_t i = 0; i < boards_.size(); ++i) {
    if (boards_[i].hub_id.has_value() && boards_[i].hub_address == address) {
      return i;
    }
  }
  return kNone;
}

std::size_t RemoteHub::board_of_id(std::int64_t id) const {
  const auto found = ids_.find(id);
  return found == ids_.end() ? kNone : found->second;
}

// Questions.

std::vector<HubPacket> RemoteHub::received_from(const std::string& name, std::uint8_t type) const {
  std::vector<HubPacket> found;
  for (const HubPacket& packet : received_) {
    const bool setup_message = packet.type == 0 && packet.counter == 0;
    if (packet.verdict == HubVerdict::accepted && packet.from == name && !setup_message &&
        (type == 0 || packet.type == type)) {
      found.push_back(packet);
    }
  }
  return found;
}

std::vector<HubSent> RemoteHub::sent_to(const std::string& name, std::uint8_t type) const {
  std::vector<HubSent> found;
  for (const HubSent& packet : sent_) {
    if (packet.to == name && (type == 0 || packet.type == type)) {
      found.push_back(packet);
    }
  }
  // A LoRa packet's row comes with its outcome: in hand-over order, as the test hub keeps them.
  std::stable_sort(found.begin(), found.end(),
                   [](const HubSent& a, const HubSent& b) { return a.at < b.at; });
  return found;
}

std::vector<HubDecision> RemoteHub::decisions(HubAction action, const std::string& device) const {
  std::vector<HubDecision> found;
  for (const HubDecision& decision : decisions_) {
    if (decision.action == action && (device.empty() || decision.device == device)) {
      found.push_back(decision);
    }
  }
  return found;
}

std::vector<HubLogEntry> RemoteHub::log_entries_from(const std::string& name) const {
  std::vector<HubLogEntry> found;
  for (const HubLogEntry& entry : log_entries_) {
    if (entry.from == name) {
      found.push_back(entry);
    }
  }
  return found;
}

std::string RemoteHub::dump() const {
  std::vector<std::pair<device::Instant, std::string>> lines;
  for (const HubPacket& packet : received_) {
    std::ostringstream line;
    line << "received " << (packet.from.empty() ? "?" : packet.from) << " "
         << (packet.counter == 0 && packet.type == 0 ? std::string("setup message")
                                                     : message_type_name(packet.type))
         << " #" << packet.counter << " " << hub_verdict_name(packet.verdict) << " by "
         << path_text(packet.path) << (packet.via.empty() ? "" : " via " + packet.via);
    lines.emplace_back(packet.at, line.str());
  }
  for (const HubLogEntry& entry : log_entries_) {
    std::ostringstream line;
    line << "logged " << entry.from << " level " << static_cast<int>(entry.level) << " code 0x"
         << std::hex << std::setw(4) << std::setfill('0') << entry.code << std::dec << " \""
         << entry.text << "\" made " << format_instant(entry.made_at) << " #" << entry.counter;
    lines.emplace_back(entry.at, line.str());
  }
  for (const HubSent& packet : sent_) {
    std::ostringstream line;
    line << "sent " << packet.to << " " << message_type_name(packet.type) << " #" << packet.counter
         << " by " << path_text(packet.path) << (packet.via.empty() ? "" : " via " + packet.via);
    lines.emplace_back(packet.at, line.str());
  }
  for (const HubDecision& decision : decisions_) {
    std::ostringstream line;
    line << "decided " << hub_action_name(decision.action) << " "
         << (decision.device.empty() ? "-" : decision.device) << " " << decision.value;
    lines.emplace_back(decision.at, line.str());
  }
  for (const auto& record : records_) {
    const std::string& kind = record.second.at("kind").as_string();
    const Value& row = record.second.at("row");
    if (kind == "hubEvent") {
      lines.emplace_back(record.first, "event " + row.at("level").as_string() + " " +
                                           row.at("code").as_string() + ": " +
                                           row.at("message").as_string());
    } else if (kind == "command") {
      lines.emplace_back(record.first, "command " + row.at("kind").as_string() + " " +
                                           row.at("args").as_string() + " " +
                                           row.at("outcome").as_string());
    } else if (kind == "decision" && !action_named(row.at("kind").as_string()).has_value()) {
      lines.emplace_back(record.first, "decided " + row.at("kind").as_string() + " " +
                                           name_of_id(row.at("deviceId")));
    }
  }
  for (const auto& close : closes_) {
    lines.emplace_back(close.first, "closed " + close.second);
  }
  std::stable_sort(lines.begin(), lines.end(),
                   [](const auto& a, const auto& b) { return a.first < b.first; });
  std::string text =
      "real hub, boot " + std::to_string(boot_) + ", " + std::to_string(steps_) + " steps\n";
  for (const auto& line : lines) {
    text += format_instant(line.first) + "  " + line.second + "\n";
  }
  return text;
}

}  // namespace hsn::host
