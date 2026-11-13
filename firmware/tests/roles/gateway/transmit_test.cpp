// Transmit requests and their results (§2 airtime, §6 transmit request and result, §7 "Reply
// timing and a busy gateway"; GW2, D104): at a given time, as soon as possible with a latest
// moment, siren commands first, a full queue, requests that are not valid, the airtime budget
// with its kept-back fifth; exactly one result for every request.

#include <algorithm>
#include <iterator>
#include <string>

#include "gateway_bench.hpp"
#include "hsn/device/services/radio_plan.hpp"
#include "hsn/roles/gateway/gateway_clock.hpp"

namespace hsn::test {
namespace {

using device::microseconds;
using host::HubAction;
using roles::gateway::clock_value;
using roles::gateway::kTransmitQueueSize;

/** The gateway's clock value at a true instant. */
std::uint32_t gateway_time(host::SimDevice& gateway, device::Instant true_time) {
  return clock_value(gateway.clock().local(true_time));
}

/** A long send (SF12, 30 bytes, about 1.6 s) that keeps the radio busy. */
std::uint32_t occupy_radio(LinkSite& site, std::uint32_t tag) {
  return site.hub.send_request(site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0,
                                                opaque_packet(0xB0, tag, 30), 0));
}

TEST_CASE("GW2 a heartbeat reply goes at the fixed moment on the gateway's own clock (§7)") {
  Site site(gateway_mode());
  host::SimDevice& gateway = add_gateway(site, "gateway", {}, -300);
  ScriptSensorLog sensor_log;
  ScriptSensorConfig config;
  config.heartbeat_every = seconds(60);
  config.link_check_every = 1;
  host::SimDevice& door = site.sensor("door", config, sensor_log);
  site.sim.run_until(at(seconds(65)));
  INFO(site.sim.timeline().select().dump() << site.hub.dump());

  const auto heartbeat = door.records().kind(RecordKind::transmission).records();
  const auto reply = gateway.records().kind(RecordKind::transmission).records();
  REQUIRE(heartbeat.size() == 1);
  REQUIRE(reply.size() == 1);
  // Exactly the reply moment after the heartbeat's end, counted on the gateway's clock.
  CHECK(gateway.clock().local(reply[0].from) ==
        gateway.clock().local(heartbeat[0].until) + seconds(1));
  CHECK(decision_values(site.hub, HubAction::transmit_result, "door") ==
        std::vector<std::int64_t>{protocol::TransmitOutcome::sent});
  const auto results = hub_got<protocol::TransmitResult>(site.hub, "gateway");
  REQUIRE(results.size() == 1);
  CHECK(results[0].sent_at_micros == gateway_time(gateway, reply[0].from));
  REQUIRE(sensor_log.heard.size() == 1);
  CHECK(sensor_log.heard[0].answered == sensor_log.sent[0]);
}

TEST_CASE("GW2 a fixed moment that has passed when the request comes is answered too late") {
  host::HubOptions options = gateway_mode();
  // A link so slow that the round trip takes longer than the reply moment.
  options.link_latency = milliseconds(600);
  Site site(options);
  host::SimDevice& gateway = add_gateway(site, "gateway");
  ScriptSensorLog sensor_log;
  ScriptSensorConfig config;
  config.heartbeat_every = seconds(60);
  config.link_check_every = 1;
  site.sensor("door", config, sensor_log);
  site.sim.run_until(at(seconds(65)));
  CHECK(decision_values(site.hub, HubAction::transmit_result, "door") ==
        std::vector<std::int64_t>{protocol::TransmitOutcome::too_late});
  CHECK(gateway.records().kind(RecordKind::transmission).empty());
  CHECK(sensor_log.heard.empty());
}

TEST_CASE("§7 at a given time: sent exactly then, skipped when the radio is busy, late refused") {
  LinkSite site;
  std::uint32_t on_time = 0;
  std::uint32_t busy = 0;
  std::uint32_t late = 0;
  site.sim.schedule(at(seconds(3)), [&]() {
    on_time = site.hub.send_request(site.hub.request(protocol::TransmitWhen::at_time,
                                                     gateway_time(site.gateway, at(seconds(4))),
                                                     opaque_packet(0xA, 1)));
    late = site.hub.send_request(site.hub.request(protocol::TransmitWhen::at_time,
                                                  gateway_time(site.gateway, at(seconds(2))),
                                                  opaque_packet(0xA, 2)));
  });
  site.sim.schedule(at(seconds(5)), [&]() {
    occupy_radio(site, 3);
    // The moment falls while the radio is still sending.
    busy = site.hub.send_request(site.hub.request(protocol::TransmitWhen::at_time,
                                                  gateway_time(site.gateway, at(seconds(6))),
                                                  opaque_packet(0xA, 4)));
  });
  site.sim.run_until(at(seconds(10)));
  INFO(site.sim.timeline().select().dump());

  const auto sent = site.gateway.records().kind(RecordKind::transmission).records();
  REQUIRE(sent.size() == 2);
  CHECK(sent[0].from == at(seconds(4)));
  REQUIRE(site.hub.result_for(on_time).has_value());
  CHECK(site.hub.result_for(on_time)->result == protocol::TransmitOutcome::sent);
  CHECK(site.hub.result_for(on_time)->sent_at_micros == gateway_time(site.gateway, at(seconds(4))));
  CHECK(site.hub.result_for(late)->result == protocol::TransmitOutcome::too_late);
  CHECK(site.hub.result_for(busy)->result == protocol::TransmitOutcome::radio_busy);
  // The busy answer came at the moment, not later.
  for (const LinkHub::Got& got : site.hub.got(type::transmit_result)) {
    protocol::TransmitResult result;
    REQUIRE(protocol::decode_body(protocol::ByteView(got.body.data(), got.body.size()), result) ==
            protocol::Error::none);
    if (result.request_counter == busy) {
      CHECK(got.at == at(seconds(6)) + milliseconds(25));
    }
  }
  CHECK(site.hub.results().size() == 4);
}

TEST_CASE("§7 a moment more than half the clock's span away maps to the nearest instant") {
  LinkSite site;
  std::uint32_t wrapped = 0;
  // 4,294 s is the clock's span: a time just before "now" taken naively as far in the future
  // would be sent about 71 minutes later.
  site.sim.schedule(at(seconds(3)), [&]() {
    wrapped = site.hub.send_request(site.hub.request(
        protocol::TransmitWhen::at_time, gateway_time(site.gateway, at(seconds(3))) - 1000000u,
        opaque_packet(0xC, 1)));
  });
  site.sim.run_until(at(seconds(5)));
  REQUIRE(site.hub.result_for(wrapped).has_value());
  CHECK(site.hub.result_for(wrapped)->result == protocol::TransmitOutcome::too_late);
  CHECK(gateway_of(site.gateway).queue().empty());
}

TEST_CASE("§7 as soon as possible: when the radio is free, but no later than the latest moment") {
  LinkSite site;
  std::uint32_t first = 0;
  std::uint32_t tight = 0;
  std::uint32_t roomy = 0;
  std::uint32_t open = 0;
  site.sim.schedule(at(seconds(5)), [&]() {
    first = occupy_radio(site, 1);
    tight = site.hub.send_request(site.hub.request(
        protocol::TransmitWhen::as_soon_as_possible,
        gateway_time(site.gateway, at(seconds(5) + milliseconds(300))), opaque_packet(0xD, 2)));
    roomy = site.hub.send_request(site.hub.request(protocol::TransmitWhen::as_soon_as_possible,
                                                   gateway_time(site.gateway, at(seconds(8))),
                                                   opaque_packet(0xD, 3)));
    open = site.hub.send_request(
        site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0, opaque_packet(0xD, 4)));
  });
  site.sim.run_until(at(seconds(12)));
  INFO(site.sim.timeline().select().dump());

