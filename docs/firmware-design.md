# Firmware design: device core, services and roles

Agreed 2026-11-12. Step A is implemented: the codec changes, the device layer, the host fakes and the role skeletons; the text below matches the code. The layer between the protocol codec (`firmware/core`, `hsn::protocol`) and the three roles. "§" means a section of [protocol.md](protocol.md), "HN" [hardware-notes.md](hardware-notes.md), "HN(a)n" item n of its reviewer checklist. Requirement and decision numbers refer to [software.md](requirements/software.md) and [architecture.md](architecture.md). Values marked † come from the protocol's provisional values.

The design in five lines:

- The platform owns one loop. It waits, then hands the core one **event** stamped with the time. The core never blocks, sleeps or reads a clock.
- A core **`Device`** receives every event. It handles USB setup messages itself, then passes the rest to the **`Role`** stored on the board (D103).
- After each event the core returns a **`Wake`**: the next instant it must run, and the deepest sleep allowed until then. A core **`Runner`** turns that into a wait the platform carries out, and is the only place the watchdog is fed.
- Shared **services** (secure channel, airtime, radio port with listen-before-send, retry timing, log buffer, stored records, setup, health) are written once in the core.
- Every piece of a sensor's memory between wakes is one retained struct, sealed with a CRC at the end of every event.

## 1. Layers and directory layout

```
platform/esp-idf | platform/host     loop, waiting, interrupts, drivers, receive buffers
        │ Event (with time)              ▲ WaitRequest
        ▼                                │
core:   Runner ──→ Device ──→ Role (roles/sensor | roles/siren | roles/gateway)
                     │          │
                     ▼          ▼
                 services ──→ HAL interfaces (implemented by the platform)
                     │
               hsn::protocol (the existing codec)
```

| Directory | Library | Contents | May include |
| --- | --- | --- | --- |
| `core/include/hsn/protocol/` | `hsn_core` | The codec, unchanged | allowed std headers |
| `core/include/hsn/device/` | `hsn_core` | `time.hpp`, `events.hpp`, `role.hpp`, `device.hpp`, `runner.hpp`, `timers.hpp` | `hsn/protocol/*` |
| `core/include/hsn/device/hal/` | `hsn_core` | One header per interface (section 3), headers only | `hsn/protocol/*` |
| `core/include/hsn/device/services/` | `hsn_core` | One header per service (section 4) | `hsn/protocol/*`, `hsn/device/**` |
| `roles/<role>/` | `hsn_role_sensor`, `_siren`, `_gateway` | One `Role` class, its state struct, its private helpers | core headers and its own `hsn/roles/<role>/*` only |
| `platform/psa/` | `hsn_psa` | `PacketCipher` on PSA, hub identity (exists) | PSA |
| `platform/host/` | `hsn_host` | A fake per interface, the virtual clock, the discrete-event `Simulation`, the shared `Medium`, a test hub; later a real-time runner and the socket bridge | anything |
| `platform/esp-idf/` | IDF components | `app_main`, per-board pin tables, the SX1262 adapter, NVS storage, the wait (sleep, queue, slices), watchdog, USB and WebSocket links, mDNS | anything |
| `tests/protocol/` | | The existing codec tests, moved | |
| `tests/device/` | | Unit tests of `Device`, `Runner` and each service | |
| `tests/roles/<role>/` | | Scenario tests of one role against `hsn_host` | |
| `tests/system/` | | Several devices on one `Medium` with the test hub | |

The core rules (C++17, no heap, exceptions, RTTI, floating point or recursion, bounded loops, 512-byte frames) apply to `core/` and `roles/`. To keep them enforced:

- `core_sources` runs over `core/` and every `roles/<role>/`, and its include list grows to `hsn/device/**`, plus `hsn/roles/<role>/*` inside that role only. A role that includes another role or a platform header fails.
- `core_symbols` runs on each role library as well as `hsn_core`.
- Interfaces copy `PacketCipher`'s pattern: a protected, non-virtual destructor. A virtual destructor makes a deleting destructor that references `operator delete`, which `core_symbols` rejects.
- Large buffers are members, never locals. The receive buffers (radio 255 bytes, link 1,024 bytes) belong to the platform; the core sees views.
- Core code runs on one task only. Interrupts and other tasks (Wi-Fi, WebSocket) only post into the platform's queue, so the core has no locks.

## 2. Event and timing model

### Time

```cpp
namespace hsn::device {
struct Instant  { std::uint64_t us; static constexpr Instant never(); };  // monotonic
struct Duration { std::int64_t us; };
Duration corrected(Duration nominal, std::int32_t ppm);  // ppm from protocol::ppm_from_clock_correction
}
```

- `Instant` is microseconds on the platform's monotonic clock. On the ESP32-S3 it is the RTC timer, which keeps counting through deep sleep. The low 32 bits are the gateway's "microsecond clock" of §6.
- Every event carries `now`. Hardware events also carry `at`, the moment the interrupt fired, captured in the ISR. The sensor times its next heartbeat from `tx_done.at`, and the gateway reports `rx_done.at`.
- A role keeps its deadlines in a `TimerSet<Id, N>`: a fixed array of instants indexed by an enum. It is trivially copyable, so it lives in the retained state.

### Events

```cpp
enum class EventKind : std::uint8_t { boot, timer, radio, link, input };
enum class BootKind  : std::uint8_t { power_on, deep_sleep_wake, other_reset };
enum class RetainedStatus : std::uint8_t { none, intact, clock_reset };       // filled in by Device
struct BootInfo  { BootKind kind; WakeMask woke_by; std::uint8_t reset_cause;  // raw ESP-IDF value, reported in Started
                   bool watchdog_reset; RetainedStatus retained; };
constexpr bool is_start_up(const BootInfo& boot);  // all but a deep-sleep wake with retained intact (§6)
enum class RadioEventKind : std::uint8_t { tx_done, rx_done, rx_timeout, rx_crc_error, header_seen, cad_done, fault };
struct RadioEvent { RadioEventKind kind; Instant at; ByteView packet;            // packet valid during handle() only
                    std::int16_t rssi_dbm; std::int8_t snr_quarter_db; bool busy; };
enum class LinkEventKind : std::uint8_t { up, down, packet };
struct LinkEvent  { LinkKind link; LinkEventKind kind; ByteView packet; };     // one whole, de-framed packet
enum class Input  : std::uint8_t { door, cover, button, external_power };
struct InputEvent { Input input; bool active; Instant at; };                   // debounced level after a change
struct Event { Instant now; EventKind kind; BootInfo boot; RadioEvent radio; LinkEvent link; InputEvent input; };
```

### The role contract

