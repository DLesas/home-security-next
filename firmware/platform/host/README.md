# hsn_host: the host bench

The test bench the roles are written against ([firmware-design.md](../../../docs/firmware-design.md), section 8). Ordinary C++17; the core rules do not apply here.

| File | Job |
| --- | --- |
| `fake_*.hpp`, `host_board.hpp` | One fake per hardware interface; `HostBoard` holds one board's fakes, flash and retained memory. Every fake ticks the board's `CallMeter` |
| `scheduler.hpp` | The queue of true time: actions in time order, ties in the order scheduled |
| `drift_clock.hpp` | One board's RTC against true time, at its own drift in ppm, exact both ways |
| `sim_device.hpp` | One board and its current boot (Services, role, Device, Runner), its inputs and power |
| `simulation.hpp` | Owns the scheduler, the devices, the Medium and the timeline; `run_until` |
| `medium.hpp`, `lora_physics.hpp`, `radio_bridge.hpp` | The shared radio, and the bridge from a board's `FakeRadio` to it |
| `link_wire.hpp` | A board's USB or network link and the wire to the hub, with latency |
| `test_hub.hpp`, `hub_radio.hpp`, `hub_log.hpp`, `replay_window.hpp` | The hub's side of the protocol, its ideal radio, its records, its replay window |
| `timeline.hpp`, `packet_labels.hpp`, `sim_time.hpp` | What happened, and how to ask about it |
| `provisioning.hpp` | `provision(board, …)` pairs a board without a hub; `make_board(board, role)` leaves it as made: unpaired, its role stored |
| `real_time.hpp` | `RealTimeDriver`: runs a `Simulation` against a `HostClock` (the host's monotonic clock, or `ManualHostClock` in tests), never ahead of it, delivering outside input at the host instant and reporting lags over 5 ms |
| `pty_link.hpp` | `PtyLink`: a board's USB or network link joined to a pseudo-terminal, COBS framed, up while the far end holds it open |
| `wire_json.hpp`, `lockstep.hpp` | The lockstep wire, version 2 (hub-design.md section 11): a strict JSON reader and JSON.stringify's writer, every message read and written, and `HubProcess`, a real hub process on a Unix socket |
| `remote_hub.hpp` | `RemoteHub`: the real hub as one more actor in a `Simulation`, with the parts of `TestHub`'s interface the system tests use |
| `bench_json.hpp`, `bench_script.hpp` | The real-time bench's manifest and JSON-lines timeline (`Timeline::set_listener` streams records as they are added), and its one-line script commands |

## Writing a scenario test

1. Make a `Simulation` (seed 1 by default) and, for anything that talks to a hub, a `TestHub` on it: `HubMode::direct_radio` (its own ideal radio stands in for a gateway) or `HubMode::gateway_link` (gateway roles carry the radio).
2. Add each device with a `DeviceSpec`: a name, a `RoleFactory` (`make_role<SensorRole>(&HostBoard::sensor_io)`), a drift and a power-on instant. The factory runs on every boot, because a reset or a deep-sleep wake destroys the role with the rest of RAM.
3. Pair it before its first boot: `hub.add_sensor(device, settings)` (or `add_siren`, `add_gateway`) provisions the board's flash and registers its key; without a hub, `provision(board, Provisioning{…})`.
4. Script the world: `device.set_input(Input::door, true, at(seconds(10)))`, `hold_button(from, to)`, `power_loss(when, off_for)`, `restart(when)`; hub actions with `sim.schedule(when, [&] { hub.disarm(); })` or between two `run_until` calls; radio conditions with `sim.medium().set_path_loss(…)`, `cut(…)`, `script_noise(…)`; a move of the site with `hub.announce_move(SiteMove{channel, rate})`, which switches by itself once every sensor has confirmed, or `hub.switch_move(true)` to force it, or `hub.cancel_move()` (see "Moving the site" below). `hub.arm()` refuses, naming them, when the hub last heard a door open (D50); `hub.arm(OpenDoors::arm_when_closed)` arms the rest now and each open one when its door closes (D114).
5. `sim.run_until(at(seconds(60)))`, then assert on the timeline, the hub's records and the fakes.

Times in tests are true times: `at(seconds(12))` is 12 s after the start. Each board's clock is its own: event `now` and `at` fields, and the fakes' records, are local readings; `device.clock().true_time(local)` converts.

## Worked example

This is [`tests/host/readme_example_test.cpp`](../../tests/host/readme_example_test.cpp), with `ScriptSensor` (`tests/support/`) standing in for the sensor role; replace `script_sensor(…)` with `make_role<roles::sensor::SensorRole>(&HostBoard::sensor_io)`.

```cpp
TEST_CASE("README: an armed door opening is answered with a countdown, then disarmed") {
  // One simulation, one hub with its own radio standing in for a gateway.
  host::Simulation sim;
  host::TestHub hub(sim);

  // A board running the role, 40 ppm fast, paired with the hub before its first boot.
  ScriptSensorLog log;
  host::DeviceSpec spec;
  spec.name = "door";
  spec.role = script_sensor(ScriptSensorConfig{}, log);
  spec.drift_ppm = 40;
  host::SimDevice& door = sim.add_device(spec);
  host::SensorConfig settings;
  settings.countdown_seconds = 30;
  hub.add_sensor(door, settings);

  // The script: armed from the start, the door opens at 10 s, the user disarms at 20 s.
  hub.arm();
  door.set_input(device::Input::door, true, at(seconds(10)));
  sim.schedule(at(seconds(20)), [&]() { hub.disarm(); });
  sim.run_until(at(seconds(30)));
  INFO(sim.timeline().select().dump() << hub.dump());

  // What went on the air, in order, by whom.
  CHECK(door.records().kind(RecordKind::transmission).type_names() == "door_changed");
  CHECK(sim.timeline().of(hub.actor()).kind(RecordKind::transmission).type_names() ==
        "reply, disarmed_notice, disarmed_notice");
  // What the hub decided, and when.
  const auto countdown = hub.decisions(host::HubAction::countdown_started, "door");
  REQUIRE(countdown.size() == 1);
  CHECK(countdown[0].value == 30);
  CHECK(hub.decisions(host::HubAction::disarmed_notice, "door").size() == 2);
  // What the device made of it.
  REQUIRE(log.heard.size() == 2);
  CHECK(log.heard[0].reply.flags.countdown_started);
  CHECK(log.heard[1].type == protocol::message_type::disarmed_notice);
  // Budgets over the run.
  CHECK(door.records().kind(RecordKind::flash_write).count() <= 1);
  CHECK(door.records().busiest_hour() < seconds(36));
}
```

## Asking what happened

- **The timeline** records, per actor and in true time: power, boots, waits and deep sleeps, inputs, transmissions, receptions, CRC errors, collisions, receive windows and timeouts, channel checks, flash writes and erases, retained-block writes, sounder output, buzzer, LEDs, link frames and link state. Packets carry their clear header and, where the hub holds the key, their message type. Filter with `of(actor)`, `kind(…)` (repeatable: kinds add up), `between(from, to)` (half-open), `type(…)`, `where(predicate)`; then `count()`, `records()`, `type_names()` (`"door_changed, reply"`), `airtime()`, `busiest(window)` and `busiest_hour()` (exact over any rolling window), `dump()`. `device.records()` is `timeline().of(device.actor())`.
- **The hub** keeps `received()` (with verdicts: accepted, duplicate, too old, bad tag…), `sent()`, `decisions()` (`HubAction`: reply, countdown started, late report, alarm, disarmed notice, siren confirmed, transmit result…) and `log_entries()`, all timed; `received_from`, `sent_to`, `decisions(action, device)` and `log_entries_from(device)` filter them; `HubPacket::as<Message>()` decodes; `dump()` prints all four in time order. A `HubLogEntry` holds the device, path and gateway, the packet's counter, level, code and text, the age, `made_at` (arrival less age), and `repeat_of`: for a sensor's entry already recorded from an earlier packet (same level, code and text, made within `HubOptions::log_repeat_tolerance`, 15 s), the counter of the packet that first carried it. Every copy is kept.
- **The scripted devices log** when their config has `log_entries` (`ScriptLogEntry`: instant, level, code, text). `ScriptSensor` with `send_logs` sends one entry at warning or above over LoRa after each heartbeat's reply window and releases it only when the reply bound to that packet arrives; `ScriptSensorLog::log_sends` says which packets were answered. `ScriptSiren` (Wi-Fi) and `ScriptGateway` (its link, once welcomed) send every entry as it arises and count `log_packets`.
- **The fakes** still record every call on the board's local clock (`FakeLink::wifi_signal_dbm` sets what a network link's `signal_dbm()` reports; a USB link always says 0): `device.board().radio.calls`, `storage.operations`, `siren_io.outputs`, `network.sent`. Set `SimulationOptions::keep_fake_records = false` for runs of months or years: the timeline then holds the history alone.

