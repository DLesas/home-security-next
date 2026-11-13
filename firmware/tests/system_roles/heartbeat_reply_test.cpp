// The heartbeat reply reaches the sensor at every reply rate (protocol §7 "Sensor heartbeat",
// "Reply timing and a busy gateway", "Faster replies", §8 "Sensor listening margin"; D72, D108):
// the gateway sends a link-check reply at the fixed moment after the heartbeat, the reply starts
// inside the sensor's margin, and the sensor hears it to its end.

#include <algorithm>
#include <sstream>

#include "system_site.hpp"

namespace hsn::test::system {
namespace {

/** Long enough for several link checks: every 5th heartbeat asks for a reply (§7, §8). */
constexpr std::int64_t kRunFor = 2 * 3600;
/** The heartbeat reply moment: from the heartbeat's end to the reply's start (§8 †). */
constexpr Duration kReplyMoment = seconds(1);
/** The margin the reply must start inside: 20 ms early to 50 ms plus 8 symbols late (§8 †). */
constexpr Duration kMargin = milliseconds(50 + 20);

/**
 * One sensor sending at `send_rate`, heard by the gateway at that rate, told to listen for
 * replies at `reply_rate`. Checks that every heartbeat reply the gateway put on the air, starting
 * on time, was heard by the sensor.
 */
void every_heartbeat_reply_heard(std::uint8_t send_rate, std::uint8_t reply_rate) {
  SystemSite site(site_allowing(static_cast<std::uint8_t>(1u << send_rate)));
  host::GatewayConfig gateway_config;
  gateway_config.listen_data_rate_mask = static_cast<std::uint8_t>(1u << send_rate);
  host::SimDevice& gateway = site.gateway("gateway", gateway_config);
  host::SensorConfig settings;
  settings.send_data_rate = send_rate;
  settings.reply_data_rate = reply_rate;
  if (send_rate == protocol::DataRate::dr0) {
    // At least 5 minutes at SF12 (§7 "Data rate"): 20 units of 15 s.
    settings.heartbeat_interval_units = 20;
  }
  host::SimDevice& door = site.sensor("door", settings);
  site.run_until(at_s(kRunFor));
  INFO(door.records()
           .kind(RecordKind::transmission)
           .kind(RecordKind::reception)
           .kind(RecordKind::rx_window)
           .kind(RecordKind::deep_sleep)
           .dump());

  const auto beats = sent(door, type::heartbeat);
  const std::uint32_t address = address_in(site.hub.sent_to("door", type::reply).at(0).packet);
  const auto replies = gateway.records()
                           .kind(RecordKind::transmission)
                           .type(type::reply)
                           .where([address](const Record& r) { return r.label.address == address; })
                           .records();
  const auto receptions = heard(door, type::reply);
  std::size_t on_time = 0;
  std::size_t received = 0;
  for (const Record& reply : replies) {
    const bool after_heartbeat = std::any_of(beats.begin(), beats.end(), [&](const Record& b) {
      return apart(reply.at, b.until + kReplyMoment) < kMargin;
    });
    if (!after_heartbeat) {
      continue;
    }
    on_time += 1;
    received += std::any_of(receptions.begin(), receptions.end(),
                            [&](const Record& r) { return r.at == reply.until; })
                    ? 1u
                    : 0u;
  }
  MESSAGE("sending at DR" << static_cast<int>(send_rate) << ", replies at DR"
                          << static_cast<int>(reply_rate) << ": " << on_time
                          << " heartbeat replies on the air on time, " << received
                          << " heard by the sensor");
  CHECK(on_time > 0);
  CHECK(received == on_time);
}

TEST_CASE("D108 §8: heartbeat replies at DR5 to a sensor sending at DR0 are heard") {
  every_heartbeat_reply_heard(protocol::DataRate::dr0, protocol::DataRate::dr5);
}

TEST_CASE("D108 §8: heartbeat replies at DR4 to a sensor sending at DR0 are heard") {
  every_heartbeat_reply_heard(protocol::DataRate::dr0, protocol::DataRate::dr4);
}

// Once caught the sensor sleeping its radio at the header of a reply at SF9 or slower.
TEST_CASE("D108 §8: heartbeat replies at DR3 to a sensor sending at DR0 are heard") {
  every_heartbeat_reply_heard(protocol::DataRate::dr0, protocol::DataRate::dr3);
}

// Once caught the same cut at SF12.
TEST_CASE("§7 §8: heartbeat replies at DR0 to a sensor sending and listening at DR0 are heard") {
  every_heartbeat_reply_heard(protocol::DataRate::dr0, protocol::DataRate::dr0);
}

/**
 * The share of link-check replies on the air that the sensors must hear. 869.525 MHz carries
 * only this gateway, which sends one packet at a time, so nothing collides with a reply; each
 * starts at the fixed moment on the gateway's clock, counted from the heartbeat's end as the
 * sensor counts (§7), with no drift here. Every reply put on the air is heard.
 */
constexpr double kHeardFloor = 1.0;

/**
 * A day of 10 real sensors at `rate`, replies at the same rate: every heartbeat reply the gateway
 * put on the air, and how many the sensor it was for heard.
 */
void link_checks_for_a_day(std::uint8_t rate) {
  constexpr std::size_t kSensors = 10;
  LoadSite load(rate, kSensors, 0);
  load.site.run_until(at_s(kDay));
  std::size_t on_air = 0;
  std::size_t received = 0;
  std::size_t skipped = 0;
  for (const host::HubDecision& result : load.site.hub.decisions(HubAction::transmit_result)) {
    skipped += result.value == protocol::TransmitOutcome::radio_busy ? 1u : 0u;
  }
  for (host::SimDevice* door : load.doors) {
    const auto beats = sent(*door, type::heartbeat);
    const auto receptions = heard(*door, type::reply);
    const std::uint32_t address =
        address_in(load.site.hub.sent_to(door->name(), type::reply).at(0).packet);
    for (const Record& reply :
         load.gateway.records()
             .kind(RecordKind::transmission)
             .type(type::reply)
             .where([address](const Record& r) { return r.label.address == address; })
             .records()) {
      const bool to_heartbeat = std::any_of(beats.begin(), beats.end(), [&](const Record& b) {
        return apart(reply.at, b.until + kReplyMoment) < kMargin;
      });
      if (!to_heartbeat) {
        continue;
      }
      on_air += 1;
      received += std::any_of(receptions.begin(), receptions.end(),
                              [&](const Record& r) { return r.at == reply.until; })
                      ? 1u
                      : 0u;
    }
  }
  MESSAGE("10 sensors at DR" << static_cast<int>(rate)
                             << ", replies at the same rate, a day: " << received << " of "
                             << on_air << " link-check replies on the air heard (" << skipped
                             << " skipped by the gateway, radio busy)");
  CHECK(on_air > 0);
  CHECK(static_cast<double>(received) >= kHeardFloor * static_cast<double>(on_air));
}

TEST_SUITE("long") {
  TEST_CASE("D72 §7: a day of link checks, 10 sensors at DR5: every reply on the air is heard") {
    link_checks_for_a_day(protocol::DataRate::dr5);
  }

  TEST_CASE("D72 §7: a day of link checks, 10 sensors at DR2: every reply on the air is heard") {
    link_checks_for_a_day(protocol::DataRate::dr2);
  }

  TEST_CASE("D72 §7: a day of link checks, 10 sensors at DR0: every reply on the air is heard") {
    link_checks_for_a_day(protocol::DataRate::dr0);
  }
}

}  // namespace
}  // namespace hsn::test::system
