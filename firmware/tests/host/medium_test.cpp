// The Medium (design section 8): time on air, collisions and capture, spreading factors, deafness
// while sending, preamble coverage, channel activity detection, range, noise, and the Radio
// contract's timed receives. Stations are driven directly; the bridge to a FakeRadio is covered by
// the simulation and hub tests.

#include <doctest/doctest.h>

#include <cmath>
#include <vector>

#include "hsn/device/services/radio_plan.hpp"
#include "hsn/host/lora_physics.hpp"
#include "hsn/host/medium.hpp"
#include "hsn/host/sim_time.hpp"
#include "hsn/host/simulation_error.hpp"

namespace hsn::test {
namespace {

using device::Instant;
using device::milliseconds;
using device::seconds;
using host::at;
using host::Bytes;
using host::RecordKind;
using host::StationId;

constexpr std::uint32_t kSite = 868300000;

/** A station that records everything it is told. */
class Recorder final : public host::StationListener {
public:
  struct Heard {
    Instant at;
    Bytes packet;
    std::int16_t rssi_dbm = 0;
    std::int8_t snr_quarter_db = 0;
  };

  void tx_done(Instant at) override {
    sent.push_back(at);
  }
  void rx_done(Instant at, const Bytes& packet, std::int16_t rssi_dbm, std::int8_t snr_quarter_db,
               std::uint8_t) override {
    heard.push_back(Heard{at, packet, rssi_dbm, snr_quarter_db});
  }
  void rx_crc_error(Instant at) override {
    crc_errors.push_back(at);
  }
  void rx_timeout(Instant at) override {
    timeouts.push_back(at);
  }
  void header_seen(Instant at) override {
    headers.push_back(at);
  }
  void cad_done(Instant at, bool busy) override {
    checks.push_back(at);
    busy_results.push_back(busy);
  }

  std::vector<Instant> sent;
  std::vector<Heard> heard;
  std::vector<Instant> crc_errors;
  std::vector<Instant> timeouts;
  std::vector<Instant> headers;
  std::vector<Instant> checks;
  std::vector<bool> busy_results;
};

/** A medium with three stations: two senders and a receiver. */
struct Bench {
  host::Scheduler scheduler;
  host::Timeline timeline;
  host::PacketLabels labels;
  host::Medium medium{scheduler, timeline, labels};
  Recorder a_events;
  Recorder b_events;
  Recorder c_events;
  Recorder d_events;
  StationId a = medium.add_station(timeline.add_actor("a"), a_events);
  StationId b = medium.add_station(timeline.add_actor("b"), b_events);
  StationId c = medium.add_station(timeline.add_actor("c"), c_events);
  StationId d = medium.add_station(timeline.add_actor("d"), d_events);

  /** Runs `action` at a true instant. */
  void when(Instant instant, std::function<void()> action) {
    scheduler.schedule(instant, std::move(action));
  }

  void send(StationId from, Instant instant, std::uint8_t data_rate = 5, std::size_t size = 25,
            std::int8_t power = 14, std::uint32_t frequency = kSite) {
    when(instant, [this, from, data_rate, size, power, frequency]() {
      medium.transmit(from, device::RadioChannel{frequency, data_rate}, power,
                      Bytes(size, static_cast<std::uint8_t>(from + 1)));
    });
  }

  void listen(StationId station, Instant instant, std::uint8_t rates = 1u << 5,
              device::Duration timeout = device::Duration{},
              device::RxStop stop = device::RxStop::preamble, std::uint8_t symbol_timeout = 0,
              std::uint32_t frequency = kSite) {
    when(instant, [this, station, rates, timeout, stop, symbol_timeout, frequency]() {
      host::Listening listening;
      listening.frequency_hz = frequency;
      listening.data_rates = rates;
      listening.timeout = timeout;
      listening.stop = stop;
      listening.symbol_timeout = symbol_timeout;
      medium.receive(station, listening);
    });
  }

  void run(Instant until = at(seconds(30))) {
    scheduler.run_until(until);
  }

