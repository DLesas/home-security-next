// The gateway's part of firmware updates and of the key change (m3-updates-design.md sections 2,
// 5, 6 and 7): the update on its connection (Wi-Fi or USB); healthy once welcomed, its settings
// opened and its continuous receive running; the quiet rule (no flash written while a transmit
// request waits or the radio receives or sends, and an "install now" waiting for the same); its
// refusal off mains; and a Key change in place of the welcome, then a hello under the new key.

#include <algorithm>

#include "gateway_bench.hpp"
#include "hsn/host/test_image.hpp"

namespace hsn::test {
namespace {

using host::HubAction;
using host::RecordKind;
using host::UpdateState;

bool same(const protocol::FirmwareVersion& a, const protocol::FirmwareVersion& b) {
  return a.major == b.major && a.minor == b.minor && a.patch == b.patch;
}

TEST_CASE("a gateway updates on its link: Wi-Fi or USB; healthy once welcomed, set and listening") {
  for (const bool usb : {false, true}) {
    CAPTURE(usb);
    Site site(gateway_mode());
    host::GatewayConfig config;
    config.usb = usb;
    config.network = !usb;
    host::SimDevice& gateway = add_gateway(site, "gateway", config);
    const host::HubImage& image = site.hub.add_image(host::make_test_image(kNewImage, 30000));
    site.hub.offer_update("gateway", image.id);
    site.sim.run_until(at(seconds(60)));
    INFO(gateway.records().dump() << site.hub.dump());
    CHECK(site.hub.update_of("gateway").state == UpdateState::confirmed);
    CHECK(same(gateway.boot_choice().image.version, kNewImage));
    CHECK_FALSE(gateway.board().slots.running().on_trial);
    // Every status on the connection's link.
    std::vector<std::uint8_t> stages;
    for (const host::HubPacket& packet : site.hub.received_from("gateway", type::update_status)) {
      stages.push_back(packet.as<protocol::UpdateStatus>().stage);
      CHECK(packet.path == host::HubPath::link);
    }
    CHECK(stages == std::vector<std::uint8_t>{protocol::UpdateStage::verified,
                                              protocol::UpdateStage::installing,
                                              protocol::UpdateStage::confirmed});
    // Confirmed only after the new image was welcomed and given its settings.
    const auto restarts = gateway.records().kind(RecordKind::restart).records();
    REQUIRE(restarts.size() == 1);
    const auto confirm = gateway.records().kind(RecordKind::otadata_write).records().back();
    const auto welcomed = site.hub.decisions(HubAction::gateway_welcomed, "gateway");
    REQUIRE(welcomed.size() == 2);
    CHECK(welcomed[1].at > restarts[0].at);
    const auto settings = site.hub.decisions(HubAction::gateway_settings, "gateway");
    REQUIRE(settings.size() >= 2);
    CHECK(confirm.at >= welcomed[1].at);
    CHECK(confirm.at >= settings.back().at);
    CHECK(gateway.board().slots.writes_on_trial() == 0);
  }
}

TEST_CASE("the gateway's trial waits for its receive to start: a radio that refuses it holds it") {
  Site site(gateway_mode());
  host::SimDevice& gateway = add_gateway(site, "gateway");
  const host::HubImage& image = site.hub.add_image(host::make_test_image(kNewImage, 30000));
  site.hub.offer_update("gateway", image.id);
  for (double t = 0.2; t < 30; t += 0.01) {
    site.sim.run_until(at(device::microseconds(static_cast<std::int64_t>(t * 1e6))));
    if (gateway.records().kind(RecordKind::restart).count() == 1) {
      break;
    }
  }
  REQUIRE(gateway.records().kind(RecordKind::restart).count() == 1);
  // The new image's radio refuses every call until 40 s: welcomed and set, but not listening.
  gateway.board().radio.refuse_all = true;
  site.sim.schedule(at(seconds(40)), [&]() { gateway.board().radio.refuse_all = false; });
  site.sim.run_until(at(seconds(39)));
  INFO(gateway.records().dump() << site.hub.dump());
  CHECK(site.hub.decisions(HubAction::gateway_welcomed, "gateway").size() == 2);
  CHECK(gateway.board().slots.running().on_trial);
  site.sim.run_until(at(seconds(60)));
  CHECK_FALSE(gateway.board().slots.running().on_trial);
  CHECK(gateway.records().kind(RecordKind::otadata_write).records().back().at >= at(seconds(40)));
  CHECK(site.hub.update_of("gateway").state == UpdateState::confirmed);
}

TEST_CASE("off mains, the gateway refuses to fetch with the reason battery") {
  Site site(gateway_mode());
  host::SimDevice& gateway = add_gateway(site, "gateway");
  gateway.board().power.external = false;
  const host::HubImage& image = site.hub.add_image(host::make_test_image(kNewImage, 30000));
  site.hub.offer_update("gateway", image.id);
  site.sim.run_until(at(seconds(20)));
  INFO(site.hub.dump());
  const auto got = site.hub.received_from("gateway", type::update_status);
  REQUIRE(got.size() == 1);
  const auto status = got[0].as<protocol::UpdateStatus>();
  CHECK(status.stage == protocol::UpdateStage::refused);
  CHECK(status.reason == protocol::UpdateReason::battery);
  CHECK(status.image_id == image.id);
  CHECK(site.hub.transfers().empty());
}

TEST_CASE(
    "the quiet rule: no flash while a request waits for its moment, then it is sent on time") {
  UpdateLinkSite world;
  LinkSite& site = world.site;
  const SignedImage image;
  site.hub.file = &image.file;
  site.sim.run_until(at(seconds(2)));
  // A request for 10 s, then the offer: the download may fetch, but not write, until it is sent.
  const host::Bytes packet = opaque_packet(0x1A2B3C4D, 900);
  const std::uint32_t request = site.hub.send_request(
      site.hub.request(protocol::TransmitWhen::at_time, gateway_time(at(seconds(10))), packet));
  site.hub.send(offer_of(protocol::UpdateAction::fetch, image));
  site.sim.run_until(at(seconds(30)));
  INFO(site.gateway.records().dump());
  const auto result = site.hub.result_for(request);
  REQUIRE(result.has_value());
  CHECK(result->result == protocol::TransmitOutcome::sent);
  const auto sent = site.gateway.records().kind(RecordKind::transmission).records();
  REQUIRE(sent.size() == 1);
  CHECK(sent[0].from == at(seconds(10)));
  // Pieces came before it was sent, but no sector was erased or written until it was.
  CHECK(std::any_of(site.hub.gets.begin(), site.hub.gets.end(),
                    [](device::Instant get) { return get < at(seconds(10)); }));
  const auto writes =
      site.gateway.records().kind(RecordKind::slot_erase).kind(RecordKind::slot_write).records();
  REQUIRE_FALSE(writes.empty());
  for (const host::Record& write : writes) {
    CHECK(write.at >= sent[0].until);
  }
  const auto statuses = link_statuses(site.hub);
  REQUIRE_FALSE(statuses.empty());
  CHECK(statuses.back().stage == protocol::UpdateStage::verified);
}

TEST_CASE("the quiet rule: no flash while a packet is being received") {
  UpdateLinkSite world;
  LinkSite& site = world.site;
  const SignedImage image(60000);
  site.hub.file = &image.file;
  // Long packets the gateway hears, one after another, through the download.
  std::vector<Burst> bursts;
  for (int i = 0; i < 40; ++i) {
    bursts.push_back(Burst{at(seconds(2) + device::milliseconds(300 * i)),
                           opaque_packet(0x1A2B3C4D, 1000 + static_cast<std::uint32_t>(i), 120)});
  }
  add_talker(site.sim, "talker", bursts);
  site.sim.schedule(at(seconds(2)),
                    [&]() { site.hub.send(offer_of(protocol::UpdateAction::fetch, image)); });
  site.sim.run_until(at(seconds(30)));
  INFO(site.gateway.records().dump());
  const auto receptions = site.gateway.records().kind(RecordKind::reception).records();
  REQUIRE(receptions.size() >= 10);
  const auto writes =
      site.gateway.records().kind(RecordKind::slot_erase).kind(RecordKind::slot_write).records();
  REQUIRE_FALSE(writes.empty());
  std::size_t during = 0;
  for (const host::Record& write : writes) {
    for (const host::Record& heard : receptions) {
      // From its header (20.25 symbols at DR5, about 21 ms, after its start) to its end.
      during += write.at > heard.from + device::milliseconds(25) && write.at < heard.until ? 1 : 0;
    }
  }
  CHECK(during == 0);
  // And every packet heard was forwarded.
  CHECK(site.hub.forwarded().size() == receptions.size());
  CHECK(link_statuses(site.hub).back().stage == protocol::UpdateStage::verified);
}

TEST_CASE("an install the hub allows while a request waits: it waits for the request to go") {
  UpdateLinkSite world;
  LinkSite& site = world.site;
  const SignedImage image;
  site.hub.file = &image.file;
  site.sim.schedule(at(seconds(2)),
                    [&]() { site.hub.send(offer_of(protocol::UpdateAction::fetch, image)); });
  site.sim.run_until(at(seconds(10)));
  REQUIRE_FALSE(link_statuses(site.hub).empty());
  REQUIRE(link_statuses(site.hub).back().stage == protocol::UpdateStage::verified);
  const host::Bytes packet = opaque_packet(0x1A2B3C4D, 901);
  const std::uint32_t request = site.hub.send_request(
      site.hub.request(protocol::TransmitWhen::at_time, gateway_time(at(seconds(15))), packet));
  site.hub.send(offer_of(protocol::UpdateAction::install_now, image));
  site.sim.run_until(at(seconds(30)));
  INFO(site.gateway.records().dump());
  const auto result = site.hub.result_for(request);
  REQUIRE(result.has_value());
  CHECK(result->result == protocol::TransmitOutcome::sent);
  const auto restarts = site.gateway.records().kind(RecordKind::restart).records();
  REQUIRE(restarts.size() == 1);
  const auto sent = site.gateway.records().kind(RecordKind::transmission).records();
  REQUIRE(sent.size() == 1);
  CHECK(restarts[0].at >= sent[0].until);
  // Installing went before the restart; the new image, welcomed and set by LinkHub, confirmed.
  std::vector<std::uint8_t> stages;
  for (const protocol::UpdateStatus& status : link_statuses(site.hub)) {
    stages.push_back(status.stage);
  }
  CHECK(stages == std::vector<std::uint8_t>{protocol::UpdateStage::verified,
                                            protocol::UpdateStage::installing,
                                            protocol::UpdateStage::confirmed});
}

TEST_CASE("after a restore, a Key change in place of the welcome, then a hello under the new key") {
  for (const bool usb : {false, true}) {
    CAPTURE(usb);
    Site site(gateway_mode());
    host::GatewayConfig config;
    config.usb = usb;
    config.network = !usb;
    host::SimDevice& gateway = add_gateway(site, "gateway", config);
    site.sim.run_until(at(seconds(10)));
    site.hub.restore(site.hub.snapshot());
    // The gateway's next connection says hello under its old key.
    site.hub.drop_link("gateway", usb ? device::LinkKind::usb : device::LinkKind::network);
    if (usb) {
      // A USB port the hub closed: the computer is there again a second later.
      site.sim.schedule(at(seconds(11)), [&]() {
        site.hub.drop_link("gateway", device::LinkKind::usb, device::Duration{});
      });
    }
    site.sim.run_until(at(seconds(60)));
    INFO(gateway.records().dump() << site.hub.dump());
    CHECK_FALSE(site.hub.rekey_pending("gateway"));
    const auto changes = site.hub.sent_to("gateway", type::key_change);
    REQUIRE(changes.size() == 1);
    const auto switched = site.hub.decisions(HubAction::key_changed, "gateway");
    REQUIRE(switched.size() == 1);
    // The Key change was no welcome: the gateway said hello again, under the new key, from 1,024,
    // and was welcomed then.
    const auto hellos = site.hub.received_from("gateway", type::hello);
    REQUIRE_FALSE(hellos.empty());
    CHECK(hellos.back().counter == 1024);
    CHECK(hellos.back().at - changes[0].at < seconds(3));
    const auto welcomed = site.hub.decisions(HubAction::gateway_welcomed, "gateway");
    REQUIRE(welcomed.size() >= 2);
    CHECK(welcomed.back().at >= switched[0].at);
    // It forwards again under the new session.
    CHECK(gateway_of(gateway).state().connection.phase ==
          roles::gateway::ConnectionPhase::connected);
  }
}

}  // namespace
}  // namespace hsn::test
