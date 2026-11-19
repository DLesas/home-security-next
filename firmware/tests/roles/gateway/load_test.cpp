// The gateway under load (GW2, GW9, §7 "Reply timing and a busy gateway"; the reviewer's sweep):
// with the real role, the test hub in gateway link mode and scripted sensors, a simulated day per
// case, nothing heard is lost unseen: every packet heard is forwarded, every transmit request gets
// exactly one result, and at 30 sensors or fewer the queue never fills past half.
//
// And while it updates (m3-updates-design.md section 5, section 8's two load cases): thirty
// sensors through a gateway that downloads, installs and restarts, with nothing lost inside it;
// and a site where a transmission always waits, so the gateway writes no flash until the bound,
// refuses radioBusy, and then downloads anyway when the update is forced (action 6).

#include <algorithm>
#include <functional>
#include <iomanip>
#include <memory>
#include <random>
#include <sstream>

#include "gateway_bench.hpp"
#include "hsn/host/test_image.hpp"

namespace hsn::test {
namespace {

using device::microseconds;
using host::HubAction;
using host::HubPath;
using roles::gateway::CarriedCounts;
using roles::gateway::kTransmitQueueSize;

/** One case of the sweep. */
struct LoadCase {
  std::size_t sensors = 0;
  std::uint8_t data_rate = 5;
  /** Armed, every door opens within one second, the alarm sounds 4 sirens, then a disarm. */
  bool burst = false;
  /** Sirens the alarm sounds, in a burst case. */
  std::size_t sirens = 4;
};

/** What a case measured. */
struct LoadFigures {
  CarriedCounts counts;
  std::size_t still_queued = 0;
  bool sending = false;
  /** Transmit requests the hub sent, and forwarded packets it accepted, from the gateway. */
  std::size_t hub_requests = 0;
  std::size_t hub_forwarded = 0;
  std::size_t hub_results = 0;
  /** Packets the sensors and sirens put on the site channel, from their transmission records. */
  std::size_t sent_on_air = 0;
  /** The most airtime the gateway used in any rolling hour. */
  device::Duration busiest_hour;
  /** Flash writes: all, the send counter's, the settings'. */
  std::size_t flash_writes = 0;
  std::size_t counter_writes = 0;
  std::size_t settings_writes = 0;
  /** The highest counter the hub had from the gateway. */
  std::uint32_t last_counter = 0;
};

constexpr std::int64_t kDay = 86400;
constexpr std::size_t kDoorChangesPerDay = 20;
/** The test hub's default site channel, 868.3 MHz. */
constexpr std::uint32_t kSiteFrequencyHz = 868300000;

/** Heartbeat interval by data rate: 3 minutes, 5 at SF12 (§7 "Data rate"). */
std::int64_t heartbeat_seconds(std::uint8_t data_rate) {
  return data_rate == 0 ? 300 : 180;
}

LoadFigures run_case(const LoadCase& load, std::int64_t span_seconds) {
  host::HubOptions options = gateway_mode();
  options.heartbeat_slots = true;
  host::SimulationOptions simulation;
  simulation.keep_fake_records = false;
  Site site(options, simulation);
  host::GatewayConfig gateway_config;
  gateway_config.listen_data_rate_mask = static_cast<std::uint8_t>(1u << load.data_rate);
  host::SimDevice& gateway = add_gateway(site, "gateway", gateway_config);

  const std::int64_t interval = heartbeat_seconds(load.data_rate);
  std::mt19937 random(static_cast<std::uint32_t>(load.sensors * 131 + load.data_rate));
  std::vector<std::unique_ptr<ScriptSensorLog>> logs;
  for (std::size_t i = 0; i < load.sensors; ++i) {
    logs.push_back(std::make_unique<ScriptSensorLog>());
    ScriptSensorConfig config;
    config.send_data_rate = load.data_rate;
    config.heartbeat_every = seconds(interval);
    config.link_check_every = 5;
    config.listen_time = milliseconds(options.event_listen_ms[load.data_rate]);
    host::DeviceSpec spec;
    spec.name = "door" + std::to_string(i);
    spec.role = script_sensor(config, *logs.back());
    // Scripted sensors ignore the hub's slots (the system tests with the sensor role cover them),
    // so their power-on instants spread the heartbeats evenly over the interval instead.
    spec.power_on = at(microseconds(seconds(interval).us * static_cast<std::int64_t>(i) /
                                    static_cast<std::int64_t>(load.sensors)));
    host::SimDevice& door = site.sim.add_device(spec);
    host::SensorConfig settings;
    settings.send_data_rate = load.data_rate;
    settings.reply_data_rate = load.data_rate;
    settings.heartbeat_interval_units = static_cast<std::uint8_t>(interval / 15);
    site.hub.add_sensor(door, settings);
    if (!load.burst) {
      // About 20 changes a day, at random moments.
      std::uniform_int_distribution<std::int64_t> moment(1000, span_seconds * 1000000 - 1000);
      std::vector<std::int64_t> moments;
      for (std::size_t k = 0; k < kDoorChangesPerDay * static_cast<std::size_t>(span_seconds) /
                                      static_cast<std::size_t>(kDay);
           ++k) {
        moments.push_back(moment(random));
      }
      std::sort(moments.begin(), moments.end());
      for (std::size_t k = 0; k < moments.size(); ++k) {
        door.set_input(device::Input::door, k % 2 == 0, at(microseconds(moments[k])));
      }
    }
  }
  std::vector<std::unique_ptr<ScriptSirenLog>> siren_logs;
  if (load.burst) {
    for (std::size_t i = 0; i < load.sirens; ++i) {
      siren_logs.push_back(std::make_unique<ScriptSirenLog>());
      ScriptSirenConfig config;
      config.send_data_rate = load.data_rate;
      host::SirenConfig settings;
      settings.send_data_rate = load.data_rate;
      site.siren("siren" + std::to_string(i), config, *siren_logs.back(), settings);
    }
    // Armed; every door opens within one second; nobody disarms before the countdown ends.
    const std::int64_t burst_at = span_seconds / 2;
    site.sim.schedule(at(seconds(burst_at - 60)), [&]() { site.hub.arm(); });
    std::uniform_int_distribution<std::int64_t> within(0, 999999);
    for (std::size_t i = 0; i < load.sensors; ++i) {
      site.sim.device("door" + std::to_string(i))
          .set_input(device::Input::door, true,
                     at(seconds(burst_at) + microseconds(within(random))));
    }
    site.sim.schedule(at(seconds(burst_at + 120)), [&]() { site.hub.disarm(); });
  }
  site.sim.run_until(at(seconds(span_seconds)));

  LoadFigures figures;
  const GatewayRole& role = gateway_of(gateway);
  figures.counts = role.counts();
  figures.still_queued = role.queue().size();
  figures.sending = role.state().radio.sending;
  for (const host::HubSent& sent : site.hub.sent()) {
    figures.hub_requests += sent.path == HubPath::gateway && sent.via == "gateway" ? 1u : 0u;
  }
  figures.hub_forwarded = site.hub.received_from("gateway", type::forwarded_packet).size();
  figures.hub_results = site.hub.received_from("gateway", type::transmit_result).size();
  for (const host::Record& record :
       site.sim.timeline().select().kind(RecordKind::transmission).records()) {
    figures.sent_on_air +=
        record.actor != gateway.actor() && record.frequency_hz == kSiteFrequencyHz ? 1u : 0u;
  }
  figures.busiest_hour = gateway.records().kind(RecordKind::transmission).busiest_hour();
  for (const host::Record& write : gateway.records().kind(RecordKind::flash_write).records()) {
    figures.flash_writes += 1;
    figures.counter_writes +=
        write.value == static_cast<std::uint32_t>(device::StoreKey::counter_resume) ? 1u : 0u;
    figures.settings_writes +=
        write.value == static_cast<std::uint32_t>(roles::gateway::kSettingsKey) ? 1u : 0u;
  }
  for (const host::HubPacket& packet : site.hub.received()) {
    if (packet.from == "gateway") {
      figures.last_counter = std::max(figures.last_counter, packet.counter);
    }
  }
  if (load.burst) {
    CHECK_FALSE(site.hub.decisions(HubAction::alarm).empty());
    for (const auto& log : siren_logs) {
      CHECK(log->count(device::CommandVerdict::new_command) >= 1);
    }
  }
  return figures;
}

/** One line of the table. */
std::string describe(const LoadCase& load, const LoadFigures& figures) {
  std::ostringstream line;
  line << (load.burst ? "burst " : "day   ") << load.sensors << " sensors DR"
       << static_cast<int>(load.data_rate) << ": sent " << figures.sent_on_air << ", heard "
       << figures.counts.heard << " (lost on the air " << std::fixed << std::setprecision(1)
       << (figures.sent_on_air == 0 ? 0.0
                                    : 100.0 *
                                          (static_cast<double>(figures.sent_on_air) -
                                           static_cast<double>(figures.counts.heard)) /
                                          static_cast<double>(figures.sent_on_air))
       << "%), forwarded " << figures.counts.forwarded << ", lost " << figures.counts.forwards_lost
       << ", requests " << figures.counts.requests << ", highest depth "
       << static_cast<int>(figures.counts.queue_highest)
       << ", results sent/late/no-air/busy/invalid " << figures.counts.results[0] << "/"
       << figures.counts.results[1] << "/" << figures.counts.results[2] << "/"
       << figures.counts.results[3] << "/" << figures.counts.results[4] << ", queue full "
       << figures.counts.queue_full << ", displaced " << figures.counts.displaced;
  return line.str();
}

void check_case(const LoadCase& load, std::int64_t span_seconds, bool queue_bound = true) {
  const LoadFigures figures = run_case(load, span_seconds);
  const std::string line = describe(load, figures);
  MESSAGE(line);
  INFO(line);
  const CarriedCounts& counts = figures.counts;
  CHECK(counts.heard > 0);
  // Nothing heard is lost: every packet reached the link, and the hub accepted each.
  CHECK(counts.forwarded == counts.heard);
  CHECK(counts.forwards_lost == 0);
  CHECK(figures.hub_forwarded == counts.forwarded);
  // Every request the hub sent got exactly one result, or is still waiting at the end.
  CHECK(figures.hub_requests == counts.requests);
  std::uint32_t results = 0;
  for (const std::uint32_t by_code : counts.results) {
    results += by_code;
  }
  CHECK(counts.results_lost == 0);
  CHECK(results + figures.still_queued + (figures.sending ? 1u : 0u) == counts.requests);
  CHECK(figures.hub_results == results);
  if (queue_bound && load.sensors <= 30) {
    CHECK(counts.queue_full == 0);
    CHECK(counts.displaced == 0);
    CHECK(counts.queue_highest <= kTransmitQueueSize / 2);
  }
}

TEST_CASE("load sweep: a day at DR5 with 5 to 50 sensors loses nothing unseen") {
  for (const std::size_t sensors : {5u, 10u, 20u, 30u, 50u}) {
    check_case(LoadCase{sensors, 5, false}, kDay);
  }
}

TEST_CASE("long run: 30 days, 10 sensors: airtime within 10% every hour, flash within budget") {
  const LoadCase load{10, 5, false};
  const LoadFigures figures = run_case(load, 30 * kDay);
  const std::string line = describe(load, figures);
  MESSAGE(line);
  INFO(line);
  CHECK(figures.counts.forwarded == figures.counts.heard);
  CHECK(figures.counts.forwards_lost == 0);
  // 10% of any rolling hour on 869.525 MHz (§2, D104).
  CHECK(figures.busiest_hour <= seconds(360));
  // Flash (design section 5): a resume point every 1,024 packets and the settings once; the
  // design's 7,500 a year for 30 sensors, for these 30 days, bounds the total.
  CHECK(figures.settings_writes == 1);
  CHECK(figures.counter_writes == figures.last_counter / 1024);
  CHECK(figures.flash_writes == figures.counter_writes + figures.settings_writes);
  CHECK(figures.flash_writes <= 7500 * 30 / 365);
  MESSAGE("30 days: busiest hour " << figures.busiest_hour << ", flash writes "
                                   << figures.flash_writes << ", last counter "
                                   << figures.last_counter);
}

TEST_CASE("load sweep: a day at DR2 with 5 to 15 sensors loses nothing unseen") {
  for (const std::size_t sensors : {5u, 10u, 15u}) {
    check_case(LoadCase{sensors, 2, false}, kDay);
  }
}

TEST_CASE("load sweep: a day at DR0 with 5 and 10 sensors loses nothing unseen") {
  for (const std::size_t sensors : {5u, 10u}) {
    check_case(LoadCase{sensors, 0, false}, kDay);
  }
}

TEST_CASE("load sweep: the armed burst keeps the queue within half, sirens and all") {
  for (const std::size_t sensors : {10u, 30u}) {
    check_case(LoadCase{sensors, 5, true}, kDay);
  }
}

TEST_CASE("load sweep: the same burst without sirens keeps the queue within half") {
  for (const std::size_t sensors : {10u, 30u}) {
    LoadCase load{sensors, 5, true};
    load.sirens = 0;
    check_case(load, 7200);
  }
}

// ---- While the gateway updates ----

/** What every boot of a CountedGateway carried, summed by the test across its boots. */
struct BootTotals {
  CarriedCounts counts;
  /** Packets it heard (good CRC, at least 18 bytes) while it had no welcomed connection. */
  std::uint32_t heard_unconnected = 0;
  /** Requests a boot still held, queued or on the air, when it ended. */
  std::size_t left_at_end = 0;
  /** Boots ended. */
  std::size_t ended = 0;
};

void add_counts(CarriedCounts& total, const CarriedCounts& counts) {
  total.heard += counts.heard;
  total.forwarded += counts.forwarded;
  total.forwards_lost += counts.forwards_lost;
  total.requests += counts.requests;
  for (std::size_t i = 0; i < counts.results.size(); ++i) {
    total.results[i] += counts.results[i];
  }
  total.results_lost += counts.results_lost;
  total.queue_full += counts.queue_full;
  total.displaced += counts.displaced;
  total.queue_highest = std::max(total.queue_highest, counts.queue_highest);
}

/**
 * The real gateway role, wrapped so that what each boot carried outlives it: a restart into a new
 * image destroys the role with the rest of RAM. It also counts the packets heard while not
 * connected, the only ones the role may lose.
 */
class CountedGateway final : public device::Role {
public:
  CountedGateway(device::Services& services, device::GatewayIo& io, BootTotals& totals)
      : inner_(services, io), totals_(totals) {}
  CountedGateway(const CountedGateway&) = delete;
  CountedGateway& operator=(const CountedGateway&) = delete;
  ~CountedGateway() {
    add_counts(totals_.counts, inner_.counts());
    totals_.left_at_end += inner_.queue().size() + (inner_.state().radio.sending ? 1u : 0u);
    totals_.ended += 1;
  }

