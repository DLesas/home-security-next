// The key change after a restore on whole devices (m3-updates-design.md section 7): a sensor, a
// siren and a gateway, each a small test role that opens a Key change under its own receiving rule,
// calls the real SecureChannel::change_key and reports again, against the test hub's restore. Each
// scenario also runs once per flash operation with the power cut there (power_cut_harness.hpp),
// during it and after it; every run must end with the device heard under its new key, its hub
// switched, no counter carrying two packets under one key, and nothing under the old key once the
// new one is in flash. A recorded old-key packet replayed after the change is refused by both ends.
// The roles' own step 4 (report_again) is U4's, U5's and U6's; these roles stand in for it.

#include <doctest/doctest.h>

#include <array>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "hsn/device/services/radio_plan.hpp"
#include "hsn/host/power_cut_harness.hpp"
#include "hsn/host/replay_radio.hpp"
#include "hsn/host/role_box.hpp"
#include "hsn/host/test_hub.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using device::Instant;
using device::seconds;
using host::at;
using host::CutRun;
using host::HubAction;
using host::HubVerdict;

/** What a test role saw, kept by the test across every boot. */
struct RekeyLog {
  struct Change {
    Instant at;
    device::Status status = device::Status::ok;
  };
  std::vector<Change> changes;
  std::size_t reports_again = 0;
  /** Packets for this device that failed their tag. */
  std::size_t refused = 0;
  std::size_t replies = 0;
  std::size_t commands = 0;
  std::size_t welcomes = 0;
};

/** Opens a Key change's body and changes the key, noting the outcome. */
void change_key(device::Services& services, RekeyLog& log, protocol::ByteView body, Instant now) {
  protocol::KeyChange change;
  REQUIRE(protocol::decode_body(body, change) == protocol::Error::none);
  log.changes.push_back(RekeyLog::Change{now, services.channel.change_key(change.new_key, now)});
}

/** Counts a packet addressed to this device that failed its tag. */
void note_refusal(device::Services& services, RekeyLog& log, protocol::ByteView packet,
                  const device::Status status, protocol::Error detail,
                  protocol::PacketLimit limit) {
  const auto header = protocol::read_header(packet, protocol::Direction::from_hub, limit);
  if (status == device::Status::protocol_error && detail == protocol::Error::bad_tag &&
      header.ok() && header.value().address == services.channel.address()) {
    log.refused += 1;
  }
}

// ---- A sensor: a reply-wanted heartbeat every 10 s, then 2.5 s of listening ----

class RekeySensor final : public device::Role {
public:
  RekeySensor(device::Services& services, RekeyLog& log) : services_(services), log_(log) {}

  std::uint8_t role_id() const override {
    return protocol::Role::sensor;
  }

  void handle(const device::Event& event) override {
    const Instant now = event.now;
    if (event.kind == device::EventKind::boot) {
      next_at_ = now + seconds(1);
    } else if (event.kind == device::EventKind::radio) {
      const device::PortReport report = services_.radio_port.on_radio(event.radio, now);
      if (report.result == device::PortResult::sent) {
        listen_until_ = report.at + device::milliseconds(2500);
        listen(now);
      } else if (report.result == device::PortResult::received) {
        on_packet(event.radio.packet, now);
        listen(now);
      }
    }
    if (services_.radio_port.next_deadline() <= now) {
      static_cast<void>(services_.radio_port.on_timer(now));
    }
    if (next_at_ <= now && services_.radio_port.state() == device::PortState::idle) {
      next_at_ = now + seconds(10);
      send(now);
    }
  }

  void report_again(Instant now) override {
    log_.reports_again += 1;
    send(now);
  }