  CHECK(site.hub.result_for(first)->result == protocol::TransmitOutcome::sent);
  CHECK(site.hub.result_for(tight)->result == protocol::TransmitOutcome::too_late);
  CHECK(site.hub.result_for(roomy)->result == protocol::TransmitOutcome::sent);
  CHECK(site.hub.result_for(open)->result == protocol::TransmitOutcome::sent);
  const auto sent = site.gateway.records().kind(RecordKind::transmission).records();
  REQUIRE(sent.size() == 3);
  // One after the other, each the moment the radio was free, in the order they came.
  CHECK(sent[1].from == sent[0].until);
  CHECK(sent[2].from == sent[1].until);
  CHECK(transmitted(site.gateway)[1] == opaque_packet(0xD, 3));
  CHECK(site.hub.result_for(roomy)->sent_at_micros == gateway_time(site.gateway, sent[1].from));
  // "Too late" was said once the latest moment had passed, while the radio was still busy.
  for (const LinkHub::Got& got : site.hub.got(type::transmit_result)) {
    protocol::TransmitResult result;
    REQUIRE(protocol::decode_body(protocol::ByteView(got.body.data(), got.body.size()), result) ==
            protocol::Error::none);
    if (result.request_counter == tight) {
      CHECK(got.at < sent[0].until);
    }
  }
}