```cpp
enum class SleepDepth : std::uint8_t { awake, light, deep };
struct Wake {
  Instant at = Instant::never();       // run again (a timer event) at or after this
  SleepDepth deepest = SleepDepth::awake;
  WakeMask deep_wake_inputs;           // deep only; the platform picks each pin's level from the pin itself
  bool restart = false;                // restart the chip instead of waiting (provisioned, fatal)
};
class Role {  // every method has a "no role" default in hsn_core; every role overrides them all
public:
  virtual std::uint8_t role_id() const;          // 1 sensor, 2 siren, 3 gateway
  virtual void handle(const Event& event);       // never blocks; may call HAL and services
  virtual Wake next_wake() const;
  virtual MutableByteView state_bytes();         // the role's whole state, a trivially copyable struct
  virtual std::uint8_t state_layout() const;     // bumped when that struct changes
  virtual std::uint8_t state_id() const;         // current top-level state, for the breadcrumb
  virtual Duration longest_awake() const;        // zero: no bound (section 6)
protected:
  ~Role() = default;
};
```

The methods are not pure virtual: a pure virtual function makes every role library reference `__cxa_pure_virtual`, which `core_symbols` forbids. A forgotten override is caught at compile time instead: `is_complete_role<R>` is true only when `&R::method` is a pointer to a member of `R` for every method, and every role header, the test role included, asserts it. A probe proves that a role missing one override does not compile. A role works through due timers on every event, not only on timer events. `Device` wraps the role:

```cpp
class Device {
public:
  Device(Services& services, Role* role);  // null role: setup-only; also when not paired or another role is stored
  void handle(const Event& event);
  Wake next_wake() const;
};
```

`Device::handle` does, in order:

1. Writes the breadcrumb, `(kind << 8) | role.state_id()`, to no-init memory (on `boot`, after reading the previous one for `Health`).
2. On `boot`, checks the retained block (magic, layout, role, role layout, sizes, CRC) and copies it into the core and role state. A bad block means a cold start. A clock that went backwards keeps the state, tells the role `clock_reset`, and rebases the airtime record (section 4).
3. Passes a USB link packet that starts with 0xF1 to the setup service (§10). It never reaches the role.
4. Passes everything else to the role, unless it is in setup-only mode. In setup-only mode its `Wake` is light sleep while `Power::external_power()` holds, so USB setup messages get through, and otherwise deep sleep woken only by external power or the button (Bluetooth pairing, M3), so an unpaired board on a cell does not run it flat.
5. Seals the retained block: copies the state in and writes the CRC.
6. Checks the next `Wake` against the watchdog rules (section 6).

### The loop

```cpp
struct WaitRequest { Instant until; SleepDepth depth; WakeMask deep_wake_inputs; bool restart; };
class Runner {   // core, non-blocking
public:
  Runner(Device& device, Watchdog& watchdog);
  void start(const Event& boot);      // watchdog.start(5000 ms), then deliver
  void deliver(const Event& event);   // device.handle(), then feed the watchdog
  WaitRequest plan(Instant now);      // the device's Wake, cut into watchdog slices unless deep
  void timed_out(Instant now);        // `until` came: feed, plus a timer event when the wake is due
};

// platform/esp-idf/main/app_main.cpp
runner.start(platform.boot_event());
for (;;) {
  const WaitResult result = waiter.wait(runner.plan(clock.now()));  // the only blocking call
  if (result.has_event) { runner.deliver(result.event); } else { runner.timed_out(clock.now()); }
}
```

`app_main` reads the stored role (D103) and builds only that role: `switch (role) { case sensor: { static SensorRole r(services, sensor_io); run(r); } ... }`. Function-local statics mean the other two are never constructed, and one image holds all three. The host `Simulation` does not call `wait`. It keeps each device's `WaitRequest` as a future wake-up on its own queue of virtual time.

### Worked example: door opens while armed, buzzer stops on a disarmed notice

Settings held: armed, countdown 30 s, send rate DR3 (SF9), reply rate DR5 (SF7), site channel 868.3 MHz. The sensor's next counter is 1024. Times are seconds after the door opens. Airtime is from §2, CAD duration from HN 3, and the listen time of 2 s is †.

| t | Event | Calls | State touched | Then |
| --- | --- | --- | --- | --- |
| 0 | — | Reed switch changes level; the ext0 wake fires; the chip boots | — | — |
| ≈0.05 | `boot{deep_sleep_wake, woke_by door}` | `Device` reads `retained.block()`, CRC good, copies it into the core and role state. Role: `io.door_open()` true, `io.battery_millivolts()`, `io.chip_temperature_c()` | `door=open`, `change_count` 41→42, `report{door, origin 0.05, attempt 0}` | same handle |
| | | `channel.seal(DoorChanged{reply wanted, age 0})`: `take()` gives 1024, a multiple of 64, so `storage.write(counter_resume, 1088)` first. `port.send(packet, essential, {868.3 MHz, DR3})`: `airtime.admit(g1, 206 ms, essential)` passes, `radio.detect_activity({SF9, 4 symbols, peak 23, min 10})` | `exchange.sent = [1024]`; port `checking` | light sleep until DIO1, guard at 0.30 |
| ≈0.07 | `radio cad_done{busy=false}` | `radio.transmit({868.3 MHz, DR3, 14 dBm}, packet)`, `airtime.record(g1, 0.07, 206 ms)` | port `sending`; airtime minute bucket | light, guard at 0.45 |
| ≈0.28 | `radio tx_done{at 0.276}` | `radio.receive({869.525 MHz, DR5, 2 s, stop on preamble})` | `exchange.sent[0].ended_at = 0.276`; timers `listen_end` 2.28 and `retry` 2.05 + U(0, 1) s (§7) | light until DIO1 or 2.28 |
| ≈0.9 | `radio rx_done{30 bytes}` | `channel.open_bound(packet, exchange.sent)`: binding 1024, tag good, Reply {armed, countdown started, 30, 29 left}. `settings.update()` finds no change and does not write. `io.buzzer(Sound::countdown)`. `radio.receive({869.525 MHz, DR5, continuous})` (D24, LR7) | retry and listen timers cancelled; `countdown{counters [1024], ends 29.9}`; flags `buzzing`, `armed` | light sleep with the radio listening; the Runner wakes every 2 s to feed (section 6); wake at 29.9 |
| ≈12.3 | `radio rx_done{18 bytes}` | `channel.open_bound(packet, countdown.counters)` → DisarmedNotice. `io.buzzer(Sound::off)`, `radio.sleep(warm)` | countdown cleared, `buzzing=0`, report finished | same handle |
| | end of handle | Role `next_wake`: next heartbeat, `corrected()` by the stored correction (units of 10 ppm), deep, inputs door, cover, button and USB. `Device` seals the retained block. `Runner` feeds | retained CRC | platform arms the door wake for "closed", re-reads the door (HN(a)27), sleeps deep |

