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

## Writing a scenario test

1. Make a `Simulation` (seed 1 by default) and, for anything that talks to a hub, a `TestHub` on it: `HubMode::direct_radio` (its own ideal radio stands in for a gateway) or `HubMode::gateway_link` (gateway roles carry the radio).
2. Add each device with a `DeviceSpec`: a name, a `RoleFactory` (`make_role<SensorRole>(&HostBoard::sensor_io)`), a drift and a power-on instant. The factory runs on every boot, because a reset or a deep-sleep wake destroys the role with the rest of RAM.
3. Pair it before its first boot: `hub.add_sensor(device, settings)` (or `add_siren`, `add_gateway`) provisions the board's flash and registers its key; without a hub, `provision(board, Provisioning{…})`.
4. Script the world: `device.set_input(Input::door, true, at(seconds(10)))`, `hold_button(from, to)`, `power_loss(when, off_for)`, `restart(when)`; hub actions with `sim.schedule(when, [&] { hub.disarm(); })` or between two `run_until` calls; radio conditions with `sim.medium().set_path_loss(…)`, `cut(…)`, `script_noise(…)`.
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

- **Boots** come 50 ms (`DeviceSpec::boot_time`) after power, a reset or a deep-sleep wake. A deep sleep and a restart destroy the boot's objects; the platform puts the radio to sleep and the links go down without an event. Every reset, deep sleep and power loss drives the siren's sounder output low, as the hardware does, recorded on the timeline as an `output` change when it was on. A power loss also turns the retained block to garbage and restarts the RTC at zero. Input changes reach a running device as events, wake a deep-sleeping one when they are among its wake inputs, and otherwise only change the level the role reads.
- **The Medium** keeps every transmission on air for its exact time on air. A receiver hears a packet only when it listened on the same frequency and data rate from the packet's first instant, was not sending, and the signal stood above the demodulation SNR of its spreading factor over the noise (−117 dBm, plus scripted noise). Overlapping packets on one frequency and data rate are both lost unless one is the capture margin (6 dB) stronger, whichever came first: a newcomer that much stronger captures the receiver, a held packet that much stronger survives. Packets at other data rates or frequencies neither collide nor are heard; a packet starting the instant another ends is no overlap. A timed receive stops its timer at preamble detection (symbol timeout symbols, at least one) or at the header (20.25 symbols), by its stop rule, then receives the packet to its end; one packet ends a timed receive, a continuous one goes on. A locked packet that does not survive ends in `rx_crc_error`. CAD takes the core's `cad_duration` and is busy while a matching, audible packet is on air. Path loss is 100 dB between every pair unless set.
- **The test hub's ideal radio** hears every data rate it is set to at once, but sends at 869.525 MHz for the full time on air and is deaf meanwhile, skips a fixed-moment packet when busy, and queues as-soon-as-possible packets (siren commands first) until their latest moment. It acts 50 ms after a packet ends (`HubOptions::processing`). Links have 25 ms each way.
- **The test hub's rates and order:** it answers a sensor packet with flag bit 7 (listening at the sending rate) at the rate the packet arrived at, and any other at the reply rate of the settings version the packet says the sensor holds (protocol section 7, "Data rate" and "Faster replies"). Log entries say neither, so it answers them at the arrival rate while the sensor's latest status packet had bit 7 and no reply has gone since, and otherwise at the reply rate of the settings in the latest reply it sent (the arrival rate before any); sirens get LoRa packets at the command rate of the version they last reported. One packet at a time per siren: settings wait while a command is unconfirmed, a newer command replaces a waiting one, and settings go once a report shows another version and nothing waits. A siren already sounding for an alarm is not commanded again when another door's countdown ends (protocol section 7, "Siren command"): within one alarm each siren gets one sound command, and a disarm (its off command), the sounding time running out or a new alarm after either starts afresh.
- **What the test hub does not do:** heartbeat slots are off unless `heartbeat_slots` is set and then use the hub's arrival time; it does not learn clock corrections (set `clock_correction_ten_ppm`) or choose reply rates from signal margins (set them in `SensorConfig`).
