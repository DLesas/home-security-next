// Data rates (protocol sections 2 and 7; LR4, LR10, LR11, D108): start at the fastest rate the
// site allows; after two unanswered reply-wanted packets listen at the sending rate with flag
// bit 7; after two more step one allowed rate slower; back to the reply rate when a reply gives
// one; keep the rate that last worked. Also the pure rate helpers.

#include <limits>
#include <vector>

#include "hsn/roles/sensor/data_rates.hpp"
#include "sensor_bench.hpp"

namespace hsn::test::sensor {
namespace {

using roles::sensor::fastest_allowed_rate;
using roles::sensor::slower_allowed_rate;

/**
 * 140 dB between the sensor and the hub: the sensor's 14 dBm arrives at −126 dBm, below SF7's
 * −124.5 dBm but above SF10's −132 dBm; the hub's 22 dBm arrives at −118 dBm, heard at any rate.
 */
constexpr double kFar = 140.0;

TEST_CASE("data rate helpers: allowed set, fastest, one slower, slow-rate heartbeat floor") {
  CHECK(fastest_allowed_rate(0x24) == 5);
  CHECK(fastest_allowed_rate(0x04) == 2);
  CHECK(fastest_allowed_rate(0x00) == 5);
  CHECK(fastest_allowed_rate(0xC0) == 5);
  CHECK(slower_allowed_rate(5, 0x24) == std::optional<std::uint8_t>(2));
  CHECK(slower_allowed_rate(2, 0x24) == std::nullopt);
  CHECK(slower_allowed_rate(5, 0x3F) == std::optional<std::uint8_t>(4));
  CHECK(slower_allowed_rate(1, 0x3F) == std::optional<std::uint8_t>(0));
  CHECK(slower_allowed_rate(9, 0x3F) == std::nullopt);
  CHECK(roles::sensor::heartbeat_interval(4, 5) == seconds(60));
  CHECK(roles::sensor::heartbeat_interval(4, 1) == seconds(180));
  CHECK(roles::sensor::heartbeat_interval(4, 0) == seconds(300));
  CHECK(roles::sensor::heartbeat_interval(40, 0) == seconds(600));
  CHECK(roles::sensor::heartbeat_interval(0, 5) == seconds(180));
  CHECK(roles::sensor::symbol_time(5) == device::microseconds(1024));
  CHECK(roles::sensor::symbol_time(0) == device::microseconds(32768));
  CHECK(roles::sensor::event_listen_time(0) == milliseconds(3000));
  CHECK(roles::sensor::event_listen_time(5) == milliseconds(1500));
}

TEST_CASE("LR4: a sensor starts at the fastest rate the site allows") {
  host::HubOptions options;
  options.allowed_data_rate_mask = 0x0C;
  Bench bench(options);
  host::SimDevice& door = bench.add();
  bench.run_to(5);
  CHECK(sent(door, type::started)[0].data_rate == 3);
}

TEST_CASE(
    "section 7: two misses, then bit 7 at the sending rate; two more, then one allowed rate "
    "slower; a reply ends it") {
  Bench bench;
  host::SensorConfig settings;
  // The hub, seeing the weak margin, tells the sensor DR2 in its replies (§7, faster replies).
  host::SimDevice& door = bench.add("door", settings);
  bench.run_to(10);
  bench.sim.medium().set_path_loss(door.station(), bench.hub.station(), kFar);
  settings.send_data_rate = 2;
  bench.hub.change_sensor("door", settings);
  door.set_input(Input::door, true, at_s(30));
  // The 5th try is the first of the 60 s retries: about 70 s after the opening.
  bench.run_to(140);
  INFO(door.records().kind(RecordKind::transmission).kind(RecordKind::rx_window).dump());
  const auto tries = sent(door, type::door_changed);
  REQUIRE(tries.size() == 5);
  // Tries 1 and 2 at DR5, listened for at the reply rate; 3 and 4 still DR5, with bit 7 and
  // listened for at DR5 = the sending rate; 5 one allowed rate slower: DR2 (DR4 and DR3 are not
  // allowed), with bit 7, heard and answered at DR2.
  const std::uint8_t rates[] = {5, 5, 5, 5, 2};
  for (std::size_t i = 0; i < tries.size(); ++i) {
    INFO("try " << i + 1);
    CHECK(tries[i].data_rate == rates[i]);
  }
  const auto heard = received<protocol::DoorChanged>(bench, "door");
  REQUIRE(heard.size() == 1);
  CHECK(heard[0].flags.listening_at_send_rate);
  const auto replies = bench.hub.sent_to("door", type::reply);
  CHECK(replies.back().data_rate == 2);
  // The reply ends the fall-back: no bit 7, listening at the reply rate again, sending at DR2.
  const roles::sensor::SensorState after = retained_state(door);
  CHECK_FALSE(after.listen_at_send_rate);
  CHECK(after.misses == 0);
  CHECK(after.send_rate == 2);
  CHECK(logged(door, roles::sensor::sensor_log::rate_stepped));
  // The windows after tries 3 and 4 listened at DR5 (the sending rate) and the 5th at DR2.
  const auto windows =
      door.records().kind(RecordKind::rx_window).between(at_s(30), at_s(140)).records();
  REQUIRE(windows.size() >= 5);
  for (std::size_t i = 0; i < 4; ++i) {
    CHECK(windows[i].value == 1u << 5);
  }
  CHECK(windows[4].value == 1u << 2);
}

/** The data rates of the door report's tries, in order. */
std::vector<std::uint8_t> try_rates(host::SimDevice& door) {
  std::vector<std::uint8_t> rates;
  for (const Record& record : sent(door, type::door_changed)) {
    rates.push_back(record.data_rate);
  }
  return rates;
}

/** A site allowing `mask`, whose hub hears only `hears` (one bit per rate). */
host::HubOptions site(std::uint8_t mask, std::uint8_t hears) {
  host::HubOptions options;
  options.allowed_data_rate_mask = mask;
  options.listen_data_rates = hears;
  return options;
}

TEST_CASE("section 7: the fall-back goes round the allowed rates: DR5, DR2, DR5") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  bench.sim.medium().cut(door.station(), bench.hub.station());
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(30 + 700);
  // Two at the start rate, two more at it listening at its own rate, then a step every two,
  // from the slowest allowed back to the fastest; never a rate the pairing does not allow.
  const std::vector<std::uint8_t> expected{5, 5, 5, 5, 2, 2, 5, 5, 2, 2, 5, 5, 2};
  CHECK(try_rates(door) == expected);
  CHECK(logged(door, roles::sensor::sensor_log::rate_stepped));
}

TEST_CASE(
    "section 7: a reply starts the count again: the next outage steps after the usual four "
    "misses") {
  Bench bench;
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  const auto lose = [&]() {
    bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(),
                                             std::numeric_limits<double>::infinity());
  };
  const auto mend = [&]() {
    bench.sim.medium().set_path_loss(bench.hub.station(), door.station(), 100.0);
  };
  // Three tries unanswered (one past listening at the sending rate), then the fourth answered.
  bench.sim.schedule(at_s(25), lose);
  door.set_input(Input::door, true, at_s(30));
  // Tries at about 0, 2 and 5 s; replies back before the fourth, about 10 s after the opening.
  bench.sim.schedule(at_s(39), mend);
  bench.run_to(140);
  REQUIRE(sent(door, type::door_changed).size() == 4);
  REQUIRE(retained_state(door).waiting == 0);
  // A second outage: four misses at DR5 again before the step.
  bench.sim.schedule(at_s(150), lose);
  door.set_input(Input::door, false, at_s(160));
  bench.run_to(160 + 120);
  const auto rates = try_rates(door);
  REQUIRE(rates.size() >= 4 + 5);
  const std::vector<std::uint8_t> second(rates.begin() + 4, rates.begin() + 9);
  CHECK(second == std::vector<std::uint8_t>{5, 5, 5, 5, 2});
}