TEST_CASE("§7 siren commands go before replies waiting for the radio") {
  LinkSite site;
  std::vector<std::uint32_t> normal;
  std::uint32_t siren = 0;
  site.sim.schedule(at(seconds(5)), [&]() {
    occupy_radio(site, 1);
    for (std::uint32_t i = 0; i < 3; ++i) {
      normal.push_back(site.hub.send_request(site.hub.request(
          protocol::TransmitWhen::as_soon_as_possible, 0, opaque_packet(0xE, 10 + i))));
    }
    siren = site.hub.send_request(site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0,
                                                   opaque_packet(0x5, 20), 5,
                                                   protocol::TransmitPriority::siren_command, 22));
  });
  site.sim.run_until(at(seconds(12)));
  const auto packets = transmitted(site.gateway);
  REQUIRE(packets.size() == 5);
  CHECK(packets[1] == opaque_packet(0x5, 20));
  CHECK(packets[2] == opaque_packet(0xE, 10));
  CHECK(packets[3] == opaque_packet(0xE, 11));
  CHECK(packets[4] == opaque_packet(0xE, 12));
  CHECK(site.hub.result_for(siren)->result == protocol::TransmitOutcome::sent);
  for (const std::uint32_t counter : normal) {
    CHECK(site.hub.result_for(counter)->result == protocol::TransmitOutcome::sent);
  }
}

TEST_CASE("§7 a full queue refuses more, but a siren command takes a reply's place") {
  LinkSite site;
  std::vector<std::uint32_t> queued;
  std::uint32_t one_more = 0;
  std::uint32_t siren = 0;
  site.sim.schedule(at(seconds(5)), [&]() {
    occupy_radio(site, 1);
    for (std::uint32_t i = 0; i < kTransmitQueueSize; ++i) {
      queued.push_back(site.hub.send_request(site.hub.request(
          protocol::TransmitWhen::as_soon_as_possible, 0, opaque_packet(0xF, 10 + i))));
    }
    one_more = site.hub.send_request(
        site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0, opaque_packet(0xF, 30)));
    siren = site.hub.send_request(site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0,
                                                   opaque_packet(0x5, 40), 5,
                                                   protocol::TransmitPriority::siren_command));
  });
  site.sim.run_until(at(seconds(5) + milliseconds(100)));
  CHECK(gateway_of(site.gateway).queue().size() == kTransmitQueueSize);
  CHECK(site.hub.result_for(one_more)->result == protocol::TransmitOutcome::radio_busy);
  // The newest reply made room for the siren command.
  CHECK(site.hub.result_for(queued.back())->result == protocol::TransmitOutcome::radio_busy);
  site.sim.run_until(at(seconds(20)));
  const auto packets = transmitted(site.gateway);
  REQUIRE(packets.size() == 1 + kTransmitQueueSize);
  CHECK(packets[1] == opaque_packet(0x5, 40));
  CHECK(site.hub.result_for(siren)->result == protocol::TransmitOutcome::sent);
  for (std::size_t i = 0; i + 1 < queued.size(); ++i) {
    CHECK(site.hub.result_for(queued[i])->result == protocol::TransmitOutcome::sent);
  }
  // Exactly one result per request: the long send, the queue's worth, one more, the siren.
  CHECK(site.hub.results().size() == 1 + kTransmitQueueSize + 1 + 1);
}

