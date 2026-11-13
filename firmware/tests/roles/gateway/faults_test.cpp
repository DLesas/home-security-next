// Faults (FW4, FW6, D110; design sections 4 and 6): a radio that refuses calls or reports a fault,
// a reception or transmission whose end never comes, the link dropping in the middle of a
// request, every way a heard packet can fail to reach the hub, a restart and a power loss.

#include <algorithm>
#include <optional>

#include "gateway_bench.hpp"
#include "hsn/device/services/radio_plan.hpp"
#include "hsn/host/host_board.hpp"
#include "hsn/roles/gateway/gateway_clock.hpp"

namespace hsn::test {
namespace {

using roles::gateway::ConnectionPhase;
using roles::gateway::ForwardLoss;
using roles::gateway::RadioMode;
namespace gateway_log = roles::gateway::gateway_log;

std::size_t count_code(const std::vector<std::uint16_t>& codes, std::uint16_t code) {
  return static_cast<std::size_t>(std::count(codes.begin(), codes.end(), code));
}

TEST_CASE("FW6 a radio that refuses every call: the request is answered, then it is retried") {
  LinkSite site;
  ScriptSensorLog sensor_log;
  host::SimDevice& door =
      add_lone_sensor(site.sim, "door", ScriptSensorConfig{}, sensor_log, 0x0D00F101);
  std::uint32_t request = 0;
  site.sim.schedule(at(seconds(5)), [&]() { site.gateway.board().radio.refuse_all = true; });
  site.sim.schedule(at(seconds(6)), [&]() {
    request = site.hub.send_request(
        site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0, opaque_packet(3, 3)));
  });
  site.sim.schedule(at(seconds(8)), [&]() {
    CHECK(gateway_of(site.gateway).state().radio.mode == RadioMode::off);
    site.gateway.board().radio.refuse_all = false;
  });
  door.set_input(device::Input::door, true, at(seconds(12)));
  site.sim.run_until(at(seconds(15)));

  REQUIRE(site.hub.result_for(request).has_value());
  CHECK(site.hub.result_for(request)->result == protocol::TransmitOutcome::radio_busy);
  // Back to listening within the 1 s retry, and hearing again.
  CHECK(gateway_of(site.gateway).state().radio.mode == RadioMode::listening);
  CHECK(site.hub.forwarded().size() == 1);
  const auto codes = site.hub.log_codes();
  CHECK(count_code(codes, gateway_log::radio_call_failed) >= 2);
}

/** A gateway driven by hand, with no simulation: events go in exactly as a test builds them. */
struct HandDriven {
  HandDriven() {
    pair_board(board, protocol::Role::gateway);
    board.power.external = true;
    instance.emplace(board, board.gateway_io);
    instance->runner.start(board.boot_event(device::BootKind::power_on));
  }

  GatewayRole& role() {
    return instance->role;
  }

  /** Moves the clock and runs whatever timer has come. */
  void advance(device::Instant now) {
    board.clock.set(now);
    instance->runner.timed_out(now);
  }

  void deliver(const device::Event& event) {
    board.clock.set(event.now);
    instance->runner.deliver(event);
  }

  /** Connects on the network link: up, hello, welcome, settings. */
  void connect() {
    deliver(device::Event::from_link(board.clock.now(), board.network.up_event()));
    REQUIRE(board.network.sent.size() == 1);
    const HubOpened hello =
        hub_open(view_of(board.network.sent[0].packet), protocol::Binding::none());
    REQUIRE(hello.type == type::hello);
    protocol::Hello decoded;
    REQUIRE(protocol::decode_body(view_of(hello.body), decoded) == protocol::Error::none);
    gateway_random = decoded.gateway_random;
    protocol::Welcome welcome;
    welcome.hub_random = {1, 2, 3, 4, 5, 6, 7, 8};
    hub_random = welcome.hub_random;
    from_hub(welcome, protocol::Binding::hello(gateway_random));
    protocol::GatewaySettings settings;
    settings.settings_version = 1;
    settings.site_channel = 1;
    settings.listen_data_rate_mask = 0x20;
    from_hub(settings, session());
    REQUIRE(role().state().connection.phase == ConnectionPhase::connected);
  }