  device::Wake next_wake() const override {
    device::Wake wake;
    wake.at = device::earliest(next_at_, services_.radio_port.next_deadline());
    wake.deepest = device::SleepDepth::light;
    return wake;
  }
  protocol::MutableByteView state_bytes() override {
    return protocol::MutableByteView(state_);
  }
  std::uint8_t state_layout() const override {
    return 1;
  }
  std::uint8_t state_id() const override {
    return 1;
  }
  device::Duration longest_awake() const override {
    return device::Duration{};
  }

private:
  void send(Instant now) {
    protocol::Heartbeat heartbeat;
    heartbeat.flags.reply_wanted = true;
    heartbeat.flags.listening_at_send_rate = true;
    const auto sealed =
        services_.channel.seal(heartbeat, protocol::Binding::none(), protocol::PacketLimit::radio,
                               protocol::MutableByteView(packet_));
    if (!sealed.ok()) {
      return;
    }
    // Newest first: the hub's answer is bound to one of these.
    for (std::size_t i = tries_.size() - 1; i > 0; --i) {
      tries_[i] = tries_[i - 1];
    }
    tries_[0] = sealed.value().counter;
    count_ = count_ < tries_.size() ? count_ + 1 : count_;
    device::Transmission transmission;
    transmission.channel.frequency_hz =
        device::site_channel_frequency(services_.setup.pairing().site_channel).value_or(868300000u);
    transmission.channel.data_rate = protocol::DataRate::dr5;
    transmission.tx_class = device::TxClass::essential;
    static_cast<void>(services_.radio_port.send(
        protocol::ByteView(packet_).first(sealed.value().size), transmission, now));
  }

  void listen(Instant now) {
    if (listen_until_ <= now || services_.radio_port.state() != device::PortState::idle) {
      return;
    }
    device::RxParams params;
    params.channel.frequency_hz = device::kReplyFrequencyHz;
    params.channel.data_rate = protocol::DataRate::dr5;
    params.timeout = listen_until_ - now;
    static_cast<void>(services_.radio_port.listen(params, now));
  }

  void on_packet(protocol::ByteView packet, Instant now) {
    const auto opened = services_.channel.open_bound(
        packet, protocol::Span<const std::uint32_t>(tries_.data(), count_));
    if (!opened.ok()) {
      note_refusal(services_, log_, packet, opened.status(), opened.detail(),
                   protocol::PacketLimit::radio);
      return;
    }
    if (opened.value().packet.type == protocol::message_type::reply) {
      log_.replies += 1;
    } else if (opened.value().packet.type == protocol::message_type::key_change) {
      change_key(services_, log_, opened.value().packet.body, now);
    }
  }

  device::Services& services_;
  RekeyLog& log_;
  Instant next_at_ = Instant::never();
  Instant listen_until_;
  std::array<std::uint32_t, device::kMaxBoundCandidates> tries_{};
  std::size_t count_ = 0;
  std::array<std::uint8_t, 64> packet_{};
  std::array<std::uint8_t, 4> state_{};
};

static_assert(device::is_complete_role<RekeySensor>, "a role must override every Role method");

// ---- A siren: Wi-Fi reports every 5 s, commands on both paths ----

class RekeySiren final : public device::Role {
public:
  RekeySiren(device::Services& services, host::FakeSirenIo& io, RekeyLog& log)
      : services_(services), io_(io), log_(log) {}

  std::uint8_t role_id() const override {
    return protocol::Role::siren;
  }

  void handle(const device::Event& event) override {
    const Instant now = event.now;
    device::Link* network = services_.hal.network;
    switch (event.kind) {
      case device::EventKind::boot:
        connect_at_ = now;
        listen(now);
        break;
      case device::EventKind::link:
        if (event.link.kind == device::LinkEventKind::packet) {
          on_command(event.link.packet, protocol::PacketLimit::link, now);
        } else if (event.link.kind == device::LinkEventKind::up) {
          up_ = true;
          report_at_ = now;
        } else {
          up_ = false;
          connect_at_ = now + seconds(1);
        }
        break;
      case device::EventKind::radio: {
        const device::PortReport report = services_.radio_port.on_radio(event.radio, now);
        if (report.result == device::PortResult::received) {
          on_command(event.radio.packet, protocol::PacketLimit::radio, now);
        }
        listen(now);
        break;
      }
      default:
        break;
    }
    if (services_.radio_port.next_deadline() <= now) {
      static_cast<void>(services_.radio_port.on_timer(now));
      listen(now);
    }
    if (connect_at_ <= now && network != nullptr) {
      connect_at_ = Instant::never();
      static_cast<void>(network->connect(services_.setup.pairing().link_target()));
    }
    if (report_at_ <= now) {
      report_at_ = now + seconds(5);
      report(protocol::SirenReportReason::regular, now);
    }
    if (output_until_ <= now) {
      output_until_ = Instant::never();
      io_.output(false);
    }
  }

  void report_again(Instant now) override {
    log_.reports_again += 1;
    report(protocol::SirenReportReason::command_answer, now);
  }