TEST_CASE("§6 a request the gateway cannot act on is answered not valid") {
  LinkSite site;
  std::uint32_t rate = 0;
  std::uint32_t when = 0;
  std::uint32_t short_packet = 0;
  site.sim.schedule(at(seconds(3)), [&]() {
    rate = site.hub.send_request(
        site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0, opaque_packet(1, 1), 9));
    when = site.hub.send_request(site.hub.request(7, 0, opaque_packet(1, 2)));
    // The codec will not build a request carrying 17 bytes, so it is written out by hand: the
    // type byte and the request's 8 bytes, then the 17-byte packet.
    constexpr std::size_t kHead = 9;
    Bytes plaintext(kHead + 17, 0x18);
    const std::uint8_t head[kHead] = {
        type::transmit_request, protocol::TransmitWhen::as_soon_as_possible, 0, 0, 0, 0, 5, 14, 0};
    std::copy(std::begin(head), std::end(head), plaintext.begin());
    short_packet = site.hub.next_counter;
    site.hub.send_raw(site.hub.seal_plaintext(plaintext));
  });
  site.sim.run_until(at(seconds(5)));
  CHECK(site.hub.result_for(rate)->result == protocol::TransmitOutcome::not_valid);
  CHECK(site.hub.result_for(when)->result == protocol::TransmitOutcome::not_valid);
  CHECK(site.hub.result_for(short_packet)->result == protocol::TransmitOutcome::not_valid);
  CHECK(transmitted(site.gateway).empty());
}

TEST_CASE("D104 10% of the hour on 869.525 MHz, the last fifth kept for siren commands (§2)") {
  host::SimulationOptions options;
  options.keep_fake_records = false;
  LinkSite site(0x20, options);
  // The longest packet at SF12: about 9 s on air each.
  const Bytes longest(255, 0x18);
  const device::Duration each = device::time_on_air(0, longest.size()).value();
  const std::size_t hour_holds = static_cast<std::size_t>(seconds(360).us / each.us);
  const std::size_t routine_fit = static_cast<std::size_t>(seconds(288).us / each.us);
  std::vector<std::uint32_t> routine;
  std::vector<std::uint32_t> sirens;
  for (std::int64_t i = 0; i < 34; ++i) {
    site.sim.schedule(at(seconds(3 + 10 * i)), [&]() {
      routine.push_back(site.hub.send_request(
          site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0, longest, 0)));
    });
  }
  // Siren commands fill the rest of the hour, and no more.
  for (std::int64_t i = 0; i < static_cast<std::int64_t>(hour_holds - routine_fit); ++i) {
    site.sim.schedule(at(seconds(343 + 10 * i)), [&]() {
      sirens.push_back(site.hub.send_request(
          site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0, longest, 0,
                           protocol::TransmitPriority::siren_command)));
    });
  }
  site.sim.run_until(at(seconds(460)));

  const auto count = [&](const std::vector<std::uint32_t>& counters, std::uint8_t outcome) {
    std::size_t total = 0;
    for (const std::uint32_t counter : counters) {
      REQUIRE(site.hub.result_for(counter).has_value());
      total += site.hub.result_for(counter)->result == outcome ? 1u : 0u;
    }
    return total;
  };
  // Routine requests stop at four fifths of 360 s; the rest are "no airtime left".
  CHECK(count(routine, protocol::TransmitOutcome::sent) == routine_fit);
  CHECK(count(routine, protocol::TransmitOutcome::no_airtime) == routine.size() - routine_fit);
  // Siren commands use the last fifth.
  CHECK(count(sirens, protocol::TransmitOutcome::sent) == sirens.size());
  const host::Selection on_air = site.gateway.records().kind(RecordKind::transmission);
  CHECK(on_air.busiest_hour() <= seconds(360));
  CHECK(on_air.count() == hour_holds);
  // Inside the limit, nothing was logged as past it.
  auto codes = site.hub.log_codes();
  CHECK(std::count(codes.begin(), codes.end(), device::log_code::airtime_past_limit) == 0);
  // The status says how much of the hour is used, in hundredths of a percent.
  const auto statuses = site.hub.statuses();
  REQUIRE_FALSE(statuses.empty());
  CHECK(statuses.back().airtime_hundredths_percent > 900);
  CHECK(statuses.back().airtime_hundredths_percent <= 1000);
}

