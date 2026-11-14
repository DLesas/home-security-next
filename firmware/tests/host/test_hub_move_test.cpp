// Moving the site to another channel or sending rate over the air (protocol section 7, "Changing
// the site's channel or rate", D115), in both hub modes, with the scripted sensor, siren and
// gateway following it: announce, confirm, switch, follow; a door report straight after the
// switch, which comes by itself once every sensor has confirmed; a sensor that missed the
// announcement, with and without force; a cancel; a switch due during a countdown or an alarm;
// only the channel, or only the rate, changing.

#include <string>

#include "hsn/host/simulation_error.hpp"
#include "sim_support.hpp"

namespace hsn::test {
namespace {

using host::HubAction;
using host::HubMode;
using host::MoveStage;
using host::SiteMove;
namespace type = protocol::message_type;

constexpr std::uint8_t kSlow = protocol::DataRate::dr2;
constexpr std::uint8_t kChannel868_5 = 2;
/** How finely the scenarios look whether the move has moved on. */
constexpr device::Duration kPoll = device::milliseconds(250);

/** A sensor that sends a heartbeat about every minute; two such sensors must not collide. */
ScriptSensorConfig every_minute(std::int64_t heartbeat_seconds = 60) {
  ScriptSensorConfig config;
  config.heartbeat_every = seconds(heartbeat_seconds);
  config.link_check_every = 5;
  return config;
}

/** Two sensors heartbeating every minute and a siren, in one hub mode. */
struct MoveSite {
  explicit MoveSite(HubMode mode) : site(hub_options(mode)) {
    site.add_mode_gateway();
    front = &site.sensor("front", every_minute(), front_log);
    back = &site.sensor("back", every_minute(63), back_log);
    siren = &site.siren("siren", ScriptSirenConfig{}, siren_log);
  }

  /**
   * Announces at `at_time` and runs until the switch, which comes by itself with the last
   * confirmation, within two heartbeats (protocol section 7); returns its instant.
   */
  device::Instant announce_and_switch(const SiteMove& move, device::Instant at_time) {
    site.sim.schedule(at_time, [this, move]() { site.hub.announce_move(move); });
    site.sim.run_until(at_time);
    while (site.hub.move_stage() != MoveStage::switched &&
           site.sim.now() < at_time + seconds(125)) {
      site.sim.run_for(kPoll);
    }
    INFO(site.hub.dump());
    REQUIRE(site.hub.move_unconfirmed().empty());
    REQUIRE(site.hub.move_stage() == MoveStage::switched);
    const auto confirmed = site.hub.decisions(HubAction::move_confirmed);
    REQUIRE_FALSE(confirmed.empty());
    const device::Instant switched = only(HubAction::move_switched).at;
    CHECK(switched == confirmed.back().at);
    return switched;
  }

  /** Runs until `count` sensors have confirmed, or `limit`. */
  void run_to_confirmations(std::size_t count, device::Instant limit) {
    while (site.hub.decisions(HubAction::move_confirmed).size() < count && site.sim.now() < limit) {
      site.sim.run_for(kPoll);
    }
  }

  host::HubDecision only(HubAction action, const std::string& device = "") const {
    const auto found = site.hub.decisions(action, device);
    REQUIRE(found.size() == 1);
    return found[0];
  }

