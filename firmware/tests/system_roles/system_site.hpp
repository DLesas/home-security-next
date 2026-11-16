#pragma once

// The whole-system bench: the real sensor, siren and gateway roles on one Simulation, with the
// test hub in gateway link mode (design section 8, "System tests"), and the questions the
// scenarios ask of what an outsider sees: the timeline, the hub's records, the buzzer and the
// sounder. Requirement and decision numbers in test names refer to software.md and
// architecture.md; "§" to protocol.md.

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <random>
#include <string>
#include <utility>
#include <vector>

#include "hsn/host/role_box.hpp"
#include "hsn/protocol/radio.hpp"
#ifdef HSN_LOCKSTEP
#include "hsn/host/remote_hub.hpp"
#include "lockstep_support.hpp"
#endif
#include "hsn/roles/gateway/gateway_role.hpp"
#include "hsn/roles/sensor/sensor_role.hpp"
#include "hsn/roles/siren/siren_role.hpp"
#include "sim_support.hpp"

namespace hsn::test::system {

using device::Duration;
using device::Input;
using device::Instant;
using device::microseconds;
using device::milliseconds;
using device::seconds;
using device::Sound;
using host::HubAction;
using host::HubPath;
using host::Record;
using host::RecordKind;
namespace type = protocol::message_type;

/** The hub the scenarios run against (sim_support.hpp): the test hub, or the real one. */
using test::SiteHub;
#ifdef HSN_LOCKSTEP
namespace json = host::json;
#endif

/**
 * Data-rate masks, one bit per index (§2, "Data rates"). A site has one sending rate until O14
 * is settled: DR5 alone is the default here. DR5 and DR2 together (the bench's own default,
 * HubOptions::allowed_data_rate_mask) are only for tests of the sensor's fall-back (§7).
 */
constexpr std::uint8_t kOnlyDr5 = 1u << protocol::DataRate::dr5;
constexpr std::uint8_t kTwoRates = kOnlyDr5 | (1u << protocol::DataRate::dr2);

/** "DR5 only" or "DR5 and DR2", for printing. */
inline std::string rates_name(std::uint8_t mask) {
  return mask == kOnlyDr5 ? "DR5 only" : "DR5 and DR2";
}

/** Hub options in gateway link mode for a site that allows the data rates in `mask` (§2). */
inline host::HubOptions site_allowing(std::uint8_t mask) {
  host::HubOptions options = gateway_mode();
  options.allowed_data_rate_mask = mask;
  return options;
}

/** The default site: one sending rate, DR5, which the gateway listens at (§2). */
inline host::HubOptions one_rate_site() {
  return site_allowing(kOnlyDr5);
}

/** The test hub's site channel, 868.3 MHz (§2, "Frequencies"; HubOptions::site_channel 1). */
constexpr std::uint32_t kSiteHz = 868300000;
/** Where the hub's replies and commands go (§2, "Frequencies"). */
constexpr std::uint32_t kHubHz = 869525000;
/** 1% of an hour on the site channel, per device (§2, "Airtime budgets"). */
constexpr Duration kDeviceLegalHour = seconds(36);
/** 10% of an hour on 869.525 MHz, per gateway (§2, "Airtime budgets"). */
constexpr Duration kGatewayLegalHour = seconds(360);
/** The house default entry countdown (D40, D86). */
constexpr std::uint8_t kCountdownSeconds = 30;
/** The disarmed notice is sent twice, this far apart (§8, D24). */
constexpr Duration kNoticeGap = seconds(2);
/** Siren commands repeat every 5 s on LoRa until confirmed (§7 "Siren command", §8). */
constexpr Duration kLoraRepeat = seconds(5);
/** The bench's link latency, each way (HubOptions::link_latency). */
constexpr Duration kLinkLatency = milliseconds(25);
/**
 * The longest the hub may take from a packet or a timer to the frame it sends: its commit, at most
 * 30 ms at the 99th percentile, and about 1 ms of processing (hub-design.md section 5's budget).
 * The test hub takes none; the real hub in lockstep takes RemoteHub::send_delay().
 */
constexpr Duration kHubActsWithin = milliseconds(31);
/** From power, a reset or a deep-sleep wake to the boot event (DeviceSpec::boot_time). */
constexpr Duration kBootTime = milliseconds(50);
/** The sensor's own alarm after its countdown, when the hub does not answer (DS6, D88). */
constexpr Duration kLocalAlarm = seconds(3 * 60);

/** Retries after the first three come every 60 s, plus up to half of that at random (§7). */
constexpr Duration kLateRetryGap = seconds(60 + 30);
/**
 * Tries from any point of the fall-back's round on a two-rate site to one at the gateway's rate:
 * at most two more at the other rate, then one at the right one (§7 "Data rate").
 */
constexpr std::int64_t kTriesToComeRound = 3;

/** A true instant `s` seconds after the start. */
inline Instant at_s(std::int64_t s) {
  return host::at(seconds(s));
}

/** How far apart two instants are, either way round. */
inline Duration apart(Instant a, Instant b) {
  return a < b ? b - a : a - b;
}

/** Seconds, with fractions, for printing. */
inline double in_seconds(Duration duration) {
  return static_cast<double>(duration.us) / 1e6;
}

/**
 * A site: one simulation, the test hub in gateway link mode, and the real roles added to it,
 * each paired before its first boot. Members are public: a scenario reaches into the
 * simulation, the hub and the devices directly.
 */
struct SystemSite {
  explicit SystemSite(host::HubOptions options = one_rate_site(),
                      host::SimulationOptions simulation = {})
#ifdef HSN_LOCKSTEP
      : sim(simulation),
        hub(sim, with_link_mode(options), hub_program()){}
#else
      : sim(simulation), hub(sim, with_link_mode(options)) {
  }
#endif

