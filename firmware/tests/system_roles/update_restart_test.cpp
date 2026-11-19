// A hub restart at each stage of a rollout, through the real hub in lockstep (m3-updates-design.md
// section 8, "Through the real hub in lockstep"; section 4, "After a hub restart"; section 6, "The
// hub loses power at any stage"): the hub killed (a power cut: nothing more committed) when a
// sensor has been offered its update, in the middle of its download, after its go-ahead, on its
// trial, and in the soak after it; and when a siren and a gateway are on trial. The rollout goes on
// from its stage, the device resumes from its checkpoint, and every device ends confirmed. On the
// real hub only, with the real roles.

#ifdef HSN_LOCKSTEP

#include <memory>

#include "update_site.hpp"

namespace hsn::test::system {
namespace {

/** How long the hub is down. */
constexpr Duration kDown = seconds(3);
/** A slow Wi-Fi link for the sensor, so the hub can die in the middle of its download. */
constexpr Duration kSlowLink = milliseconds(400);

enum class Stage : std::uint8_t { offered, fetching, installing, on_trial, soak };

const char* stage_name(Stage stage) {
  switch (stage) {
    case Stage::offered:
      return "offered";
    case Stage::fetching:
      return "fetching";
    case Stage::installing:
      return "installing";
    case Stage::on_trial:
      return "on trial";
    case Stage::soak:
      return "soak";
  }
  return "?";
}

/** True once `name` has reached `stage` on the hub's records. */
bool reached(const host::RemoteHub& hub, const std::string& name, Stage stage) {
  switch (stage) {
    case Stage::offered:
      return !hub.decisions(HubAction::firmware_offer, name).empty();
    case Stage::fetching:
      return served(hub, name).data >= 6;
    case Stage::installing:
      return !hub.decisions(HubAction::firmware_installing, name).empty();
    case Stage::on_trial:
      return !hub.decisions(HubAction::firmware_on_trial, name).empty();
    case Stage::soak:
      return !hub.decisions(HubAction::firmware_confirmed, name).empty();
  }
  return false;
}

TEST_CASE(
    "D139 section 6: the hub killed at each stage of a sensor's update; the rollout goes on") {
  for (const Stage stage :
       {Stage::offered, Stage::fetching, Stage::installing, Stage::on_trial, Stage::soak}) {
    const std::string stage_text = stage_name(stage);
    CAPTURE(stage_text);
    SystemSite site;
    site.gateway("gateway");
    host::SimDevice& pilot = site.sensor("door0");
    host::SimDevice& other = site.sensor("door1");
    site.run_until(at_s(20));
    site.hub.set_network_latency("door0", kSlowLink);
    const host::RemoteImage& image =
        site.hub.add_own_build(host::make_test_image(kNewVersion, 60000), kNewVersion);
    site.hub.rollout_start(image.id, {"door0", "door1"}, {"door0"});
    INFO(site.dump());
    REQUIRE(run_until_true(
        site, at_s(30 * 60), [&]() { return reached(site.hub, "door0", stage); },
        milliseconds(10)));
    const Instant killed = site.sim.now();
    const std::size_t written = pilot.records().kind(RecordKind::slot_write).count();
    site.hub.kill();
    site.run_until(killed + kDown);
    site.hub.start();
    // The pilot, the soak after it, then the other sensor. A sensor offered Wi-Fi as the hub died
    // finds no hub (noWifi), and the hub does not try Wi-Fi again for it in this rollout (section
    // 4, "Choosing the method"): it needs a phone, and gets one.
    std::unique_ptr<host::ScriptPhone> phone;
    const Instant until = killed + kSoak + seconds(30 * 60);
    while (site.sim.now() < until) {
      site.run_until(std::min(until, site.sim.now() + seconds(30)));
      const json::Value row = site.hub.update_of("door0");
      if (phone == nullptr && !row.is_null() && !row.at("held").is_null() &&
          row.at("held").as_string() == "needsPhone") {
        phone = std::make_unique<host::ScriptPhone>(site.sim, pilot,
                                                    site.hub.firmware_bluetooth("door0"));
      }
    }
    CHECK((phone == nullptr) == (stage != Stage::offered));
    CHECK(runs_new_confirmed(pilot));
    CHECK(runs_new_confirmed(other));
    CHECK(site.hub.update_state("door0") == kConfirmed);
    CHECK(site.hub.update_state("door1") == kConfirmed);
    CHECK(site.hub.decisions(HubAction::rollout_done).size() == 1);
    CHECK(site.hub.decisions(HubAction::firmware_rolled_back).empty());
    CHECK(site.hub.decisions(HubAction::firmware_refused).empty());
    // Resumed from its checkpoint: the download after the restart wrote at most the image again
    // from its last checkpoint (64 KB ‡ apart: for a 60 KB image, from the start), never twice.
    const std::size_t sectors = (60000 + 4095) / 4096 + 1;
    CHECK(pilot.records().kind(RecordKind::slot_write).count() <= written + sectors);
    // The soak counts from the pilot's confirmation, the restart in it or not.
    const Instant confirmed = first(site.hub, HubAction::firmware_confirmed, "door0");
    for (const host::HubDecision& offer : site.hub.decisions(HubAction::firmware_offer, "door1")) {
      if (offer.value >= 1 && offer.value <= 3) {
        CHECK(offer.at >= confirmed + kSoak);
      }
    }
    CHECK(critical_events(site.hub).empty());
  }
}

/** The hub killed while `name` (the siren or the gateway, on Wi-Fi) is on trial, then started. */
void kill_at(const std::string& name, Stage stage) {
  {
    SystemSite site;
    host::SimDevice& gateway = site.gateway("gateway");
    host::SimDevice& siren = site.siren("siren");
    site.run_until(at_s(20));
    const host::RemoteImage& image =
        site.hub.add_own_build(host::make_test_image(kNewVersion, 60000), kNewVersion);
    site.hub.rollout_start(image.id, {name}, {name});
    INFO(site.dump());
    REQUIRE(run_until_true(
        site, at_s(30 * 60), [&]() { return reached(site.hub, name, stage); }, milliseconds(10)));
    const Instant killed = site.sim.now();
    site.hub.kill();
    site.run_until(killed + kDown);
    site.hub.start();
    // The siren's trial is proven by the "report now" the restarted hub owes every siren (§7 "Hub
    // restart"); the gateway's by its new hello's welcome and settings.
    while (site.sim.now() < killed + seconds(10 * 60)) {
      site.run_until(site.sim.now() + seconds(10));
    }
    host::SimDevice& device = name == "siren" ? siren : gateway;
    CHECK(runs_new_confirmed(device));
    CHECK(site.hub.update_state(name) == kConfirmed);
    CHECK(site.hub.decisions(HubAction::firmware_rolled_back).empty());
    CHECK(critical_events(site.hub).empty());
  }
}

TEST_CASE("D139 section 6: the hub killed while a gateway is on trial; it confirms after") {
  kill_at("gateway", Stage::on_trial);
}

TEST_CASE(
    "D139 section 4 'After a hub restart': the hub killed just after a gateway's offer; offered "
    "again when it reconnects, it updates") {
  kill_at("gateway", Stage::offered);
}

TEST_CASE(
    "D139 section 4 'After a hub restart': the hub killed just after a siren's offer; offered "
    "again when it reconnects, it updates") {
  kill_at("siren", Stage::offered);
}

TEST_CASE(
    "D139 section 6 §7: the hub killed while a siren is on trial; it confirms "
    "after") {
  kill_at("siren", Stage::on_trial);
}

TEST_CASE(
    "§7 Hub restart: the hub killed and started again; a gateway on USB says hello again and "
    "forwards") {
  SystemSite site;
  host::GatewayConfig usb;
  usb.usb = true;
  usb.network = false;
  site.gateway("gateway", usb);
  host::SimDevice& door = site.sensor("door0");
  site.run_until(at_s(20));
  const Instant killed = site.sim.now();
  site.hub.kill();
  site.run_until(killed + kDown);
  site.hub.start();
  site.run_until(killed + seconds(5 * 60));
  INFO(site.dump());
  CHECK(site.hub.decisions_named("gateway_offline", "gateway").empty());
  CHECK_FALSE(decisions_since(site.hub, HubAction::gateway_welcomed, killed, "gateway").empty());
  // Its forwarding works: the sensor's heartbeats reach the new hub.
  bool heard = false;
  for (const host::HubPacket& packet : site.hub.received_from("door0", type::heartbeat)) {
    heard = heard || packet.at > killed + kDown;
  }
  CHECK(heard);
  static_cast<void>(door);
}

}  // namespace
}  // namespace hsn::test::system

#endif