TEST_CASE("section 7: with three rates allowed the order is fastest, slower, slowest, fastest") {
  Bench bench(site(0x25, 0x3F));
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  bench.sim.medium().cut(door.station(), bench.hub.station());
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(30 + 700);
  const std::vector<std::uint8_t> expected{5, 5, 5, 5, 2, 2, 0, 0, 5, 5, 2, 2, 0};
  CHECK(try_rates(door) == expected);
}

TEST_CASE(
    "section 7: with one rate allowed the rate never changes, and bit 7 still comes after "
    "two misses") {
  Bench bench(site(0x20, 0x3F));
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  // The hub hears the tries, its replies are lost.
  bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(),
                                           std::numeric_limits<double>::infinity());
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(30 + 700);
  CHECK(try_rates(door) == std::vector<std::uint8_t>(13, 5));
  const auto heard = received<protocol::DoorChanged>(bench, "door");
  REQUIRE(heard.size() == 13);
  CHECK_FALSE(heard[0].flags.listening_at_send_rate);
  CHECK_FALSE(heard[1].flags.listening_at_send_rate);
  for (std::size_t i = 2; i < heard.size(); ++i) {
    CHECK(heard[i].flags.listening_at_send_rate);
  }
  CHECK_FALSE(logged(door, roles::sensor::sensor_log::rate_stepped));
}

