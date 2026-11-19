// A whole rollout through the real hub in lockstep (m3-updates-design.md section 8, "Through the
// real hub in lockstep": update_rollout_test.cpp; section 4, "How a rollout proceeds"; D139),
// with the real roles on the simulated radio: an own build added with `hsn firmware add --own`,
// approved with `rollout.start`, and every device updated over its transport: sensors over Wi-Fi,
// the ones out of Wi-Fi range from a phone over Bluetooth, sirens on their Wi-Fi, a gateway on
// USB and one on Wi-Fi. On the real hub only.

#ifdef HSN_LOCKSTEP

#include <memory>

#include "update_site.hpp"

namespace hsn::test::system {
namespace {

/** Sensors in Wi-Fi range, and out of it (they need a phone, UP6). */
const std::vector<std::string> kWifiSensors{"door0", "door1", "door2", "door3", "door4", "door5"};
const std::vector<std::string> kPhoneSensors{"door6", "door7"};
const std::vector<std::string> kSirens{"siren0", "siren1"};
const std::vector<std::string> kGateways{"gateway_usb", "gateway_wifi"};

std::vector<std::string> all_of(std::initializer_list<const std::vector<std::string>*> lists) {
  std::vector<std::string> out;
  for (const auto* list : lists) {
    out.insert(out.end(), list->begin(), list->end());
  }
  return out;
}

bool contains(const std::vector<std::string>& list, const std::string& name) {
  return std::find(list.begin(), list.end(), name) != list.end();
}

/** The site of the design's test, larger: six sensors in Wi-Fi range, two out of it. */
struct RolloutSite {
  RolloutSite() {
    host::GatewayConfig usb;
    usb.usb = true;
    usb.network = false;
    site.gateway("gateway_usb", usb);
    site.gateway("gateway_wifi");
    for (const std::string& name : kWifiSensors) {
      site.sensor(name);
    }
    host::SensorConfig far;
    far.wifi_in_range = false;
    for (const std::string& name : kPhoneSensors) {
      site.sensor(name, far);
    }
    for (const std::string& name : kSirens) {
      site.siren(name);
    }
    site.run_until(at_s(20));
    image = &site.hub.add_own_build(host::make_test_image(kNewVersion, 60000), kNewVersion);
  }

  /**
   * Runs to `until` in steps of 30 s; a sensor the hub holds as needing a phone gets one, with
   * the session `firmware.bluetooth` gives (section 5).
   */
  void run_with_phones(Instant until) {
    while (site.sim.now() < until) {
      site.run_until(std::min(until, site.sim.now() + seconds(30)));
      for (const std::string& name : kPhoneSensors) {
        if (phones.count(name) != 0) {
          continue;
        }
        const json::Value row = site.hub.update_of(name);
        const json::Value* held = row.is_null() ? nullptr : row.find("held");
        if (held != nullptr && !held->is_null() && held->as_string() == "needsPhone") {
          phones[name] = std::make_unique<host::ScriptPhone>(site.sim, device(name),
                                                             site.hub.firmware_bluetooth(name));
        }
      }
    }
  }

  host::SimDevice& device(const std::string& name) {
    for (const auto& d : site.sim.devices()) {
      if (d->name() == name) {
        return *d;
      }
    }
    throw host::SimulationError("no device " + name);
  }

