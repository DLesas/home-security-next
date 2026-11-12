// The test hub's ideal radio: deaf while it sends, a fixed moment skipped when busy, packets for
// as soon as possible waiting with siren commands first, until their latest moment.

#include <doctest/doctest.h>

#include <vector>

#include "hsn/host/hub_radio.hpp"
#include "hsn/host/sim_time.hpp"

namespace hsn::test {
namespace {

using device::Instant;
using device::milliseconds;
using device::seconds;
using host::at;
using host::Bytes;
using host::HubRadio;

constexpr std::uint32_t kSite = 868300000;

/** A station that only sends. */
class Sender final : public host::StationListener {
public:
  void tx_done(Instant) override {}
  void rx_done(Instant, const Bytes&, std::int16_t, std::int8_t, std::uint8_t) override {}
  void rx_crc_error(Instant) override {}
  void rx_timeout(Instant) override {}
  void header_seen(Instant) override {}
  void cad_done(Instant, bool) override {}
};

struct Bench {
  struct Result {
    std::uint64_t tag;
    HubRadio::Outcome outcome;
    Instant at;
  };

  host::Scheduler scheduler;
  host::Timeline timeline;
  host::PacketLabels labels;
  host::Medium medium{scheduler, timeline, labels};
  Sender sender_events;
  host::StationId sender = medium.add_station(timeline.add_actor("sensor"), sender_events);
  std::vector<Result> results;
  std::vector<Instant> heard;
  HubRadio radio{scheduler,
                 medium,
                 timeline.add_actor("hub"),
                 kSite,
                 0x3F,
                 [this](const Bytes&, std::int16_t, std::int8_t, std::uint8_t) {
                   heard.push_back(scheduler.now());
                 },
                 [this](std::uint64_t tag, HubRadio::Outcome outcome, std::uint8_t) {
                   results.push_back(Result{tag, outcome, scheduler.now()});
                 }};

  /** Queues a send at a true instant. */
  void send(Instant when, std::uint64_t tag, bool siren, std::uint8_t data_rate = 5,
            Instant latest = Instant::never(), bool at_moment = false) {
    scheduler.schedule(when, [this, tag, siren, data_rate, latest, at_moment, when]() {
      HubRadio::Send send;
      send.packet = Bytes(30, static_cast<std::uint8_t>(tag));
      send.data_rate = data_rate;
      send.siren_command = siren;
      send.latest = latest;
      send.at_moment = at_moment;
      send.moment = when;
      send.tag = tag;
      radio.send(send);
    });
  }
};

TEST_CASE("the hub's radio sends siren commands first, and drops what would start too late") {
  Bench bench;
  // Tag 1 holds the radio at SF12 for 1.6 s; 2 and 3 wait; 4 cannot start before 2 s.
  bench.send(at(seconds(1)), 1, false, 0);
  bench.send(at(seconds(1)) + milliseconds(100), 2, false);
  bench.send(at(seconds(1)) + milliseconds(200), 3, true);
  bench.send(at(seconds(1)) + milliseconds(300), 4, false, 5, at(seconds(2)));
  bench.scheduler.run_until(at(seconds(10)));
  REQUIRE(bench.results.size() == 4);
  CHECK(bench.results[0].tag == 1);
  CHECK(bench.results[1].tag == 3);
  CHECK(bench.results[1].outcome == HubRadio::Outcome::sent);
  CHECK(bench.results[2].tag == 2);
  CHECK(bench.results[3].tag == 4);
  CHECK(bench.results[3].outcome == HubRadio::Outcome::too_late);
}

TEST_CASE("the hub's radio skips a fixed moment when busy, and is deaf while it sends") {
  Bench bench;
  bench.send(at(seconds(1)), 1, false, 0);
  bench.send(at(seconds(2)), 2, false, 5, Instant::never(), true);
  // A sensor packet while it sends is not heard; one after it is.
  bench.scheduler.schedule(at(seconds(1)) + milliseconds(500), [&bench]() {
    bench.medium.transmit(bench.sender, device::RadioChannel{kSite, 5}, 14, Bytes(25, 9));
  });
  bench.scheduler.schedule(at(seconds(4)), [&bench]() {
    bench.medium.transmit(bench.sender, device::RadioChannel{kSite, 5}, 14, Bytes(25, 9));
  });
  bench.scheduler.run_until(at(seconds(10)));
  REQUIRE(bench.results.size() == 2);
  CHECK(bench.results[1].outcome == HubRadio::Outcome::skipped_busy);
  REQUIRE(bench.heard.size() == 1);
  CHECK(bench.heard[0] > at(seconds(4)));
}

}  // namespace
}  // namespace hsn::test