TEST_CASE(
    "section 7: fallen back to DR2 while the hub was quiet, the sensor returns to DR5 by "
    "itself, with no door event, and is heard") {
  // The site allows DR5 and DR2; the hub (standing in for the gateway) hears DR5 only.
  Bench bench(site(0x24, 0x20));
  host::SimDevice& door = bench.add();
  bench.run_to(10);
  bench.sim.medium().cut(door.station(), bench.hub.station());
  // Quiet until the heartbeats' misses have stepped the sensor to DR2.
  Instant back = Instant::never();
  for (int step = 0; step < 1000 && back.is_never(); ++step) {
    bench.sim.run_for(seconds(10));
    if (retained_state(door).send_rate == 2) {
      back = bench.sim.now();
    }
  }
  REQUIRE_FALSE(back.is_never());
  bench.sim.medium().set_path_loss(door.station(), bench.hub.station(), 100.0);
  const std::size_t heard_before = bench.hub.received_from("door").size();
  bench.sim.run_until(back + seconds(3600));
  const auto heard = bench.hub.received_from("door");
  REQUIRE(heard.size() > heard_before);
  const device::Duration took = heard[heard_before].at - back;
  // Measured: 554 s: two unheard heartbeats at DR2 step it round, the third is heard.
  // Two unheard heartbeats at DR2 asking for a reply step it round to DR5: about two
  // intervals, at most three.
  CHECK(took <= seconds(3 * 198 + 5));
  CHECK(took >= seconds(162));
  // The heartbeat whose miss stepped it round was at DR2 and unheard; log entries wait while
  // misses are above zero (§6), so the next heartbeat, at DR5, is the first packet heard.
  CHECK(heard[heard_before].data_rate == 5);
  CHECK(heard[heard_before].type == type::heartbeat);
  CHECK(bench.hub.sent_to("door", type::reply).back().at > heard[heard_before].at);
  CHECK(sent(door, type::door_changed).empty());
  CHECK(retained_state(door).send_rate == 5);
  CHECK(retained_state(door).misses == 0);
}

TEST_CASE(
    "section 7: the mirror: a hub that hears DR2 only; the sensor steps to DR2 and stays "
    "once answered") {
  Bench bench(site(0x24, 0x04));
  host::SensorConfig settings;
  // The hub, hearing it at DR2, tells it to send at DR2.
  settings.send_data_rate = 2;
  host::SimDevice& door = bench.add("door", settings);
  bench.run_to(3 * 3600);
  const auto started = sent(door, type::started);
  REQUIRE(started.size() == 5);
  CHECK(started[4].data_rate == 2);
  // From the answer on, everything goes at DR2 and is heard.
  for (const Record& record : sent(door)) {
    if (record.from > started[4].until) {
      CHECK(record.data_rate == 2);
    }
  }
  for (const host::HubPacket& packet : bench.hub.received_from("door")) {
    CHECK(packet.data_rate == 2);
  }
  CHECK(bench.hub.received_from("door", type::heartbeat).size() >= 50);
  CHECK(retained_state(door).send_rate == 2);
}

TEST_CASE(
    "section 7: every heartbeat asks for a reply while misses are above zero; after a reply, "
    "every Nth again") {
  Bench bench;
  host::SimDevice& door = bench.add();
  // Replies lost from 10 minutes to 30: the 5th heartbeat's link check goes unanswered.
  bench.sim.schedule(at_s(600), [&]() {
    bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(),
                                             std::numeric_limits<double>::infinity());
  });
  bench.sim.schedule(at_s(1800), [&]() {
    bench.sim.medium().set_path_loss(bench.hub.station(), door.station(), 100.0);
  });
  bench.run_to(4 * 3600);
  const auto beats = received<protocol::Heartbeat>(bench, "door");
  const auto times = bench.hub.received_from("door", type::heartbeat);
  REQUIRE(beats.size() >= 60);
  std::size_t first_miss = beats.size();
  std::size_t answered = beats.size();
  for (std::size_t i = 0; i < beats.size(); ++i) {
    if (first_miss == beats.size() && beats[i].flags.reply_wanted && times[i].at > at_s(600)) {
      first_miss = i;
    }
    if (first_miss != beats.size() && answered == beats.size() && times[i].at > at_s(1800)) {
      answered = i;
    }
  }
  REQUIRE(first_miss < answered);
  REQUIRE(answered + 12 < beats.size());
  // From the unanswered link check until the first heartbeat after the replies came back,
  // every one asks.
  for (std::size_t i = first_miss; i <= answered; ++i) {
    INFO("heartbeat " << i);
    CHECK(beats[i].flags.reply_wanted);
  }
  // Answered, the next ones ask on every 5th only.
  std::size_t asking = 0;
  for (std::size_t i = answered + 1; i <= answered + 10; ++i) {
    asking += beats[i].flags.reply_wanted ? 1u : 0u;
  }
  CHECK(asking == 2);
}

