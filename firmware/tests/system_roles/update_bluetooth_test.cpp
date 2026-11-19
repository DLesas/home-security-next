// A sensor out of Wi-Fi range updated from a phone over Bluetooth, through the real hub in
// lockstep (m3-updates-design.md section 8: update_bluetooth_test.cpp; section 5, "Over Bluetooth
// from the phone"; UP6, D138): the hub holds it as needing a phone, `firmware.bluetooth` gives the
// phone the session key, the sensor learns of the session at its next reply and opens Bluetooth on
// the hub's offer alone; ScriptPhone serves the file; the hub gives the go-ahead. A phone with the
// wrong key opens nothing. On the real hub only, with the real roles.

#ifdef HSN_LOCKSTEP

#include <memory>

#include "update_site.hpp"

namespace hsn::test::system {
namespace {

/** A sensor out of Wi-Fi range, the hub's rollout to it, and the hold that says it needs a phone.
 */
struct PhoneSite {
  PhoneSite() {
    site.gateway("gateway");
    host::SensorConfig far;
    far.wifi_in_range = false;
    door = &site.sensor("door", far);
    site.run_until(at_s(20));
    image = &site.hub.add_own_build(host::make_test_image(kNewVersion, 60000), kNewVersion);
    site.hub.rollout_start(image->id, {"door"}, {"door"});
    needs_phone = run_until_true(
        site, at_s(20 * 60),
        [&]() {
          const json::Value row = site.hub.update_of("door");
          return !row.is_null() && !row.at("held").is_null() &&
                 row.at("held").as_string() == "needsPhone";
        },
        seconds(10));
  }

  SystemSite site;
  host::SimDevice* door = nullptr;
  const host::RemoteImage* image = nullptr;
  bool needs_phone = false;
};

TEST_CASE(
    "UP6 D138: a sensor out of Wi-Fi range is held as needing a phone, and updated from one with "
    "the session firmware.bluetooth gives") {
  PhoneSite world;
  SystemSite& site = world.site;
  INFO(site.dump());
  REQUIRE(world.needs_phone);
  // Bluetooth stayed off until the hub said so (PR3): nothing advertised yet.
  CHECK_FALSE(world.door->wire(device::LinkKind::bluetooth).advertising());
  const Instant asked = site.sim.now();
  host::ScriptPhone phone(site.sim, *world.door, site.hub.firmware_bluetooth("door"));
  CHECK(site.hub.decisions_named("firmware_session_opened", "door").size() == 1);
  // The sensor learns at its next reply, opens Bluetooth on the offer (action 3), the phone serves.
  site.run_until(asked + seconds(10 * 60));
  REQUIRE(phone.done.has_value());
  CHECK(phone.done->result == protocol::DoneResult::verified);
  CHECK(phone.served_to == world.image->file.size());
  CHECK(phone.wrong_opens == 0);
  bool offered_bluetooth = false;
  for (const host::HubDecision& offer : site.hub.decisions(HubAction::firmware_offer, "door")) {
    offered_bluetooth = offered_bluetooth || (offer.at > asked && offer.value == 3);
  }
  CHECK(offered_bluetooth);
  CHECK(runs_new_confirmed(*world.door));
  CHECK(site.hub.update_state("door") == kConfirmed);
  CHECK(data_links(*world.door, asked) == std::set<std::string>{"bluetooth"});
  CHECK(world.door->board().network.connects <= 1);  // its one Wi-Fi attempt, before
  CHECK(critical_events(site.hub).empty());
}

TEST_CASE("D138 D124: a phone with a wrong session key opens nothing: the sensor refuses it") {
  PhoneSite world;
  SystemSite& site = world.site;
  INFO(site.dump());
  REQUIRE(world.needs_phone);
  host::BluetoothSession session = site.hub.firmware_bluetooth("door");
  session.session_key[0] = static_cast<std::uint8_t>(session.session_key[0] ^ 0x01);
  const Instant asked = site.sim.now();
  host::ScriptPhone phone(site.sim, *world.door, session);
  site.run_until(asked + seconds(10 * 60));
  CHECK_FALSE(phone.done.has_value());
  CHECK(phone.served_to == 0);
  CHECK(phone.opens >= 1);
  CHECK(
      world.door->records().kind(RecordKind::slot_write).between(asked, Instant::never()).count() ==
      0);
  CHECK(same_version(world.door->boot_choice().image.version, kOldVersion));
  CHECK(critical_events(site.hub).empty());
}

}  // namespace
}  // namespace hsn::test::system

#endif