TEST_CASE("D111 past the full hour a siren command still goes after its gap; a reply does not") {
  host::SimulationOptions options;
  options.keep_fake_records = false;
  LinkSite site(0x20, options);
  const Bytes longest(255, 0x18);
  const device::Duration each = device::time_on_air(0, longest.size()).value();
  // The whole legal hour used by siren commands, 10 s apart.
  const std::int64_t filling = seconds(360).us / each.us;
  for (std::int64_t i = 0; i < filling; ++i) {
    site.sim.schedule(at(seconds(3 + 10 * i)), [&]() {
      site.hub.send_request(site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0,
                                             longest, 0,
                                             protocol::TransmitPriority::siren_command));
    });
  }
  // Then three siren commands at once, and an ordinary reply.
  std::vector<std::uint32_t> urgent;
  std::uint32_t reply = 0;
  const device::Instant full = at(seconds(3 + 10 * filling + 100));
  site.sim.schedule(full, [&]() {
    for (int i = 0; i < 3; ++i) {
      urgent.push_back(site.hub.send_request(
          site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0, longest, 0,
                           protocol::TransmitPriority::siren_command)));
    }
    reply = site.hub.send_request(
        site.hub.request(protocol::TransmitWhen::as_soon_as_possible, 0, opaque_packet(9, 9)));
  });
  site.sim.run_until(full + seconds(300));
  INFO(site.sim.timeline().select().between(full, full + seconds(300)).dump());

  CHECK(site.hub.result_for(reply)->result == protocol::TransmitOutcome::no_airtime);
  for (const std::uint32_t counter : urgent) {
    REQUIRE(site.hub.result_for(counter).has_value());
    CHECK(site.hub.result_for(counter)->result == protocol::TransmitOutcome::sent);
  }
  // Each went nine times its airtime after the one before: a tenth of the channel at most.
  const auto all = site.gateway.records().kind(RecordKind::transmission).records();
  REQUIRE(all.size() == static_cast<std::size_t>(filling) + 3);
  const std::size_t first_past = static_cast<std::size_t>(filling);
  for (std::size_t i = first_past; i < all.size(); ++i) {
    CHECK(all[i].from - all[i - 1].until >= microseconds(9 * each.us));
  }
  // The two held back went the moment their gap ended, not at some later wake.
  for (std::size_t i = first_past + 1; i < all.size(); ++i) {
    CHECK(all[i].from == all[i - 1].until + microseconds(9 * each.us));
  }
  const device::Duration window = all.back().until - all[first_past - 1].until;
  const device::Duration used = all.back().until - all.back().from +
                                (all[first_past + 1].until - all[first_past + 1].from) +
                                (all[first_past].until - all[first_past].from);
  CHECK(used.us * 10 <= window.us);
  // Each past the limit was logged as a warning.
  const auto codes = site.hub.log_codes();
  CHECK(std::count(codes.begin(), codes.end(), device::log_code::airtime_past_limit) == 3);
}

