// Whole-device update scenarios on the simulated radio (m3-updates-design.md section 8, "On the
// host simulator"): a board running the real UpdateService (core/src/device/update*.cpp, engineer
// U1) behind a small test role that speaks a sensor's update part, against the test hub, with the
// fake slots and bootloader, the PSA crypto, the power-cut harness and ScriptPhone.
//
// The role here is not the sensor role (engineer U4): it sends Started (again until answered),
// the update queries and statuses UpdateService asks for (a LoRa one counted as sent once it is on
// the air, so "installing" goes before its restart), opens the hub's replies and offers, passes
// its network link's up and down to UpdateService (Device passes only Bluetooth's), and reports
// its door.

#include <doctest/doctest.h>

#include <array>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "hsn/device/hal/sensor_io.hpp"
#include "hsn/device/role.hpp"
#include "hsn/device/services.hpp"
#include "hsn/device/services/radio_plan.hpp"
#include "hsn/host/power_cut_harness.hpp"
#include "hsn/host/script_phone.hpp"
#include "hsn/host/test_hub.hpp"
#include "hsn/host/test_image.hpp"
#include "sim_support.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using host::HubAction;
using host::RecordKind;
using host::UpdateState;

const protocol::FirmwareVersion kOld{0, 1, 0};
const protocol::FirmwareVersion kNew{1, 4, 0};

bool same(const protocol::FirmwareVersion& a, const protocol::FirmwareVersion& b) {
  return a.major == b.major && a.minor == b.minor && a.patch == b.patch;
}

/** How an UpdateProbe behaves: the image kinds section 8 lists. */
struct UpdateProbeConfig {
  /** Calls UpdateService::healthy() when the reply to its Started arrives (a good image). */
  bool confirms = true;
  /** Opens nothing from the hub (an image that cannot open packets). */
  bool deaf = false;
};

/** What every boot of an UpdateProbe did, kept by the test. */
struct UpdateProbeLog {
  std::uint32_t started_sent = 0;
  std::uint32_t started_answered = 0;
  std::uint32_t queries = 0;
  std::uint32_t statuses = 0;
  std::uint32_t door_reports = 0;
  std::vector<protocol::UpdateOffer> offers;
  std::vector<protocol::UpdateStatus> sent_statuses;
};

/** A sensor-like test role that speaks the update part of a sensor (see the file's head). */
class UpdateProbe final : public device::Role {
public:
  UpdateProbe(device::Services& services, device::SensorIo& io, const UpdateProbeConfig& config,
              UpdateProbeLog& log)
      : services_(services), config_(config), log_(log) {
    static_cast<void>(io);
  }

  std::uint8_t role_id() const override {
    return protocol::Role::sensor;
  }

  void handle(const device::Event& event) override {
    const device::Instant now = event.now;
    switch (event.kind) {
      case device::EventKind::boot:
        if (device::is_start_up(event.boot)) {
          send_started(now);
        }
        break;
      case device::EventKind::radio: {
        const device::PortReport report = services_.radio_port.on_radio(event.radio, now);
        if (report.result == device::PortResult::sent) {
          if (update_on_air_) {
            // An update packet is out only now: "installing" must reach the air before the
            // restart it announces.
            update_on_air_ = false;
            services_.update.packet_sent(now);
          }
          listen(now);
        } else if (report.result == device::PortResult::received) {
          on_hub_packet(event.radio.packet, device::UpdatePath::radio, now);
        } else if (report.result == device::PortResult::rx_timeout && !started_answered_) {
          // Started is retried until the hub answers it, as a sensor's is (protocol section 6).
          started_retry_ = now + device::seconds(2);
        }
        break;
      }
      case device::EventKind::link:
        if (event.link.link == device::LinkKind::network) {
          if (event.link.kind == device::LinkEventKind::packet) {
            on_hub_packet(event.link.packet, device::UpdatePath::network, now);
          } else {
            services_.update.link_changed(device::LinkKind::network,
                                          event.link.kind == device::LinkEventKind::up, now);
          }
        }
        break;
      case device::EventKind::input:
        if (event.input.input == device::Input::door) {
          send_door(event.input.active, now);
        }
        break;
      default:
        break;
    }
    if (services_.radio_port.next_deadline() <= now) {
      static_cast<void>(services_.radio_port.on_timer(now));
    }
    if (started_retry_ <= now && port_idle() && !started_answered_) {
      started_retry_ = device::Instant::never();
      send_started(now);
    }
    pump(now);
    next_ = now + device::milliseconds(500);
  }