  Site site;
  ScriptSensorLog front_log;
  ScriptSensorLog back_log;
  ScriptSirenLog siren_log;
  host::SimDevice* front = nullptr;
  host::SimDevice* back = nullptr;
  host::SimDevice* siren = nullptr;
};

/** The device's transmissions on the site channel since `from`. */
std::vector<host::Record> sent_since(host::SimDevice& device, device::Instant from) {
  return device.records()
      .kind(RecordKind::transmission)
      .where([from](const host::Record& record) {
        return record.at >= from && record.frequency_hz != device::kReplyFrequencyHz;
      })
      .records();
}

TEST_CASE("a move with every device in touch: announce, confirm, switch, follow") {
  for (const HubMode mode : kBothModes) {
    INFO("mode: " << mode_name(mode));
    MoveSite s(mode);
    SiteMove move;
    move.send_data_rate = kSlow;
    // The switch comes by itself with the last confirmation.
    const device::Instant switch_at = s.announce_and_switch(move, at(seconds(10)));
    // The announcement: each sensor's version changed, its replies named the next rate only.
    CHECK(s.only(HubAction::move_requested).value == 0xFF * 256 + kSlow);
    CHECK(s.site.hub.decisions(HubAction::move_confirmed).size() == 2);
    CHECK(s.front_log.next_send_data_rate == kSlow);
    CHECK(s.front_log.next_site_channel == protocol::kStaysAsItIs);
    CHECK(s.only(HubAction::move_switched).value == 0);
    CHECK(s.site.hub.switch_move());
    s.site.sim.run_until(switch_at + seconds(200));
    INFO(s.site.hub.dump());

    // Each sensor followed within two heartbeats: an old one unanswered, then a new one answered.
    for (auto [device, log] : {std::pair{s.front, &s.front_log}, std::pair{s.back, &s.back_log}}) {
      CHECK(s.site.hub.move_followed(device->name()));
      REQUIRE(log->moves.size() == 1);
      CHECK(log->moves[0].send_data_rate == kSlow);
      CHECK(log->next_send_data_rate == protocol::kStaysAsItIs);
      const auto after = sent_since(*device, switch_at + seconds(130));
      REQUIRE_FALSE(after.empty());
      CHECK(after.back().data_rate == kSlow);
      // The reply to the first packet on the new settings names their rate and announces nothing.
      const ScriptSensorLog::Heard* first_new = nullptr;
      for (const ScriptSensorLog::Heard& heard : log->heard) {
        if (first_new == nullptr && heard.at > switch_at &&
            heard.type == protocol::message_type::reply && heard.reply.send_data_rate == kSlow) {
          first_new = &heard;
        }
      }
      REQUIRE(first_new != nullptr);
      CHECK(first_new->reply.next_send_data_rate == protocol::kStaysAsItIs);
      CHECK(first_new->reply.next_site_channel == protocol::kStaysAsItIs);
      // It is the reply the sensor took the new settings on (both on the board's clock).
      CHECK(first_new->at == log->moves[0].at);
    }
    // The siren got its settings with the new rate and showed them in a report; it answers their
    // LoRa copy at the new rate.
    CHECK(s.site.hub.move_followed("siren"));
    const auto siren_sent = sent_since(*s.siren, switch_at);
    REQUIRE_FALSE(siren_sent.empty());
    CHECK(siren_sent.back().data_rate == kSlow);
    CHECK(s.siren_log.settings_version == s.site.hub.settings_version("siren"));
    CHECK(s.site.hub.decisions(HubAction::device_followed).size() == 3);
    CHECK(s.site.hub.decisions(HubAction::move_done).size() == 1);
    CHECK(s.site.hub.move_stage() == MoveStage::none);
    if (mode == HubMode::gateway_link) {
      const auto listens =
          s.site.sim.device("gateway").board().radio.calls_of(host::RadioCall::Kind::receive);
      CHECK(listens.back().rx.channel.data_rate == kSlow);
    }
  }
}

TEST_CASE("a door report straight after the switch: its retry goes on the new settings") {
  for (const HubMode mode : kBothModes) {
    INFO("mode: " << mode_name(mode));
    MoveSite s(mode);
    s.site.hub.arm();
    SiteMove move;
    move.send_data_rate = kSlow;
    const device::Instant switch_at = s.announce_and_switch(move, at(seconds(10)));
    s.front->set_input(device::Input::door, true, switch_at + seconds(1));
    s.site.sim.run_until(switch_at + seconds(8));
    INFO(s.site.hub.dump());
    // The first try at the old rate is unheard; the retry at the new one starts the countdown.
    const auto tries = sent_since(*s.front, switch_at);
    REQUIRE(tries.size() >= 2);
    CHECK(tries[0].data_rate == protocol::DataRate::dr5);
    CHECK(tries[1].data_rate == kSlow);
    const auto reports = s.site.hub.received_from("front", type::door_changed);
    REQUIRE(reports.size() == 1);
    CHECK(reports[0].data_rate == kSlow);
    CHECK(reports[0].at < switch_at + seconds(6));
    CHECK(s.site.hub.decisions(HubAction::countdown_started, "front").size() == 1);
    CHECK(s.site.hub.move_followed("front"));
  }
}

TEST_CASE("a sensor that missed the announcement stops the switch, unless forced past it") {
  for (const bool force : {false, true}) {
    INFO("force: " << force);
    MoveSite s(HubMode::direct_radio);
    // "far" sends nothing while the move is announced, so it never learns the next settings.
    ScriptSensorLog far_log;
    host::SimDevice& far = s.site.sensor("far", ScriptSensorConfig{}, far_log);
    SiteMove move;
    move.send_data_rate = kSlow;
    s.site.sim.schedule(at(seconds(10)), [&]() { s.site.hub.announce_move(move); });
    s.site.sim.run_until(at(seconds(140)));
    CHECK(s.site.hub.move_unconfirmed() == std::vector<std::string>{"far"});
    const bool switched = s.site.hub.switch_move(force);
    CHECK(switched == force);
    if (!force) {
      // Refused, naming it; nothing changes.
      CHECK(s.only(HubAction::move_unconfirmed, "far").at == s.site.sim.now());
      CHECK(s.site.hub.move_stage() == MoveStage::announcing);
      CHECK(s.site.hub.decisions(HubAction::move_switched).empty());
      continue;
    }
    // Forced: it is named as left behind; the move completes without it.
    CHECK(s.only(HubAction::move_forced, "far").at == s.site.sim.now());
    CHECK(s.only(HubAction::move_switched).value == 1);
    far.set_input(device::Input::door, true, at(seconds(400)));
    s.site.sim.run_until(at(seconds(420)));
    CHECK(s.site.hub.decisions(HubAction::move_done).size() == 1);
    CHECK_FALSE(s.site.hub.move_followed("far"));
    // It still sends on the old rate, which nobody hears now.
    CHECK(far_log.moves.empty());
    CHECK(sent_since(far, at(seconds(400))).back().data_rate == protocol::DataRate::dr5);
    CHECK(s.site.hub.received_from("far", type::door_changed).empty());
  }
}

TEST_CASE("a cancel before the switch clears the next settings; there is nothing to switch") {
  MoveSite s(HubMode::direct_radio);
  SiteMove move;
  move.send_data_rate = kSlow;
  // Cancelled while announcing: after the sensors have heard the next settings, before both have
  // confirmed them (the switch would then have come by itself).
  s.site.sim.schedule(at(seconds(10)), [&]() { s.site.hub.announce_move(move); });
  s.site.sim.run_until(at(seconds(75)));
  REQUIRE(s.site.hub.move_stage() == MoveStage::announcing);
  CHECK(s.front_log.next_send_data_rate == kSlow);
  const std::uint8_t announcing = s.site.hub.settings_version("front");
  s.site.hub.cancel_move();
  // Every sensor gets a version announcing nothing, so even a heartbeat that does not ask is
  // answered (protocol section 7).
  CHECK(s.site.hub.settings_version("front") != announcing);
  CHECK(s.site.hub.move_stage() == MoveStage::none);
  CHECK(s.only(HubAction::move_cancelled).at == s.site.sim.now());
  CHECK_THROWS_AS(s.site.hub.switch_move(true), host::SimulationError);
  CHECK_THROWS_AS(s.site.hub.cancel_move(), host::SimulationError);
  // The next replies announce nothing, so each sensor drops the next settings, and stays put.
  s.site.sim.run_until(s.site.sim.now() + seconds(130));
  for (const ScriptSensorLog* log : {&s.front_log, &s.back_log}) {
    CHECK(log->next_send_data_rate == protocol::kStaysAsItIs);
    CHECK(log->moves.empty());
  }
  CHECK(sent_since(*s.front, s.site.sim.now() + seconds(-60)).back().data_rate ==
        protocol::DataRate::dr5);
}

TEST_CASE("a switch due during a countdown or an alarm waits for it to end") {
  for (const bool let_alarm_sound : {false, true}) {
    INFO("alarm: " << let_alarm_sound);
    MoveSite s(HubMode::direct_radio);
    s.site.hub.arm();
    SiteMove move;
    move.send_data_rate = kSlow;
    s.site.sim.schedule(at(seconds(10)), [&]() { s.site.hub.announce_move(move); });
    // One sensor has confirmed; its door opens, and the other confirms during the countdown.
    s.run_to_confirmations(1, at(seconds(135)));
    REQUIRE(s.site.hub.decisions(HubAction::move_confirmed).size() == 1);
    host::SimDevice* door =
        s.site.hub.decisions(HubAction::move_confirmed)[0].device == "front" ? s.front : s.back;
    const device::Instant opened = s.site.sim.now() + seconds(1);
    door->set_input(device::Input::door, true, opened);
    s.run_to_confirmations(2, opened + seconds(25));
    INFO(s.site.hub.dump());
    REQUIRE(s.site.hub.decisions(HubAction::move_confirmed).size() == 2);
    REQUIRE(s.site.hub.countdown_running(door->name()));
    // Due, it is put off.
    CHECK(s.only(HubAction::move_switch_waiting).at ==
          s.site.hub.decisions(HubAction::move_confirmed).back().at);
    CHECK(s.site.hub.move_stage() == MoveStage::announcing);
    if (let_alarm_sound) {
      // The countdown ends in an alarm, which also puts it off.
      s.site.sim.run_until(opened + seconds(40));
      REQUIRE(s.site.hub.decisions(HubAction::alarm).size() == 1);
      CHECK(s.site.hub.decisions(HubAction::move_switched).empty());
    }
    // The disarm ends both: the switch goes at once.
    const device::Instant disarm_at = s.site.sim.now();
    s.site.hub.disarm();
    CHECK(s.only(HubAction::move_switched).at == disarm_at);
    CHECK(s.site.hub.move_stage() == MoveStage::switched);
  }
}

TEST_CASE("only the channel moves: the next rate stays, the sensors follow to 868.5 MHz") {
  for (const HubMode mode : kBothModes) {
    INFO("mode: " << mode_name(mode));
    MoveSite s(mode);
    SiteMove move;
    move.site_channel = kChannel868_5;
    const device::Instant switch_at = s.announce_and_switch(move, at(seconds(10)));
    CHECK(s.front_log.next_site_channel == kChannel868_5);
    CHECK(s.front_log.next_send_data_rate == protocol::kStaysAsItIs);
    CHECK(s.site.hub.site_channel() == kChannel868_5);
    s.site.sim.run_until(switch_at + seconds(200));
    INFO(s.site.hub.dump());
    for (auto [device, log] : {std::pair{s.front, &s.front_log}, std::pair{s.back, &s.back_log}}) {
      REQUIRE(log->moves.size() == 1);
      CHECK(log->moves[0].site_channel == kChannel868_5);
      CHECK(log->moves[0].send_data_rate == protocol::DataRate::dr5);
      const auto after = sent_since(*device, switch_at + seconds(130));
      REQUIRE_FALSE(after.empty());
      CHECK(after.back().frequency_hz == 868500000u);
      CHECK(after.back().data_rate == protocol::DataRate::dr5);
    }
    CHECK(s.site.hub.decisions(HubAction::move_done).size() == 1);
  }
}

TEST_CASE("a packet still heard on the old settings after the switch is answered announcing") {
  Site site(gateway_mode());
  // A gateway that is two minutes late applying its new settings.
  ScriptGatewayConfig late;
  late.apply_settings_after = seconds(120);
  site.gateway("gateway", late, site.gateway_log);
  ScriptSensorLog front_log;
  site.sensor("front", every_minute(), front_log);
  SiteMove move;
  move.send_data_rate = kSlow;
  site.sim.schedule(at(seconds(10)), [&]() { site.hub.announce_move(move); });
  site.sim.run_until(at(seconds(130)));
  REQUIRE(site.hub.move_unconfirmed().empty());
  // It switched by itself with the confirmation.
  const auto switched = site.hub.decisions(HubAction::move_switched);
  REQUIRE(switched.size() == 1);
  const device::Instant switch_at = switched[0].at;
  const std::uint8_t announcing = front_log.heard.back().reply.settings_version;
  site.sim.run_until(switch_at + seconds(110));
  INFO(site.hub.dump());
  // Heard on the old rate after the switch: the reply goes on announcing, with the old version
  // and rate, so the sensor stays where it is.
  REQUIRE(front_log.heard.back().at > switch_at);
  const protocol::Reply& reply = front_log.heard.back().reply;
  CHECK(reply.settings_version == announcing);
  CHECK(reply.send_data_rate == protocol::DataRate::dr5);
  CHECK(reply.next_send_data_rate == kSlow);
  CHECK(front_log.moves.empty());
  CHECK_FALSE(site.hub.move_followed("front"));
  // Once the gateway has applied them, the sensor follows.
  site.sim.run_until(switch_at + seconds(300));
  REQUIRE(front_log.moves.size() == 1);
  CHECK(site.hub.move_followed("front"));
  CHECK(site.hub.decisions(HubAction::move_done).size() == 1);
}

TEST_CASE("a move that would change nothing, or a second one, is refused") {
  MoveSite s(HubMode::direct_radio);
  SiteMove same;
  same.send_data_rate = protocol::DataRate::dr5;
  same.site_channel = 1;
  CHECK_THROWS_AS(s.site.hub.announce_move(same), host::SimulationError);
  SiteMove move;
  move.send_data_rate = kSlow;
  s.site.hub.announce_move(move);
  CHECK_THROWS_AS(s.site.hub.announce_move(move), host::SimulationError);
}

}  // namespace
}  // namespace hsn::test