  protocol::Binding session() const {
    return protocol::Binding::session(gateway_random, hub_random);
  }

  template <typename M>
  void from_hub(const M& message, const protocol::Binding& binding) {
    const Bytes packet =
        hub_packet(message, counter++, binding, kAddress, protocol::PacketLimit::link);
    deliver(device::Event::from_link(board.clock.now(), board.network.packet_event(packet)));
  }

  /** The types of what the gateway sent the hub since `from`. */
  std::vector<HubOpened> sent_since(std::size_t from) const {
    std::vector<HubOpened> opened;
    for (std::size_t i = from; i < board.network.sent.size(); ++i) {
      opened.push_back(hub_open(view_of(board.network.sent[i].packet), session()));
    }
    return opened;
  }

  host::HostBoard board;
  std::optional<host::HostInstance<GatewayRole>> instance;
  protocol::RandomValue gateway_random{};
  protocol::RandomValue hub_random{};
  std::uint32_t counter = 1;
};

TEST_CASE("FW6 a radio fault resets the radio and listening starts again") {
  HandDriven bench;
  const std::size_t before = bench.board.radio.calls.size();
  bench.deliver(device::Event::from_radio(at(seconds(2)), bench.board.radio.fault(at(seconds(2)))));
  const auto& calls = bench.board.radio.calls;
  REQUIRE(calls.size() >= before + 2);
  CHECK(calls[before].kind == host::RadioCall::Kind::recover);
  CHECK(calls[before + 1].kind == host::RadioCall::Kind::receive);
  CHECK(bench.role().state().radio.mode == RadioMode::listening);
}

TEST_CASE("§6 the arrival time is when the reception ended, not when the event was handled") {
  HandDriven bench;
  bench.connect();
  const std::size_t sent_before = bench.board.network.sent.size();
  // The interrupt fired 7 ms before the event reached the core.
  const device::Instant ended = at(seconds(3));
  const Bytes packet = opaque_packet(0x77, 5, 25);
  bench.deliver(device::Event::from_radio(ended + milliseconds(7),
                                          bench.board.radio.rx_done(ended, packet, -95, -6)));
  const auto opened = bench.sent_since(sent_before);
  REQUIRE(opened.size() == 1);
  REQUIRE(opened[0].type == type::forwarded_packet);
  const Forwarded forwarded = decode_forwarded(at(seconds(3)), opened[0].body);
  CHECK(forwarded.meta.received_at_micros == roles::gateway::clock_value(ended));
  CHECK(forwarded.meta.rssi_dbm == -95);
  CHECK(forwarded.meta.snr_quarter_db == -6);
  CHECK(forwarded.packet == packet);
}

TEST_CASE("FW4 the breadcrumb names the gateway's connection phase and radio mode") {
  HandDriven bench;
  bench.connect();
  const protocol::MutableByteView crumb = bench.board.retained.breadcrumb();
  // Written before the last event (a link packet): its kind, then phase << 4 | mode.
  CHECK(crumb[0] == ((static_cast<unsigned>(ConnectionPhase::connected) << 4) |
                     static_cast<unsigned>(RadioMode::listening)));
  CHECK(crumb[1] == static_cast<std::uint8_t>(device::EventKind::link));
  CHECK(bench.role().state_id() == crumb[0]);
}

TEST_CASE("§7 a reception whose end never comes is cut by its guard, not held for ever") {
  HandDriven bench;
  bench.deliver(
      device::Event::from_radio(at(seconds(2)), bench.board.radio.header_seen(at(seconds(2)))));
  REQUIRE(bench.role().state().radio.mode == RadioMode::receiving);
  // The longest packet at the listening rate, plus the margin.
  const device::Duration guard =
      device::time_on_air(bench.role().state().radio.data_rate, 255).value() +
      device::kRadioGuardMargin;
  bench.advance(at(seconds(2)) + guard + milliseconds(-1));
  CHECK(bench.role().state().radio.mode == RadioMode::receiving);
  const std::size_t before = bench.board.radio.calls.size();
  bench.advance(at(seconds(2)) + guard);
  CHECK(bench.role().state().radio.mode == RadioMode::listening);
  REQUIRE(bench.board.radio.calls.size() >= before + 2);
  CHECK(bench.board.radio.calls[before].kind == host::RadioCall::Kind::recover);
  CHECK(bench.instance->services.log.size() >= 1);
}

/** A request at a given time on a hand-driven board, `ahead` from now; returns its counter. */
std::uint32_t timed_request(HandDriven& bench, device::Instant moment, std::uint32_t tag) {
  protocol::TransmitRequest request;
  request.when = protocol::TransmitWhen::at_time;
  request.gateway_time_micros = roles::gateway::clock_value(moment);
  request.data_rate = 5;
  request.power_dbm = 14;
  const Bytes packet = opaque_packet(3, tag);
  request.packet.bytes = view_of(packet);
  const std::uint32_t counter = bench.counter;
  bench.from_hub(request, bench.session());
  return counter;
}

/** The transmit results a hand-driven gateway sent since `from`. */
std::vector<protocol::TransmitResult> results_since(const HandDriven& bench, std::size_t from) {
  std::vector<protocol::TransmitResult> results;
  for (const HubOpened& opened : bench.sent_since(from)) {
    if (opened.type == type::transmit_result) {
      protocol::TransmitResult result;
      REQUIRE(protocol::decode_body(view_of(opened.body), result) == protocol::Error::none);
      results.push_back(result);
    }
  }
  return results;
}

TEST_CASE("§6 a fixed moment reached 10 ms late is still sent; 30 ms late is too late") {
  HandDriven bench;
  bench.board.clock.set(at(seconds(2)));
  bench.connect();
  const std::size_t transmits = bench.board.radio.calls_of(host::RadioCall::Kind::transmit).size();

  // The timer comes 10 ms after the moment (a slow flash write in the same event): within 20 ms.
  const device::Instant first = at(seconds(3));
  std::size_t sent_before = bench.board.network.sent.size();
  const std::uint32_t on_time = timed_request(bench, first, 1);
  bench.advance(first + milliseconds(10));
  CHECK(bench.board.radio.calls_of(host::RadioCall::Kind::transmit).size() == transmits + 1);
  bench.deliver(device::Event::from_radio(first + milliseconds(80),
                                          bench.board.radio.tx_done(first + milliseconds(80))));
  auto results = results_since(bench, sent_before);
  REQUIRE(results.size() == 1);
  CHECK(results[0].request_counter == on_time);
  CHECK(results[0].result == protocol::TransmitOutcome::sent);

  // 30 ms late: answered "too late", and nothing goes on the air.
  const device::Instant second = at(seconds(5));
  sent_before = bench.board.network.sent.size();
  const std::uint32_t missed = timed_request(bench, second, 2);
  bench.advance(second + milliseconds(30));
  CHECK(bench.board.radio.calls_of(host::RadioCall::Kind::transmit).size() == transmits + 1);
  CHECK(bench.role().state().radio.mode == RadioMode::listening);
  results = results_since(bench, sent_before);
  REQUIRE(results.size() == 1);
  CHECK(results[0].request_counter == missed);
  CHECK(results[0].result == protocol::TransmitOutcome::too_late);
  CHECK(bench.role().queue().empty());
}

TEST_CASE("§6 a moment that passed less than 20 ms before the request came is still sent") {
  HandDriven bench;
  bench.board.clock.set(at(seconds(2)));
  bench.connect();
  const std::size_t sent_before = bench.board.network.sent.size();
  const std::uint32_t slightly = timed_request(bench, at(seconds(2)) + milliseconds(-15), 1);
  CHECK(bench.board.radio.calls_of(host::RadioCall::Kind::transmit).size() == 1);
  const std::uint32_t too_far = timed_request(bench, at(seconds(2)) + milliseconds(-25), 2);
  const auto results = results_since(bench, sent_before);
  REQUIRE(results.size() == 1);
  CHECK(results[0].request_counter == too_far);
  CHECK(results[0].result == protocol::TransmitOutcome::too_late);
  CHECK(slightly != too_far);
}

TEST_CASE("§7 a transmission whose end never comes is answered radio busy at its guard") {
  HandDriven bench;
  bench.connect();
  const std::size_t sent_before = bench.board.network.sent.size();
  protocol::TransmitRequest request;
  request.when = protocol::TransmitWhen::as_soon_as_possible;
  request.data_rate = 5;
  request.power_dbm = 14;
  const Bytes packet = opaque_packet(2, 2);
  request.packet.bytes = view_of(packet);
  const std::uint32_t counter = bench.counter;
  bench.from_hub(request, bench.session());
  REQUIRE(bench.role().state().radio.mode == RadioMode::transmitting);
  const device::Duration guard =
      device::time_on_air(5, packet.size()).value() + device::kRadioGuardMargin;
  bench.advance(bench.board.clock.now() + guard);
  CHECK(bench.role().state().radio.mode == RadioMode::listening);
  bool answered = false;
  for (const HubOpened& opened : bench.sent_since(sent_before)) {
    if (opened.type == type::transmit_result) {
      protocol::TransmitResult result;
      REQUIRE(protocol::decode_body(view_of(opened.body), result) == protocol::Error::none);
      CHECK(result.request_counter == counter);
      CHECK(result.result == protocol::TransmitOutcome::radio_busy);
      answered = true;
    }
  }
  CHECK(answered);
}

TEST_CASE("FW6 the link drops in the middle of a request: nothing more is sent, all logged") {
  LinkSite site;
  site.sim.schedule(at(seconds(5)), [&]() {
    site.hub.send_request(site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0,
                                           opaque_packet(4, 1, 30), 0));
    site.hub.send_request(
        site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0, opaque_packet(4, 2)));
    site.hub.send_request(
        site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0, opaque_packet(4, 3)));
  });
  // Half way through the first send, the connection goes.
  site.sim.schedule(at(seconds(5) + milliseconds(800)),
                    [&]() { site.gateway.wire(device::LinkKind::network).drop(); });
  site.sim.run_until(at(seconds(12)));
  INFO(site.sim.timeline().select().dump());
  // The packet on the air finished; the two waiting were dropped with their connection.
  CHECK(transmitted(site.gateway).size() == 1);
  CHECK(site.hub.results().empty());
  CHECK(gateway_of(site.gateway).queue().empty());
  CHECK(gateway_of(site.gateway).counts().results_lost == 1);
  // Reconnected, the hub hears why.
  REQUIRE(gateway_of(site.gateway).state().connection.phase == ConnectionPhase::connected);
  const auto codes = site.hub.log_codes();
  CHECK(count_code(codes, gateway_log::requests_dropped) == 1);
  CHECK(count_code(codes, gateway_log::result_lost) == 1);
  CHECK(count_code(codes, gateway_log::link_down) == 1);
  // And a new request on the new connection is carried out.
  std::uint32_t fresh = 0;
  site.sim.schedule(at(seconds(12)), [&]() {
    fresh = site.hub.send_request(
        site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0, opaque_packet(4, 9)));
  });
  site.sim.run_until(at(seconds(13)));
  CHECK(site.hub.result_for(fresh)->result == protocol::TransmitOutcome::sent);
}