  device::Wake next_wake() const override {
    device::Wake wake;
    wake.at =
        device::earliest(device::earliest(device::earliest(connect_at_, report_at_), output_until_),
                         services_.radio_port.next_deadline());
    wake.deepest = device::SleepDepth::awake;
    return wake;
  }
  protocol::MutableByteView state_bytes() override {
    return protocol::MutableByteView(state_);
  }
  std::uint8_t state_layout() const override {
    return 1;
  }
  std::uint8_t state_id() const override {
    return 1;
  }
  device::Duration longest_awake() const override {
    return device::Duration{};
  }

private:
  void listen(Instant now) {
    if (services_.radio_port.state() != device::PortState::idle) {
      return;
    }
    device::RxParams params;
    params.channel.frequency_hz = device::kReplyFrequencyHz;
    params.channel.data_rate = protocol::DataRate::dr5;
    static_cast<void>(services_.radio_port.listen(params, now));
  }

  void on_command(protocol::ByteView packet, protocol::PacketLimit limit, Instant now) {
    const auto opened = services_.channel.open_command(packet, limit);
    if (!opened.ok()) {
      note_refusal(services_, log_, packet, opened.status(), opened.detail(), limit);
      return;
    }
    const device::CommandOpen& command = opened.value();
    if (command.verdict == device::CommandVerdict::too_old) {
      return;
    }
    if (command.verdict == device::CommandVerdict::new_command) {
      if (command.packet.type == protocol::message_type::key_change) {
        // The answer is the report Device asks for once the key has changed.
        change_key(services_, log_, command.packet.body, now);
        return;
      }
      if (command.packet.type == protocol::message_type::siren_command) {
        protocol::SirenCommand body;
        REQUIRE(protocol::decode_body(command.packet.body, body) == protocol::Error::none);
        log_.commands += 1;
        if (body.action == protocol::SirenAction::test ||
            body.action == protocol::SirenAction::sound_alarm) {
          io_.output(true);
          output_until_ = now + seconds(body.sound_seconds);
        } else if (body.action == protocol::SirenAction::off) {
          io_.output(false);
          output_until_ = Instant::never();
        }
      } else if (command.packet.type == protocol::message_type::siren_settings) {
        protocol::SirenSettings settings;
        REQUIRE(protocol::decode_body(command.packet.body, settings) == protocol::Error::none);
        settings_version_ = settings.settings_version;
      }
    }
    report(protocol::SirenReportReason::command_answer, now);
  }

  void report(std::uint8_t reason, Instant now) {
    static_cast<void>(now);
    device::Link* network = services_.hal.network;
    if (!up_ || network == nullptr) {
      return;
    }
    protocol::SirenReport body;
    body.settings_version = settings_version_;
    body.state = io_.output_on() ? protocol::SirenState::testing : protocol::SirenState::off;
    body.last_command_counter_low =
        static_cast<std::uint16_t>(services_.channel.last_command() & 0xFFFFu);
    body.reason = reason;
    const auto sealed =
        services_.channel.seal(body, protocol::Binding::none(), protocol::PacketLimit::link,
                               protocol::MutableByteView(packet_));
    if (sealed.ok()) {
      static_cast<void>(network->send(protocol::ByteView(packet_).first(sealed.value().size)));
    }
  }

  device::Services& services_;
  host::FakeSirenIo& io_;
  RekeyLog& log_;
  bool up_ = false;
  std::uint8_t settings_version_ = 0;
  Instant connect_at_ = Instant::never();
  Instant report_at_ = Instant::never();
  Instant output_until_ = Instant::never();
  std::array<std::uint8_t, 64> packet_{};
  std::array<std::uint8_t, 4> state_{};
};

static_assert(device::is_complete_role<RekeySiren>, "a role must override every Role method");

// ---- A gateway: a hello on every connection, nothing forwarded ----

class RekeyGateway final : public device::Role {
public:
  RekeyGateway(device::Services& services, RekeyLog& log) : services_(services), log_(log) {}

  std::uint8_t role_id() const override {
    return protocol::Role::gateway;
  }

  void handle(const device::Event& event) override {
    const Instant now = event.now;
    if (event.kind == device::EventKind::boot) {
      connect_at_ = now;
    } else if (event.kind == device::EventKind::link) {
      if (event.link.kind == device::LinkEventKind::up) {
        up_ = true;
        hello(now);
      } else if (event.link.kind == device::LinkEventKind::down) {
        dropped(now);
      } else {
        on_packet(event.link.packet, now);
      }
    }
    device::Link* network = services_.hal.network;
    if (welcome_by_ <= now && network != nullptr) {
      // No welcome: the gateway's welcome timeout, then a new connection.
      network->disconnect();
      dropped(now);
    }
    if (connect_at_ <= now && network != nullptr) {
      connect_at_ = Instant::never();
      static_cast<void>(network->connect(services_.setup.pairing().link_target()));
    }
  }