  SystemSite site;
  const host::RemoteImage* image = nullptr;
  std::map<std::string, std::unique_ptr<host::ScriptPhone>> phones;
};

/** The whole rollout and what it must keep to (section 4, "How a rollout proceeds"). */
void check_rollout() {
  RolloutSite world;
  SystemSite& site = world.site;
  host::RemoteHub& hub = site.hub;
  const Instant approved = site.sim.now();
  hub.rollout_start(world.image->id);
  world.run_with_phones(approved + kSoak + seconds(40 * 60));
  INFO(site.dump());
  const json::Value status = hub.rollout_status();
  INFO(json::write(status));
  const std::vector<std::string> sensors = all_of({&kWifiSensors, &kPhoneSensors});
  const std::vector<std::string> mains = all_of({&kSirens, &kGateways});
  const std::vector<std::string> everyone = all_of({&sensors, &mains});

  // Every device runs the new image, confirmed, and the hub says so; the rollout is done.
  for (const std::string& name : everyone) {
    CAPTURE(name);
    CHECK(runs_new_confirmed(world.device(name)));
    CHECK(hub.update_state(name) == kConfirmed);
    CHECK(hub.decisions(HubAction::firmware_confirmed, name).size() == 1);
    CHECK(hub.decisions(HubAction::firmware_rolled_back, name).empty());
    CHECK(hub.decisions(HubAction::firmware_refused, name).empty());
  }
  CHECK(status.at("rollout").at("stage").as_string() == "done");
  CHECK(hub.decisions(HubAction::rollout_done).size() == 1);

  // The pilots: one device of each role, one at a time, before the soak; nothing else is told to
  // fetch until an hour after the last pilot confirmed (section 4, steps 2 and 3).
  std::vector<std::string> pilots;
  for (const json::Value& id : status.at("rollout").at("pilots").as_array()) {
    for (const std::string& name : everyone) {
      if (hub.device_number(name) == id.as_int()) {
        pilots.push_back(name);
      }
    }
  }
  REQUIRE(pilots.size() == 3);
  std::set<std::string> pilot_roles;
  Instant pilots_done;
  for (const std::string& pilot : pilots) {
    pilot_roles.insert(contains(kSirens, pilot)     ? "siren"
                       : contains(kGateways, pilot) ? "gateway"
                                                    : "sensor");
    pilots_done = std::max(pilots_done, first(hub, HubAction::firmware_confirmed, pilot));
  }
  CHECK(pilot_roles.size() == 3);
  CHECK(most_at_once(install_spans(hub, pilots)) == 1);
  for (const std::string& name : everyone) {
    if (contains(pilots, name)) {
      continue;
    }
    CAPTURE(name);
    for (const host::HubDecision& offer : hub.decisions(HubAction::firmware_offer, name)) {
      if (offer.value >= 1 && offer.value <= 3) {
        CHECK(offer.at >= pilots_done + kSoak);
      }
    }
  }

  // The rest: sirens and gateways one at a time between them (D91); sensors at most four at
  // once, fetching and installing; no gateway's go-ahead while a sensor is on trial.
  CHECK(most_at_once(install_spans(hub, mains)) == 1);
  CHECK(most_at_once(install_spans(hub, sensors)) <= 4);
  CHECK(most_at_once(fetch_spans(hub, sensors)) <= 4);
  MESSAGE("sensors at once: installing " << most_at_once(install_spans(hub, sensors))
                                         << ", fetching "
                                         << most_at_once(fetch_spans(hub, sensors)));
  for (const Span& gateway : install_spans(hub, kGateways)) {
    for (const std::string& sensor : sensors) {
      const Instant trial = first(hub, HubAction::firmware_on_trial, sensor);
      const Instant confirmed = first(hub, HubAction::firmware_confirmed, sensor);
      CAPTURE(gateway.device);
      CAPTURE(sensor);
      const bool during_trial = trial < gateway.from && gateway.from < confirmed;
      CHECK_FALSE(during_trial);
    }
  }

  // Each over its own transport: the image's pieces came on the link the design names.
  for (const std::string& name : kWifiSensors) {
    CAPTURE(name);
    CHECK(data_links(world.device(name), approved) == std::set<std::string>{"network"});
    CHECK(served(hub, name).to == world.image->file.size());
  }
  for (const std::string& name : kPhoneSensors) {
    CAPTURE(name);
    REQUIRE(world.phones.count(name) == 1);
    CHECK(data_links(world.device(name), approved) == std::set<std::string>{"bluetooth"});
    CHECK(world.phones[name]->served_to == world.image->file.size());
    REQUIRE(world.phones[name]->done.has_value());
    CHECK(world.phones[name]->done->result == protocol::DoneResult::verified);
    CHECK(served(hub, name).data == 0);
  }
  for (const std::string& name : kSirens) {
    CAPTURE(name);
    CHECK(data_links(world.device(name), approved) == std::set<std::string>{"network"});
  }
  CHECK(data_links(world.device("gateway_usb"), approved) == std::set<std::string>{"usb"});
  CHECK(data_links(world.device("gateway_wifi"), approved) == std::set<std::string>{"network"});
  // The header the hub signed and served is the one made here with the hub's key: RFC 6979 on
  // both sides (R8), so the phone's file is the hub's.
  REQUIRE(world.image->header_matches.has_value());
  CHECK(*world.image->header_matches);

  // Nothing went wrong along the way: no critical hub event (the deadline guard's among them).
  // A sensor's warnings are checked by the case below.
  CHECK(critical_events(hub).empty());
}

TEST_CASE(
    "D139 UP5 UP6 GW7 SR8: a rollout over every transport: pilots one at a time, an hour's "
    "soak, sirens and gateways one at a time, sensors at most four at once, every device "
    "confirmed") {
  check_rollout();
}

TEST_CASE("D139: the rollout completes with the hub's report now command for each trial siren") {
  check_rollout();
}

TEST_CASE(
    "D134 UP2: a sensor's update, start to end, raises no warning on the "
    "sensor") {
  SystemSite site;
  site.gateway("gateway");
  host::SimDevice& door = site.sensor("door");
  site.run_until(at_s(10));
  const host::RemoteImage& image =
      site.hub.add_own_build(host::make_test_image(kNewVersion, 60000), kNewVersion);
  site.hub.rollout_start(image.id);
  site.run_until(at_s(20 * 60));
  INFO(site.dump());
  REQUIRE(runs_new_confirmed(door));
  CHECK(device_warnings(site.hub, "door").empty());
  // What the hub answers the installing status with: anything but a second go-ahead.
  const auto statuses = site.hub.decisions(HubAction::firmware_status, "door");
  for (const host::HubDecision& status : statuses) {
    if ((status.value >> 8) != 4) {
      continue;
    }
    for (const host::HubDecision& offer : site.hub.decisions(HubAction::firmware_offer, "door")) {
      CHECK_FALSE((offer.at > status.at && offer.value == protocol::UpdateAction::install_now &&
                   offer.at < first(site.hub, HubAction::firmware_on_trial, "door") + seconds(5)));
    }
  }
}

}  // namespace
}  // namespace hsn::test::system

#endif
