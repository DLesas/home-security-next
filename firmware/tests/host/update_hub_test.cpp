// The test hub's side of an update (m3-updates-design.md sections 4 and 5), checked against the
// codec from the device's side: the images it signs, offers to a siren, a sensor and a gateway,
// Gets served on granted links only, statuses and the go-ahead, Started's image fields, a
// rollout's order, and the session it gives a phone.

#include <doctest/doctest.h>

#include <memory>
#include <string>
#include <vector>

#include "hsn/device/services/record.hpp"
#include "hsn/device/services/setup.hpp"
#include "hsn/host/fake_update.hpp"
#include "hsn/host/test_image.hpp"
#include "hsn/protocol/checksum.hpp"
#include "sim_support.hpp"
#include "support.hpp"
#include "update_hub_support.hpp"

namespace hsn::test {
namespace {

using host::HubAction;
using host::UpdateState;
namespace transfer = protocol::transfer;
using action = protocol::UpdateAction;

const protocol::FirmwareVersion kNew{1, 4, 0};
/** kNew as the hub's decisions give a version: major × 65,536 + minor × 256 + patch. */
constexpr std::int64_t kNewValue = 1 * 65536 + 4 * 256;

bool same(const protocol::FirmwareVersion& a, const protocol::FirmwareVersion& b) {
  return a.major == b.major && a.minor == b.minor && a.patch == b.patch;
}

template <typename Frame>
Bytes frame_of(const Frame& frame) {
  Bytes bytes(1100);
  const auto size =
      protocol::encode_transfer(frame, protocol::MutableByteView(bytes.data(), bytes.size()));
  REQUIRE(size.ok());
  bytes.resize(size.value());
  return bytes;
}

transfer::Get get_of(const protocol::ImageId& id, std::uint32_t offset, std::uint16_t length) {
  transfer::Get get;
  get.image_id = id;
  get.offset = offset;
  get.length = length;
  return get;
}

/** A hub and boards with no role: the test speaks for the boards with sealed packets. */
struct World {
  World() : hub(sim) {}

  /** A board with no role, on external power so that it waits awake (setup-only mode). */
  host::SimDevice& board(const std::string& name) {
    host::DeviceSpec spec;
    spec.name = name;
    host::SimDevice& device = sim.add_device(spec);
    device.board().power.external = true;
    return device;
  }

  /** A siren whose Wi-Fi comes up at 0.1 s. */
  host::SimDevice& siren(const std::string& name) {
    host::SimDevice& device = board(name);
    hub.add_siren(device);
    sim.schedule(at(milliseconds(100)), [&device]() {
      static_cast<void>(device.board().network.connect(device::LinkTarget{}));
    });
    return device;
  }

  /** Sends a packet from a board on its network link now. */
  void on_link(host::SimDevice& device, const Bytes& bytes) {
    REQUIRE(device.board().network.send(view(bytes)) == device::HalError::none);
  }

  /** The address the hub gave a board. */
  std::uint32_t address(host::SimDevice& device) {
    device::Record<device::PairingRecord> pairing(device.board().storage, device::StoreKey::pairing,
                                                  device::kPairingRecordVersion, {});
    REQUIRE(pairing.load() == device::HalError::none);
    return pairing.get().address;
  }

  template <typename Message>
  Bytes sealed(host::SimDevice& device, std::uint32_t counter, const Message& message,
               protocol::PacketLimit limit = protocol::PacketLimit::radio) {
    return seal_as_device(hub.key_of(device.name()), address(device), counter, message, limit);
  }

  void run_to(device::Duration t) {
    sim.run_until(at(t));
  }