  void report_again(Instant now) override {
    log_.reports_again += 1;
    hello(now);
  }

  device::Wake next_wake() const override {
    device::Wake wake;
    wake.at = device::earliest(connect_at_, welcome_by_);
    wake.deepest = device::SleepDepth::awake;
    return wake;
  }
  protocol::MutableByteView state_bytes() override {
    return protocol::MutableByteView(state_);
  }
  std::uint8_t state_layout() const override {
    return 1;
  }
  std::uint8_t state_id() const override {
    return 1;
  }
  device::Duration longest_awake() const override {
    return device::Duration{};
  }

private:
  void dropped(Instant now) {
    up_ = false;
    session_ = device::SessionState{};
    welcome_by_ = Instant::never();
    connect_at_ = now + seconds(1);
  }

  void hello(Instant now) {
    device::Link* network = services_.hal.network;
    if (!up_ || network == nullptr) {
      return;
    }
    welcome_by_ = now + seconds(5);
    protocol::RandomValue random{};
    services_.random.fill(protocol::MutableByteView(random));
    session_.begin(random);
    protocol::Hello hello;
    hello.gateway_random = random;
    hello.firmware_version = services_.hal.build.version;
    const auto sealed =
        services_.channel.seal(hello, protocol::Binding::none(), protocol::PacketLimit::link,
                               protocol::MutableByteView(packet_));
    if (sealed.ok()) {
      static_cast<void>(network->send(protocol::ByteView(packet_).first(sealed.value().size)));
    }
  }

  void on_packet(protocol::ByteView packet, Instant now) {
    const bool was_welcomed = session_.welcomed;
    const auto opened = services_.channel.open_session(packet, session_);
    if (!opened.ok()) {
      note_refusal(services_, log_, packet, opened.status(), opened.detail(),
                   protocol::PacketLimit::link);
      return;
    }
    if (opened.value().type == protocol::message_type::key_change) {
      change_key(services_, log_, opened.value().body, now);
    } else if (!was_welcomed && session_.welcomed) {
      log_.welcomes += 1;
      welcome_by_ = Instant::never();
    }
  }

  device::Services& services_;
  RekeyLog& log_;
  bool up_ = false;
  device::SessionState session_;
  Instant connect_at_ = Instant::never();
  Instant welcome_by_ = Instant::never();
  std::array<std::uint8_t, 64> packet_{};
  std::array<std::uint8_t, 4> state_{};
};

static_assert(device::is_complete_role<RekeyGateway>, "a role must override every Role method");

// ---- What every run must show ----

/**
 * The true instant the new key reached flash: the first whole pairing write after `after` (the
 * timeline's, since a power loss restarts the board's own clock).
 */
std::optional<Instant> key_written_at(host::SimDevice& device, Instant after) {
  for (const host::Record& record :
       device.records().kind(host::RecordKind::flash_write).records()) {
    if (record.value == static_cast<std::uint32_t>(device::StoreKey::pairing) && !record.flag &&
        record.at > after) {
      return record.at;
    }
  }
  return std::nullopt;
}

/**
 * The device's packets as the hub had them, split by the key they were under: the old one before
 * the hub's switch (and every old_key verdict), the new one after it. Under each key no counter
 * carries two different packets; under the new key every counter is at least one step; no packet
 * fails its tag; and once the new key was in flash, nothing came under the old key.
 */