The second notice at 14.3 is not heard, because the radio is asleep, and is not needed. Had no reply arrived by 2.28, the radio would sleep and the retry would run at about 2.6. Because the sensor believes it is armed and the first try went unanswered, it would also buzz from the opening for its stored 30 s, then sound its own alarm (DS6, D88). That needs light sleep, not deep, so the buzzer keeps playing.

## 3. Hardware interfaces

Common contract:

- **Non-blocking.** A call returns within 5 ms, except `Storage::write` (500 ms at most, flash erase included) and `Radio::recover` (50 ms).
- **Buffers.** A call copies whatever it is given before it returns. A view in an event belongs to the platform and is valid only until `handle()` returns.
- **Errors.** Every fallible call returns `HalError {none, busy, not_found, io, invalid, unsupported}`. Results that arrive later come as events.
- **Types.** No vendor type appears in any interface. Pins, TCXO voltage, ADC scale and board revision live in the platform's per-board table (HN(a)35).

```cpp
class Clock          { public: virtual Instant now() const = 0; };              // used by the platform loop only
class Watchdog       { public: virtual void start(std::uint32_t timeout_ms) = 0; virtual void feed() = 0; };
class RetainedMemory { public: virtual MutableByteView block() = 0;          // 1,024 bytes, RTC slow memory
                               virtual MutableByteView breadcrumb() = 0; };  // 4 bytes, no-init
class Random         { public: virtual void fill(MutableByteView out) = 0; };   // hardware RNG
class Power          { public: virtual bool external_power() = 0; };  // USB on a sensor, supply on a siren or gateway
class Waiter         { public: virtual WaitResult wait(const WaitRequest& request) = 0; };  // platform side only

enum class StoreKey : std::uint8_t;  // ranges: core 0x00–0x0F, sensor 0x10–, siren 0x20–, gateway 0x30–0x3F
class Storage {
public:
  virtual HalResult<std::size_t> read(StoreKey key, MutableByteView out) = 0;  // not_found when absent
  virtual HalError write(StoreKey key, ByteView value) = 0;  // ≤ 256 bytes; whole or nothing; committed on return
  virtual HalError erase(StoreKey key) = 0;
  virtual HalError erase_all_but_role() = 0;                 // factory reset (PR4), Erase, a new pairing or role
};

struct RadioChannel { std::uint32_t frequency_hz; std::uint8_t data_rate; };
enum class RxStop : std::uint8_t { header, preamble };
struct RxParams  { RadioChannel channel; Duration timeout; /* 0: continuous */ RxStop stop; std::uint8_t symbol_timeout; };
struct CadParams { RadioChannel channel; std::uint8_t symbols, detect_peak, detect_min; };
class Radio {
public:
  virtual HalError transmit(const RadioChannel& channel, std::int8_t power_dbm, ByteView packet) = 0;  // → tx_done
  virtual HalError receive(const RxParams& params) = 0;      // → header_seen, rx_done, rx_crc_error, rx_timeout
  virtual HalError detect_activity(const CadParams& params) = 0;  // → cad_done{busy}
  virtual HalResult<std::int16_t> noise_dbm() = 0;           // instantaneous; only while receiving (GW11)
  virtual HalError sleep(bool warm) = 0;
  virtual HalError recover() = 0;                            // reset pin and full re-initialisation
};

enum class LinkKind : std::uint8_t { usb, network };
struct LinkTarget { HubIdentity hub; ByteView wifi_name, wifi_password; };
class Link {
public:
  virtual LinkKind kind() const = 0;
  virtual HalError connect(const LinkTarget& target) = 0;  // asynchronous → up / down
  virtual void disconnect() = 0;
  virtual HalError send(ByteView packet) = 0;              // one packet; platform frames it; busy when its queue is full
  virtual bool up() const = 0;
  virtual std::int8_t signal_dbm() const = 0;                // Wi-Fi signal strength; 0 on USB or when unknown
};
```

