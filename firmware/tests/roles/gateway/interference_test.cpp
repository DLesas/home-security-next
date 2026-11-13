// Interference (§6 interference, §8; GW11, D82): the noise sampled about once a second while
// listening, a normal level learned by integer averaging, "started" when the level stays above
// normal by the threshold for the duration, "ended" when it falls back; no false start from
// packets on the air.

#include <algorithm>

#include "gateway_bench.hpp"

namespace hsn::test {
namespace {

namespace gateway_log = roles::gateway::gateway_log;

constexpr std::uint32_t kSiteHz = 868300000;

TEST_CASE("GW11 D82 interference that lasts 30 s starts an alert, and its end ends it") {
  LinkSite site;
  // The plain floor is -117 dBm; jamming at -95 dBm from 100 s to 200 s.
  site.sim.medium().script_noise(kSiteHz, at(seconds(100)), at(seconds(200)), -95.0);
  site.sim.run_until(at(seconds(250)));
  INFO(site.sim.timeline().select().dump());

  const auto messages = site.hub.interference();
  REQUIRE(messages.size() == 2);
  CHECK(messages[0].event == protocol::InterferenceEvent::started);
  CHECK(messages[0].noise_dbm == -95);
  CHECK(messages[0].duration_seconds == 30);
  CHECK(messages[1].event == protocol::InterferenceEvent::ended);
  CHECK(messages[1].noise_dbm == -95);
  CHECK(messages[1].duration_seconds == 100);
  // Samples come once a second from 1.05 s: the first above normal is at 100.05 s.
  const auto got = site.hub.got(type::interference);
  CHECK(got[0].at == at(seconds(130) + milliseconds(50) + milliseconds(25)));
  CHECK(got[1].at == at(seconds(200) + milliseconds(50) + milliseconds(25)));
  // The normal level did not learn the jamming.
  const auto statuses = site.hub.statuses();
  REQUIRE(statuses.size() >= 8);
  for (const protocol::GatewayStatus& status : statuses) {
    CHECK(status.normal_noise_dbm == -117);
  }
  // The status covering 120-150 s saw it: median and highest at the jammer's level.
  CHECK(statuses[4].noise_median_dbm == -95);
  CHECK(statuses[4].noise_highest_dbm == -95);
  CHECK(statuses[0].noise_median_dbm == -117);
  CHECK(statuses[0].noise_highest_dbm == -117);
  // Each status covers only its own period: after the jamming the readings are quiet again.
  CHECK(statuses[7].noise_median_dbm == -117);
  CHECK(statuses[7].noise_highest_dbm == -117);
}

TEST_CASE("GW11 no false start: packets on the air and a short burst of noise") {
  LinkSite site;
  // A sensor 40 dB above the floor, every 5 s: each packet lifts the level for a moment only.
  std::vector<Burst> bursts;
  for (std::int64_t t = 5; t < 300; t += 5) {
    bursts.push_back(Burst{at(seconds(t)), Bytes(30, 0x18)});
  }
  add_talker(site.sim, "chatty", bursts);
  // A long SF12 packet from the gateway's own neighbour, and 20 s of noise: neither lasts 30 s.
  add_talker(site.sim, "slow", {Burst{at(seconds(50)), Bytes(255, 0x18), 0}});
  site.sim.medium().script_noise(kSiteHz, at(seconds(150)), at(seconds(170)), -90.0);
  site.sim.run_until(at(seconds(320)));
  CHECK(site.hub.interference().empty());
  const auto codes = site.hub.log_codes();
  CHECK(std::count(codes.begin(), codes.end(), gateway_log::interference) == 0);
  // It still saw them.
  bool saw_noise = false;
  for (const protocol::GatewayStatus& status : site.hub.statuses()) {
    saw_noise = saw_noise || status.noise_highest_dbm >= -91;
  }
  CHECK(saw_noise);
}

TEST_CASE("GW11 the threshold and the duration come from the settings") {
  for (const bool sensitive : {false, true}) {
    INFO((sensitive ? "10 dB for 10 s" : "30 dB for 30 s"));
    LinkSite site;
    site.hub.settings.interference_threshold_db = sensitive ? 10 : 30;
    site.hub.settings.interference_seconds = sensitive ? 10 : 30;
    // 22 dB above normal, for 40 s.
    site.sim.medium().script_noise(kSiteHz, at(seconds(60)), at(seconds(100)), -95.0);
    site.sim.run_until(at(seconds(130)));
    const auto messages = site.hub.interference();
    if (sensitive) {
      REQUIRE(messages.size() == 2);
      CHECK(messages[0].duration_seconds == 10);
      CHECK(site.hub.got(type::interference)[0].at ==
            at(seconds(70) + milliseconds(50) + milliseconds(25)));
    } else {
      CHECK(messages.empty());
    }
  }
}

TEST_CASE("D82 D110 interference while the hub cannot be reached is logged and reported later") {
  LinkSite site;
  site.sim.medium().script_noise(kSiteHz, at(seconds(60)), at(seconds(120)), -95.0);
  site.sim.schedule(at(seconds(50)),
                    [&]() { site.gateway.wire(device::LinkKind::network).detach(); });
  site.sim.schedule(at(seconds(150)), [&]() { site.hub.attach(device::LinkKind::network); });
  site.sim.run_until(at(seconds(260)));
  REQUIRE(gateway_of(site.gateway).state().connection.phase ==
          roles::gateway::ConnectionPhase::connected);
  CHECK(site.hub.interference().empty());
  const auto codes = site.hub.log_codes();
  CHECK(std::count(codes.begin(), codes.end(), gateway_log::interference) == 2);
}

}  // namespace
}  // namespace hsn::test