## What the bench enforces

- **32 hardware calls per `handle()`** (design section 6): more throws `SimulationError` out of `run_until`, naming the device, the event and the time. So do a zero-time loop (a million actions at one instant) and an unlisted data rate on the air.
- **Determinism:** the same seed and script give the same timeline, byte for byte. Nothing reads a wall clock.
- **RTTI:** code deriving from `device::Role` is built with `-fno-rtti`, like the core that emits its vtable; `tests/CMakeLists.txt` does it for the scripted devices and probe role in `tests/support/`, for `tests/host/` and `tests/system/`, and for every role test executable (`tests/roles/<role>/`, `tests/system_roles/`). `SimDevice::role<R>()` reaches the running role without RTTI.

## How the world behaves

- **Boots** come 50 ms (`DeviceSpec::boot_time`) after power, a reset or a deep-sleep wake. A deep sleep and a restart destroy the boot's objects; the platform puts the radio to sleep and the links go down without an event. A restart the device asks for through the waiter first lets its links finish sending what they were given, for at most 200 ms (`LinkWire::kRestartGrace`; design section 4, Waiter), so a Provision result reaches the hub; a power loss, a deep sleep and a scripted `restart` lose it, and frames towards a resetting device are always lost. Each board has its own chip identifier, `chip_id_for(seed, name)`, kept across every reset. Every reset, deep sleep and power loss drives the siren's sounder output low, as the hardware does, recorded on the timeline as an `output` change when it was on. A power loss also turns the retained block to garbage and restarts the RTC at zero. Input changes reach a running device as events, wake a deep-sleeping one when they are among its wake inputs, and otherwise only change the level the role reads.
- **The Medium** keeps every transmission on air for its exact time on air. A receiver hears a packet only when it listened on the same frequency and data rate from the packet's first instant, was not sending, and the signal stood above the demodulation SNR of its spreading factor over the noise (−117 dBm, plus scripted noise). Overlapping packets on one frequency and data rate are both lost unless one is the capture margin (6 dB) stronger, whichever came first: a newcomer that much stronger captures the receiver, a held packet that much stronger survives. Packets at other data rates or frequencies neither collide nor are heard; a packet starting the instant another ends is no overlap. A timed receive stops its timer at preamble detection (symbol timeout symbols, at least one) or at the header (20.25 symbols), by its stop rule, then receives the packet to its end; one packet ends a timed receive, a continuous one goes on. A locked packet that does not survive ends in `rx_crc_error`. CAD takes the core's `cad_duration` and is busy while a matching, audible packet is on air. Path loss is 100 dB between every pair unless set.
- **The test hub's ideal radio** hears every data rate it is set to at once, but sends at 869.525 MHz for the full time on air and is deaf meanwhile, skips a fixed-moment packet when busy, and queues as-soon-as-possible packets (siren commands first) until their latest moment. It acts 50 ms after a packet ends (`HubOptions::processing`). Links have 25 ms each way.
- **The test hub's rates and order:** it answers a sensor packet with flag bit 7 (listening at the sending rate) at the rate the packet arrived at, and any other at the reply rate of the settings version the packet says the sensor holds (protocol section 7, "Data rate" and "Faster replies"). Log entries say neither, so it answers them at the arrival rate while the sensor's latest status packet had bit 7 and no reply has gone since, and otherwise at the reply rate of the settings in the latest reply it sent (the arrival rate before any); sirens get LoRa packets at the command rate of the version they last reported. One packet at a time per siren: settings wait while a command is unconfirmed, a newer command replaces a waiting one, and settings go once a report shows another version and nothing waits. A siren already sounding for an alarm is not commanded again when another door's countdown ends (protocol section 7, "Siren command"): within one alarm each siren gets one sound command, and a disarm (its off command), the sounding time running out or a new alarm after either starts afresh.
- **What the test hub does not do:** heartbeat slots are off unless `heartbeat_slots` is set and then use the hub's arrival time; it does not learn clock corrections (set `clock_correction_ten_ppm`) or choose reply rates from signal margins (set them in `SensorConfig`). Its event listen times are the protocol's own table (`protocol::event_listen_milliseconds`); `HubOptions::event_listen_ms[rate]` reads it, and holds no copy.