void check_counters(const host::TestHub& hub, host::SimDevice& device, const std::string& name,
                    std::uint32_t step) {
  const auto switches = hub.decisions(HubAction::key_changed, name);
  REQUIRE(switches.size() == 1);
  const Instant switched = switches[0].at;
  const auto sent = hub.decisions(HubAction::key_change_sent, name);
  REQUIRE_FALSE(sent.empty());
  const Instant first_sent = sent.front().at;
  const std::optional<Instant> written = key_written_at(device, first_sent);
  REQUIRE(written.has_value());
  std::map<std::uint32_t, Bytes> old_key;
  std::map<std::uint32_t, Bytes> new_key;
  std::size_t under_new = 0;
  for (const host::HubPacket& packet : hub.received()) {
    if (packet.from != name) {
      continue;
    }
    CAPTURE(packet.counter);
    CHECK(packet.verdict != HubVerdict::bad_tag);
    if (packet.body.empty()) {
      continue;
    }
    const bool old = packet.verdict == HubVerdict::old_key || packet.at < switched;
    if (old && packet.at > first_sent) {
      // After the first Key change, the old key only until the new one is in flash.
      CHECK(packet.at <= *written);
    }
    if (!old) {
      CHECK(packet.counter >= step);
      under_new += 1;
    }
    auto& seen = old ? old_key : new_key;
    const auto found = seen.find(packet.counter);
    if (found == seen.end()) {
      seen.emplace(packet.counter, packet.body);
    } else {
      CHECK(found->second == packet.body);
    }
  }
  CHECK(under_new > 0);
}

/** The device is heard and acted on in the last `window` of the run. */
bool heard_lately(const host::TestHub& hub, const std::string& name, Instant end,
                  device::Duration window) {
  for (const host::HubPacket& packet : hub.received_from(name)) {
    if (packet.at + window > end && packet.verdict == HubVerdict::accepted) {
      return true;
    }
  }
  return false;
}

// ---- The sensor ----

struct SensorWorld {
  SensorWorld() : hub(sim), radio(sim) {
    sim.medium().keep_transmissions(true);
    host::DeviceSpec spec;
    spec.name = "door";
    spec.role = [this](device::Services& services, host::HostBoard&) {
      return host::box_role<RekeySensor>(services, log);
    };
    device = &sim.add_device(spec);
    hub.add_sensor(*device);
    sim.schedule(at(seconds(25)), [this]() { backup = hub.snapshot(); });
    sim.schedule(at(seconds(27)), [this]() { hub.restore(backup); });
  }
  host::Simulation sim;
  host::TestHub hub;
  host::ReplayRadio radio;
  RekeyLog log;
  host::SimDevice* device = nullptr;
  host::HubSnapshot backup;
};

constexpr Instant kSensorEnd = at(seconds(120));

void check_sensor(SensorWorld& world, const CutRun& run) {
  INFO(run.describe() << "\n" << world.hub.dump());
  CHECK_FALSE(world.hub.rekey_pending("door"));
  CHECK(heard_lately(world.hub, "door", kSensorEnd, seconds(25)));
  check_counters(world.hub, *world.device, "door", 64);
  CHECK(world.log.replies > 0);
  if (run.uncut()) {
    REQUIRE(world.log.changes.size() == 1);
    CHECK(world.log.changes[0].status == device::Status::ok);
    CHECK(world.log.reports_again == 1);
    CHECK(world.hub.decisions(HubAction::key_change_sent, "door").size() == 1);
  }
}

TEST_CASE("a sensor changes its key at the hub's Key change, reports again, and is switched") {
  SensorWorld world;
  world.sim.run_until(kSensorEnd);
  check_sensor(world, CutRun{});
  // Its first packet under the new key went out at once, counting from one step.
  const auto switched = world.hub.decisions(HubAction::key_changed, "door");
  REQUIRE(switched.size() == 1);
  CHECK(switched[0].at - world.log.changes[0].at < seconds(1));
  const auto accepted = world.hub.received_from("door");
  bool first_new = false;
  for (const host::HubPacket& packet : accepted) {
    if (packet.at >= switched[0].at && !first_new) {
      first_new = true;
      CHECK(packet.counter == 64);
    }
  }
  CHECK(first_new);
}

TEST_CASE("a sensor's key change with the power cut at every flash operation") {
  host::CutScenario<SensorWorld> scenario;
  scenario.make = []() { return std::make_unique<SensorWorld>(); };
  scenario.simulation = [](SensorWorld& world) -> host::Simulation& { return world.sim; };
  scenario.run = [](SensorWorld& world) { world.sim.run_until(kSensorEnd); };
  scenario.check = check_sensor;
  const host::CutReport report = host::run_power_cuts(scenario);
  MESSAGE("door: flash operations " << report.operations.at("door") << ", runs " << report.runs);
  // The resume points before the restore, the pairing record, the resume point, and the next.
  CHECK(report.operations.at("door") >= 3);
  CHECK(report.runs == 1 + 2 * report.operations.at("door"));
}