            /** A GatewayRole on mains, connected to the hub over Wi-Fi unless `config` says
               otherwise. */
            host::SimDevice
            & gateway(const std::string& name, const host::GatewayConfig& config = {},
                      std::int32_t drift_ppm = 0) {
    host::DeviceSpec spec;
    spec.name = name;
    spec.role = host::make_role<roles::gateway::GatewayRole>(&host::HostBoard::gateway_io);
    spec.drift_ppm = drift_ppm;
    host::SimDevice& device = sim.add_device(spec);
    device.board().power.external = true;
    hub.add_gateway(device, config);
    gateways.push_back(name);
    return device;
  }

  /** True when `name` is one of the site's gateways. */
  bool is_gateway(const std::string& name) const {
    for (const std::string& gateway : gateways) {
      if (gateway == name) {
        return true;
      }
    }
    return false;
  }

  /** A SensorRole on a cell, powered on at `power_on`. */
  host::SimDevice& sensor(const std::string& name, const host::SensorConfig& settings = {},
                          std::int32_t drift_ppm = 0, Instant power_on = Instant{}) {
    host::DeviceSpec spec;
    spec.name = name;
    spec.role = host::make_role<roles::sensor::SensorRole>(&host::HostBoard::sensor_io);
    spec.drift_ppm = drift_ppm;
    spec.power_on = power_on;
    host::SimDevice& device = sim.add_device(spec);
    hub.add_sensor(device, settings);
    return device;
  }

  /**
   * A SirenRole on mains, powered on at `power_on`, with its Wi-Fi link to the hub unless
   * `settings.wifi` is false.
   */
  host::SimDevice& siren(const std::string& name, const host::SirenConfig& settings = {},
                         Instant power_on = Instant{}, std::int32_t drift_ppm = 0) {
    host::DeviceSpec spec;
    spec.name = name;
    spec.role = host::make_role<roles::siren::SirenRole>(&host::HostBoard::siren_io);
    spec.power_on = power_on;
    spec.drift_ppm = drift_ppm;
    host::SimDevice& device = sim.add_device(spec);
    device.board().power.external = true;
    hub.add_siren(device, settings);
    return device;
  }

  /** Runs to a true instant. */
  void run_until(Instant until) {
    sim.run_until(until);
  }

  /** Everything on the timeline and in the hub's records, for a failed check. */
  std::string dump() const {
    return sim.timeline().select().dump() + hub.dump();
  }

