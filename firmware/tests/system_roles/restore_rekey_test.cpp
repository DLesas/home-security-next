// The key change after a restore, through the real hub in lockstep (m3-updates-design.md section
// 7, D141; section 8: restore_rekey_test.cpp): a backup taken mid-day and restored later with the
// lockstep hub's test-only `benchRestore`; every device's key changed (a sensor that only sends
// heartbeats, an armed one, a siren on both paths, a gateway in place of its welcome); a door
// report recorded off the air between the backup and the restore, replayed after it, never acted
// on; a device out of range throughout, re-keyed when it returns; a backup taken in the middle of
// the key changes, restored, losing nothing. On the real hub only, with the real roles.

#ifdef HSN_LOCKSTEP

#include <filesystem>
#include <map>

#include "hsn/host/replay_radio.hpp"
#include "update_site.hpp"

namespace hsn::test::system {
namespace {

/** The default path loss between stations (Medium), to mend a cut. */
constexpr double kPathLossDb = 100;
/** A sensor re-keys at its next packet: its next heartbeat, at most an interval and a margin. */
constexpr Duration kSensorRekeyWithin = seconds(180 + 30);

/** A scratch folder for the backups, removed afterwards. */
struct BackupFolder {
  BackupFolder() {
    path = (std::filesystem::temp_directory_path() /
            ("hsn-rekey-" + std::to_string(reinterpret_cast<std::uintptr_t>(this))))
               .string();
    std::filesystem::remove_all(path);
    std::filesystem::create_directories(path);
  }
  ~BackupFolder() {
    std::error_code ignored;
    std::filesystem::remove_all(path, ignored);
  }
  BackupFolder(const BackupFolder&) = delete;
  BackupFolder& operator=(const BackupFolder&) = delete;

  std::size_t files() const {
    std::size_t count = 0;
    for (const auto& entry : std::filesystem::directory_iterator(path)) {
      count += entry.path().extension() == ".hsnb" ? 1 : 0;
    }
    return count;
  }

  std::string path;
};

/** The decisions the hub acts on a door report with: none may come from a replay (D141). */
constexpr HubAction kActedOn[] = {
    HubAction::countdown_started,     HubAction::countdown_continued,
    HubAction::late_report_sirens,    HubAction::late_report_notification,
    HubAction::report_while_disarmed, HubAction::alarm};

std::size_t acted_on_since(const host::RemoteHub& hub, const std::string& name, Instant from,
                           Instant to) {
  std::size_t count = 0;
  for (const HubAction action : kActedOn) {
    for (const host::HubDecision& d : hub.decisions(action, name)) {
      count += d.at >= from && d.at < to ? 1 : 0;
    }
  }
  return count;
}

/** Every device's key changed once since `from`: a Key change sent, then the switch. */
void check_rekeyed(const host::RemoteHub& hub, const std::string& name, Instant from) {
  CAPTURE(name);
  const auto switched = decisions_since(hub, HubAction::key_changed, from, name);
  REQUIRE(switched.size() == 1);
  const auto sent = decisions_since(hub, HubAction::key_change_sent, from, name);
  REQUIRE_FALSE(sent.empty());
  CHECK(sent.front().at <= switched[0].at);
  // Under the new key: the packet that switched it is accepted, and none after it is old-key.
  bool accepted_after = false;
  for (const host::HubPacket& packet : hub.received()) {
    if (packet.from != name || packet.at < switched[0].at) {
      continue;
    }
    accepted_after = accepted_after || packet.verdict == host::HubVerdict::accepted;
    CHECK(packet.verdict != host::HubVerdict::old_key);
  }
  CHECK(accepted_after);
}

/**
 * A site: a gateway on Wi-Fi, an idle sensor, an armed one whose door reports are recorded off the
 * air, a siren; backed up at 60 s, the armed door opened (and disarmed) after it.
 */
struct RestoreSite {
  RestoreSite() {
    site.sim.medium().keep_transmissions(true);
    gateway = &site.gateway("gateway");
    idle = &site.sensor("idle");
    armed = &site.sensor("armed");
    siren = &site.siren("siren");
    site.run_until(at_s(60));
    backup = site.hub.backup_now(folder.path);
    // After the backup: the armed door opens, its countdown starts, and is disarmed. The report is
    // on the air, and a recorder keeps it.
    site.hub.arm();
    armed->set_input(Input::door, true, at_s(100));
    site.run_until(at_s(110));
    site.hub.disarm();
    armed->set_input(Input::door, false, at_s(120));
    site.run_until(at_s(200));
    const auto reports = armed->records().kind(RecordKind::transmission).type(type::door_changed);
    for (const Record& record : reports.records()) {
      if (record.at > at_s(100) && record.at < at_s(110) && recorded == 0) {
        recorded = record.transmission;
      }
    }
  }