  std::size_t records(RecordKind kind) const {
    return timeline.select().kind(kind).count();
  }
};

TEST_CASE("time on air matches the protocol's table for every packet and spreading factor") {
  // Protocol section 2, "Time on air", in milliseconds.
  struct Row {
    std::size_t bytes;
    std::int64_t sf7, sf9, sf10, sf12;
  };
  const Row rows[] = {{25, 62, 206, 412, 1483}, {30, 72, 226, 453, 1647}, {18, 51, 185, 330, 1319},
                      {21, 57, 185, 371, 1483}, {28, 67, 226, 412, 1647}, {26, 62, 206, 412, 1647}};
  for (const Row& row : rows) {
    const std::pair<std::uint8_t, std::int64_t> cells[] = {
        {5, row.sf7}, {3, row.sf9}, {2, row.sf10}, {0, row.sf12}};
    for (const auto& cell : cells) {
      INFO(row.bytes << " bytes at DR" << static_cast<int>(cell.first));
      Bench bench;
      bench.send(bench.a, at(seconds(1)), cell.first, row.bytes);
      bench.run();
      REQUIRE(bench.a_events.sent.size() == 1);
      const device::Duration on_air = bench.a_events.sent[0] - at(seconds(1));
      CHECK(std::llround(static_cast<double>(on_air.us) / 1000.0) == cell.second);
      const auto records = bench.timeline.select().kind(RecordKind::transmission).records();
      REQUIRE(records.size() == 1);
      CHECK(records[0].until - records[0].from == on_air);
    }
  }
}

TEST_CASE("two packets overlapping on one frequency and data rate are both lost") {
  Bench bench;
  bench.listen(bench.c, at(seconds(0)));
  bench.send(bench.a, at(seconds(1)));
  bench.send(bench.b, at(seconds(1)) + milliseconds(30));
  bench.run();
  CHECK(bench.c_events.heard.empty());
  // The receiver locked onto the first, which ends in a CRC error; both are recorded as lost.
  CHECK(bench.c_events.crc_errors.size() == 1);
  CHECK(bench.records(RecordKind::collision) == 2);
  CHECK(bench.records(RecordKind::reception) == 0);
}

TEST_CASE("one packet survives another only when it is the capture margin stronger") {
  // A starts first and holds the receiver; B starts 10 ms later. The stronger one arrives at
  // −86 dBm, the weaker `difference` dB lower.
  struct Case {
    const char* name;
    bool newcomer_stronger;
    double difference;
    int heard;  // 0 none, 1 A, 2 B
    int held;   // the packet the receiver ends on: 1 A, 2 B
  };
  const Case cases[] = {
      {"a newcomer 5.9 dB stronger does not capture: both lost", true, 5.9, 0, 1},
      {"a newcomer 6 dB stronger captures", true, 6.0, 2, 2},
      {"a held packet 5.9 dB stronger does not survive: both lost", false, 5.9, 0, 1},
      {"a held packet 6 dB stronger survives", false, 6.0, 1, 1},
      {"equal: both lost", true, 0.0, 0, 1},
  };
  const device::Duration on_air = *device::time_on_air(5, 25);
  for (const Case& item : cases) {
    INFO(item.name);
    Bench bench;
    bench.medium.set_path_loss(item.newcomer_stronger ? bench.a : bench.b, bench.c,
                               100.0 + item.difference);
    bench.listen(bench.c, at(seconds(0)));
    bench.send(bench.a, at(seconds(1)));
    bench.send(bench.b, at(seconds(1)) + milliseconds(10));
    bench.run();
    // The receiver stays on the packet it holds unless captured: the first packet lost here is
    // the one it did not end on, and a lost held packet ends in a CRC error at its own end.
    const auto collisions = bench.timeline.select().kind(RecordKind::collision).records();
    REQUIRE_FALSE(collisions.empty());
    CHECK(bench.timeline.actor_name(collisions[0].peer) == (item.held == 1 ? "b" : "a"));
    if (item.heard == 0) {
      CHECK(bench.c_events.heard.empty());
      CHECK(collisions.size() == 2);
      REQUIRE(bench.c_events.crc_errors.size() == 1);
      CHECK(bench.c_events.crc_errors[0] == at(seconds(1)) + on_air);
    } else {
      REQUIRE(bench.c_events.heard.size() == 1);
      CHECK(bench.c_events.heard[0].packet[0] == item.heard);
      CHECK(bench.c_events.heard[0].rssi_dbm == -86);
      CHECK(bench.records(RecordKind::collision) == 1);
    }
  }
}

TEST_CASE("the capture margin can be set") {
  for (const double margin : {6.0, 4.0}) {
    INFO("margin " << margin);
    Bench bench;
    bench.medium.set_capture_margin(margin);
    bench.medium.set_path_loss(bench.b, bench.c, 105.0);
    bench.listen(bench.c, at(seconds(0)));
    bench.send(bench.a, at(seconds(1)));
    bench.send(bench.b, at(seconds(1)) + milliseconds(10));
    bench.run();
    CHECK(bench.c_events.heard.size() == (margin < 5.0 ? 1u : 0u));
  }
}

TEST_CASE("a receiver hears only its own data rate and frequency") {
  SUBCASE("a packet at another data rate is not heard") {
    Bench bench;
    bench.listen(bench.c, at(seconds(0)), 1u << 5, seconds(5));
    bench.send(bench.a, at(seconds(1)), 3);
    bench.run();
    CHECK(bench.c_events.heard.empty());
    CHECK(bench.c_events.timeouts.size() == 1);
  }
  SUBCASE("a packet on another frequency is not heard, nor seen by a channel check") {
    Bench bench;
    bench.listen(bench.c, at(seconds(0)), 1u << 5, seconds(5));
    bench.send(bench.a, at(seconds(1)), 5, 25, 14, 868100000);
    bench.when(at(seconds(1)) + milliseconds(10), [&bench]() {
      bench.medium.detect(bench.d, *device::cad_params(device::RadioChannel{kSite, 5}));
    });
    bench.run();
    CHECK(bench.c_events.heard.empty());
    REQUIRE(bench.d_events.busy_results.size() == 1);
    CHECK_FALSE(bench.d_events.busy_results[0]);
  }
  SUBCASE("overlapping packets at two data rates are each heard at their own rate") {
    Bench bench;
    bench.listen(bench.c, at(seconds(0)), 1u << 5);
    bench.listen(bench.d, at(seconds(0)), 1u << 3);
    bench.send(bench.a, at(seconds(1)), 5);
    bench.send(bench.b, at(seconds(1)) + milliseconds(5), 3);
    bench.run();
    REQUIRE(bench.c_events.heard.size() == 1);
    CHECK(bench.c_events.heard[0].packet[0] == 1);
    REQUIRE(bench.d_events.heard.size() == 1);
    CHECK(bench.d_events.heard[0].packet[0] == 2);
  }
}

TEST_CASE("a packet starting the instant another ends at a receiver is heard too") {
  Bench bench;
  const device::Duration on_air = *device::time_on_air(5, 25);
  bench.listen(bench.c, at(seconds(0)));
  bench.send(bench.a, at(seconds(1)));
  bench.send(bench.b, at(seconds(1)) + on_air);
  bench.run();
  REQUIRE(bench.c_events.heard.size() == 2);
  CHECK(bench.records(RecordKind::collision) == 0);
}

TEST_CASE("a packet at an unlisted data rate is a bench error") {
  Bench bench;
  bench.send(bench.a, at(seconds(1)), 7);
  CHECK_THROWS_AS(bench.run(), host::SimulationError);
}

TEST_CASE("packets at different spreading factors do not collide") {
  Bench bench;
  // A receiver hearing two data rates at once, as the hub's ideal radio does.
  bench.listen(bench.c, at(seconds(0)), (1u << 5) | (1u << 3));
  bench.send(bench.a, at(seconds(1)), 5);
  bench.send(bench.b, at(seconds(1)) + milliseconds(5), 3);
  bench.run();
  CHECK(bench.c_events.heard.size() == 2);
  CHECK(bench.records(RecordKind::collision) == 0);
}

TEST_CASE("a radio is deaf while it sends, and sending ends a reception") {
  SUBCASE("sending while a packet arrives") {
    Bench bench;
    bench.send(bench.c, at(seconds(1)), 0, 30);  // SF12: 1.6 s on air
    bench.send(bench.a, at(seconds(1)) + milliseconds(100));
    bench.listen(bench.c, at(seconds(5)));
    bench.run();
    CHECK(bench.c_events.heard.empty());
    CHECK(bench.c_events.sent.size() == 1);
  }
  SUBCASE("starting to send in the middle of a reception") {
    Bench bench;
    bench.listen(bench.c, at(seconds(0)));
    bench.send(bench.a, at(seconds(1)));
    bench.send(bench.c, at(seconds(1)) + milliseconds(20));
    bench.run();
    CHECK(bench.c_events.heard.empty());
    CHECK(bench.c_events.crc_errors.empty());
  }
}

TEST_CASE("a receiver must listen from the start of the preamble") {
  for (const std::int64_t late_us : {0, 1, 1000}) {
    INFO("listening starts " << late_us << " us after the packet");
    Bench bench;
    bench.send(bench.a, at(seconds(1)));
    bench.listen(bench.c, at(seconds(1)) + device::microseconds(late_us));
    bench.run();
    CHECK(bench.c_events.heard.size() == (late_us == 0 ? 1u : 0u));
  }
}

TEST_CASE("channel activity detection is busy only while a matching packet is on air") {
  const device::Duration cad = *device::cad_duration(5);
  struct Case {
    const char* name;
    std::uint8_t data_rate;
    bool cut;
    std::int64_t check_after_ms;
    bool busy;
  };
  const Case cases[] = {{"on air, same rate", 5, false, 10, true},
                        {"after it ended", 5, false, 100, false},
                        {"another data rate", 3, false, 10, false},
                        {"out of earshot", 5, true, 10, false}};
  for (const Case& item : cases) {
    INFO(item.name);
    Bench bench;
    if (item.cut) {
      bench.medium.cut(bench.a, bench.c);
    }
    bench.send(bench.a, at(seconds(1)), item.data_rate);
    bench.when(at(seconds(1)) + milliseconds(item.check_after_ms), [&bench]() {
      device::CadParams params = *device::cad_params(device::RadioChannel{kSite, 5});
      bench.medium.detect(bench.c, params);
    });
    bench.run();
    REQUIRE(bench.c_events.busy_results.size() == 1);
    CHECK(bench.c_events.busy_results[0] == item.busy);
    CHECK(bench.c_events.checks[0] - (at(seconds(1)) + milliseconds(item.check_after_ms)) == cad);
    CHECK(bench.records(RecordKind::channel_check) == 1);
  }
}

TEST_CASE("a link below the sensitivity of its spreading factor is not heard") {
  for (const std::uint8_t rate : {std::uint8_t{5}, std::uint8_t{0}}) {
    const double sensitivity = host::kThermalNoiseDbm + host::demodulation_snr_db(rate);
    for (const double margin : {0.5, -0.5}) {
      INFO("DR" << static_cast<int>(rate) << ", " << margin << " dB from sensitivity");
      Bench bench;
      CHECK(bench.medium.sensitivity_dbm(rate) == sensitivity);
      // 14 dBm sent arrives at sensitivity + margin.
      bench.medium.set_path_loss(bench.a, bench.c, 14.0 - sensitivity - margin);
      bench.listen(bench.c, at(seconds(0)), static_cast<std::uint8_t>(1u << rate));
      bench.send(bench.a, at(seconds(1)), rate);
      bench.run();
      CHECK(bench.c_events.heard.size() == (margin > 0 ? 1u : 0u));
      // Below sensitivity it is not even noticed: no lock, so no CRC error either.
      CHECK(bench.c_events.crc_errors.empty());
      if (!bench.c_events.heard.empty()) {
        CHECK(
            bench.c_events.heard[0].snr_quarter_db ==
            static_cast<std::int8_t>(std::lround(4 * (host::demodulation_snr_db(rate) + margin))));
      }
    }
  }
}

TEST_CASE("scripted noise drowns a packet and is what a radio reads") {
  Bench bench;
  // The packet arrives at −86 dBm; noise at −75 dBm leaves it −11 dB, below SF7's −7.5 dB.
  bench.medium.script_noise(kSite, at(seconds(1)) + milliseconds(20), at(seconds(2)), -75.0);
  bench.medium.script_noise(869525000, at(seconds(0)), at(seconds(10)), -60.0);
  bench.listen(bench.c, at(seconds(0)));
  bench.send(bench.a, at(seconds(1)));
  bench.send(bench.a, at(seconds(3)));
  std::int16_t during = 0;
  std::int16_t after = 0;
  bench.when(at(seconds(1)) + milliseconds(30),
             [&]() { during = bench.medium.instant_rssi_dbm(bench.c); });
  bench.when(at(seconds(2)) + milliseconds(500),
             [&]() { after = bench.medium.instant_rssi_dbm(bench.c); });
  bench.run();
  // The first packet started clean, so it was locked, then lost to the noise: a CRC error.
  CHECK(bench.c_events.crc_errors.size() == 1);
  CHECK(bench.c_events.heard.size() == 1);
  CHECK(bench.medium.noise_dbm(kSite, at(seconds(1)) + milliseconds(30)) == -75.0);
  // Noise plus the packet on air (−86 dBm) reads a little above the noise.
  CHECK(during == -75);
  CHECK(after == -117);
}

TEST_CASE("a timed receive times out, unless a preamble or header came in time") {
  SUBCASE("nothing comes") {
    Bench bench;
    bench.listen(bench.c, at(seconds(1)), 1u << 5, milliseconds(300));
    bench.run();
    REQUIRE(bench.c_events.timeouts.size() == 1);
    CHECK(bench.c_events.timeouts[0] == at(seconds(1)) + milliseconds(300));
    CHECK(bench.records(RecordKind::rx_window) == 1);
    CHECK(bench.records(RecordKind::rx_timeout) == 1);
  }
  SUBCASE(
      "a packet starting just before the timeout is received to its end with stop on preamble") {
    Bench bench;
    bench.listen(bench.c, at(seconds(1)), 1u << 5, milliseconds(300));
    bench.send(bench.a, at(seconds(1)) + milliseconds(298));
    bench.run();
    CHECK(bench.c_events.timeouts.empty());
    REQUIRE(bench.c_events.heard.size() == 1);
    CHECK(bench.c_events.heard[0].at > at(seconds(1)) + milliseconds(300));
    // header_seen comes 20.25 symbols into the packet: 20.25 × 1.024 ms at SF7.
    REQUIRE(bench.c_events.headers.size() == 1);
    CHECK(bench.c_events.headers[0] ==
          at(seconds(1)) + milliseconds(298) + device::microseconds(20736));
  }
  SUBCASE("the timer stops only after the receive's symbol timeout in symbols") {
    // 2 ms before the timeout: one SF7 symbol (1.024 ms) fits, four (4.1 ms) do not.
    for (const std::uint8_t symbols : {std::uint8_t{1}, std::uint8_t{4}}) {
      INFO(static_cast<int>(symbols) << " symbols");
      Bench bench;
      bench.listen(bench.c, at(seconds(1)), 1u << 5, milliseconds(300), device::RxStop::preamble,
                   symbols);
      bench.send(bench.a, at(seconds(1)) + milliseconds(298));
      bench.run();
      CHECK(bench.c_events.heard.size() == (symbols == 1 ? 1u : 0u));
      CHECK(bench.c_events.timeouts.size() == (symbols == 1 ? 0u : 1u));
    }
  }
  SUBCASE("the same packet times out when the stop is on the header") {
    Bench bench;
    bench.listen(bench.c, at(seconds(1)), 1u << 5, milliseconds(300), device::RxStop::header);
    bench.send(bench.a, at(seconds(1)) + milliseconds(298));
    bench.run();
    CHECK(bench.c_events.timeouts.size() == 1);
    CHECK(bench.c_events.heard.empty());
  }
  SUBCASE("a timed receive takes one packet; a continuous one goes on") {
    for (const bool continuous : {false, true}) {
      Bench bench;
      bench.listen(bench.c, at(seconds(0)), 1u << 5, continuous ? device::Duration{} : seconds(10));
      bench.send(bench.a, at(seconds(1)));
      bench.send(bench.b, at(seconds(2)));
      bench.run();
      CHECK(bench.c_events.heard.size() == (continuous ? 2u : 1u));
    }
  }
}

}  // namespace
}  // namespace hsn::test