  host::Simulation sim;
  SiteHub hub;
  std::vector<std::string> gateways;

private:
  static host::HubOptions with_link_mode(host::HubOptions options) {
    options.mode = host::HubMode::gateway_link;
    return options;
  }
};

/** The buzzer's changes, with their true instants. */
inline std::vector<std::pair<Instant, Sound>> buzzer(const host::SimDevice& device) {
  std::vector<std::pair<Instant, Sound>> out;
  for (const Record& record : device.records().kind(RecordKind::buzzer).records()) {
    out.emplace_back(record.at, static_cast<Sound>(record.value));
  }
  return out;
}

/** The true instants the buzzer changed to `sound`. */
inline std::vector<Instant> buzzer_times(const host::SimDevice& device, Sound sound) {
  std::vector<Instant> out;
  for (const auto& change : buzzer(device)) {
    if (change.second == sound) {
      out.push_back(change.first);
    }
  }
  return out;
}

/** The sounder's changes, with their true instants and the level changed to. */
inline std::vector<std::pair<Instant, bool>> sounder(const host::SimDevice& device) {
  std::vector<std::pair<Instant, bool>> out;
  for (const Record& record : device.records().kind(RecordKind::output).records()) {
    out.emplace_back(record.at, record.flag);
  }
  return out;
}

/** The first instant the sounder came on at or after `from`, or never. */
inline Instant sounding_from(const host::SimDevice& device, Instant from) {
  for (const auto& change : sounder(device)) {
    if (change.second && change.first >= from) {
      return change.first;
    }
  }
  return Instant::never();
}

/** The sounder's level just after `when`, from the timeline. */
inline bool sounding_at(const host::SimDevice& device, Instant when) {
  bool on = false;
  for (const auto& change : sounder(device)) {
    if (change.first <= when) {
      on = change.second;
    }
  }
  return on;
}

/** The device's transmissions, optionally of one type. */
inline std::vector<Record> sent(const host::SimDevice& device, std::uint8_t of_type = 0) {
  host::Selection selection = device.records().kind(RecordKind::transmission);
  return of_type == 0 ? selection.records() : selection.type(of_type).records();
}

/** The device's receptions of one type. */
inline std::vector<Record> heard(const host::SimDevice& device, std::uint8_t of_type) {
  return device.records().kind(RecordKind::reception).type(of_type).records();
}

/** Every packet the hub had from `from`, accepted or not. */
inline std::vector<host::HubPacket> hub_got_all(const SiteHub& hub, const std::string& from) {
  std::vector<host::HubPacket> out;
  for (const host::HubPacket& packet : hub.received()) {
    if (packet.from == from) {
      out.push_back(packet);
    }
  }
  return out;
}

/** The most airtime the device used on one frequency in any rolling hour. */
inline Duration busiest_hour_on(const host::SimDevice& device, std::uint32_t frequency_hz) {
  return device.records()
      .kind(RecordKind::transmission)
      .where([frequency_hz](const Record& r) { return r.frequency_hz == frequency_hz; })
      .busiest_hour();
}

/**
 * True when, at `now`, the device is in deep sleep, or awake only for the timer of its latest deep
 * sleep (a heartbeat: booting from it, or booted with nothing else since): asleep between its
 * heartbeats, wherever the hub placed them. A wake by an input or a reset is not that.
 */
inline bool sleeping_between_heartbeats(const host::SimDevice& device, Instant now) {
  if (device.state() == host::PowerState::deep_sleep) {
    return true;
  }
  const auto records =
      device.records().kind(RecordKind::deep_sleep).kind(RecordKind::boot).records();
  if (records.empty()) {
    return false;
  }
  const Record& last = records.back();
  if (last.kind == RecordKind::deep_sleep) {
    // Its timer has come and it boots: no input woke it before.
    return device.state() == host::PowerState::booting && last.until <= now;
  }
  return records.size() >= 2 && last.flag &&
         last.value == static_cast<std::uint32_t>(device::BootKind::deep_sleep_wake) &&
         records[records.size() - 2].kind == RecordKind::deep_sleep;
}

/**
 * Checks the sleep discipline of design section 6 from the timeline: every wake ends in exactly
 * one deep sleep, never two, and every boot but the first and those after a power loss or a
 * restart the test scripted (or provisioning made, kProvisioningResets) comes from a deep sleep.
 * The last boot may still be awake when the run ends. A restart the device asked for itself (a
 * fatal error) fails the check.
 */
inline void check_one_deep_sleep_per_wake(const host::SimDevice& device,
                                          std::size_t scripted_resets = 0) {
  INFO(device.name());
  std::size_t boots = 0;
  std::size_t resets = 0;
  std::size_t sleeps_since_boot = 0;
  bool reset_since_boot = true;
  for (const Record& record : device.records()
                                  .kind(RecordKind::boot)
                                  .kind(RecordKind::deep_sleep)
                                  .kind(RecordKind::restart)
                                  .kind(RecordKind::power_loss)
                                  .records()) {
    switch (record.kind) {
      case RecordKind::boot:
        CHECK((reset_since_boot || sleeps_since_boot == 1));
        boots += 1;
        sleeps_since_boot = 0;
        reset_since_boot = false;
        break;
      case RecordKind::deep_sleep:
        sleeps_since_boot += 1;
        CHECK(sleeps_since_boot == 1);
        break;
      default:
        resets += 1;
        reset_since_boot = true;
        break;
    }
  }
  CHECK(boots > 0);
  CHECK(resets == scripted_resets + kProvisioningResets);
}

/** The device address in a radio packet's clear part (§3). */
inline std::uint32_t address_in(const host::Bytes& packet) {
  REQUIRE(packet.size() >= protocol::kClearSize);
  std::uint32_t address = 0;
  for (std::size_t i = 0; i < 4; ++i) {
    address |= static_cast<std::uint32_t>(packet[1 + i]) << (8 * i);
  }
  return address;
}

/**
 * Packets from `name` the hub counted as duplicates without a record each. The test hub keeps a
 * record of every copy; the real hub counts duplicates per minute in `rejects` (section 6, D110).
 */
inline std::size_t duplicates_without_record(const host::TestHub&, const std::string&) {
  return 0;
}
#ifdef HSN_LOCKSTEP
inline std::size_t duplicates_without_record(const host::RemoteHub& hub, const std::string& name) {
  return hub.duplicates_counted(name);
}
#endif

/** True when the hub has a record of a packet from `from` carrying `counter`, whatever its verdict.
 */
inline bool hub_has(const SiteHub& hub, const std::string& from, std::uint32_t counter) {
  for (const host::HubPacket& packet : hub.received()) {
    if (packet.from == from && packet.counter == counter) {
      return true;
    }
  }
  return false;
}

/**
 * A whole number in [low, high) from the generator's raw output with fixed arithmetic, so every
 * standard library draws the same scenario (std:: distributions are not specified bit for bit).
 * Two 32-bit outputs make a 64-bit draw; its remainder's bias, under span / 2^64, is negligible.
 */
inline std::int64_t draw(std::mt19937& random, std::int64_t low, std::int64_t high) {
  const std::uint64_t high_bits = static_cast<std::uint64_t>(random());
  const std::uint64_t low_bits = static_cast<std::uint64_t>(random());
  const std::uint64_t span = static_cast<std::uint64_t>(high - low);
  return low + static_cast<std::int64_t>(((high_bits << 32) | low_bits) % span);
}

/** A day, in seconds. */
constexpr std::int64_t kDay = 86400;
/** About 20 door changes a day per sensor, at random moments (the load spike's figure). */
constexpr std::int64_t kDoorChangesPerDay = 20;
/** Heartbeat interval by sending rate: 3 minutes, at least 5 at SF12 (§7 "Data rate", §8). */
constexpr std::uint8_t kHeartbeatUnits = 12;
constexpr std::uint8_t kHeartbeatUnitsAtSf12 = 20;
constexpr Duration kHeartbeatUnit = seconds(15);
/** Replies use a rate three steps faster than the sending rate, at most DR5 (§7, D108). */
constexpr std::uint8_t kFasterReplySteps = 3;

/** The heartbeat interval the hub gives at a sending rate. */
inline Duration heartbeat_interval(std::uint8_t data_rate) {
  return Duration{kHeartbeatUnit.us *
                  (data_rate == protocol::DataRate::dr0 ? kHeartbeatUnitsAtSf12 : kHeartbeatUnits)};
}

/**
 * A load site (design section 8, "System tests"): heartbeat slots on, one sending rate, one
 * gateway listening at it, and `sensors` real sensors powered on spread over one interval,
 * replying `reply_steps` rates faster (§7 "Faster replies"). Long runs keep only the timeline.
 */
struct LoadSite {
  LoadSite(std::uint8_t data_rate, std::size_t sensors,
           std::uint8_t reply_steps = kFasterReplySteps)
      : rate(data_rate), site(options(data_rate), simulation()), gateway(add_gateway(data_rate)) {
    const Duration interval = heartbeat_interval(data_rate);
    for (std::size_t i = 0; i < sensors; ++i) {
      host::SensorConfig settings;
      settings.send_data_rate = data_rate;
      settings.reply_data_rate = static_cast<std::uint8_t>(
          std::min<int>(data_rate + reply_steps, protocol::DataRate::dr5));
      settings.heartbeat_interval_units =
          static_cast<std::uint8_t>(interval.us / kHeartbeatUnit.us);
      // Power-on spread over one interval, so Started packets do not all collide; the hub's
      // slots then spread the heartbeats.
      const Instant power_on = host::at(Duration{interval.us * static_cast<std::int64_t>(i) /
                                                 static_cast<std::int64_t>(sensors)} +
                                        seconds(1));
      doors.push_back(&site.sensor("door" + std::to_string(i), settings, 0, power_on));
    }
  }