TEST_CASE("after a sensor's key change, recorded old-key packets are refused at both ends") {
  SensorWorld world;
  world.sim.run_until(at(seconds(40)));
  REQUIRE(world.log.changes.size() == 1);
  const auto changes = world.hub.sent_to("door", protocol::message_type::key_change);
  REQUIRE(changes.size() == 1);
  // The device's own heartbeat under the old key, as recorded off the air before the change.
  std::uint64_t recorded = 0;
  for (const host::Record& record : world.device->records()
                                        .kind(host::RecordKind::transmission)
                                        .between(at(seconds(29)), world.log.changes[0].at)
                                        .records()) {
    recorded = record.transmission;
  }
  REQUIRE(recorded != 0);
  // The heartbeat at 41 s opens a listening window to 43.6 s: the hub's old Key change, replayed
  // inside it, fails its tag, and the key does not change again.
  world.sim.schedule(at(seconds(42) + device::milliseconds(600)), [&]() {
    world.radio.send(changes[0].packet, device::RadioChannel{device::kReplyFrequencyHz, 5});
  });
  world.sim.schedule(at(seconds(50)), [&]() { world.radio.replay(recorded); });
  world.sim.run_until(at(seconds(60)));
  INFO(world.hub.dump());
  CHECK(world.log.refused == 1);
  CHECK(world.log.changes.size() == 1);
  // At the hub, switched, the old-key heartbeat is a stranger's: a bad tag, never answered.
  std::size_t bad = 0;
  for (const host::HubPacket& packet : world.hub.received()) {
    bad += packet.from == "door" && packet.verdict == HubVerdict::bad_tag ? 1 : 0;
  }
  CHECK(bad == 1);
  CHECK(world.hub.sent_to("door", protocol::message_type::key_change).size() == 1);
}

// ---- The siren ----

struct SirenWorld {
  SirenWorld() : hub(sim), radio(sim) {
    sim.medium().keep_transmissions(true);
    host::DeviceSpec spec;
    spec.name = "siren";
    spec.role = [this](device::Services& services, host::HostBoard& board) {
      return host::box_role<RekeySiren>(services, board.siren_io, log);
    };
    device = &sim.add_device(spec);
    hub.add_siren(*device);
    sim.schedule(at(seconds(5)),
                 [this]() { hub.command_siren("siren", protocol::SirenAction::test, 2); });
    sim.schedule(at(seconds(20)), [this]() { backup = hub.snapshot(); });
    sim.schedule(at(seconds(22)), [this]() { hub.restore(backup); });
    sim.schedule(at(seconds(60)),
                 [this]() { hub.command_siren("siren", protocol::SirenAction::test, 2); });
  }
  host::Simulation sim;
  host::TestHub hub;
  host::ReplayRadio radio;
  RekeyLog log;
  host::SimDevice* device = nullptr;
  host::HubSnapshot backup;
};

constexpr Instant kSirenEnd = at(seconds(90));

void check_siren(SirenWorld& world, const CutRun& run) {
  INFO(run.describe() << "\n" << world.hub.dump());
  CHECK_FALSE(world.hub.rekey_pending("siren"));
  CHECK(heard_lately(world.hub, "siren", kSirenEnd, seconds(10)));
  check_counters(world.hub, *world.device, "siren", 1024);
  // Its command counter restarted with the key: the hub's command at 60 s, under the new key
  // from a low counter, is acted on and confirmed.
  bool confirmed_late = false;
  for (const host::HubDecision& decision :
       world.hub.decisions(HubAction::siren_confirmed, "siren")) {
    confirmed_late = confirmed_late || decision.at > at(seconds(60));
  }
  CHECK(confirmed_late);
  if (run.uncut()) {
    REQUIRE(world.log.changes.size() == 1);
    CHECK(world.log.changes[0].status == device::Status::ok);
    CHECK(world.log.reports_again == 1);
    CHECK(world.log.commands == 2);
  }
}

TEST_CASE("a siren changes its key at the restored hub's start, and its commands go on") {
  SirenWorld world;
  world.sim.run_until(kSirenEnd);
  check_siren(world, CutRun{});
  // The copy on the other path came after the change: under the old key, refused.
  CHECK(world.log.refused >= 1);
}