TEST_CASE("§6 overload: a full queue and 12 more at once, 6 siren commands; one result each") {
  LinkSite site;
  // In this order: a queue's worth of replies, then sirens and replies in this pattern.
  const std::string order = std::string(kTransmitQueueSize, 'N') + "SNSNSSNNSSNN";
  const std::size_t kept_replies = kTransmitQueueSize - 6;
  std::vector<std::uint32_t> counters;
  std::vector<bool> is_siren;
  site.sim.schedule(at(seconds(5)), [&]() {
    occupy_radio(site, 1);
    for (std::uint32_t i = 0; i < order.size(); ++i) {
      const bool siren = order[i] == 'S';
      is_siren.push_back(siren);
      counters.push_back(site.hub.send_request(site.hub.request(
          protocol::TransmitWhen::as_soon_as_possible, 0, opaque_packet(siren ? 0x5 : 0xF, 100 + i),
          5,
          siren ? protocol::TransmitPriority::siren_command : protocol::TransmitPriority::normal)));
    }
  });
  site.sim.run_until(at(seconds(5) + milliseconds(500)));
  const roles::gateway::CarriedCounts& counts = gateway_of(site.gateway).counts();
  CHECK(counts.queue_highest == kTransmitQueueSize);
  CHECK(gateway_of(site.gateway).queue().size() == kTransmitQueueSize);
  // Each siren command took the place of the newest reply still queued, six in turn.
  CHECK(counts.displaced == 6);
  // Each reply after the queue filled was refused: 6 of them.
  CHECK(counts.queue_full == 6);
  for (std::size_t i = 0; i < counters.size(); ++i) {
    INFO("request " << i << (is_siren[i] ? " (siren)" : ""));
    const bool kept = is_siren[i] || i < kept_replies;
    if (!kept) {
      REQUIRE(site.hub.result_for(counters[i]).has_value());
      CHECK(site.hub.result_for(counters[i])->result == protocol::TransmitOutcome::radio_busy);
    } else {
      CHECK_FALSE(site.hub.result_for(counters[i]).has_value());
    }
  }
  site.sim.run_until(at(seconds(10)));
  // The six siren commands went first, in the order they came, then the replies kept.
  const auto packets = transmitted(site.gateway);
  REQUIRE(packets.size() == 1 + kTransmitQueueSize);
  std::size_t next = 1;
  for (std::size_t i = 0; i < counters.size(); ++i) {
    if (is_siren[i]) {
      CHECK(packets[next++] == opaque_packet(0x5, 100 + static_cast<std::uint32_t>(i)));
    }
  }
  for (std::size_t i = 0; i < kept_replies; ++i) {
    CHECK(packets[7 + i] == opaque_packet(0xF, 100 + static_cast<std::uint32_t>(i)));
  }
  // Exactly one result for each request and the long send (result_for refuses a second).
  CHECK(site.hub.results().size() == 1 + order.size());
  for (const std::uint32_t counter : counters) {
    CHECK(site.hub.result_for(counter).has_value());
  }
  CHECK(counts.results[protocol::TransmitOutcome::sent] == 1 + kTransmitQueueSize);
  CHECK(counts.results[protocol::TransmitOutcome::radio_busy] == 12);
  // And each was logged with its own code.
  const auto codes = site.hub.log_codes();
  CHECK(std::count(codes.begin(), codes.end(), roles::gateway::gateway_log::queue_full) == 6);
  CHECK(std::count(codes.begin(), codes.end(), roles::gateway::gateway_log::request_displaced) ==
        6);
}

}  // namespace
}  // namespace hsn::test