TEST_CASE("FW6 a result for a request of an ended connection never reaches the next one") {
  LinkSite site;
  std::uint32_t long_send = 0;
  // About 9 s on the air; the connection drops and is back long before it ends.
  site.sim.schedule(at(seconds(5)), [&]() {
    long_send = site.hub.send_request(
        site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0, Bytes(255, 0x18), 0));
  });
  site.sim.schedule(at(seconds(5) + milliseconds(500)),
                    [&]() { site.gateway.wire(device::LinkKind::network).drop(); });
  site.sim.run_until(at(seconds(8)));
  REQUIRE(gateway_of(site.gateway).state().connection.phase == ConnectionPhase::connected);
  REQUIRE(gateway_of(site.gateway).state().radio.mode == RadioMode::transmitting);
  site.sim.run_until(at(seconds(20)));
  // The new session's hub never sent that request: no result names it.
  CHECK_FALSE(site.hub.result_for(long_send).has_value());
  CHECK(gateway_of(site.gateway).counts().results_lost == 1);
  const auto codes = site.hub.log_codes();
  CHECK(count_code(codes, gateway_log::result_lost) == 1);
}

/** Each lost forward's code and text, as the hub received them. */
std::vector<std::string> loss_texts(const LinkHub& hub) {
  std::vector<std::string> texts;
  for (const LinkHub::Got& got : hub.got(type::log_entries)) {
    protocol::LogEntries entries;
    REQUIRE(protocol::decode_body(view_of(got.body), entries) == protocol::Error::none);
    protocol::LogEntryReader reader(entries.entries);
    protocol::LogEntry entry;
    while (reader.next(entry)) {
      if (entry.code == gateway_log::forward_lost ||
          entry.code == gateway_log::forward_seal_failed ||
          entry.code == gateway_log::forward_link_busy ||
          entry.code == gateway_log::forward_link_down) {
        CHECK(entry.level == static_cast<std::uint8_t>(device::LogLevel::warning));
        texts.push_back(std::to_string(entry.code) + " " +
                        std::string(entry.text.bytes.begin(), entry.text.bytes.end()));
      }
    }
  }
  return texts;
}