  static host::HubOptions options(std::uint8_t data_rate) {
    host::HubOptions hub = site_allowing(static_cast<std::uint8_t>(1u << data_rate));
    hub.heartbeat_slots = true;
    return hub;
  }

  static host::SimulationOptions simulation() {
    host::SimulationOptions out;
    out.keep_fake_records = false;
    return out;
  }

  host::SimDevice& add_gateway(std::uint8_t data_rate) {
    host::GatewayConfig config;
    config.listen_data_rate_mask = static_cast<std::uint8_t>(1u << data_rate);
    return site.gateway("gateway", config);
  }

  /** Schedules about kDoorChangesPerDay changes a day on every sensor, at random moments. */
  void random_doors(std::int64_t span_seconds, std::uint32_t seed) {
    std::mt19937 random(seed);
    const std::int64_t changes = kDoorChangesPerDay * span_seconds / kDay;
    // Not before every sensor has had its Started answered and its first heartbeat.
    const std::int64_t first = heartbeat_interval(rate).us * 2;
    for (host::SimDevice* door : doors) {
      std::vector<std::int64_t> moments;
      for (std::int64_t k = 0; k < changes; ++k) {
        moments.push_back(draw(random, first, span_seconds * 1000000));
      }
      std::sort(moments.begin(), moments.end());
      for (std::size_t k = 0; k < moments.size(); ++k) {
        door->set_input(Input::door, k % 2 == 0, host::at(microseconds(moments[k])));
      }
    }
  }