TEST_CASE("a siren's key change with the power cut at every flash operation") {
  host::CutScenario<SirenWorld> scenario;
  scenario.make = []() { return std::make_unique<SirenWorld>(); };
  scenario.simulation = [](SirenWorld& world) -> host::Simulation& { return world.sim; };
  scenario.run = [](SirenWorld& world) { world.sim.run_until(kSirenEnd); };
  scenario.check = check_siren;
  const host::CutReport report = host::run_power_cuts(scenario);
  MESSAGE("siren: flash operations " << report.operations.at("siren") << ", runs " << report.runs);
  CHECK(report.runs == 1 + 2 * report.operations.at("siren"));
  // Command counters, the Key change's, the pairing record, the resume points.
  CHECK(report.operations.at("siren") >= 5);
}

TEST_CASE("after a siren's key change, a recorded old-key command replayed on the air is refused") {
  SirenWorld world;
  world.sim.run_until(at(seconds(30)));
  REQUIRE(world.log.changes.size() == 1);
  const auto commands = world.hub.sent_to("siren", protocol::message_type::siren_command);
  REQUIRE_FALSE(commands.empty());
  const std::size_t acted = world.log.commands;
  const std::size_t refused = world.log.refused;
  world.sim.schedule(at(seconds(31)), [&]() {
    world.radio.send(commands.front().packet,
                     device::RadioChannel{device::kReplyFrequencyHz, protocol::DataRate::dr5});
  });
  world.sim.run_until(at(seconds(35)));
  CHECK(world.log.commands == acted);
  CHECK(world.log.refused == refused + 1);
  CHECK_FALSE(world.device->board().siren_io.output_on());
}

// ---- The gateway ----

struct GatewayWorld {
  GatewayWorld() : hub(sim, gateway_options()) {
    host::DeviceSpec spec;
    spec.name = "gateway";
    spec.role = [this](device::Services& services, host::HostBoard&) {
      return host::box_role<RekeyGateway>(services, log);
    };
    device = &sim.add_device(spec);
    hub.add_gateway(*device);
    sim.schedule(at(seconds(10)), [this]() { backup = hub.snapshot(); });
    sim.schedule(at(seconds(12)), [this]() { hub.restore(backup); });
  }
  static host::HubOptions gateway_options() {
    host::HubOptions options;
    options.mode = host::HubMode::gateway_link;
    return options;
  }
  host::Simulation sim;
  host::TestHub hub;
  RekeyLog log;
  host::SimDevice* device = nullptr;
  host::HubSnapshot backup;
};

constexpr Instant kGatewayEnd = at(seconds(60));

void check_gateway(GatewayWorld& world, const CutRun& run) {
  INFO(run.describe() << "\n" << world.hub.dump());
  CHECK_FALSE(world.hub.rekey_pending("gateway"));
  check_counters(world.hub, *world.device, "gateway", 1024);
  const auto switched = world.hub.decisions(HubAction::key_changed, "gateway");
  REQUIRE(switched.size() == 1);
  // Welcomed under the new key, after the switch.
  bool welcomed_after = false;
  for (const host::HubDecision& decision :
       world.hub.decisions(HubAction::gateway_welcomed, "gateway")) {
    welcomed_after = welcomed_after || decision.at >= switched[0].at;
  }
  CHECK(welcomed_after);
  if (run.uncut()) {
    REQUIRE(world.log.changes.size() == 1);
    CHECK(world.log.changes[0].status == device::Status::ok);
    CHECK(world.log.reports_again == 1);
    CHECK(world.log.welcomes == 2);
  }
}

TEST_CASE("a gateway changes its key in place of the welcome and says hello again") {
  GatewayWorld world;
  world.sim.run_until(kGatewayEnd);
  check_gateway(world, CutRun{});
}

TEST_CASE("a gateway's key change with the power cut at every flash operation") {
  host::CutScenario<GatewayWorld> scenario;
  scenario.make = []() { return std::make_unique<GatewayWorld>(); };
  scenario.simulation = [](GatewayWorld& world) -> host::Simulation& { return world.sim; };
  scenario.run = [](GatewayWorld& world) { world.sim.run_until(kGatewayEnd); };
  scenario.check = check_gateway;
  const host::CutReport report = host::run_power_cuts(scenario);
  MESSAGE("gateway: flash operations " << report.operations.at("gateway") << ", runs "
                                       << report.runs);
  CHECK(report.runs == 1 + 2 * report.operations.at("gateway"));
  // The pairing record, the resume point, and the next.
  CHECK(report.operations.at("gateway") >= 3);
}

}  // namespace
}  // namespace hsn::test