/** What a loss is logged with: its cause's code and text, and the HAL's or service's status. */
std::string loss_text(ForwardLoss cause, std::int32_t detail) {
  switch (cause) {
    case ForwardLoss::not_connected:
      return std::to_string(gateway_log::forward_lost) + " not connected " + std::to_string(detail);
    case ForwardLoss::seal_failed:
      return std::to_string(gateway_log::forward_seal_failed) + " forward seal failed " +
             std::to_string(detail);
    case ForwardLoss::link_busy:
      return std::to_string(gateway_log::forward_link_busy) + " forward link busy " +
             std::to_string(detail);
    case ForwardLoss::link_down:
      return std::to_string(gateway_log::forward_link_down) + " forward link down " +
             std::to_string(detail);
  }
  return "";
}

TEST_CASE("FW6 a packet heard before the welcome is counted lost: not connected") {
  LinkSite site;
  site.hub.auto_welcome = false;
  // Before settings it listens at the slowest rate its pairing allows, DR2; then at DR5.
  add_talker(site.sim, "neighbour",
             {Burst{at(seconds(2)), Bytes(24, 0x24), 2}, Burst{at(seconds(6)), Bytes(24, 0x25)}});
  site.sim.schedule(at(seconds(3)), [&]() {
    site.hub.welcome();
    site.hub.send(site.hub.settings);
  });
  site.sim.run_until(at(seconds(8)));
  const roles::gateway::CarriedCounts& counts = gateway_of(site.gateway).counts();
  CHECK(counts.heard == 2);
  CHECK(counts.forwarded == 1);
  CHECK(counts.forwards_lost == 1);
  CHECK(site.hub.forwarded().size() == 1);
  CHECK(loss_texts(site.hub) == std::vector<std::string>{loss_text(ForwardLoss::not_connected, 0)});
}