  device::Wake next_wake() const override {
    device::Wake wake;
    wake.at = device::earliest(device::earliest(next_, services_.radio_port.next_deadline()),
                               started_retry_);
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
  void report_again(device::Instant) override {}

private:
  bool port_idle() const {
    return services_.radio_port.state() == device::PortState::idle;
  }

  void remember(std::uint32_t counter) {
    for (std::size_t i = candidates_.size() - 1; i > 0; --i) {
      candidates_[i] = candidates_[i - 1];
    }
    candidates_[0] = counter;
    count_ = count_ < candidates_.size() ? count_ + 1 : candidates_.size();
  }

  template <typename Message>
  bool send(const Message& message, bool on_link_only, device::Instant now) {
    device::Link* network = services_.hal.network;
    const bool link = network != nullptr && network->up();
    if (on_link_only && !link) {
      return false;
    }
    if (!link && !port_idle()) {
      return false;
    }
    const auto sealed =
        services_.channel.seal(message, protocol::Binding::none(),
                               link ? protocol::PacketLimit::link : protocol::PacketLimit::radio,
                               protocol::MutableByteView(packet_));
    if (!sealed.ok()) {
      return false;
    }
    remember(sealed.value().counter);
    const protocol::ByteView bytes = protocol::ByteView(packet_).first(sealed.value().size);
    sent_on_link_ = link;
    if (link) {
      return network->send(bytes) == device::HalError::none;
    }
    device::Transmission transmission;
    transmission.channel.frequency_hz =
        device::site_channel_frequency(services_.setup.pairing().site_channel).value_or(868300000u);
    transmission.channel.data_rate = protocol::DataRate::dr5;
    transmission.power_dbm = 14;
    transmission.tx_class = device::TxClass::essential;
    return services_.radio_port.send(bytes, transmission, now) == device::Status::ok;
  }

  void send_started(device::Instant now) {
    const protocol::Started started = services_.health.started(protocol::Role::sensor, 0);
    if (send(started, false, now)) {
      started_counter_ = candidates_[0];
      log_.started_sent += 1;
    }
  }

  void send_door(bool open, device::Instant now) {
    protocol::DoorChanged report;
    report.flags.door_open = open;
    report.flags.reply_wanted = true;
    report.settings_version = settings_version_;
    if (send(report, false, now)) {
      log_.door_reports += 1;
    }
  }

  void pump(device::Instant now) {
    if (update_on_air_) {
      return;
    }
    const device::UpdatePacket packet = services_.update.next_packet(now);
    bool sent = false;
    if (packet.kind == device::UpdatePacketKind::query) {
      sent = send(packet.query, packet.links_only, now);
      log_.queries += sent ? 1 : 0;
    } else if (packet.kind == device::UpdatePacketKind::status) {
      sent = send(packet.status, packet.links_only, now);
      if (sent) {
        log_.statuses += 1;
        log_.sent_statuses.push_back(packet.status);
      }
    }
    if (sent && sent_on_link_) {
      services_.update.packet_sent(now);
    } else if (sent) {
      update_on_air_ = true;
    }
  }

  void listen(device::Instant now) {
    device::RxParams params;
    params.channel.frequency_hz = device::kReplyFrequencyHz;
    params.channel.data_rate = protocol::DataRate::dr5;
    params.timeout = device::milliseconds(1500);
    params.stop = device::RxStop::preamble;
    static_cast<void>(services_.radio_port.listen(params, now));
  }

  void on_hub_packet(protocol::ByteView packet, device::UpdatePath path, device::Instant now) {
    if (config_.deaf) {
      return;
    }
    const auto opened = services_.channel.open_bound(
        packet, protocol::Span<const std::uint32_t>(candidates_.data(), count_));
    if (!opened.ok()) {
      return;
    }
    const protocol::OpenedPacket& hub = opened.value().packet;
    if (hub.type == protocol::message_type::reply) {
      protocol::Reply reply;
      if (protocol::decode_body(hub.body, reply) != protocol::Error::none) {
        return;
      }
      settings_version_ = reply.settings_version;
      if (opened.value().answered == started_counter_) {
        log_.started_answered += 1;
        started_answered_ = true;
        if (config_.confirms) {
          services_.update.healthy(now);
        }
      }
      services_.update.update_flag(reply, now);
    } else if (hub.type == protocol::message_type::update_offer) {
      protocol::UpdateOffer offer;
      if (protocol::decode_body(hub.body, offer) == protocol::Error::none) {
        log_.offers.push_back(offer);
        services_.update.offer(offer, path, now);
      }
    }
  }

  device::Services& services_;
  UpdateProbeConfig config_;
  UpdateProbeLog& log_;
  std::array<std::uint32_t, device::kMaxBoundCandidates> candidates_{};
  std::size_t count_ = 0;
  std::uint32_t started_counter_ = 0;
  std::uint8_t settings_version_ = 0;
  bool sent_on_link_ = false;
  bool started_answered_ = false;
  device::Instant started_retry_ = device::Instant::never();
  bool update_on_air_ = false;
  device::Instant next_;
  std::array<std::uint8_t, 255> packet_{};
  std::array<std::uint8_t, 4> state_{};
};

static_assert(device::is_complete_role<UpdateProbe>, "a role must override every Role method");

host::RoleFactory update_probe(const UpdateProbeConfig& config, UpdateProbeLog& log) {
  return [config, &log](device::Services& services, host::HostBoard& board) {
    return host::box_role<UpdateProbe>(services, board.sensor_io, config, log);
  };
}

/** A hub, a sensor running UpdateProbe, and two images: the factory 0.1.0 and the new 1.4.0. */
struct UpdateHome {
  explicit UpdateHome(UpdateProbeConfig new_image = {}, std::size_t image_size = 20000,
                      bool new_hangs = false)
      : hub(sim) {
    host::DeviceSpec spec;
    spec.name = "door";
    spec.role = update_probe(UpdateProbeConfig{}, old_log);
    spec.images.push_back(host::ImageRole{kOld, update_probe(UpdateProbeConfig{}, old_log), {}});
    spec.images.push_back(host::ImageRole{
        kNew, update_probe(new_image, new_log),
        new_hangs ? std::optional<device::Duration>(milliseconds(1)) : std::nullopt});
    door = &sim.add_device(spec);
    hub.add_sensor(*door);
    image = &hub.add_image(host::make_test_image(kNew, image_size));
  }