  /** The restore at the current instant; returns when the restored hub has started. */
  Instant restore(const std::string& file) {
    const Instant at = site.sim.now();
    site.hub.restore(file);
    return at;
  }

  BackupFolder folder;
  SystemSite site;
  host::SimDevice* gateway = nullptr;
  host::SimDevice* idle = nullptr;
  host::SimDevice* armed = nullptr;
  host::SimDevice* siren = nullptr;
  std::string backup;
  std::uint64_t recorded = 0;
};

TEST_CASE(
    "D141: a restore mid-day: every device's key is changed, the idle sensor's at its heartbeat, "
    "the siren's at the start on both paths, the gateway's in place of its welcome") {
  RestoreSite world;
  SystemSite& site = world.site;
  host::RemoteHub& hub = site.hub;
  INFO(site.dump());
  const Instant restored = world.restore(world.backup);
  site.run_until(restored + kSensorRekeyWithin + seconds(30));
  CHECK(hub.boot() == 1);  // a restored database counts its boots again (it holds none)
  CHECK(hub.decisions_named("restored").size() == 1);
  for (const std::string& name : {"gateway", "idle", "armed", "siren"}) {
    check_rekeyed(hub, name, restored);
  }
  // The siren's came at once (at the start), on both paths.
  const auto siren_sent = decisions_since(hub, HubAction::key_change_sent, restored, "siren");
  REQUIRE_FALSE(siren_sent.empty());
  CHECK(siren_sent.front().at - restored <= seconds(5));
  // The idle sensor, which only sends heartbeats, took its Key change at a heartbeat's reply
  // moment: the hub answered its old-key heartbeat when it listens (protocol section 7).
  const auto idle_old = decisions_since(hub, HubAction::old_key_packet, restored, "idle");
  REQUIRE_FALSE(idle_old.empty());
  // Nothing under an old key was acted on, and nothing failed its tag from a device meanwhile.
  for (const std::string& name : {"idle", "armed"}) {
    CHECK(acted_on_since(hub, name, restored, site.sim.now()) == 0);
  }
  // A key change is a change to paired devices: it starts a backup (D122), within a minute.
  CHECK(world.folder.files() >= 2);
  CHECK(critical_events(hub).empty());
  // The devices go on: the armed door, armed again, opens and starts its countdown.
  hub.arm();
  const Instant open = site.sim.now() + seconds(5);
  world.armed->set_input(Input::door, true, open);
  site.run_until(open + seconds(10));
  CHECK(decisions_since(hub, HubAction::countdown_started, open, "armed").size() == 1);
}

TEST_CASE(
    "D141: a door report recorded between the backup and the restore, replayed after it, is never "
    "acted on: before the sensor's switch it draws a Key change, after it it fails its tag") {
  RestoreSite world;
  SystemSite& site = world.site;
  host::RemoteHub& hub = site.hub;
  INFO(site.dump());
  REQUIRE(world.recorded != 0);
  hub.arm();  // armed: a replay acted on would start a countdown
  site.run_until(site.sim.now() + seconds(5));
  // The armed sensor out of the gateway's range, so it stays on its old key while the replay comes.
  site.sim.medium().cut(world.armed->station(), world.gateway->station());
  const Instant restored = world.restore(world.backup);
  host::ReplayRadio recorder(site.sim);
  site.run_until(restored + seconds(20));
  const Instant first_replay = site.sim.now();
  recorder.replay(world.recorded);
  site.run_until(first_replay + seconds(15));
  // Before the switch: recorded, not acted on, answered with a Key change only the sensor opens.
  CHECK(decisions_since(hub, HubAction::old_key_packet, first_replay, "armed").size() == 1);
  CHECK(acted_on_since(hub, "armed", restored, site.sim.now()) == 0);
  CHECK(hub.decisions(HubAction::key_changed, "armed").empty());
  // A flood of replays draws at most one Key change every 10 s (section 7).
  const Instant flood = site.sim.now();
  for (int i = 0; i < 6; ++i) {
    site.sim.schedule(flood + seconds(2 * i), [&]() { recorder.replay(world.recorded); });
  }
  site.run_until(flood + seconds(12));
  CHECK(decisions_since(hub, HubAction::key_change_sent, flood, "armed").size() <= 2);
  CHECK(acted_on_since(hub, "armed", restored, site.sim.now()) == 0);
  // Back in range: its next heartbeat draws the Key change and it switches.
  site.sim.medium().set_path_loss(world.armed->station(), world.gateway->station(), kPathLossDb);
  site.run_until(site.sim.now() + kSensorRekeyWithin);
  check_rekeyed(hub, "armed", restored);
  const Instant switched = hub.decisions(HubAction::key_changed, "armed").back().at;
  // After the switch the replay fails its tag, as a stranger's: not old-key, not acted on.
  const Instant after = site.sim.now();
  recorder.replay(world.recorded);
  site.run_until(after + seconds(10));
  CHECK(decisions_since(hub, HubAction::old_key_packet, after, "armed").empty());
  CHECK(acted_on_since(hub, "armed", switched, site.sim.now()) == 0);
  CHECK(critical_events(hub).empty());
}

TEST_CASE(
    "D141: a device out of range from before the restore is re-keyed when it returns, hours "
    "later; nothing it sent meanwhile was acted on") {
  RestoreSite world;
  SystemSite& site = world.site;
  host::RemoteHub& hub = site.hub;
  INFO(site.dump());
  site.sim.medium().cut(world.idle->station(), world.gateway->station());
  const Instant restored = world.restore(world.backup);
  site.run_until(restored + seconds(3 * 3600));
  CHECK(hub.decisions(HubAction::key_changed, "idle").empty());
  CHECK(hub.decisions(HubAction::key_change_sent, "idle").empty());
  // The others are done.
  for (const std::string& name : {"gateway", "armed", "siren"}) {
    check_rekeyed(hub, name, restored);
  }
  const Instant back = site.sim.now();
  site.sim.medium().set_path_loss(world.idle->station(), world.gateway->station(), kPathLossDb);
  site.run_until(back + kSensorRekeyWithin);
  check_rekeyed(hub, "idle", back);
  CHECK(acted_on_since(hub, "idle", restored, site.sim.now()) == 0);
  CHECK(critical_events(hub).empty());
}

TEST_CASE(
    "D141 D122: a backup taken in the middle of the key changes holds the pending ones; restored, "
    "it loses nothing: every device ends on a key the hub holds") {
  RestoreSite world;
  SystemSite& site = world.site;
  host::RemoteHub& hub = site.hub;
  INFO(site.dump());
  // The idle sensor out of range across both restores: it never takes the first new key.
  site.sim.medium().cut(world.idle->station(), world.gateway->station());
  const Instant first = world.restore(world.backup);
  site.run_until(first + kSensorRekeyWithin + seconds(30));
  for (const std::string& name : {"gateway", "armed", "siren"}) {
    check_rekeyed(hub, name, first);
  }
  REQUIRE(hub.decisions(HubAction::key_changed, "idle").empty());
  // A backup now: the switched devices' new keys, the idle one still marked for its change.
  const std::string middle = hub.backup_now(world.folder.path);
  site.run_until(site.sim.now() + seconds(60));
  const Instant second = world.restore(middle);
  site.sim.medium().set_path_loss(world.idle->station(), world.gateway->station(), kPathLossDb);
  site.run_until(second + kSensorRekeyWithin + seconds(60));
  // Every device is heard under a key the restored hub holds, and changed again (a restore marks
  // every device): none needs pairing again.
  for (const std::string& name : {"gateway", "armed", "siren", "idle"}) {
    check_rekeyed(hub, name, second);
  }
  CHECK(acted_on_since(hub, "idle", first, site.sim.now()) == 0);
  CHECK(critical_events(hub).empty());
}

}  // namespace
}  // namespace hsn::test::system

#endif
