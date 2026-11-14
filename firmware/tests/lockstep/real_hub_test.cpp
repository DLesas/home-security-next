// What only the real hub has (hub-design.md section 11, "Stops, kills and restarts"): the hub
// restarts during a countdown and every siren still sounds at its end, with the real roles.

#include "system_site.hpp"

namespace hsn::test::system {
namespace {

constexpr std::int64_t kOpenAt = 60;

TEST_CASE(
    "lockstep D80 §7: the hub stops cleanly during a countdown and starts again; the "
    "sirens still sound at its end") {
  SystemSite site;
  site.gateway("gateway");
  host::SimDevice& door = site.sensor("door");
  host::SimDevice& siren = site.siren("siren");
  site.hub.arm();
  door.set_input(Input::door, true, at_s(kOpenAt));
  site.sim.schedule(at_s(kOpenAt + 10), [&]() { site.hub.stop(); });
  site.sim.schedule(at_s(kOpenAt + 15), [&]() { site.hub.start(); });
  site.run_until(at_s(kOpenAt + 3 * kCountdownSeconds));
  INFO(site.dump());

  CHECK(site.hub.boot() == 2);
  const auto alarm = site.hub.decisions(HubAction::alarm, "door");
  REQUIRE(alarm.size() == 1);
  const auto started = site.hub.decisions(HubAction::countdown_started, "door");
  REQUIRE(started.size() == 1);
  CHECK(alarm[0].at - started[0].at == seconds(kCountdownSeconds));
  CHECK(sounding_from(siren, alarm[0].at) - alarm[0].at < seconds(6));
}

}  // namespace
}  // namespace hsn::test::system

namespace hsn::test::system {
namespace {

TEST_CASE(
    "lockstep §7: a gateway that comes back on Wi-Fi replaces its USB session; the hub "
    "closes the USB link, the board sees it go, and works on Wi-Fi") {
  SystemSite site;
  // A scripted gateway on USB; after a restart it connects over Wi-Fi instead (its role reads
  // the link to use at every boot).
  ScriptGatewayConfig config;
  config.use_usb = true;
  ScriptGatewayLog log;
  host::DeviceSpec spec;
  spec.name = "gateway";
  spec.role = [&config, &log](device::Services& services, host::HostBoard& board) {
    return host::box_role<ScriptGateway>(services, board.gateway_io, config, log);
  };
  host::SimDevice& gateway = site.sim.add_device(spec);
  gateway.board().power.external = true;
  host::GatewayConfig attachment;
  attachment.usb = true;
  attachment.network = true;
  site.hub.add_gateway(gateway, attachment);
  site.gateways.push_back("gateway");
  host::SimDevice& door = site.sensor("door");
  site.run_until(at_s(20));
  REQUIRE(site.hub.decisions(HubAction::gateway_welcomed, "gateway").size() == 1);
  REQUIRE(gateway.board().gateway_io.host);

  site.sim.schedule(at_s(20), [&]() { config.use_usb = false; });
  gateway.restart(at_s(20));
  site.run_until(at_s(40));
  INFO(site.dump());
  // A new session on Wi-Fi, proven; the hub closed the USB link and said why.
  CHECK(site.hub.decisions(HubAction::gateway_welcomed, "gateway").size() == 2);
  REQUIRE(site.hub.closed_links().size() == 1);
  CHECK(site.hub.closed_links()[0].second.rfind("gateway:usb: ", 0) == 0);
  CHECK(site.hub.closed_links()[0].first > at_s(20));
  // The board saw its port go, and nothing more went on it.
  CHECK_FALSE(gateway.board().gateway_io.host);
  CHECK_FALSE(gateway.wire(device::LinkKind::usb).attached());
  CHECK(gateway.records()
            .kind(RecordKind::link_sent)
            .between(site.hub.closed_links()[0].first, Instant::never())
            .where([](const Record& r) { return r.value == 0; })
            .empty());
  // On Wi-Fi it carries the door's report, which is answered.
  door.set_input(Input::door, true, at_s(45));
  site.run_until(at_s(50));
  const auto reports = site.hub.received_from("door", type::door_changed);
  REQUIRE(reports.size() == 1);
  CHECK(reports[0].via == "gateway");
  CHECK(site.hub.sent_to("door", type::reply).back().at > at_s(45));
}

}  // namespace
}  // namespace hsn::test::system