  void run_to(device::Duration t) {
    sim.run_until(at(t));
  }

  host::Simulation sim;
  host::TestHub hub;
  UpdateProbeLog old_log;
  UpdateProbeLog new_log;
  host::SimDevice* door = nullptr;
  const host::HubImage* image = nullptr;
};

TEST_CASE("an update over Wi-Fi: offered, fetched, verified, installed, on trial, confirmed") {
  UpdateHome home;
  home.hub.offer_update("door", home.image->id, host::UpdateMethod::join_wifi);
  home.run_to(seconds(120));
  INFO(home.sim.timeline().select().dump() << home.hub.dump());
  CHECK(home.hub.update_of("door").state == UpdateState::confirmed);
  CHECK(same(home.door->boot_choice().image.version, kNew));
  CHECK(home.door->boot_choice().image.on_trial);
  CHECK_FALSE(home.door->board().slots.running().on_trial);
  CHECK(home.door->board().slots.entry(0).state == host::ota_state::valid);
  CHECK(home.hub.update_of("door").bytes_served >= home.image->file.size());
  CHECK(home.door->board().slots.writes_on_trial() == 0);
  CHECK(home.door->board().slots.flash.unerased_programs == 0);
  CHECK_FALSE(home.door->board().storage.has(device::StoreKey::update));
}

TEST_CASE("a refused image is refused before any write, and the slot is untouched") {
  struct Bad {
    const char* name;
    std::uint8_t reason;
  };
  for (const Bad bad : {Bad{"wrong signature", protocol::UpdateReason::bad_signature},
                        Bad{"wrong hub", protocol::UpdateReason::wrong_hub},
                        Bad{"wrong role", protocol::UpdateReason::wrong_role},
                        Bad{"too large", protocol::UpdateReason::too_large}}) {
    CAPTURE(bad.name);
    UpdateHome home;
    // The hub's file, made wrong in one way and signed again where the check is not the signature.
    host::HubImage& image = const_cast<host::HubImage&>(*home.image);
    if (bad.reason == protocol::UpdateReason::bad_signature) {
      image.header.signature[10] ^= 0x01;
    } else if (bad.reason == protocol::UpdateReason::wrong_hub) {
      image.header.hub_identity[0] ^= 0x01;
      home.hub.signing_key().sign(image.header);
    } else if (bad.reason == protocol::UpdateReason::wrong_role) {
      image.header.roles = protocol::image_role_bit(protocol::Role::siren);
      home.hub.signing_key().sign(image.header);
    } else {
      image.header.image_bytes = home.door->board().slots.capacity() + 1;
      home.hub.signing_key().sign(image.header);
    }
    const Bytes header = host::header_bytes(image.header);
    std::copy(header.begin(), header.end(), image.file.begin());
    home.hub.offer_update("door", image.id, host::UpdateMethod::join_wifi);
    home.run_to(seconds(60));
    INFO(home.hub.dump());
    CHECK(home.hub.update_of("door").state == UpdateState::refused);
    CHECK(home.hub.update_of("door").reason == bad.reason);
    CHECK(home.door->records().kind(RecordKind::slot_erase).count() == 0);
    CHECK(home.door->records().kind(RecordKind::slot_write).count() == 0);
  }
}

TEST_CASE("an image that never confirms rolls back at its deadline, and says so") {
  UpdateProbeConfig never;
  never.confirms = false;
  UpdateHome home(never);
  home.hub.offer_update("door", home.image->id, host::UpdateMethod::join_wifi);
  home.run_to(seconds(15 * 60));
  INFO(home.hub.dump());
  CHECK(home.hub.update_of("door").state == UpdateState::rolled_back);
  CHECK(same(home.hub.update_of("door").failed, kNew));
  CHECK(same(home.door->boot_choice().image.version, kOld));
  CHECK(home.door->boot_choice().image.rolled_back);
}

TEST_CASE("an image that hangs is rolled back by the watchdog") {
  UpdateHome home(UpdateProbeConfig{}, 20000, true);
  home.hub.offer_update("door", home.image->id, host::UpdateMethod::join_wifi);
  home.run_to(seconds(180));
  INFO(home.hub.dump());
  CHECK(home.door->records()
            .kind(RecordKind::restart)
            .where([](const host::Record& r) { return r.flag; })
            .count() == 1);
  CHECK(same(home.door->boot_choice().image.version, kOld));
  CHECK(home.hub.update_of("door").state == UpdateState::rolled_back);
}

TEST_CASE("a door opening during a download is reported as usual") {
  UpdateHome home(UpdateProbeConfig{}, 60000);
  home.hub.offer_update("door", home.image->id, host::UpdateMethod::join_wifi);
  home.door->set_input(device::Input::door, true, at(seconds(8)));
  home.run_to(seconds(120));
  INFO(home.hub.dump());
  const auto reports = home.hub.received_from("door", protocol::message_type::door_changed);
  REQUIRE_FALSE(reports.empty());
  // Heard within a second and an erase (400 ms) of the opening.
  CHECK(reports[0].at <= at(seconds(8) + milliseconds(1400)));
  CHECK(home.hub.update_of("door").state == UpdateState::confirmed);
}

TEST_CASE("an update from the phone over Bluetooth") {
  UpdateHome home;
  const host::BluetoothSession session = home.hub.open_bluetooth("door", home.image->id);
  host::ScriptPhone phone(home.sim, *home.door, session);
  // The sensor learns of it at its next reply: here, its door report's.
  home.door->set_input(device::Input::door, true, at(seconds(2)));
  home.run_to(seconds(180));
  INFO(home.hub.dump());
  INFO("phone: hellos " << phone.hellos.size() << ", opens " << phone.opens << ", data "
                        << phone.data_frames << ", served to " << phone.served_to
                        << ", connections " << phone.connections << ", unexpected "
                        << phone.unexpected);
  CHECK(phone.opens >= 1);
  REQUIRE(phone.done.has_value());
  CHECK(phone.done->result == protocol::DoneResult::verified);
  CHECK(phone.served_to == home.image->file.size());
  CHECK(home.hub.update_of("door").state == UpdateState::confirmed);
}

TEST_CASE("Bluetooth: a dropped connection resumes, and the update completes") {
  UpdateHome home;
  const host::BluetoothSession session = home.hub.open_bluetooth("door", home.image->id);
  host::ScriptPhoneOptions options;
  options.drop_after_data = 30;
  options.reconnect_after = seconds(1);
  host::ScriptPhone phone(home.sim, *home.door, session, options);
  home.door->set_input(device::Input::door, true, at(seconds(2)));
  home.run_to(seconds(180));
  INFO(home.hub.dump());
  CHECK(phone.connections == 2);
  CHECK(phone.hellos.size() == 2);
  REQUIRE(phone.done.has_value());
  CHECK(phone.done->result == protocol::DoneResult::verified);
  CHECK(home.hub.update_of("door").state == UpdateState::confirmed);
}

TEST_CASE("Bluetooth: a window with no phone ends, and the sensor says so over LoRa") {
  UpdateHome home;
  static_cast<void>(home.hub.open_bluetooth("door", home.image->id));
  home.door->set_input(device::Input::door, true, at(seconds(2)));
  home.run_to(seconds(300));
  INFO(home.hub.dump());
  CHECK(home.door->board().bluetooth.connects >= 1);
  CHECK_FALSE(home.door->wire(device::LinkKind::bluetooth).advertising());
  CHECK(home.hub.update_of("door").state == UpdateState::refused);
  CHECK(home.hub.update_of("door").reason == protocol::UpdateReason::window_ended);
  CHECK(home.door->records().kind(RecordKind::slot_write).count() == 0);
}

TEST_CASE("a power cut on trial rolls back, and the board reports the failed version") {
  UpdateProbeConfig never;
  never.confirms = false;
  UpdateHome home(never);
  home.hub.offer_update("door", home.image->id, host::UpdateMethod::join_wifi);
  // Wait for the trial, then cut the power during it.
  for (int i = 0; i < 120 && !home.door->boot_choice().image.on_trial; ++i) {
    home.run_to(seconds(i + 1));
  }
  REQUIRE(home.door->boot_choice().image.on_trial);
  home.door->power_loss(home.sim.now() + seconds(1));
  home.run_to(seconds(200));
  INFO(home.hub.dump());
  CHECK(same(home.door->boot_choice().image.version, kOld));
  CHECK(home.door->boot_choice().image.rolled_back);
  CHECK(home.hub.update_of("door").state == UpdateState::rolled_back);
  CHECK(same(home.hub.update_of("door").failed, kNew));
}

TEST_CASE("Bluetooth: five wrong tags end the window; no window opens without an offer") {
  UpdateHome home;
  host::BluetoothSession wrong = home.hub.open_bluetooth("door", home.image->id);
  host::ScriptPhoneOptions options;
  options.wrong_tags = 5;
  options.reconnect_after = milliseconds(500);
  host::ScriptPhone phone(home.sim, *home.door, wrong, options);
  home.door->set_input(device::Input::door, true, at(seconds(2)));
  home.run_to(seconds(60));
  INFO(home.hub.dump());
  CHECK(phone.wrong_opens == 5);
  CHECK_FALSE(home.door->wire(device::LinkKind::bluetooth).advertising());
  CHECK(home.hub.update_of("door").reason == protocol::UpdateReason::session_refused);
  // A board with nothing offered never advertises.
  UpdateHome quiet;
  quiet.run_to(seconds(60));
  CHECK(quiet.door->board().bluetooth.connects == 0);
}

/** The update over Wi-Fi as a scenario for the power-cut harness. */
struct CutHome {
  CutHome() : home(UpdateProbeConfig{}, 40000) {
    home.hub.offer_update("door", home.image->id, host::UpdateMethod::join_wifi);
  }
  UpdateHome home;
};

TEST_CASE("a power cut at every flash operation of an update: a working image, then the update") {
  host::CutScenario<CutHome> scenario;
  scenario.make = []() { return std::make_unique<CutHome>(); };
  scenario.simulation = [](CutHome& world) -> host::Simulation& { return world.home.sim; };
  scenario.run = [](CutHome& world) { world.home.run_to(seconds(300)); };
  scenario.devices = {"door"};
  scenario.check = [](CutHome& world, const host::CutRun& run) {
    INFO(run.describe() << "\n" << world.home.hub.dump());
    host::SimDevice& door = *world.home.door;
    // It always boots something that works, and never writes the other slot on trial.
    CHECK(door.state() == host::PowerState::running);
    CHECK(door.boot_choice().bootable);
    CHECK_FALSE(door.board().slots.running().on_trial);
    CHECK(door.board().slots.writes_on_trial() == 0);
    if (world.home.hub.update_of("door").state == UpdateState::rolled_back) {
      // A cut on trial (the bootloader's PENDING_VERIFY write whole, then the reset) rolls back,
      // as section 6 says; the hub knows, and the old image runs.
      CHECK(run.op == host::FlashOp::otadata_write);
      CHECK(same(door.boot_choice().image.version, kOld));
      CHECK(door.boot_choice().image.rolled_back);
      return;
    }
    // Otherwise the update finishes from its checkpoint.
    CHECK(world.home.hub.update_of("door").state == UpdateState::confirmed);
    CHECK(same(door.boot_choice().image.version, kNew));
  };
  const host::CutReport report = host::run_power_cuts(scenario);
  MESSAGE("flash operations in the update: " << report.operations.at("door") << "; runs "
                                             << report.runs);
  CHECK(report.operations.at("door") >= 10);
}

}  // namespace
}  // namespace hsn::test