## The real-time bench

`hsn_bench` ([`tools/bench/`](../../tools/bench/README.md)) runs these same pieces in real time against the real hub: `RealTimeDriver` keeps true time on the host clock, each link is a `PtyLink`, `BenchScript` reads commands from standard input, and the timeline streams as JSON lines. Its boards start from `make_board`, unpaired, so the hub provisions them over USB.

## The real hub in lockstep

`RemoteHub(sim, options, program)` starts the real hub (`bun hub/src/shell/main.ts --data <folder> --bench-lockstep <socket>`) on a fresh folder, removed afterwards, and joins it to the simulation as section 11 says a controller must: everything the hub learns is an input at the current instant, followed in that instant by an advance to it, and each `idle`'s `wake` is a step scheduled then, so true time never passes a hub wake and nothing reaches the hub in its past. Device links go to it as `linkUp`, `frame` and `linkDown`, with `HubOptions::link_latency` each way on the wires.

- **Boards** added with `add_sensor`, `add_siren` and `add_gateway` start as made (`make_board`), are plugged into the hub's USB 100 ms after power-on and provisioned with real setup messages: a gateway by itself (D100), the others one at a time with `hsn usb add`, then `hsn sensor set` or `hsn siren set` from their configs. Their USB is then unplugged (a sensor's USB power with it), unless `GatewayConfig::usb`. Every board has USB power while plugged in, so it waits for the hub instead of sleeping deep, and keeps the supply it was given after. `arm()` and `disarm()` asked meanwhile wait until every board is paired; once they are, `arm(open_doors)` answers at once with the open doors, as the test hub's does. Each board has one more restart than on the test hub (`kProvisioningResets`), and two more flash writes (`provisioning_flash_writes`).
- **Questions** (`received`, `received_from`, `sent_to`, `decisions`, `log_entries_from`, `dump`) are answered from the records in the `idle` answers, never from the database: rx and tx rows, decisions plus section 6's `benchActions` for LoRa tx rows, device log rows, and the hub's records of the setup messages (a packet of type 0, counter 0). A LoRa packet's tx row comes with its outcome; its `at` is the instant its transmit request left, from the frame. Device numbers, names, addresses and links come from the hub events' fields; a gateway's forwarded packets and transmit results are found by `gw_counter` and `result_counter`, a duplicate by its `rejects` row (`duplicates_counted`), all as section 6 says. To label packets on the timeline, and to know a transmit request's packet, this side reads what it carries: each board's key from the Provision the hub sends, each gateway connection's randoms from its hello and welcome.
- **The hub's delay:** every frame the hub sends leaves `send_delay()` after the instant it decided it (10 ms, `HSN_HUB_DELAY_MS`, or `set_send_delay`), standing in for its commit: the lockstep hub itself answers in zero time. Timing checks bound the hub by its budget, `kHubActsWithin` (31 ms); the lockstep group runs again at 30 ms.
- **Commands:** `announce_move`, `switch_move` (`hsn site change force`, with `--yes` when forced), `cancel_move`, `move_unconfirmed` (`site change status`), `command_siren` (`hsn siren test`, the one direct command), `change_gateway` (`hsn gateway set`) act at once: each steps the hub at the current instant and has its answer before it returns.
- **The socket:** every line is written whole (a loop over partial writes, waiting while the socket is full) and read whole (bytes kept until a line end), tested against a stand-in hub (`tests/lockstep/fake_hub.ts`) that writes 100 bytes at a time and counts what it gets; `HSN_LOCKSTEP_TRACE=<file>` writes every line both ways, as the recorded sessions have them.
- **Restarts:** `stop()` (clean), `kill()` and `start()` (a new process on the same folder; USB links come up again, network links reconnect by themselves).
- **The hub's closes** (wire version 2, `idle.closed`, `closed_links()`): a WebSocket the hub closed is dropped from its side, so the device sees it go down and connects again by itself; a USB port the hub closed leaves the board without a host there until it is plugged in again (section 11, "A link the hub closed").
- **M2's arming** (m2-design.md sections 6 and 7): `arm()` and `disarm()` are `hsn arm --all` and `hsn disarm --all`, switches to the fixed modes Away and Disarmed (D90); `create_group`, `create_mode`, `switch_mode`, `arm_group`, `disarm_group` and `create_schedule` are `hsn op` requests answered at once, devices named as on the bench; `set_clock(wall, trusted)` is the wire's `clock`; `decisions_named(kind)` reads any decision the hub records, M2's included (`mode_switched`, `alarm_trigger_added`, `schedule_ran`…). The fixed modes are numbers 1 and 2 (`fixed_mode`), since `snapshot` is refused on the lockstep hub.
- **Refused, not mapped:** a site of more than one data rate, a mode other than gateway link, settings with no `hsn` command (a gateway's listening rates, siren report intervals, addresses), a siren command other than a test; a command the hub refuses throws out of `run_until`.

## Moving the site

The test hub moves a site to another channel, sending rate or both in the three steps of protocol section 7, "Changing the site's channel or rate" (D115), simply: no stall warnings, no silence grace, no restart in the middle.

```cpp
host::SiteMove move;
move.send_data_rate = 2;          // or move.site_channel = 2; either or both
hub.announce_move(move);          // step 1: every sensor's next version names the next settings
// … step 2 comes by itself with the last confirmation (move_switched), or later if a countdown
// or an alarm runs; hub.switch_move(true) forces it past unconfirmed sensors …
// … run on: each sensor follows (step 3); hub.move_followed(name), hub.move_stage() …
hub.cancel_move();                // instead of the switch, before it
```

- **Announce** throws while a move is in progress or when it would change nothing. Every sensor gets a settings version whose replies name the next channel and rate (0xFF for one that stays); its replies' own rates stay the current ones. A sensor has confirmed when a packet from it names such a version (`move_confirmed`). A sensor paired meanwhile learns the move like the others; one paired after the switch gets the new settings.
- **Switch** comes by itself when the last sensor confirms (protocol section 7), at once when there is no sensor. `switch_move()` is the user's: without force it only names each sensor that has not confirmed (`move_unconfirmed`) and changes nothing; forced, it names each as left behind (`move_forced`): it keeps sending on the old settings, nobody hears it, and it is not waited for. During a countdown or an alarm (its sounding time, or until a disarm) it waits (`move_switch_waiting`) and goes when they end. It sets the site channel (`hub.site_channel()`) and, for a new rate, every sensor's and siren's sending rate, every gateway's listen mask and the mask pairing gives; sends every gateway its settings first (in direct radio mode the hub's own radio retunes, to the new channel and, for a new rate, that rate alone), then every siren its settings with the new channel and rate on both paths (`move_switched`, value 1 when forced).
- **Follow.** The first packet that arrives on the new settings makes a sensor followed (`device_followed`); it is answered at the rate it came at, with a version naming the new rate and announcing nothing. A packet still heard on the old settings (a gateway late to apply its own) is answered still announcing, with the version and rate the sensor holds. A siren has followed when a report shows its new version. When every confirmed sensor and every siren has followed: `move_done`.
- **Cancel** works only while announcing: every sensor gets a version announcing nothing (`move_cancelled`).
- **The scripted devices follow a move** as protocol section 7 says. `ScriptSensor` keeps next settings from any reply (`ScriptSensorLog::next_site_channel`, `next_send_data_rate`, as the latest reply said them), asks for a reply on every heartbeat while it holds them, sends the packet after an unanswered reply-wanted one on the other settings with flag bit 7, retries an unanswered report once that way, takes the next settings when a packet on them is answered (`moves`), and drops them on a reply announcing nothing. It keeps them in RAM only. `ScriptSiren` sends on the channel and rate of the settings it holds from its next transmission. `ScriptGateway` listens on the channel and the fastest rate its settings name, `apply_settings_after` later (zero by default: at once); `Site::add_mode_gateway(rate)` gives the hub's settings that same rate.