TEST_CASE("FW6 a forward the link's full queue refuses is counted lost: link busy") {
  LinkSite site;
  add_talker(site.sim, "neighbour",
             {Burst{at(seconds(4)), Bytes(24, 0x24)}, Burst{at(seconds(6)), Bytes(24, 0x25)}});
  site.sim.schedule(at(seconds(3)), [&]() { site.gateway.board().network.refuse_sends = true; });
  site.sim.schedule(at(seconds(5)), [&]() { site.gateway.board().network.refuse_sends = false; });
  site.sim.run_until(at(seconds(8)));
  const roles::gateway::CarriedCounts& counts = gateway_of(site.gateway).counts();
  CHECK(counts.heard == 2);
  CHECK(counts.forwarded == 1);
  CHECK(counts.forwards_lost == 1);
  CHECK(loss_texts(site.hub) ==
        std::vector<std::string>{
            loss_text(ForwardLoss::link_busy, static_cast<std::int32_t>(device::HalError::busy))});
}

TEST_CASE("FW6 a forward a dead link refuses is counted lost: link down") {
  LinkSite site;
  add_talker(site.sim, "neighbour",
             {Burst{at(seconds(4)), Bytes(24, 0x24)}, Burst{at(seconds(6)), Bytes(24, 0x25)}});
  // The link died and its "down" has not been delivered yet.
  site.sim.schedule(at(seconds(3)),
                    [&]() { static_cast<void>(site.gateway.board().network.down_event()); });
  site.sim.schedule(at(seconds(5)),
                    [&]() { static_cast<void>(site.gateway.board().network.up_event()); });
  site.sim.run_until(at(seconds(8)));
  const roles::gateway::CarriedCounts& counts = gateway_of(site.gateway).counts();
  CHECK(counts.heard == 2);
  CHECK(counts.forwarded == 1);
  CHECK(counts.forwards_lost == 1);
  CHECK(loss_texts(site.hub) ==
        std::vector<std::string>{
            loss_text(ForwardLoss::link_down, static_cast<std::int32_t>(device::HalError::io))});
}