| Interface | Contract notes |
| --- | --- |
| Radio | Starting an operation cancels the current one and raises no event for it. The fixed §2 settings (sync word 0x12, CRC, explicit header, IQ, LDRO exactly at SF11–12, preamble 8) are applied by the platform, not passed in. The DIO1 ISR only stamps `at` and posts; the IRQ is read over SPI in task context (HN(a)13). `header_seen` lets the gateway avoid cutting off a reception (§7). The CAD settings per spreading factor are a core table taken from HN 3, so `detect_activity` maps directly onto `SetCadParams`. Both back-ends fit: Semtech's `sx126x_driver` (`sx126x_set_rx`, `sx126x_set_cad_params`, `sx126x_set_cad`, `sx126x_get_rssi_inst`, raw `StopTimerOnPreamble`), or RadioLib's `startTransmit`, `startReceive`, `startChannelScan` and `getRSSI` with `RADIOLIB_STATIC_ONLY` and `RADIOLIB_LOW_LEVEL` (HN(a)10). The platform applies the HN 3 workarounds: TX clamp, sleep between a receive timeout and a CAD, and register fixes. |
| Link | One interface for USB and WebSocket. The platform does the framing (the core's `FrameDecoder` and `encode_frame` on USB; one binary message on WebSocket), Wi-Fi join, mDNS with the identity check (HN(a)47) and the WebSocket. It turns off the client's own reconnect, because the core times reconnects. A network link pings the hub every 15 s and reports `down` after 15 s without an answer, which is how a siren knows a Wi-Fi report failed (§7). It queues up to 4 received packets; overflow drops the newest and is counted in a log. On UART links, console output is silenced (HN(a)44). |
| Storage | NVS on the ESP32. Each record starts with its own version byte. |
| RetainedMemory | Survives deep sleep. Survival through a watchdog reset or brown-out is unverified (HN(b)), so the core always checks the CRC and never assumes either way. |
| Watchdog | The ESP-IDF task watchdog on the main task only. Reset cause comes in `BootInfo`. |
| Random | `esp_fill_random`. This is true randomness only with Wi-Fi or the radio on, which holds for the gateway's hello. Sensor jitter needs no more. |
| Waiter | Deep sleep and restart never return. Before a restart the platform lets every link finish sending what it was already given, for at most 200 ms ‡, so that an answer is not cut off by the restart it announces (a Provision result, §10); a power loss gives no such grace. Light sleep wakes on DIO1, inputs, link activity or `until`. Before deep sleep: stop Wi-Fi and Bluetooth, radio asleep before the SPI pins are released, LED and divider off, arm the wake levels, re-read the inputs, then sleep (HN(a)27, 34). |

Role I/O interfaces. The platform debounces inputs and reports levels as `InputEvent`s:

```cpp
enum class Sound : std::uint8_t { off, countdown, alarm, chirp, low_battery, reset_warning };  // the platform plays the pattern
enum class Blink : std::uint8_t { off, short_once, pairing, fault };
class SensorIo  { public: virtual bool door_open() = 0; virtual bool cover_open() = 0; virtual bool button_pressed() = 0;
                  virtual bool charging() = 0; virtual std::uint16_t battery_millivolts() = 0;
                  virtual std::int8_t chip_temperature_c() = 0; virtual void buzzer(Sound) = 0; virtual void led(Blink) = 0; };
class SirenIo   { public: virtual void output(bool on) = 0; virtual bool output_on() const = 0; virtual bool cover_open() = 0;
                  virtual bool cell_fitted() = 0; virtual bool charging() = 0;
                  virtual std::uint16_t cell_millivolts() = 0; virtual std::int8_t chip_temperature_c() = 0; virtual void led(Blink) = 0; };
class GatewayIo { public: virtual bool cell_fitted() = 0; virtual bool usb_host() = 0;
                  virtual std::int8_t chip_temperature_c() = 0; virtual void led(Blink) = 0; };
```

External power is the shared `Power` interface in `Hal`, because `Device` needs it before any role exists; the role I/O interfaces do not repeat it (the sensor's "on USB power" flag and the siren's and gateway's "on mains" flags read it). `BuildInfo {FirmwareVersion version; bool development; std::array<uint8_t, 6> chip_id;}` is plain data the platform fills.

## 4. Shared services

All live in `core/include/hsn/device/services/`. Each takes `now` as an argument and never reads a clock.

| Service | Responsibilities | State | Persists |
| --- | --- | --- | --- |
| `SecureChannel` | Owns the device's address, `PacketCipher&` and `SendCounter`. `seal()` takes a counter; when `take()` asks, it writes the resume point **before** sealing, and refuses to send if that write fails. It applies the right §4 receiving rule per case (below). A packet whose body is shorter than its type's fields is dropped before any counter moves (§3). | next counter and resume point (retained on the sensor); siren's last command counter; gateway session | resume point every 64 or 1,024; siren command counter on each new command |
| `AirtimeBudget` | Rolling hour per sub-band: g1 868.0–868.6 MHz at 1%, g3 869.4–869.65 MHz at 10%. `admit(band, airtime, class)` returns allowed, or the earliest instant it will be. `routine` traffic may use 4/5 of the hour and waits or is skipped beyond that. `essential` traffic may use all of it and is still admitted past the limit (D111), with a gap of nine times its airtime after the device's last transmission; such an admission is marked, and the sender logs it (§2). After a clock reset, `rebase` counts everything again in the current minute. | 61 one-minute buckets per band in units of 10 ms (u16: a bucket saturates at 655 s, above both limits), plus the newest minute: 252 bytes. The sum covers at least the last hour and over-counts by at most a minute. | nothing; retained |
| `RadioPort` | For the sensor and siren. One outgoing packet at a time: admit, then CAD (up to 5 busy checks with a random 0.2–2 s wait, then send anyway, §2), transmit, record airtime. If a continuous receive was running when the send began, the port starts it again for each busy wait, so a siren or a buzzing sensor is not deaf while it waits; a packet that arrives is delivered as usual, and one whose header has been seen holds off the next check until it ends, within a guard. A packet sent past the legal hour is logged (D111). A guard deadline of airtime + 100 ms per operation; when it passes, `radio.recover()` and a log entry. Routes radio events to the role. Keeps nothing across deep sleep: a packet that does not fit is refused with the time it will, and the role sends a fresh one then, with the newest state and age. | operation, attempt, guard, the packet copy (255 bytes) | nothing |
| `RetrySchedule` | Stateless tables: sensor event retries (2, 5, 10 s, then every 60 s to 600 s, plus a random wait up to half the gap, §7); gateway and siren reconnects (1, 2, 4, 8, 15, then 30 s); un-slotted heartbeat (interval ±10%). `retry_time(origin, attempt, not_before, random)` returns the time, never before the previous try's listening ended (§7), or nothing after giving up; `after_failure` counts a reconnect's gap from each failure. | none; the caller keeps origin and attempt | — |
| `RandomSource` | Buffers bytes from `Random`; `below(n)` and `between(lo, hi)` by multiply or a 64-bit modulo, with no rejection loop, so it is bounded | 32-byte pool | — |
| `LogBuffer` | Entries `{instant, level, code, text ≤ 24 bytes}`. Text is a constant plus one optional integer, formatted without `<cstdio>`. A repeat of the newest entry's code raises its count, unless that entry is in a packet, when the repeat starts a new entry. `prepare(now, out, at_least, most)` builds a log entries message (§6) of the oldest entries at or above `at_least`, at most `most`, each dated by its age at that moment in tenths of a second; lower entries are skipped and kept. The entries taken are that packet's, and only the latest prepare has a packet. Entries leave only by `release()`, which removes exactly that packet's, whatever was added since. Wi-Fi and USB: `prepare(now, out)` takes everything, and `release()` once `link.send` takes the packet. LoRa (D110): `prepare(now, out, warning, 1)` after a heartbeat or LoRa check; a sensor releases when the hub's reply bound to that packet arrives, and without one the next prepare offers the same entry again; a siren, which gets no reply, releases once it is sent. Codes are reserved per range: core 0x0xxx, sensor 0x1xxx, siren 0x2xxx, gateway 0x3xxx, platform 0x4xxx. | 8 entries in the retained block, for every role, above a minimum level (a sensor keeps warnings and above) | — |
| `Record<T>` | A typed stored record: loads with a default, and `update(value)` writes only when the stored bytes differ. Settings from the hub (each role's own struct and key), pairing data, role. | a RAM copy | on change only |
| `SetupService` | USB setup messages (§10): Identify → Identity; Provision checked against the rules (release builds: a gateway accepts only while unpaired, sensors and sirens refuse; development builds: every role accepts Provision and Erase at any time); Erase; Set role (0x06: a release build only while no role is stored, a development build any time, forgetting the pairing when the role changes; an unlisted role is refused and the identity shows the role unchanged). Accepting a pairing erases everything but the role, writes the pairing record and a resume point of one step, and asks for a restart; `Device` then invalidates the retained block. | — | role, pairing record |
| `Health` | FW5, FW8. Builds `Started` from `BuildInfo` and `BootInfo`. Last fatal error is the stored code, or after a watchdog reset `0x8000 | breadcrumb`, so the hub learns which event and state hung. `raise_fatal(code)` stores the code and requests a restart; `reported()` clears it once Started has gone out. | — | fatal code; written on a fatal and when clearing a non-zero code |
| `stored_role(Storage&)` | D103: the stored role for `app_main`'s switch, or 0. No role, or no pairing, gives setup-only mode. | — | role: by Set role |

Receiving rules of `SecureChannel`, one per §4 row:

```cpp
struct BoundOpen   { protocol::OpenedPacket packet; std::uint32_t answered; };
enum class CommandVerdict : std::uint8_t { new_command, repeat_of_latest, too_old };
struct CommandOpen { protocol::OpenedPacket packet; CommandVerdict verdict; bool saved; };
// Sensor: tag check under Binding::sensor_packet(c) for each candidate c, newest first, at most 16.
Outcome<BoundOpen> open_bound(ByteView packet, Span<const std::uint32_t> candidates);
// Siren: binding none; strictly higher; on new_command the counter is written to flash before returning.
Outcome<CommandOpen> open_command(ByteView packet, PacketLimit limit);
// Gateway: welcome under Binding::hello, then Binding::session and strictly higher counters, all in RAM.
Outcome<protocol::OpenedPacket> open_session(ByteView packet, SessionState& session);
```

Opened bodies are views into the channel's own buffer. Each candidate costs one AES-CCM pass over at most 30 bytes; sixteen are well under a millisecond with hardware AES.

## 5. Retained memory and flash

Retained block, 1,024 bytes reserved in RTC slow memory (of 8 KB). The header and core part take 640 bytes, which leaves `kMaxRoleStateSize` = 384 bytes for a role's state; each role header checks its struct against it.

| Part | Contents | Bytes |
| --- | --- | --- |
| Header | magic, block layout, role, role state layout, core and role sizes, CRC-32 | 16 |
| Core | last `now` seen (a smaller one at boot means the clock restarted), last start-up, next counter and resume point, airtime buckets and the end of the last transmission per band (D111) | 8 + 8 + 8 + 272 (with padding) |
| Core log | 8 entries | 8 × 40 + 8 |
| Sensor state (provisional, owned by the sensor's engineer) | Armed, held here only and never in flash: a sensor that starts with no retained memory counts as disarmed until its Started is answered (§6). Settings held (version, countdown, heartbeat units, link-check N, send and reply rates, clock correction); schedule (next heartbeat, heartbeats since link check, misses in a row, listen-at-own-rate flag); door (reported level, change count, last change); report exchange (kind, origin, attempt, up to 16 sent counters with end times); countdown (counters, end); local alarm (phase, end, "sounded since last reply"); button (pressed at, phase); `TimerSet` of 9 timers | ≈ 330 |
| Breadcrumb | separate 4-byte no-init word, outside the CRC | 4 |

The siren keeps its output and stop time in the block. After a reset that is not a power-on, with the block valid, it resumes sounding for the time left (SR5, D80). The gateway keeps nothing that matters.

Flash (NVS). Each record carries a version byte, and NVS adds its own CRC. Rates assume a 3-minute heartbeat and 20 door changes a day for the sensor; reports every 30 s and a LoRa check every 5 minutes for the siren; 30 sensors for the gateway.

| Record | Bytes | Written when | Sensor / year | Siren / year | Gateway / year |
| --- | --- | --- | --- | --- | --- |
| Role | 1 | Set role, at manufacture (§10) | 0 | 0 | 0 |
| Pairing: address, key, hub identity, signing key, channel, rates, Wi-Fi name and password | 192 | Provision, factory reset | ≈0 | ≈0 | ≈0 |
| Send counter resume point | 4 | every 64 or 1,024 packets | 500/day ÷ 64 ≈ 2,850 | 3,170/day ÷ 1,024 ≈ 1,130 | ≈21,000/day ÷ 1,024 ≈ 7,500 |
| Siren last command counter | 4 | each new command or settings; never on a repeat (HN(a)40) | — | ≤ 1,000 (alarms, tests, "report now" after each hub restart) | — |
| Settings held (the sensor's excludes armed) | ≤ 16 | when a stored field changes | ≈10 | ≈10 | ≈10 |
| Last fatal error | 2 | on a fatal, and when it is cleared | ≈0 | ≈0 | ≈0 |
| **Total** | | | **≈ 2,860** | **≈ 2,150** | **≈ 7,500** |

With a 24 KB NVS partition (about 630 usable entries per cycle), the gateway erases each page about 12 times a year. That is far inside any NOR rating; HN 7 puts endurance at about 100,000 erases, unverified. Battery devices turn on `CONFIG_NVS_FLASH_VERIFY_ERASE`. No other flash write exists. A test counts writes over simulated years (section 8).

## 6. Watchdog policy (FW4)

| Rule | Detail |
| --- | --- |
| Timer | ESP-IDF task watchdog, `W` = 5 s, on the main task only. It is started first in `app_main`. The bootloader's RTC watchdog covers boot until then. |
| Who feeds | Only `Runner`: after `device.handle()` returns, and in `timed_out`. No ISR, timer callback or other task feeds it. |
| Waits | `plan()` never asks the platform to wait longer than 2 s, the slice, unless the depth is deep. A 60 s wait is 30 slices, each ending in a feed, which removes the old core's bug. A slice end calls nothing in the role. A hang inside the platform's own wait or a driver call is still caught, because the slice never returns. |
| Deep sleep | The chip resets on wake, and the watchdog starts again in `app_main`. Nothing runs, so nothing needs feeding. |
| A hang inside `handle()` | Not fed: reset after 5 s. On the next boot `BootInfo.watchdog_reset` is set, and Started reports `0x8000 | breadcrumb` as the last fatal error (FW5). |
| Busy loop | A role whose `Wake.at` is at or before `now` 64 times in a row, without a real wait between, gets `raise_fatal(busy_loop)` and a restart. Feeding cannot hide it. |
| Stuck awake | The sensor role states a longest awake time: 20 minutes, covering a 10-minute retry run plus a 255 s countdown and a 3-minute local alarm. `Device` raises `stuck_awake` past it, so a state machine that never allows deep sleep is caught before it drains the cell. Other roles state none. |
| Double sleep | A deep sleep ends the loop iteration (the chip resets), and nothing else sleeps, so the old second sleep after each cycle cannot occur. A host test asserts exactly one deep sleep per wake. |
| Budget | No call inside `handle()` may exceed 500 ms (section 3). Step B's simulation counts HAL calls per `handle()` and fails a test above 32, a cheap guard against hidden loops; the fakes already record every call. |

## 7. The roles

Each role is one class in `roles/<role>/`, constructed as `XRole(Services&, XIo&)`, with its own state struct, store keys, log codes and tests. The core and the three constructor signatures are frozen first, together with `hsn_host`. After that, three engineers work only inside their own `roles/<role>/` and `tests/roles/<role>/`. `app_main`'s role switch is written once, against those constructors.

### Sensor

| Aspect | Sketch |
| --- | --- |
| Events | `boot` (wake reasons), `input` door, cover, button, external_power; `radio` cad_done, tx_done, header_seen, rx_done, rx_timeout; `timer` |
| Top-level states | `idle` (may deep sleep) · `reporting` (via `RadioPort`: checking, sending, then listening, then waiting to retry) · `heartbeat_listen` (light sleep to the reply moment, 1 s †; window 20 ms early to 50 ms + 8 symbols late †) |
| Parallel states | alert: none, countdown (hub said started), local countdown, local alarm (DS6, D88) · button: released, held (5 s pairing hold, 15 s reset hold; DS7, DS8, D89) |
| Timers | next heartbeat, reply moment, listen end, retry, countdown end, local alarm end, button 5 s and 15 s, port guard |
| Rules | A report always carries the newest door state and its age (DS3), including one that waited for airtime (§2). Started is retried like a door report (§6). A retry never starts before the previous try's listening ended (§7). Every 5th heartbeat asks for a reply (link check). Data-rate fallback (§7): after 2 unanswered reply-wanted packets, listen at the sending rate; after 2 more, send one rate slower. The next heartbeat comes from the reply's tenths, counted from `tx_done.at` of the packet answered, scaled by `corrected(ppm_from_clock_correction(units))`. Unslotted heartbeats use the interval ±10%. Heartbeats are `routine`; door, cover, button and Started are `essential`. Factory reset (D89): while armed, report action 3 and sound `reset_warning` through the whole 10-minute retry run, refusing the reset if anything answers; when not armed, send action 4 once with reply wanted and wait one listen window. Either way action 4 goes before the erase. While `Power::external_power()` holds it never sleeps deeper than light (§10). |
| Keeps | Everything in its retained state (section 5), armed included. Flash only through `Record` (settings, without armed) and the core services. |
| Uses | SecureChannel (`open_bound`), RadioPort, AirtimeBudget, RetrySchedule, RandomSource, Record, Health, LogBuffer |

### Siren

| Aspect | Sketch |
| --- | --- |
| Events | `link` up, down, packet (WebSocket); `radio` (continuous receive on 869.525 MHz at the command rate; sends on the site channel); `input` cover, external_power; `timer` |
| States | output: off, alarm(stop at), test(stop at) · Wi-Fi path: down, connecting, up · LoRa report pending, through `RadioPort` |
| Timers | auto stop (SR5, capped by the settings' longest time), Wi-Fi report 30 s, LoRa check 5 min, reconnect back-off, port guard |
| Rules | A command or settings packet arrives on either path. `open_command` with `new_command`: the counter is written first, then the action runs, then a report (reason 1) is sent on the path the command came by (§7). The output is switched even if the flash write failed, with a log entry, because sounding matters more. `repeat_of_latest`: the same report, no write. `too_old`: silence. An unknown action does nothing but is still answered (§3). Each 30 s report goes on Wi-Fi; if the link is down (the platform's 15 s ping, section 3) or `send` refuses, it goes on LoRa at once (reason 3). The 5-minute LoRa check is `routine`; answers are `essential`. Never sleeps deeper than `awake`. |
| Keeps | Output and stop time in retained memory; command counter, settings and resume point in flash |
| Uses | SecureChannel (`open_command`), RadioPort, AirtimeBudget, RetrySchedule, Record, Health, LogBuffer |

### Gateway

| Aspect | Sketch |
| --- | --- |
| Events | `link` up, down, packet (USB or WebSocket); `radio` header_seen, rx_done, rx_crc_error, tx_done; `timer`; `boot` |
| States | connection: disconnected, connecting, awaiting welcome, connected(session) · radio: listening (site channel), receiving (after `header_seen`), transmitting (deaf), back to listening · interference: normal, suspected, alerting |
| Timers | status 30 s, noise sample (every 1 s while listening), interference hold 30 s †, reconnect back-off, welcome timeout, USB probe, scheduled transmits, radio guard |
| Rules | USB or Wi-Fi (§10): while `usb_host()`, Hello on USB every 2 s; USB only once welcomed; otherwise Wi-Fi after 10 s, trying USB again every 30 s while a computer is attached. On `up`: 8 random bytes, Hello, `open_session` for the welcome, then settings, then Started. A received packet of at least 18 bytes with a good CRC becomes a ForwardedPacket with `at` as the low 32 bits of the instant, sealed with the session binding. Transmit requests go into a bounded queue of 8, siren commands first; a full queue answers "radio busy", except that a siren command displaces the newest request that is not one (§6). The queue's size is set from the load sweep's highest measured depth, with at least as much again spare. An "at a given time" request maps the 32-bit clock to the nearest instant. Never transmit while `receiving`. `airtime.admit(g3, …)`: siren commands are `essential`, everything else `routine`, which keeps the last fifth for commands (§2). The result is sent, too late, no airtime, busy, or not valid. Noise: median and highest since the last status from at most 64 samples, and a learned normal level by integer averaging. No listen-before-send, which §2 does not ask of gateways. Never sleeps. |
| Keeps | Nothing retained of value; after any boot it starts a new connection, whatever its retained session says. Flash: resume point. Settings arrive on every connection and are stored only on change. |
| Uses | SecureChannel (`open_session`), AirtimeBudget, RetrySchedule (reconnect), RandomSource (hello), Record, Health, LogBuffer, SetupService (release-build auto-add, D100) |

## 8. Test strategy

| Piece | What it is |
| --- | --- |
| Fakes (step A, done) | One per interface in `hsn_host`. Each records every call with the virtual time: transmissions, receive windows, CADs, storage writes, buzzer and output changes, links sent. Fault switches: storage writes or reads fail, the next radio call fails or all do, link sends refused, connect fails, retained block corrupted or lost. `FakeWaiter` runs the real loop shape for one device. |
| Virtual clock | One true time for the simulation. Each device's `Clock` runs at its own drift in ppm, so clock correction and heartbeat slots can be tested. Deep sleep is a reset: the role and `Device` objects are rebuilt, RAM is lost, and the retained bytes and flash are kept. Any reset also drives a siren's sounder low, as the hardware does, and the timeline records it. A "power loss" also drops the retained bytes. |
| Simulation | A discrete-event scheduler. Every device's `WaitRequest` becomes a future wake. An event is delivered at the earliest of the device's wake and its hardware events. A boot event comes 50 ms (settable) after power, a reset or a deep-sleep wake. Every `handle()` is held to the budget of 32 hardware calls (section 6): more throws out of the run. Thirty simulated days of a periodic sensor-like role run in a quarter of a second. Seeded randomness makes every run repeatable, and a recorded timeline (every transmission, reception, collision, receive window, channel check, flash and retained write, output, buzzer, LED, link frame and sleep, per device, in true time) is what tests assert on. Built (step B): `platform/host`, with `README.md` there. |
| Medium | Radios register their frequency, data rate and state. A transmission is a span of true time with the §2 airtime. A receiver hears a packet only when listening on the same frequency and spreading factor from the preamble to the end, and not transmitting, which models the deaf gateway. Overlapping same-frequency, same-spreading-factor packets are both lost unless one is 6 dB stronger (a capture model that can be set; a newcomer that much stronger captures the receiver, and a held packet that much stronger survives). A per-pair path-loss table gives RSSI and SNR; a packet below its spreading factor's demodulation SNR over the noise is not heard. CAD reports busy while a matching transmission that receiver could hear is on air. Noise per frequency can be scripted, for interference. A timed receive stops its timer at preamble detection (the symbol timeout, at least one symbol) or at the header (20.25 symbols), by its stop rule. |
| Test hub | `TestHub` in `hsn_host` (as section 1 has it), with the hub-side rules needed: the 64-packet replay window, replies with their binding at the fixed moment or as soon as possible, at the rate the device listens at (the arrival rate under flag bit 7, otherwise that of the settings version it holds), settings versions, countdown with late reports, disarmed notice twice, siren commands and settings on both paths with repeats, one at a time (settings wait for an unconfirmed command, a newer command replaces a waiting one), one sound command per siren per alarm (a siren already sounding is not commanded again when another countdown ends), log entries from every device on every path, each kept with its made-at time (arrival less age) and a sensor's answered by a reply as soon as possible at the rate it listens at (a siren's and a gateway's are not), gateway hello, welcome, settings, forwarded packets, transmit requests and results. Two modes: its own ideal radio on the Medium standing in for a gateway (sensor and siren tests before a gateway role exists), or the gateway roles' links (gateway and system tests). It provisions the boards it is given, and keeps everything it received, sent and decided, timed. It keeps every copy of a sensor's log entry it received: one sent again after a lost reply is recorded again, marked with the counter of the packet that first carried it, so the audit record never loses an entry by taking it for another. |
| Bridge (later) | A real-time mode of the same scheduler, pinned to wall time. The gateway's USB `Link` is a pseudo-terminal, so the real hub opens it like a serial port with COBS framing, and no WebSocket library is needed on the host. The `Medium` can also export transmissions over a socket. This is the build plan's "simulated radio". |

The seam for step B. Everything below exists; step B adds the Simulation, the Medium, drifting clocks, the test hub and the bridge without changing any fake's interface to the core:

- **One board, many boots.** `HostBoard` holds a board's fakes, flash and retained memory. `HostInstance<R>` builds `Services`, the role, `Device` and `Runner` on it. A reset or deep-sleep wake destroys the instance and builds a new one; flash and retained memory stay, and `power_loss()` drops the retained bytes. The Simulation's `SimDevice` builds the same four objects from a `RoleFactory` instead, because its devices' role types are chosen at run time.
- **Time is pushed in.** No fake reads time on its own. The Simulation computes each board's time from its true time and that board's drift, and calls `FakeClock::set` before delivering an event.
- **Driving.** The Simulation does not use `FakeWaiter`. It keeps each device's `Runner::plan()` result as a future wake, and calls `deliver()` for a hardware event or `timed_out()` when `until` comes. A deep sleep ends the boot; the board is woken at `until` or by an input in `deep_wake_inputs`.
- **Radio.** `RadioObserver::operation_started` reports every transmit, receive, CAD and sleep as it starts; `FakeRadio::mode()`, `channel()` and `rx_params()` say what the radio is doing. The Medium answers with the event builders (`tx_done`, `rx_done`, `rx_timeout`, `rx_crc_error`, `header_seen`, `cad_done`, `fault`), which move the fake's mode as the chip would and keep received bytes in the radio's own buffer. A noise reading is reported too, just before it returns, so the Medium can set what it reads.
- **Links.** `LinkObserver::packet_sent` reports every packet a device sends; the test hub or the bridge answers with `FakeLink::up_event`, `down_event` and `packet_event`. Step B added `connect_requested` and `disconnected` (empty by default), because a connect must be answered with `up` or `down`.
- **Counting.** Step B added a `CallMeter` that every fake ticks on each call of a core interface (not the clock or watchdog), for the budget, and `FakeRetainedMemory::contents()`, so the Simulation sees what a `handle()` wrote. Neither changes an interface to the core.

| Kind | Covers |
| --- | --- |
| Bench (done, step B) | `tests/host/`: the Medium, the Simulation, the timeline, the replay window against the vectors, and every test-hub rule in both modes, with test-only roles and scripted devices built on `SecureChannel` and `RadioPort`; `tests/system/`: M1a's "done when" with scripted devices through a scripted gateway |
| Rule checks (done) | FW1: `core_sources` and `core_symbols` over the core; the same rules over each role, which may include only the core and itself; a probe for each check |
| Service unit tests (done) | §4 send and receive rules, including random resets between `take()` and a send never repeating a counter; LR5 airtime under priorities; §7 retry and jitter bounds; FW6 log bounds and drain, on links and over LoRa (one entry at warning or above, released exactly); FW7; §10 setup rules for release and development builds; FW5, FW8 Started fields |
| `Runner` and `Device` tests (done, with a test-only role) | FW4: feeds at least every `W` across 60 s waits, busy loop caught, stuck awake caught, one deep sleep per wake; retained CRC and layout mismatch; a clock that went back; setup interception; setup-only mode on a cell (deep sleep, woken by power or the button) and on power (light sleep, setup answered), with and without a role; the breadcrumb after a watchdog reset |
| Sensor scenarios | DS1–DS14, D88, D89, LR3, LR4, LR6, LR7, LR11, the worked example step by step; 365 simulated days with flash writes ≤ section 5 and airtime ≤ 1% in every hour |
| Siren scenarios | SR2–SR7: duplicate on two paths, a repeat answered without a write, auto stop, Wi-Fi failure falls back to LoRa, resume after a reset |
| Gateway scenarios | GW2, GW3, GW5, GW6, GW9 (two gateways), GW11; deafness while sending; the kept-back fifth; reconnect back-off |
| System tests | M1a "done when": armed door, buzzer, siren at the countdown's end, disarm stops it; 10 to 30 sensors on one gateway against the [gateway load](spikes/gateway-load.md) figures |
| Old native tests, carried as scenarios | stale armed alarm (DS6), resend on change (DS3), malformed response dropped, auto turn-off (SR5), reset cause, fatal recording, log bounds |

## 9. The old core: carried over, reshaped, dropped

| Old piece | Fate | Reason |
| --- | --- | --- |
| `retry_policy` | Reshaped into `RetrySchedule`: table-driven, with jitter, stateless | The protocol fixes irregular offsets and a random wait; doubling does not match. |
| `log_ring` | Reshaped into `LogBuffer`: binary entries, a code instead of a SHA-256, no JSON | §6 log entries; the SHA, `snprintf` and 160-byte texts do not fit the core rules. |
| `fixed_string` | Dropped | Text never travels; Wi-Fi details are `LengthPrefixed` byte views. |
| `interfaces.hpp` `Clock` | Reshaped: `now()` only; `sleep_ms` removed | Roles never sleep (constraint 1). |
| `Storage` (whole config and runtime structs) | Reshaped into keyed records | Writing a whole struct on every change wears flash and mixes rates. |
| `Transport` (Wi-Fi, UDP discovery, HTTP) | Dropped; replaced by `Link` and `Radio` | D101 and FW9. |
| `SensorHardware`, `AlarmHardware` | Reshaped into `SensorIo`, `SirenIo` | `sleep_until_event` became `Wake`; `poll_command_server` is gone. |
| `Watchdog` | Kept as start and feed; the progress marker became the breadcrumb; the reset cause moved to `BootInfo` | |
| `types.hpp` | Roles become the protocol's numbers; `Telemetry` floats become integers; `DeviceConfig` (HTTP, pins) is dropped (pins go to the board table); `RuntimeState` is split into retained and flash; normalised reset flags are dropped | Started wants the raw ESP-IDF value; no floating point. |
| `device_core` | Dropped; its duties are in `Device`, `Health` and `SecureChannel` | Blocking bootstrap and HTTP retries. |
| `sensor_app`, `alarm_app` | Behaviour kept: resend on change, stale-armed alarm, auto turn-off; code not kept | Blocking loops. |
| `main.cpp` | Dropped | The watchdog bug and the double sleep. |
| `provisioning`, `sha256`, `config_defaults` | Dropped | Setup messages, PSA hashing, protocol defaults. |

Almost no code carries over verbatim, which departs from D2 and the build plan's "carried over" (G12, now noted in the decisions).

## 10. Risks, open questions and gaps

| Risk or question | What settles it |
| --- | --- |
| Short timed waits on the RC slow clock: a 1 s wait to the reply moment with an error of a few tenths of a percent misses the 20 ms early margin | S8: light-sleep timer error over 1 s on the Olimex board with the crystal off (HN(a)31). If too large, stay in modem sleep for that second and measure the cost. |
| Receive stop condition: this design uses stop-on-preamble with a symbol timeout, so the window only needs to cover preamble detection | O10 and S6 on the boards; test that a false preamble does not hold the radio (HN 3) |
| Watchdog during light sleep: whether the task watchdog counts | Measure. The 2 s slices are correct either way. |
| Retained memory after a watchdog reset or brown-out (HN(b)) | Test on hardware. The CRC keeps it safe either way; the siren's resume and the breadcrumb depend on it. |
| Rollback and deep sleep (HN(a)42, UP1): a trial image must be confirmed before its first deep sleep | M3. `Device` will refuse `deep` while the image is on trial. |
| Event-time accuracy for gateway transmits "at a given time" | O10: measure timer latency on the gateway. Target ±1 ms. |
| O14, one radio and two data rates | S7. Alternating CAD would stay inside the gateway role. |
| Radio back-end | Recommend Semtech's `sx126x_driver`: plain C, no heap, raw commands available. RadioLib 8 stays possible behind the same interface. Decide before M1b. |
| RAM | `Services` take 4.1 KB (two 1,024-byte channel buffers among them); the gateway queue ≈2.2 KB and the platform's link buffers 4 KB come on top. Measure heap high-water marks (HN(a)48). |

The gaps this design found, and where each was settled on 2026-11-12:

| Gap | Settled |
| --- | --- |
| G1 heartbeat has no armed bit | §6 sensor status: the settings version covers the armed state. Armed is retained only (sections 5, 7). |
| G2 no message sets the role | §10: setup message 0x06 Set role, with its rules; `SetupService` (section 4) |
| G3 what a start-up is; Started retries | §6 Started, as read here; `is_start_up` (section 2) |
| G4 retries before the listening ends | §7: retry times are the earliest; `retry_time(…, not_before, …)` |
| G5 disarmed notice binding | §4 bindings: the newest accepted report of the opening; the sensor tries up to 16, newest first |
| G6 events that do not fit the airtime | §2: an essential packet waits, never dropped, with the newest state and age |
| G7 log time wraps after 49.7 days | §6 log entries: age in tenths of a second, computed when the packet is sealed |
| G8 clock correction range | §6 reply: units of 10 ppm (±32%); `ppm_from_clock_correction` |
| G9 siren answer path; failed Wi-Fi report | §7: the path the command came by; link down or packet refused; a 15 s WebSocket ping (section 3) |
| G10 gateway USB or Wi-Fi | §10 USB, "Choosing USB or Wi-Fi" (section 7) |
| G11 factory reset "nothing answers" | D89: the whole 10-minute retry run with the reset-warning sound; button action 4 before erasing (section 7) |
| G12, G13 old core carry-over; transmit current | Noted in the decisions and the board documents |
| G14 USB on a sleeping sensor | §10: a sensor on USB power never sleeps deeper than light |

Questions step A raised, and their answers:

- **The first counter after pairing** is one step (64 or 1,024), because a device restarts when paired; §4 now says so.
- **A pairing that cannot be stored** is answered "refused"; §10 now says that result covers it.
- **The RTC timer across a watchdog or software reset** is unverified. If it restarts, the airtime record counts for a full hour from the reset (section 4), which is safe, but a sensor that resets often during an alarm could defer reports. Measure on the board with the HN(b) retained-memory test.
- **A forgotten role override** no longer compiles (`is_complete_role`, section 2).

On the fixed constraints: none is departed from. One reading is stated here so it can be checked. For constraint 4, the core never *calls* a sleep. It returns a `Wake`, and the platform's `Waiter`, which is behind an interface with vendor-free wake reasons, does the sleeping. That is what lets constraint 1 hold and the host simulation run devices without blocking.