  std::uint8_t role_id() const override {
    return inner_.role_id();
  }
  void handle(const device::Event& event) override {
    const auto& state = inner_.state();
    const bool connected = state.connection.phase == roles::gateway::ConnectionPhase::connected &&
                           state.connection.session.welcomed;
    const bool hearing = state.radio.mode == roles::gateway::RadioMode::listening ||
                         state.radio.mode == roles::gateway::RadioMode::receiving;
    if (event.kind == device::EventKind::radio &&
        event.radio.kind == device::RadioEventKind::rx_done && hearing && !connected &&
        event.radio.packet.size() >= protocol::kMinCarriedPacketSize) {
      totals_.heard_unconnected += 1;
    }
    inner_.handle(event);
  }
  device::Wake next_wake() const override {
    return inner_.next_wake();
  }
  protocol::MutableByteView state_bytes() override {
    return inner_.state_bytes();
  }
  std::uint8_t state_layout() const override {
    return inner_.state_layout();
  }
  std::uint8_t state_id() const override {
    return inner_.state_id();
  }
  device::Duration longest_awake() const override {
    return inner_.longest_awake();
  }
  void report_again(device::Instant now) override {
    inner_.report_again(now);
  }

  const GatewayRole& inner() const {
    return inner_;
  }

private:
  GatewayRole inner_;
  BootTotals& totals_;
};

static_assert(device::is_complete_role<CountedGateway>, "a role must override every Role method");

TEST_CASE("§5 load: 30 sensors through a gateway that updates lose nothing inside it") {
  constexpr std::int64_t kSpan = 2 * 3600;
  host::HubOptions options = gateway_mode();
  options.heartbeat_slots = true;
  host::SimulationOptions simulation;
  simulation.keep_fake_records = false;
  // Before the site: the live boot's role adds to it when the simulation is destroyed.
  BootTotals totals;
  Site site(options, simulation);
  host::DeviceSpec spec;
  spec.name = "gateway";
  spec.role = [&totals](device::Services& services, host::HostBoard& board) {
    return host::box_role<CountedGateway>(services, board.gateway_io, totals);
  };
  host::SimDevice& gateway = site.sim.add_device(spec);
  gateway.board().power.external = true;
  site.hub.add_gateway(gateway, host::GatewayConfig{});
  const std::int64_t interval = heartbeat_seconds(5);
  std::mt19937 random(30 * 131 + 5);
  std::vector<std::unique_ptr<ScriptSensorLog>> logs;
  for (std::size_t i = 0; i < 30; ++i) {
    logs.push_back(std::make_unique<ScriptSensorLog>());
    ScriptSensorConfig config;
    config.heartbeat_every = seconds(interval);
    config.link_check_every = 5;
    config.listen_time = milliseconds(options.event_listen_ms[5]);
    host::DeviceSpec door_spec;
    door_spec.name = "door" + std::to_string(i);
    door_spec.role = script_sensor(config, *logs.back());
    door_spec.power_on = at(microseconds(seconds(interval).us * static_cast<std::int64_t>(i) / 30));
    host::SimDevice& door = site.sim.add_device(door_spec);
    host::SensorConfig settings;
    settings.heartbeat_interval_units = static_cast<std::uint8_t>(interval / 15);
    site.hub.add_sensor(door, settings);
    // Door changes through the run, several of them in the minutes of the update.
    std::uniform_int_distribution<std::int64_t> moment(1000, kSpan * 1000000 - 1000);
    std::vector<std::int64_t> moments;
    for (std::size_t k = 0; k < 4; ++k) {
      moments.push_back(moment(random));
    }
    moments.push_back(1800 * 1000000LL + static_cast<std::int64_t>(i) * 100000);
    std::sort(moments.begin(), moments.end());
    for (std::size_t k = 0; k < moments.size(); ++k) {
      door.set_input(device::Input::door, k % 2 == 0, at(microseconds(moments[k])));
    }
  }
  const host::HubImage& image = site.hub.add_image(host::make_test_image(kNewImage, 60000));
  site.sim.schedule(at(seconds(1795)), [&]() { site.hub.offer_update("gateway", image.id); });
  site.sim.run_until(at(seconds(kSpan)));

  INFO(site.hub.dump().substr(0, 20000));
  // The update went through: one restart, the new image confirmed.
  CHECK(site.hub.update_of("gateway").state == host::UpdateState::confirmed);
  REQUIRE(totals.ended == 1);
  const auto restarts = gateway.records().kind(RecordKind::restart).records();
  REQUIRE(restarts.size() == 1);
  BootTotals all = totals;
  const CountedGateway& live = gateway.role<CountedGateway>();
  add_counts(all.counts, live.inner().counts());
  const CarriedCounts& counts = all.counts;
  MESSAGE("update under load: heard " << counts.heard << ", forwarded " << counts.forwarded
                                      << ", heard unconnected " << all.heard_unconnected
                                      << ", requests " << counts.requests);
  CHECK(counts.heard > 1000);
  // Every packet heard was forwarded, but those heard while it reconnected after its restart.
  CHECK(counts.forwarded + counts.forwards_lost == counts.heard);
  CHECK(counts.forwards_lost == all.heard_unconnected);
  CHECK(site.hub.received_from("gateway", type::forwarded_packet).size() == counts.forwarded);
  // The install waited for an empty queue: the restart cut off no request.
  CHECK(totals.left_at_end == 0);
  CHECK(counts.results_lost == 0);
  std::uint32_t results = 0;
  for (const std::uint32_t by_code : counts.results) {
    results += by_code;
  }
  const std::size_t still =
      live.inner().queue().size() + (live.inner().state().radio.sending ? 1 : 0);
  CHECK(results + still == counts.requests);
  CHECK(site.hub.received_from("gateway", type::transmit_result).size() == results);
  // The hub's requests that never reached it: only those that arrived while it restarted.
  std::size_t hub_requests = 0;
  std::size_t into_restart = 0;
  const auto welcomes = site.hub.decisions(HubAction::gateway_welcomed, "gateway");
  REQUIRE(welcomes.size() == 2);
  for (const host::HubSent& sent : site.hub.sent()) {
    if (sent.path != HubPath::gateway || sent.via != "gateway") {
      continue;
    }
    hub_requests += 1;
    const device::Instant arrives = sent.at + options.link_latency;
    into_restart += arrives >= restarts[0].at && arrives < welcomes[1].at ? 1 : 0;
  }
  CHECK(hub_requests == counts.requests + into_restart);
  CHECK(counts.queue_full == 0);
  CHECK(counts.displaced == 0);
  CHECK(counts.queue_highest <= kTransmitQueueSize / 2);
}

TEST_CASE("§5: a transmission always waiting: radioBusy after the bound, then a forced update") {
  UpdateLinkSite world;
  LinkSite& site = world.site;
  const SignedImage image(30000);
  site.hub.file = &image.file;
  // From 2 s, a request every 2 s for 5 s ahead: one always waits for its moment.
  std::vector<std::uint32_t> requests;
  std::function<void()> stream = [&]() {
    const device::Instant now = site.sim.now();
    const host::Bytes packet =
        opaque_packet(0x1A2B3C4D, 2000 + static_cast<std::uint32_t>(requests.size()));
    requests.push_back(site.hub.send_request(
        site.hub.request(protocol::TransmitWhen::at_time, gateway_time(now + seconds(5)), packet)));
    site.sim.schedule(now + seconds(2), stream);
  };
  site.sim.schedule(at(seconds(2)), stream);
  site.sim.schedule(at(seconds(3)),
                    [&]() { site.hub.send(offer_of(protocol::UpdateAction::fetch, image)); });
  site.sim.run_until(at(seconds(3 + 600 + 10)));
  INFO(site.gateway.records().kind(RecordKind::flash_write).dump());
  // Ten minutes without a sector written: refused radioBusy, the part kept.
  CHECK(site.gateway.records().kind(RecordKind::slot_write).count() == 0);
  CHECK(site.gateway.records().kind(RecordKind::slot_erase).count() == 0);
  std::vector<protocol::UpdateStatus> statuses = link_statuses(site.hub);
  REQUIRE(statuses.size() == 1);
  CHECK(statuses[0].stage == protocol::UpdateStage::refused);
  CHECK(statuses[0].reason == protocol::UpdateReason::radio_busy);
  const auto got = site.hub.got(type::update_status);
  REQUIRE(got.size() == 1);
  CHECK(got[0].at >= at(seconds(3 + 600)));
  CHECK(got[0].at < at(seconds(3 + 600 + 2)));
  CHECK(site.gateway.board().storage.has(device::StoreKey::update));
  // A person forces it: action 6. It writes with a transmission waiting, to the end.
  const device::Instant forced = site.sim.now();
  site.hub.send(offer_of(protocol::UpdateAction::forced_fetch, image));
  site.sim.run_until(forced + seconds(30));
  statuses = link_statuses(site.hub);
  REQUIRE(statuses.size() == 2);
  CHECK(statuses[1].stage == protocol::UpdateStage::verified);
  const auto writes = site.gateway.records().kind(RecordKind::slot_write).records();
  REQUIRE_FALSE(writes.empty());
  // Each written while a request waited for its moment (one always does).
  const auto& role = gateway_of(site.gateway);
  CHECK_FALSE(role.queue().empty());
  // Every request got exactly one result, sent or (made late by a write) too late, or waits.
  std::size_t answered = 0;
  for (const std::uint32_t counter : requests) {
    const auto result = site.hub.result_for(counter);
    answered += result.has_value() ? 1 : 0;
    if (result.has_value()) {
      CHECK((result->result == protocol::TransmitOutcome::sent ||
             result->result == protocol::TransmitOutcome::too_late));
    }
  }
  CHECK(answered + role.queue().size() + (role.state().radio.sending ? 1 : 0) == requests.size());
  CHECK(site.hub.results().size() == answered);
}

}  // namespace
}  // namespace hsn::test