  std::uint8_t rate;
  SystemSite site;
  host::SimDevice& gateway;
  std::vector<host::SimDevice*> doors;
};

/** The gateway's log codes for a heard packet it could not forward (FW6, D110). */
inline bool is_forward_loss(std::uint16_t code) {
  namespace codes = roles::gateway::gateway_log;
  return code == codes::forward_lost || code == codes::forward_seal_failed ||
         code == codes::forward_link_busy || code == codes::forward_link_down;
}

/** A log entry's made-at time is its packet's arrival less an age in tenths (§6, log entries). */
constexpr Duration kLogAgeResolution = milliseconds(100);

/**
 * True when the hub holds a log entry from `gateway` saying it could not forward a packet heard
 * at `heard_at`: the gateway had no connection yet, or its link refused the forward.
 */
inline bool hub_told_of_loss(const SiteHub& hub, const std::string& gateway, Instant heard_at) {
  for (const host::HubLogEntry& entry : hub.log_entries_from(gateway)) {
    if (is_forward_loss(entry.code) && apart(entry.made_at, heard_at) <= kLogAgeResolution) {
      return true;
    }
  }
  return false;
}

/** How the packets the gateways heard and the devices sent on links ended up at the hub. */
struct HubAccount {
  /** Packets checked. */
  std::size_t checked = 0;
  /** Heard by a gateway, not forwarded, and logged by it to the hub. */
  std::size_t lost_and_logged = 0;
};

/**
 * D110: nothing is lost unseen. Every packet a device sent on a link is in the hub's records
 * under that device and its counter; every packet a gateway heard on the site channel is too,
 * or the gateway told the hub, in a log entry made at that moment, that it could not forward it
 * (a packet heard before its welcome: GW2, FW6).
 */
inline HubAccount check_hub_recorded_everything(const SystemSite& site) {
  const host::Timeline& timeline = site.sim.timeline();
  HubAccount account;
  for (const auto& device : site.sim.devices()) {
    const bool is_gateway = site.is_gateway(device->name());
    // The packets this device sent on a link that the hub has no record of: there must be exactly
    // as many as the duplicates it counted for the device without a record each (D110).
    std::size_t unrecorded = 0;
    std::string which;
    for (const Record& record :
         device->records().kind(RecordKind::link_sent).kind(RecordKind::reception).records()) {
      if (record.kind == RecordKind::link_sent) {
        account.checked += 1;
        if (!hub_has(site.hub, device->name(), record.label.counter)) {
          unrecorded += 1;
          which += timeline.describe(record) + "\n";
        }
      } else if (is_gateway && record.frequency_hz == kSiteHz) {
        INFO(timeline.describe(record));
        account.checked += 1;
        if (!hub_has(site.hub, timeline.actor_name(record.peer), record.label.counter)) {
          CHECK(hub_told_of_loss(site.hub, device->name(), record.at));
          account.lost_and_logged += 1;
        }
      }
    }
    INFO(device->name() << ": sent on a link with no record of it at the hub:\n" << which);
    CHECK(unrecorded == duplicates_without_record(site.hub, device->name()));
  }
  return account;
}

}  // namespace hsn::test::system