TEST_CASE("FW6 a forward whose resume point cannot be written is counted lost: seal failed") {
  LinkSite site;
  // About 1,100 packets: the send counter passes 2,048, which must first be saved (§4).
  std::vector<Burst> bursts;
  for (std::int64_t i = 0; i < 1100; ++i) {
    bursts.push_back(Burst{at(seconds(2) + milliseconds(60 * i)), Bytes(18, 0x18)});
  }
  add_talker(site.sim, "neighbour", bursts);
  site.sim.schedule(at(seconds(2)), [&]() { site.gateway.board().storage.fail_writes = true; });
  site.sim.schedule(at(seconds(2) + milliseconds(60 * 1100)),
                    [&]() { site.gateway.board().storage.fail_writes = false; });
  site.sim.run_until(at(seconds(80)));
  const roles::gateway::CarriedCounts& counts = gateway_of(site.gateway).counts();
  CHECK(counts.heard == bursts.size());
  CHECK(counts.forwards_lost > 0);
  CHECK(counts.forwarded + counts.forwards_lost == counts.heard);
  CHECK(site.hub.forwarded().size() == counts.forwarded);
  const auto texts = loss_texts(site.hub);
  REQUIRE_FALSE(texts.empty());
  // Repeats of one entry are counted in it rather than kept apart (design section 4).
  const std::string expected =
      loss_text(ForwardLoss::seal_failed, static_cast<std::int32_t>(device::Status::storage_error));
  CHECK(texts[0].rfind(expected, 0) == 0);
}

TEST_CASE("FW4 the gateway never sleeps more deeply than awake, and the watchdog is always fed") {
  Site site(gateway_mode());
  host::SimDevice& gateway = add_gateway(site, "gateway");
  site.sim.run_until(at(seconds(600)));
  CHECK(gateway.records().kind(RecordKind::deep_sleep).empty());
  CHECK(gateway.last_wait().depth == device::SleepDepth::awake);
  CHECK(gateway.board().watchdog.longest_gap(gateway.local_now()) <= device::kFeedSlice);
  CHECK_FALSE(gateway.board().watchdog.would_have_fired(gateway.local_now()));
  CHECK(gateway.boots() == 1);
}

TEST_CASE("a restart or a power loss starts a new connection, whatever was retained") {
  Site site(gateway_mode());
  host::SimDevice& gateway = add_gateway(site, "gateway");
  site.sim.run_until(at(seconds(5)));
  const protocol::RandomValue first = gateway_of(gateway).state().connection.session.gateway_random;
  gateway.restart(at(seconds(5)));
  site.sim.run_until(at(seconds(8)));
  CHECK(gateway_of(gateway).state().connection.phase == ConnectionPhase::connected);
  CHECK(gateway_of(gateway).state().connection.session.gateway_random != first);
  gateway.power_loss(at(seconds(8)));
  site.sim.run_until(at(seconds(15)));
  CHECK(gateway_of(gateway).state().connection.phase == ConnectionPhase::connected);
  CHECK(site.hub.decisions(host::HubAction::gateway_welcomed, "gateway").size() == 3);
  CHECK(hub_got<protocol::Started>(site.hub, "gateway").size() == 3);
  // The send counter never went back: every packet the hub had from it was accepted.
  for (const host::HubPacket& packet : site.hub.received()) {
    if (packet.from == "gateway") {
      CHECK(packet.verdict == host::HubVerdict::accepted);
    }
  }
}

}  // namespace
}  // namespace hsn::test
