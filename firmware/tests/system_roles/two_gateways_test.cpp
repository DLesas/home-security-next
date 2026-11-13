// C: two gateways hear the same sensor (GW9, D28; protocol §4 "Receiving", §7 "One gateway
// replies"): the hub keeps the first copy, runs one countdown, and answers once, through the
// gateway that delivered first; the other gateway sends nothing for the sensor.

#include <algorithm>

#include "system_site.hpp"

namespace hsn::test::system {
namespace {

/** The door opens here, after the start-up exchanges. */
constexpr std::int64_t kOpenAt = 60;
/** Path losses from the door: the near gateway hears it 20 dB stronger (§6, forwarded packet). */
constexpr double kNearLossDb = 95;
constexpr double kFarLossDb = 115;

TEST_CASE(
    "GW9 D28: two gateways hear one door report: one countdown, one reply, through the "
    "gateway that delivered first") {
  SystemSite site;
  // Clocks that disagree: each gateway counts send-at times on its own clock (§7).
  constexpr std::int32_t kEastDriftPpm = 300;
  constexpr std::int32_t kWestDriftPpm = -300;
  host::SimDevice& east = site.gateway("east", {}, kEastDriftPpm);
  host::SimDevice& west = site.gateway("west", {}, kWestDriftPpm);
  host::SimDevice& door = site.sensor("door");
  site.sim.medium().set_path_loss(door.station(), east.station(), kNearLossDb);
  site.sim.medium().set_path_loss(door.station(), west.station(), kFarLossDb);
  site.hub.arm();
  door.set_input(Input::door, true, at_s(kOpenAt));
  site.run_until(at_s(kOpenAt + 10));
  INFO(site.dump());

  // Both gateways heard the report and forwarded it.
  const auto tries = sent(door, type::door_changed);
  REQUIRE(tries.size() == 1);
  const std::uint32_t counter = tries[0].label.counter;
  std::vector<host::HubPacket> copies;
  for (const host::HubPacket& packet : hub_got_all(site.hub, "door")) {
    if (packet.counter == counter) {
      copies.push_back(packet);
    }
  }
  REQUIRE(copies.size() == 2);
  CHECK(copies[0].via != copies[1].via);
  // The first copy was taken; the second was dropped by its counter (§4).
  CHECK(copies[0].verdict == host::HubVerdict::accepted);
  CHECK(copies[1].verdict == host::HubVerdict::duplicate);
  CHECK(copies[0].at <= copies[1].at);
  const std::string first = copies[0].via;
  host::SimDevice& replier = first == "east" ? east : west;
  host::SimDevice& silent = first == "east" ? west : east;

  // One countdown, one reply, through the gateway whose copy came first.
  CHECK(site.hub.decisions(HubAction::countdown_started, "door").size() == 1);
  CHECK(site.hub.decisions(HubAction::countdown_continued, "door").empty());
  const auto replies = site.hub.sent_to("door", type::reply);
  const auto answering = std::count_if(replies.begin(), replies.end(), [&](const host::HubSent& r) {
    return r.at >= at_s(kOpenAt);
  });
  CHECK(answering == 1);
  CHECK(replies.back().via == first);
  const std::uint32_t address = address_in(replies.back().packet);
  const auto for_door = [address](const Record& r) { return r.label.address == address; };
  CHECK(replier.records()
            .kind(RecordKind::transmission)
            .between(at_s(kOpenAt), at_s(kOpenAt + 10))
            .where(for_door)
            .type_names() == "reply");
  CHECK(silent.records()
            .kind(RecordKind::transmission)
            .between(at_s(kOpenAt), at_s(kOpenAt + 10))
            .where(for_door)
            .empty());
  // The sensor heard that one reply and buzzes for the countdown.
  CHECK(heard(door, type::reply).back().peer == replier.actor());
  CHECK(buzzer_times(door, Sound::countdown).size() == 1);
}

}  // namespace
}  // namespace hsn::test::system
