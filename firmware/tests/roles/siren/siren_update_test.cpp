// The siren's part of firmware updates and of the key change (m3-updates-design.md sections 2, 5,
// 6 and 7): offers and Key changes under the command rule on either path, never read as settings;
// the update on its own Wi-Fi link, statuses on LoRa when Wi-Fi cannot carry them; its refusal off
// mains; an install that waits for the output to stop; healthy only once a command or settings
// packet opened and one LoRa transmission completed; commands acted on and answered throughout;
// and after a restore a report under the new key on the path the Key change came by.

#include <algorithm>

#include "hsn/device/services/record.hpp"
#include "hsn/device/services/setup.hpp"
#include "hsn/host/replay_radio.hpp"
#include "hsn/host/test_image.hpp"
#include "hsn/psa/psa_packet_cipher.hpp"
#include "siren_support.hpp"

namespace hsn::test::siren {
namespace {

using host::UpdateState;

const protocol::FirmwareVersion kNew{1, 4, 0};

bool same(const protocol::FirmwareVersion& a, const protocol::FirmwareVersion& b) {
  return a.major == b.major && a.minor == b.minor && a.patch == b.patch;
}

/** A siren on mains (the condition for an update), with an image of 1.4.0 at the hub. */
struct UpdateSite {
  explicit UpdateSite(host::HubOptions options = {}, std::size_t image_bytes = 30000)
      : site(options) {
    site.siren.board().power.external = true;
    image = &site.hub.add_image(host::make_test_image(kNew, image_bytes));
  }
  SirenSite site;
  const host::HubImage* image = nullptr;
};

/** The siren's update statuses as the hub had them, with how each came. */
std::vector<host::HubPacket> statuses(const SirenSite& site) {
  return site.hub.received_from("siren", type::update_status);
}

/** The instant of the board's last otadata write: the trial's confirmation. */
device::Instant confirmed_at(host::SimDevice& device) {
  const auto writes = device.records().kind(RecordKind::otadata_write).records();
  REQUIRE_FALSE(writes.empty());
  return writes.back().at;
}

/** The siren's address and key, from the pairing record its flash holds. */
device::PairingRecord pairing_of(host::SimDevice& device) {
  device::Record<device::PairingRecord> record(device.board().storage, device::StoreKey::pairing,
                                               device::kPairingRecordVersion, {});
  REQUIRE(record.load() == device::HalError::none);
  return record.get();
}

/** A packet from the hub, sealed with the siren's key, no binding, `counter` (the command rule). */
template <typename M>
host::Bytes forged(host::SimDevice& device, const M& message, std::uint32_t counter,
                   protocol::PacketLimit limit = protocol::PacketLimit::radio) {
  const device::PairingRecord pairing = pairing_of(device);
  psa::PsaPacketCipher cipher;
  REQUIRE(cipher.set_key(pairing.key) == protocol::Error::none);
  host::Bytes plain(protocol::kMaxLinkPacketSize);
  const auto size =
      protocol::encode_plaintext(message, protocol::MutableByteView(plain.data(), plain.size()));
  REQUIRE(size.ok());
  host::Bytes packet(protocol::kMaxLinkPacketSize);
  const auto sealed = protocol::seal_packet(
      cipher, {protocol::Direction::from_hub, pairing.address, counter}, protocol::Binding::none(),
      protocol::ByteView(plain.data(), size.value()), limit,
      protocol::MutableByteView(packet.data(), packet.size()));
  REQUIRE(sealed.ok());
  packet.resize(sealed.value());
  return packet;
}

TEST_CASE("a siren updates on its Wi-Fi link: fetched, verified, installed, confirmed on trial") {
  UpdateSite world;
  SirenSite& site = world.site;
  site.hub.offer_update("siren", world.image->id);
  site.run_until(seconds(90));
  INFO(site.dump());
  CHECK(site.hub.update_of("siren").state == UpdateState::confirmed);
  CHECK(same(site.siren.boot_choice().image.version, kNew));
  CHECK_FALSE(site.siren.board().slots.running().on_trial);
  // Every status went on Wi-Fi: verified, installing, confirmed.
  std::vector<std::uint8_t> stages;
  for (const host::HubPacket& packet : statuses(site)) {
    stages.push_back(packet.as<protocol::UpdateStatus>().stage);
    CHECK(packet.path == HubPath::link);
  }
  CHECK(stages == std::vector<std::uint8_t>{protocol::UpdateStage::verified,
                                            protocol::UpdateStage::installing,
                                            protocol::UpdateStage::confirmed});
  // Healthy only once the hub's "report now" opened and a LoRa transmission completed after the
  // new image's start.
  const auto restarts = site.siren.records().kind(RecordKind::restart).records();
  REQUIRE(restarts.size() == 1);
  const device::Instant confirmed = confirmed_at(site.siren);
  const auto lora = site.siren.records()
                        .kind(RecordKind::transmission)
                        .between(restarts[0].at, confirmed + milliseconds(1))
                        .records();
  REQUIRE_FALSE(lora.empty());
  CHECK(lora.front().until <= confirmed);
  const auto report_now = site.hub.decisions(HubAction::siren_command, "siren");
  REQUIRE_FALSE(report_now.empty());
  CHECK(report_now.back().at < confirmed);
  CHECK(site.siren.board().slots.writes_on_trial() == 0);
}

TEST_CASE("the siren's trial: no LoRa transmission completed, no confirmation; then one") {
  UpdateSite world;
  SirenSite& site = world.site;
  site.hub.offer_update("siren", world.image->id);
  // From the restart on, every radio call fails until 60 s: no LoRa transmission completes, though
  // "report now" opens on Wi-Fi.
  for (double t = 0.5; t < 40; t += 0.01) {
    site.run_until(device::microseconds(static_cast<std::int64_t>(t * 1e6)));
    if (site.siren.records().kind(RecordKind::restart).count() == 1) {
      break;
    }
  }
  REQUIRE(site.siren.records().kind(RecordKind::restart).count() == 1);
  site.siren.board().radio.refuse_all = true;
  site.sim.schedule(at(seconds(60)), [&]() { site.siren.board().radio.refuse_all = false; });
  site.run_until(seconds(59));
  INFO(site.dump());
  CHECK(site.siren.board().slots.running().on_trial);
  CHECK(site.hub.decisions(HubAction::siren_confirmed, "siren").size() >= 1);
  site.run_until(seconds(120));
  CHECK_FALSE(site.siren.board().slots.running().on_trial);
  CHECK(confirmed_at(site.siren) > at(seconds(60)));
  CHECK(site.hub.update_of("siren").state == UpdateState::confirmed);
}

TEST_CASE("the siren's trial: LoRa works but no hub packet opens, so it rolls back at 5 minutes") {
  UpdateSite world;
  SirenSite& site = world.site;
  site.hub.offer_update("siren", world.image->id);
  for (double t = 0.5; t < 40; t += 0.01) {
    site.run_until(device::microseconds(static_cast<std::int64_t>(t * 1e6)));
    if (site.siren.records().kind(RecordKind::restart).count() == 1) {
      break;
    }
  }
  const device::Instant restart = site.siren.records().kind(RecordKind::restart).records()[0].at;
  // The hub's packets reach it on neither path: its "report now" is lost on both.
  site.hub.drop_link("siren", device::LinkKind::network);
  site.sim.medium().cut(site.hub.station(), site.siren.station());
  site.siren.board().network.fail_connect = true;
  site.run_until(restart - at(device::Duration{}) + seconds(4 * 60 + 50));
  INFO(site.dump());
  CHECK(site.siren.board().slots.running().on_trial);
  // It sent on LoRa meanwhile (its Started, and its reports with Wi-Fi down).
  CHECK(site.siren.records()
            .kind(RecordKind::transmission)
            .between(restart, site.sim.now())
            .count() >= 1);
  site.run_until(restart - at(device::Duration{}) + seconds(5 * 60 + 5));
  CHECK_FALSE(same(site.siren.boot_choice().image.version, kNew));
  CHECK(site.siren.boot_choice().image.rolled_back);
}

TEST_CASE("off mains, the siren refuses to fetch with the reason battery, and fetches nothing") {
  UpdateSite world;
  SirenSite& site = world.site;
  site.siren.board().power.external = false;
  site.hub.offer_update("siren", world.image->id);
  site.run_until(seconds(30));
  INFO(site.dump());
  const auto got = statuses(site);
  REQUIRE(got.size() == 1);
  CHECK(got[0].path == HubPath::link);
  const auto status = got[0].as<protocol::UpdateStatus>();
  CHECK(status.stage == protocol::UpdateStage::refused);
  CHECK(status.reason == protocol::UpdateReason::battery);
  CHECK(status.image_id == world.image->id);
  CHECK(site.hub.transfers().empty());
  CHECK(site.siren.records().kind(RecordKind::slot_write).count() == 0);
}

TEST_CASE("an install that comes while the siren sounds waits for the output to stop") {
  UpdateSite world;
  SirenSite& site = world.site;
  // A test sound of 40 s from 1 s; the image is verified well before it ends.
  site.command_at(seconds(1), action::test, 40);
  site.sim.schedule(at(seconds(2)), [&]() { site.hub.offer_update("siren", world.image->id); });
  site.run_until(seconds(90));
  INFO(site.dump());
  const auto outputs = site.outputs();
  REQUIRE(outputs.size() >= 2);
  CHECK(outputs[0].second);
  CHECK_FALSE(outputs[1].second);
  // It sounded its whole 40 s, then restarted into the new image.
  CHECK(outputs[1].first - outputs[0].first >= seconds(40));
  const auto restarts = site.siren.records().kind(RecordKind::restart).records();
  REQUIRE(restarts.size() == 1);
  CHECK(restarts[0].at >= outputs[1].first);
  const auto go_ahead = site.hub.decisions(HubAction::firmware_installing, "siren");
  REQUIRE_FALSE(go_ahead.empty());
  CHECK(go_ahead[0].at < outputs[1].first);
  CHECK(site.hub.update_of("siren").state == UpdateState::confirmed);
}

TEST_CASE("during a download, a command sounds the siren and is answered on both paths") {
  UpdateSite world(host::HubOptions{}, 60000);
  SirenSite& site = world.site;
  site.hub.offer_update("siren", world.image->id);
  // The download runs from about 0.1 s to 1.1 s.
  const device::Instant command = at(milliseconds(500));
  site.command_at(milliseconds(500), action::sound_alarm, 20);
  site.run_until(seconds(60));
  INFO(site.dump());
  bool before = false;
  bool after = false;
  for (const host::HubTransfer& transfer : site.hub.transfers()) {
    before = before || transfer.at < command;
    after = after || transfer.at > command + milliseconds(100);
  }
  CHECK(before);
  CHECK(after);
  const auto outputs = site.outputs();
  REQUIRE_FALSE(outputs.empty());
  CHECK(outputs[0].second);
  // Sounding within the link's latency of the command.
  CHECK(outputs[0].first - command < milliseconds(100));
  CHECK_FALSE(site.reports(reason::command_answer, HubPath::link).empty());
  CHECK_FALSE(site.reports(reason::command_answer, HubPath::radio).empty());
  CHECK(site.hub.decisions(HubAction::siren_confirmed, "siren").size() >= 1);
}

TEST_CASE("an update offer and a Key change are never read as settings") {
  UpdateSite world;
  SirenSite& site = world.site;
  site.run_until(seconds(5));
  const roles::siren::SirenSettingsHeld before = site.role().state().settings;
  // An offer to discard (nothing held) and a Key change to the key it holds, on LoRa, with
  // counters above the hub's: both open under the command rule.
  host::ReplayRadio radio(site.sim);
  protocol::UpdateOffer offer;
  offer.action = protocol::UpdateAction::nothing;
  protocol::KeyChange change;
  change.new_key = pairing_of(site.siren).key;
  const device::RadioChannel channel{device::kReplyFrequencyHz, protocol::DataRate::dr5};
  site.sim.schedule(at(seconds(6)),
                    [&]() { radio.send(forged(site.siren, offer, 5000), channel); });
  site.sim.schedule(at(seconds(7)),
                    [&]() { radio.send(forged(site.siren, change, 5001), channel); });
  site.run_until(seconds(10));
  INFO(site.dump());
  CHECK(site.siren.board().storage.write_count(device::StoreKey::command_counter) >= 2);
  const roles::siren::SirenSettingsHeld after = site.role().state().settings;
  CHECK(std::memcmp(&before, &after, sizeof(before)) == 0);
  // Neither is answered with a report, and the same key changes nothing.
  for (const HubReport& report : site.reports(reason::command_answer)) {
    CHECK(report.at < at(seconds(6)));
  }
  CHECK(site.logged(siren_log::body_dropped).empty());
}

TEST_CASE("a status Wi-Fi cannot carry goes on LoRa: the siren's refusal off mains, Wi-Fi down") {
  UpdateSite world;
  SirenSite& site = world.site;
  site.siren.board().power.external = false;
  site.run_until(seconds(5));
  site.hub.drop_link("siren", device::LinkKind::network);
  site.siren.board().network.fail_connect = true;
  host::ReplayRadio radio(site.sim);
  protocol::UpdateOffer offer;
  offer.action = protocol::UpdateAction::fetch;
  offer.image_id = world.image->id;
  site.sim.schedule(at(seconds(8)), [&]() {
    radio.send(forged(site.siren, offer, 5000),
               device::RadioChannel{device::kReplyFrequencyHz, protocol::DataRate::dr5});
  });
  site.run_until(seconds(20));
  INFO(site.dump());
  const auto got = statuses(site);
  REQUIRE(got.size() == 1);
  CHECK(got[0].path == HubPath::radio);
  CHECK(got[0].as<protocol::UpdateStatus>().reason == protocol::UpdateReason::battery);
  CHECK(site.on_air(type::update_status).count() == 1);
}

TEST_CASE("after a restore, the siren changes its key and reports on the Key change's path") {
  SirenSite site;
  site.run_until(seconds(10));
  const host::HubSnapshot backup = site.hub.snapshot();
  site.hub.restore(backup);
  site.command_at(seconds(30), action::test, 2);
  site.run_until(seconds(40));
  INFO(site.dump());
  CHECK_FALSE(site.hub.rekey_pending("siren"));
  const auto changes = site.hub.sent_to("siren", type::key_change);
  REQUIRE(changes.size() >= 2);
  const auto switched = site.hub.decisions(HubAction::key_changed, "siren");
  REQUIRE(switched.size() == 1);
  // The first packet under the new key: a report answering the Key change (reason 1), at 1,024,
  // on the path the Key change came by first (Wi-Fi: 25 ms against a LoRa packet's airtime).
  std::optional<host::HubPacket> first;
  for (const host::HubPacket& packet : site.hub.received()) {
    if (packet.from == "siren" && packet.verdict == host::HubVerdict::accepted &&
        packet.at >= switched[0].at && !first) {
      first = packet;
    }
  }
  REQUIRE(first.has_value());
  CHECK(first->counter == 1024);
  CHECK(first->path == HubPath::link);
  REQUIRE(first->type == type::siren_report);
  CHECK(first->as<protocol::SirenReport>().reason == reason::command_answer);
  CHECK(first->at - changes[0].at < milliseconds(100));
  // The other copy, under the old key, failed its tag: logged, nothing else.
  CHECK_FALSE(site.logged(siren_log::packet_dropped).empty());
  // Its command counter restarted with the key: the test at 30 s, from a low counter, sounds.
  bool sounded = false;
  for (const auto& output : site.outputs()) {
    sounded = sounded || (output.second && output.first >= at(seconds(30)));
  }
  CHECK(sounded);
  for (const host::HubPacket& packet : site.hub.received()) {
    if (packet.from == "siren" && packet.verdict == host::HubVerdict::old_key) {
      // Nothing under the old key after the change.
      CHECK(packet.at <= switched[0].at);
    }
  }
}

}  // namespace
}  // namespace hsn::test::siren