  host::Simulation sim;
  host::TestHub hub;
};

protocol::UpdateStatus status_of(const protocol::ImageId& id, std::uint8_t stage,
                                 std::uint8_t reason = 0) {
  protocol::UpdateStatus status;
  status.image_id = id;
  status.stage = stage;
  status.reason = reason;
  return status;
}

TEST_CASE("the hub signs its images, and every board it pairs holds its key and identity") {
  World world;
  host::SimDevice& sensor = world.board("door");
  world.hub.add_sensor(sensor);
  const Bytes image = host::make_test_image(kNew, 7000);
  const host::HubImage& held = world.hub.add_image(image);
  CHECK(held.id == protocol::image_id_of(held.header));
  CHECK(held.file == host::image_file(held.header, view(image)));
  CHECK(same(held.header.version, kNew));
  CHECK_FALSE(held.header.flags.own_build);
  CHECK(world.hub.add_image(image, true).header.flags.own_build);

  device::Record<device::PairingRecord> pairing(sensor.board().storage, device::StoreKey::pairing,
                                                device::kPairingRecordVersion, {});
  REQUIRE(pairing.load() == device::HalError::none);
  CHECK(pairing.get().firmware_signing_key == world.hub.signing_key().public_key());
  CHECK(pairing.get().hub_identity == host::Provisioning{}.hub_identity);
  CHECK(held.header.hub_identity == pairing.get().hub_identity);
  // What a board checks: the signature under the key it was given.
  const protocol::Sha256Digest digest = host::HubSigningKey::signed_digest(held.header);
  CHECK(sensor.board().update_crypto.verify_p256(
      protocol::ByteView(pairing.get().firmware_signing_key), protocol::ByteView(digest),
      protocol::ByteView(held.header.signature)));
  CHECK_THROWS_AS(world.hub.offer_update("door", protocol::ImageId{}), host::SimulationError);
}

TEST_CASE("a siren is offered its update on its link, and only that link is served") {
  World world;
  host::SimDevice& siren = world.siren("siren");
  host::SimDevice& other = world.siren("other");
  const host::HubImage& held = world.hub.add_image(host::make_test_image(kNew, 5000));
  world.hub.offer_update("siren", held.id);
  CHECK(world.hub.update_of("siren").state == UpdateState::planned);
  world.run_to(seconds(1));
  INFO(world.hub.dump());
  const auto offers = world.hub.sent_to("siren", protocol::message_type::update_offer);
  REQUIRE(offers.size() == 1);
  CHECK(offers[0].path == host::HubPath::link);
  const auto offer = open_from_hub<protocol::UpdateOffer>(
      world.hub.key_of("siren"), offers[0].packet, protocol::Binding::none());
  REQUIRE(offer.has_value());
  CHECK(offer->action == action::fetch);
  CHECK(offer->image_id == held.id);
  CHECK(offer->file_bytes == held.file.size());
  CHECK(same(offer->version, kNew));
  CHECK(world.hub.update_of("siren").state == UpdateState::offered);
  CHECK(world.hub.sent_to("other", protocol::message_type::update_offer).empty());

  const std::size_t size = held.file.size();
  protocol::ImageId stranger = held.id;
  stranger[7] ^= 0x01;
  world.sim.schedule(at(seconds(1)), [&]() {
    world.on_link(siren, frame_of(get_of(held.id, 0, 128)));
    world.on_link(siren, frame_of(get_of(held.id, 128, 1000)));
    world.on_link(siren, frame_of(get_of(held.id, static_cast<std::uint32_t>(size - 10), 1000)));
    world.on_link(siren, frame_of(get_of(held.id, static_cast<std::uint32_t>(size), 10)));
    world.on_link(siren, frame_of(get_of(stranger, 0, 10)));
    world.on_link(other, frame_of(get_of(held.id, 0, 10)));
  });
  world.run_to(seconds(2));
  const auto& served = world.hub.transfers();
  REQUIRE(served.size() == 6);
  const auto data_of = [](const host::HubTransfer& t) {
    transfer::Data data;
    REQUIRE(t.frame.size() > 2);
    REQUIRE(t.frame[1] == protocol::transfer_kind::data);
    REQUIRE(protocol::decode_transfer_body(
                protocol::ByteView(t.frame.data() + 2, t.frame.size() - 2), data) ==
            protocol::Error::none);
    return std::make_pair(data, Bytes(data.data.bytes.begin(), data.data.bytes.end()));
  };
  const auto expect_data = [&](std::size_t i, std::size_t from, std::size_t length) {
    CAPTURE(i);
    CHECK(served[i].answer == protocol::transfer_kind::data);
    const auto [data, bytes] = data_of(served[i]);
    CHECK(data.image_id == held.id);
    CHECK(data.offset == from);
    CHECK(bytes == Bytes(held.file.begin() + static_cast<std::ptrdiff_t>(from),
                         held.file.begin() + static_cast<std::ptrdiff_t>(from + length)));
    CHECK(data.crc32 == protocol::crc32(view(bytes)));
  };
  expect_data(0, 0, 128);
  expect_data(1, 128, 1000);
  expect_data(2, size - 10, 10);
  CHECK(served[3].answer == protocol::transfer_kind::gone);
  CHECK(served[3].gone_reason == protocol::GoneReason::out_of_range);
  CHECK(served[4].gone_reason == protocol::GoneReason::not_available);
  CHECK(served[5].device == "other");
  CHECK(served[5].gone_reason == protocol::GoneReason::not_granted);
  CHECK(world.hub.update_of("siren").state == UpdateState::fetching);
  CHECK(world.hub.update_of("siren").bytes_served == 1138);
  // Frames reach the board on its link, and are not packets the hub keeps.
  CHECK(siren.records().kind(host::RecordKind::link_received).count() >= 6);
  CHECK(world.hub.received_from("siren").empty());
  // A dropped link loses its grant.
  world.sim.schedule(at(seconds(2)),
                     [&]() { world.hub.drop_link("siren", device::LinkKind::network); });
  world.sim.schedule(at(seconds(3)), [&]() {
    static_cast<void>(siren.board().network.connect(device::LinkTarget{}));
  });
  world.sim.schedule(at(seconds(4)),
                     [&]() { world.on_link(siren, frame_of(get_of(held.id, 0, 8))); });
  world.run_to(seconds(5));
  CHECK(world.hub.transfers().back().gone_reason == protocol::GoneReason::not_granted);
}

TEST_CASE("a verified siren gets install now at once, or when the go-ahead is given") {
  for (const bool automatic : {true, false}) {
    CAPTURE(automatic);
    host::HubOptions options;
    options.auto_install = automatic;
    host::Simulation sim;
    host::TestHub hub(sim, options);
    host::DeviceSpec spec;
    spec.name = "siren";
    host::SimDevice& siren = sim.add_device(spec);
    siren.board().power.external = true;
    hub.add_siren(siren);
    sim.schedule(at(milliseconds(100)), [&siren]() {
      static_cast<void>(siren.board().network.connect(device::LinkTarget{}));
    });
    const host::HubImage& held = hub.add_image(host::make_test_image(kNew, 3000));
    hub.offer_update("siren", held.id);
    sim.run_until(at(seconds(1)));
    device::Record<device::PairingRecord> pairing(siren.board().storage, device::StoreKey::pairing,
                                                  device::kPairingRecordVersion, {});
    REQUIRE(pairing.load() == device::HalError::none);
    const std::uint32_t address = pairing.get().address;
    const auto send = [&](std::uint32_t counter, const auto& message) {
      const Bytes packet = seal_as_device(hub.key_of("siren"), address, counter, message,
                                          protocol::PacketLimit::link);
      REQUIRE(siren.board().network.send(view(packet)) == device::HalError::none);
    };
    sim.schedule(at(seconds(1)),
                 [&]() { send(2000, status_of(held.id, protocol::UpdateStage::verified)); });
    sim.run_until(at(seconds(2)));
    INFO(hub.dump());
    CHECK(hub.update_of("siren").state == UpdateState::verified);
    const auto go = [&]() {
      for (const host::HubSent& sent : hub.sent_to("siren", protocol::message_type::update_offer)) {
        const auto offer = open_from_hub<protocol::UpdateOffer>(hub.key_of("siren"), sent.packet,
                                                                protocol::Binding::none());
        if (offer.has_value() && offer->action == action::install_now) {
          return true;
        }
      }
      return false;
    };
    CHECK(go() == automatic);
    if (!automatic) {
      hub.go_ahead("siren");
      CHECK(go());
    }
    const auto installing = hub.decisions(HubAction::firmware_installing, "siren");
    REQUIRE(installing.size() == 1);
    CHECK(installing[0].value == kNewValue);
    CHECK(hub.update_of("siren").go_ahead);

    // Installing, then the new image's Started on trial: "report now" on both paths; then
    // confirmed.
    sim.schedule(at(seconds(2)),
                 [&]() { send(2001, status_of(held.id, protocol::UpdateStage::installing)); });
    sim.schedule(at(seconds(3)),
                 [&]() { send(3000, started_of(protocol::Role::siren, kNew, true, false)); });
    sim.run_until(at(seconds(4)));
    CHECK(hub.update_of("siren").state == UpdateState::on_trial);
    const auto trial = hub.decisions(HubAction::firmware_on_trial, "siren");
    REQUIRE(trial.size() == 1);
    CHECK(trial[0].value == kNewValue);
    const auto commands = hub.decisions(HubAction::siren_command, "siren");
    REQUIRE_FALSE(commands.empty());
    CHECK(commands.back().value == std::int64_t{protocol::SirenAction::report_now} * 65536);
    sim.schedule(at(seconds(4)),
                 [&]() { send(3001, started_of(protocol::Role::siren, kNew, false, false)); });
    sim.run_until(at(seconds(5)));
    CHECK(hub.update_of("siren").state == UpdateState::confirmed);
    const auto confirmed = hub.decisions(HubAction::firmware_confirmed, "siren");
    REQUIRE(confirmed.size() == 1);
    CHECK(confirmed[0].value == kNewValue);
  }
}

TEST_CASE("a sensor sees update available, and every heartbeat is answered while it waits") {
  World world;
  ScriptSensorConfig config;
  config.heartbeat_every = seconds(20);
  config.link_check_every = 200;
  ScriptSensorLog log;
  host::DeviceSpec spec;
  spec.name = "door";
  spec.role = script_sensor(config, log);
  host::SimDevice& door = world.sim.add_device(spec);
  world.hub.add_sensor(door);
  const host::HubImage& held = world.hub.add_image(host::make_test_image(kNew, 3000));
  world.run_to(seconds(65));
  // Only the first heartbeat (new settings) was answered, with no update available.
  REQUIRE(log.count(protocol::message_type::reply) == 1);
  CHECK_FALSE(log.heard[0].reply.flags.update_available);
  world.hub.offer_update("door", held.id);
  world.run_to(seconds(130));
  INFO(world.hub.dump());
  REQUIRE(log.count(protocol::message_type::reply) >= 3);
  CHECK(log.heard.back().reply.flags.update_available);
}

TEST_CASE("a sensor's Update query is answered with the offer that fits, bound to it") {
  World world;
  host::SimDevice& door = world.board("door");
  world.hub.add_sensor(door);
  host::ReplayRadio radio(world.sim, "door-radio");
  const host::HubImage& held = world.hub.add_image(host::make_test_image(kNew, 3000));
  std::uint32_t counter = 100;
  std::uint32_t seconds_at = 1;
  const auto query = [&](std::uint8_t held_what, bool for_image) {
    protocol::UpdateQuery message;
    message.held = held_what;
    if (for_image) {
      message.image_id = held.id;
      message.bytes_held = static_cast<std::uint32_t>(held.file.size());
    }
    const std::uint32_t used = counter++;
    const Bytes packet = world.sealed(door, used, message);
    world.sim.schedule(at(seconds(seconds_at)),
                       [&radio, packet]() { static_cast<void>(radio.send(packet, site_dr5())); });
    world.run_to(seconds(++seconds_at));
    const auto offers = world.hub.sent_to("door", protocol::message_type::update_offer);
    REQUIRE_FALSE(offers.empty());
    CHECK(offers.back().path == host::HubPath::radio);
    const auto offer = open_from_hub<protocol::UpdateOffer>(
        world.hub.key_of("door"), offers.back().packet, protocol::Binding::sensor_packet(used),
        protocol::PacketLimit::radio);
    REQUIRE(offer.has_value());
    return *offer;
  };
  // Nothing planned: discard anything held.
  CHECK(query(protocol::UpdateHeld::nothing, false).action == action::nothing);
  // Planned, over LoRa: join Wi-Fi and fetch.
  world.hub.offer_update("door", held.id);
  protocol::UpdateOffer offer = query(protocol::UpdateHeld::nothing, false);
  CHECK(offer.action == action::join_wifi_and_fetch);
  CHECK(offer.image_id == held.id);
  CHECK(offer.file_bytes == held.file.size());
  CHECK(world.hub.update_of("door").state == UpdateState::offered);
  // Armed: keep and wait (D91).
  world.hub.arm();
  CHECK(query(protocol::UpdateHeld::part, true).action == action::wait);
  world.hub.disarm();
  // Verified and disarmed: install now.
  CHECK(query(protocol::UpdateHeld::verified, true).action == action::install_now);
  const auto installing = world.hub.decisions(HubAction::firmware_installing, "door");
  REQUIRE(installing.size() == 1);
  CHECK(installing[0].value == kNewValue);
  CHECK(world.hub.update_of("door").state == UpdateState::verified);
  // Verified but armed: wait.
  world.hub.arm();
  CHECK(query(protocol::UpdateHeld::verified, true).action == action::wait);
  world.hub.disarm();
  // A Bluetooth session waits: open Bluetooth with its nonce and window.
  const host::BluetoothSession session = world.hub.open_bluetooth("door", held.id);
  offer = query(protocol::UpdateHeld::nothing, false);
  CHECK(offer.action == action::open_bluetooth);
  CHECK(offer.bluetooth_nonce == session.nonce);
  CHECK(offer.bluetooth_window_units == 12);
  CHECK(offer.image_id == held.id);
  // The session key is the device key's, by the vectors' derivation; the phone gets the file.
  CHECK(session.address == world.address(door));
  CHECK(session.session_key ==
        host::derive_session_key(world.hub.key_of("door"),
                                 protocol::ByteView(session.nonce.data(), session.nonce.size()),
                                 session.address));
  CHECK(session.file == held.file);
  CHECK(session.nonce != std::array<std::uint8_t, 8>{});
  CHECK(world.hub.update_of("door").method == host::UpdateMethod::bluetooth);
  // Once offered, the next query is answered by the plan again.
  CHECK(query(protocol::UpdateHeld::nothing, false).action == action::join_wifi_and_fetch);
  const auto queries = world.hub.decisions(HubAction::firmware_query, "door");
  CHECK(queries.size() == 7);
}

TEST_CASE("a sensor's statuses are always answered; verified is answered with the go-ahead") {
  World world;
  host::SimDevice& door = world.board("door");
  world.hub.add_sensor(door);
  host::ReplayRadio radio(world.sim, "door-radio");
  const host::HubImage& held = world.hub.add_image(host::make_test_image(kNew, 3000));
  world.hub.offer_update("door", held.id);
  const Bytes fetching =
      world.sealed(door, 10, status_of(held.id, protocol::UpdateStage::fetching));
  const Bytes verified =
      world.sealed(door, 11, status_of(held.id, protocol::UpdateStage::verified));
  world.sim.schedule(at(seconds(1)),
                     [&]() { static_cast<void>(radio.send(fetching, site_dr5())); });
  world.sim.schedule(at(seconds(3)),
                     [&]() { static_cast<void>(radio.send(verified, site_dr5())); });
  world.run_to(seconds(5));
  INFO(world.hub.dump());
  const auto replies = world.hub.sent_to("door", protocol::message_type::reply);
  REQUIRE(replies.size() == 1);
  CHECK(open_from_hub<protocol::Reply>(world.hub.key_of("door"), replies[0].packet,
                                       protocol::Binding::sensor_packet(10),
                                       protocol::PacketLimit::radio)
            .has_value());
  const auto offers = world.hub.sent_to("door", protocol::message_type::update_offer);
  REQUIRE(offers.size() == 1);
  const auto offer = open_from_hub<protocol::UpdateOffer>(
      world.hub.key_of("door"), offers[0].packet, protocol::Binding::sensor_packet(11),
      protocol::PacketLimit::radio);
  REQUIRE(offer.has_value());
  CHECK(offer->action == action::install_now);
  CHECK(world.hub.update_of("door").state == UpdateState::verified);
  const auto statuses = world.hub.decisions(HubAction::firmware_status, "door");
  REQUIRE(statuses.size() == 2);
  CHECK(statuses[0].value == protocol::UpdateStage::fetching * 256);
  CHECK(statuses[1].value == protocol::UpdateStage::verified * 256);
}

TEST_CASE("a sensor's query over its own link is answered there with fetch, and served there") {
  World world;
  host::SimDevice& door = world.board("door");
  world.hub.add_sensor(door);
  const host::HubImage& held = world.hub.add_image(host::make_test_image(kNew, 3000));
  world.hub.offer_update("door", held.id, host::UpdateMethod::join_wifi);
  world.sim.schedule(at(milliseconds(100)), [&door]() {
    static_cast<void>(door.board().network.connect(device::LinkTarget{}));
  });
  protocol::UpdateQuery query;
  const Bytes packet = world.sealed(door, 50, query, protocol::PacketLimit::link);
  world.sim.schedule(at(seconds(1)), [&]() { world.on_link(door, packet); });
  world.sim.schedule(at(seconds(2)),
                     [&]() { world.on_link(door, frame_of(get_of(held.id, 0, 128))); });
  world.run_to(seconds(3));
  INFO(world.hub.dump());
  const auto offers = world.hub.sent_to("door", protocol::message_type::update_offer);
  REQUIRE(offers.size() == 1);
  CHECK(offers[0].path == host::HubPath::link);
  const auto offer = open_from_hub<protocol::UpdateOffer>(
      world.hub.key_of("door"), offers[0].packet, protocol::Binding::sensor_packet(50));
  REQUIRE(offer.has_value());
  CHECK(offer->action == action::fetch);
  REQUIRE(world.hub.transfers().size() == 1);
  CHECK(world.hub.transfers()[0].answer == protocol::transfer_kind::data);
}

TEST_CASE("a rollback in a Started is recorded with the failed version, and pauses the rollout") {
  World world;
  host::SimDevice& first = world.siren("first");
  world.siren("second");
  const host::HubImage& held = world.hub.add_image(host::make_test_image(kNew, 3000));
  world.hub.rollout(held.id, {"first", "second"});
  world.run_to(seconds(1));
  CHECK(world.hub.update_of("first").state == UpdateState::offered);
  CHECK(world.hub.update_of("second").state == UpdateState::none);
  world.sim.schedule(at(seconds(1)), [&]() {
    world.on_link(first,
                  world.sealed(first, 2000, status_of(held.id, protocol::UpdateStage::installing),
                               protocol::PacketLimit::link));
    world.on_link(
        first,
        world.sealed(first, 2001, started_of(protocol::Role::siren, {0, 1, 0}, false, true, kNew),
                     protocol::PacketLimit::link));
  });
  world.run_to(seconds(2));
  INFO(world.hub.dump());
  CHECK(world.hub.update_of("first").state == UpdateState::rolled_back);
  CHECK(same(world.hub.update_of("first").failed, kNew));
  const auto rolled = world.hub.decisions(HubAction::firmware_rolled_back, "first");
  REQUIRE(rolled.size() == 1);
  CHECK(rolled[0].value == kNewValue);
  CHECK(world.hub.rollout_paused());
  // As the hub records it: the rollout as the value, the device, and the reason 20 (a rollback).
  const auto paused = world.hub.decisions(HubAction::rollout_paused);
  REQUIRE(paused.size() == 1);
  CHECK(paused[0].value == 1);
  CHECK(paused[0].device == "first");
  CHECK(world.hub.rollout_pause_reason() == host::kRolledBackReason);
  CHECK(host::kRolledBackReason == 20);
  CHECK(world.hub.update_of("second").state == UpdateState::none);
  // Resumed, the next device goes.
  world.hub.resume_rollout();
  CHECK(world.hub.rollout_pause_reason() == 0);
  world.run_to(seconds(3));
  CHECK(world.hub.update_of("second").state == UpdateState::offered);
}

/** Takes a siren from offered to confirmed with its statuses and Started, from `t`. */
void confirm_siren(World& world, host::SimDevice& siren, const host::HubImage& held,
                   device::Duration t, std::uint32_t counter) {
  world.sim.schedule(at(t), [&world, &siren, &held, counter]() {
    world.on_link(siren,
                  world.sealed(siren, counter, status_of(held.id, protocol::UpdateStage::verified),
                               protocol::PacketLimit::link));
    world.on_link(siren, world.sealed(siren, counter + 1,
                                      status_of(held.id, protocol::UpdateStage::installing),
                                      protocol::PacketLimit::link));
  });
  world.sim.schedule(at(t + milliseconds(500)), [&world, &siren, counter]() {
    world.on_link(siren, world.sealed(siren, counter + 2,
                                      started_of(protocol::Role::siren, kNew, false, false),
                                      protocol::PacketLimit::link));
  });
}

TEST_CASE("a rollout takes sirens one at a time, after its pilot and the soak, until done") {
  World world;
  std::vector<host::SimDevice*> sirens;
  for (const char* name : {"pilot", "a", "b"}) {
    sirens.push_back(&world.siren(name));
  }
  const host::HubImage& held = world.hub.add_image(host::make_test_image(kNew, 3000));
  host::RolloutRules rules;
  rules.pilots = 1;
  rules.soak = seconds(60);
  world.hub.rollout(held.id, {"pilot", "a", "b"}, rules);
  world.run_to(seconds(1));
  CHECK(world.hub.update_of("pilot").state == UpdateState::offered);
  CHECK(world.hub.update_of("a").state == UpdateState::none);
  confirm_siren(world, *sirens[0], held, seconds(1), 2000);
  world.run_to(seconds(3));
  CHECK(world.hub.update_of("pilot").state == UpdateState::confirmed);
  // The soak: nothing for an hour (here a minute) after the pilot's confirmation.
  world.run_to(seconds(60));
  CHECK(world.hub.update_of("a").state == UpdateState::none);
  world.run_to(seconds(63));
  INFO(world.hub.dump());
  CHECK(world.hub.update_of("a").state == UpdateState::offered);
  // One siren at a time: b waits for a.
  CHECK(world.hub.update_of("b").state == UpdateState::none);
  confirm_siren(world, *sirens[1], held, seconds(63), 2000);
  world.run_to(seconds(65));
  CHECK(world.hub.update_of("a").state == UpdateState::confirmed);
  CHECK(world.hub.update_of("b").state == UpdateState::offered);
  CHECK_FALSE(world.hub.rollout_done());
  confirm_siren(world, *sirens[2], held, seconds(65), 2000);
  world.run_to(seconds(67));
  CHECK(world.hub.rollout_done());
  const auto done = world.hub.decisions(HubAction::rollout_done);
  REQUIRE(done.size() == 1);
  CHECK(done[0].value == 1);
  // A second rollout is numbered 2, as the hub's rollouts are; its one device is confirmed.
  world.hub.rollout(held.id, {"pilot"});
  const auto again = world.hub.decisions(HubAction::rollout_done);
  REQUIRE(again.size() == 2);
  CHECK(again[1].value == 2);
}

TEST_CASE("a rollout offers sensors up to its limit at once") {
  World world;
  for (const char* name : {"s1", "s2", "s3"}) {
    world.hub.add_sensor(world.board(name));
  }
  const host::HubImage& held = world.hub.add_image(host::make_test_image(kNew, 3000));
  host::RolloutRules rules;
  rules.sensors_at_once = 2;
  world.hub.rollout(held.id, {"s1", "s2", "s3"}, rules);
  CHECK(world.hub.update_of("s1").state == UpdateState::planned);
  CHECK(world.hub.update_of("s2").state == UpdateState::planned);
  CHECK(world.hub.update_of("s3").state == UpdateState::none);
  // One refused for a hold (no Wi-Fi): not a pause, and the next one goes.
  host::ReplayRadio radio(world.sim, "radio");
  const Bytes refused = world.sealed(
      world.sim.device("s1"), 10,
      status_of(held.id, protocol::UpdateStage::refused, protocol::UpdateReason::no_wifi));
  world.sim.schedule(at(seconds(1)), [&]() { static_cast<void>(radio.send(refused, site_dr5())); });
  world.run_to(seconds(2));
  CHECK(world.hub.update_of("s1").state == UpdateState::refused);
  CHECK_FALSE(world.hub.rollout_paused());
  CHECK(world.hub.update_of("s3").state == UpdateState::planned);
  // A refusal of the image itself pauses it.
  const Bytes bad = world.sealed(
      world.sim.device("s2"), 10,
      status_of(held.id, protocol::UpdateStage::refused, protocol::UpdateReason::bad_signature));
  world.sim.schedule(at(seconds(2)), [&]() { static_cast<void>(radio.send(bad, site_dr5())); });
  world.run_to(seconds(3));
  CHECK(world.hub.rollout_paused());
  const auto paused = world.hub.decisions(HubAction::rollout_paused, "s2");
  REQUIRE(paused.size() == 1);
  CHECK(paused[0].value == 1);
  CHECK(world.hub.rollout_pause_reason() == protocol::UpdateReason::bad_signature);
  const auto refusals = world.hub.decisions(HubAction::firmware_refused);
  REQUIRE(refusals.size() == 2);
  CHECK(refusals[0].value == protocol::UpdateReason::no_wifi);
  CHECK(refusals[1].value == protocol::UpdateReason::bad_signature);
}

TEST_CASE("a gateway is offered its update inside its session, after its welcome, and served") {
  Site site(gateway_mode());
  site.add_mode_gateway();
  const host::HubImage& held = site.hub.add_image(host::make_test_image(kNew, 3000));
  site.hub.offer_update("gateway", held.id);
  host::SimDevice& gateway = site.sim.device("gateway");
  site.sim.run_until(at(seconds(3)));
  INFO(site.hub.dump());
  const auto hellos = site.hub.received_from("gateway", protocol::message_type::hello);
  REQUIRE(hellos.size() == 1);
  const auto hello = hellos[0].as<protocol::Hello>();
  const auto welcomes = site.hub.sent_to("gateway", protocol::message_type::welcome);
  REQUIRE(welcomes.size() == 1);
  const auto welcome =
      open_from_hub<protocol::Welcome>(site.hub.key_of("gateway"), welcomes[0].packet,
                                       protocol::Binding::hello(hello.gateway_random));
  REQUIRE(welcome.has_value());
  const auto offers = site.hub.sent_to("gateway", protocol::message_type::update_offer);
  REQUIRE(offers.size() == 1);
  const auto offer = open_from_hub<protocol::UpdateOffer>(
      site.hub.key_of("gateway"), offers[0].packet,
      protocol::Binding::session(hello.gateway_random, welcome->hub_random));
  REQUIRE(offer.has_value());
  CHECK(offer->action == action::fetch);
  CHECK(offer->image_id == held.id);
  site.sim.schedule(at(seconds(3)), [&]() {
    REQUIRE(gateway.board().network.send(view(frame_of(get_of(held.id, 0, 128)))) ==
            device::HalError::none);
  });
  site.sim.run_until(at(seconds(4)));
  REQUIRE(site.hub.transfers().size() == 1);
  CHECK(site.hub.transfers()[0].answer == protocol::transfer_kind::data);
  CHECK(site.hub.transfers()[0].device == "gateway");
}

}  // namespace
}  // namespace hsn::test