TEST_CASE(
    "LR5: out of touch for 24 hours at DR5, DR2 or DR0, or going round all three, the "
    "sensor stays inside its legal hour") {
  struct Case {
    std::uint8_t mask;
    const char* name;
  };
  for (const Case& option : {Case{0x20, "DR5"}, Case{0x04, "DR2"}, Case{0x01, "DR0"},
                             Case{0x25, "round DR5, DR2, DR0"}}) {
    INFO(option.name);
    host::SimulationOptions simulation;
    simulation.keep_fake_records = false;
    Bench bench(site(option.mask, 0x3F), simulation);
    host::SimDevice& door = bench.add();
    bench.sim.schedule(at_s(0),
                       [&]() { bench.sim.medium().cut(door.station(), bench.hub.station()); });
    bench.run_to(24 * 3600);
    const auto selection = door.records().kind(RecordKind::transmission);
    CHECK(selection.busiest_hour() <= seconds(36));
    // Heartbeats and log entries, all regular, inside four fifths of the hour (§2).
    CHECK(door.records()
              .kind(RecordKind::transmission)
              .where([](const Record& record) {
                return record.label.type == type::heartbeat ||
                       record.label.type == type::log_entries;
              })
              .busiest_hour() <= milliseconds(28800));
    // Still trying in every hour, every heartbeat asking for a reply.
    for (int hour = 1; hour < 24; ++hour) {
      INFO("hour " << hour);
      CHECK(door.records()
                .kind(RecordKind::transmission)
                .type(type::heartbeat)
                .between(at_s(3600.0 * hour), at_s(3600.0 * (hour + 1)))
                .count() >= 5);
    }
    if (option.mask == 0x25) {
      // Past 255 misses, still going round: every rate in the last hour.
      std::uint8_t seen = 0;
      for (const Record& record : door.records()
                                      .kind(RecordKind::transmission)
                                      .between(at_s(23 * 3600), at_s(24 * 3600))
                                      .records()) {
        seen = static_cast<std::uint8_t>(seen | (1u << record.data_rate));
      }
      CHECK(seen == 0x25);
      CHECK(retained_state(door).misses == 0xFF);
    }
    check_sleep_discipline(door);
  }
}

TEST_CASE("section 7: when only the faster reply fails, listening at the sending rate recovers") {
  Bench bench;
  host::SensorConfig settings;
  settings.send_data_rate = 2;
  settings.reply_data_rate = 5;
  host::SimDevice& door = bench.add("door", settings);
  bench.run_to(10);
  // The hub's DR5 replies no longer reach the sensor, its DR2 ones do: 22 dBm − 150 dB.
  bench.sim.medium().set_path_loss_one_way(bench.hub.station(), door.station(), 150.0);
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(60);
  const auto heard = received<protocol::DoorChanged>(bench, "door");
  REQUIRE(heard.size() == 3);
  CHECK_FALSE(heard[0].flags.listening_at_send_rate);
  CHECK_FALSE(heard[1].flags.listening_at_send_rate);
  CHECK(heard[2].flags.listening_at_send_rate);
  // The third is answered at DR2 and heard; the sensor still sends at DR2, back to reply rate 5.
  CHECK(door.records().kind(RecordKind::reception).type(type::reply).records().back().data_rate ==
        2);
  CHECK_FALSE(retained_state(door).listen_at_send_rate);
  CHECK(sent(door, type::door_changed).back().data_rate == 2);
}

TEST_CASE("LR4: the rate that last worked is kept across sleep, and across a power loss") {
  Bench bench;
  host::SensorConfig settings;
  host::SimDevice& door = bench.add("door", settings);
  bench.run_to(10);
  bench.sim.medium().set_path_loss(door.station(), bench.hub.station(), kFar);
  settings.send_data_rate = 2;
  bench.hub.change_sensor("door", settings);
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(400);
  // Heartbeats after the fall-back go at DR2, from deep sleep.
  const auto beats = sent(door, type::heartbeat);
  REQUIRE_FALSE(beats.empty());
  CHECK(beats.back().data_rate == 2);
  // The hub's DR2 came in a reply and is in flash: after a power loss, DR2 at once.
  door.power_loss(at_s(400), seconds(1));
  bench.run_to(410);
  CHECK(sent(door, type::started).back().data_rate == 2);
  CHECK(sent(door, type::started).back().from > at_s(401));
}

TEST_CASE("LR10: the sensor sends on the site channel and listens on 869.525 MHz") {
  host::HubOptions options;
  options.site_channel = 2;
  Bench bench(options);
  host::SimDevice& door = bench.add();
  door.set_input(Input::door, true, at_s(30));
  bench.run_to(200);
  for (const Record& record : sent(door)) {
    CHECK(record.frequency_hz == 868500000u);
  }
  for (const Record& record : door.records().kind(RecordKind::rx_window).records()) {
    CHECK(record.frequency_hz == 869525000u);
  }
  CHECK(retained_state(door).waiting == 0);
}

}  // namespace
}  // namespace hsn::test::sensor
