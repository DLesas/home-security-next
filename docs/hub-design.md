# Hub design: core, ports and the minimal hub

Agreed 2026-11-13. The hub is built and integrated in `hub/`, and the text below matches the code; where the code departed from the agreed design, the text says what the code does and why. This is the hub's counterpart of [firmware-design.md](firmware-design.md). It describes the minimal hub of milestone M1a ([build-plan.md](build-plan.md)), shaped so that the full hub of M2 grows from it: the same core, ports and database, with modules added and none rewritten.

"§" means a section of [protocol.md](protocol.md), "FD" a section of [firmware-design.md](firmware-design.md). D and O numbers refer to [architecture.md](architecture.md); HB, AL, GW, SR, DS, LR and PR numbers to [software.md](requirements/software.md). Values marked † are the protocol's provisional values. Values marked ‡ are this design's own provisional choices, each to be set by a measurement; section 8 lists them.

The design in six lines:

- One process and one loop. Adapters turn the world (serial ports, WebSockets, the control socket, timers) into **inputs**, each stamped with the time and carrying 32 fresh random bytes.
- One pure function, `step(state, input, deps)`, returns the new **state**, a list of **effects** and the next **wake**. Timers are deadlines held in the state. The core never reads a clock, a file or a socket.
- The core does all protocol and alarm logic, opening and sealing packets through a deterministic cipher it is handed; the keys themselves stay in the shell.
- Effects are writes and audit records (each either written now or routine) and sends. Nothing that must survive a power cut is acted on before it is committed, and every door, cover, button and Started report and every warning is committed at once; routine records are held in memory and committed every five minutes (D112, HB35).
- One SQLite file in write-ahead mode, one writer, every commit fully synced, as few pages per commit as the rows allow.
- The command-line tool talks to the running hub over a local socket. The same socket drives the firmware bench in lockstep, so the bench's system tests can run against the real hub.

## 1. Layers and directory layout

```
serial ports · WebSocket /device · control socket · monotonic and wall clocks · random · SQLite
        │ adapters (shell) turn each into an Input                  ▲ the shell performs Effects
        ▼                                                            │ in a fixed order (section 4)
  shell loop ──→ step(state, input, deps) ──→ { state, effects, wake }
                    │ dispatcher: modules in a fixed order, internal messages in one queue
                    ▼
  clock · registry · links · setup · control · gateways · intake · alarm · sensors · slots · sirens · audit
                    │
              @hsn/protocol: codec, counters, replay window, COBS framing, setup messages, pairing, time on air
```

Bun workspaces as [stack.md](stack.md) has them, with two additions under `tools/`.

| Directory | Package | Contents |
| --- | --- | --- |
| `packages/protocol/` | `@hsn/protocol` | Exists. It holds the event listen time table (`EVENT_LISTEN_MS`) and lets `sealPacket` and `openPacket` take an AES cipher keyed once (D94). |
| `hub/src/core/model/` | `@hsn/hub` | The frozen types: ids, time, `Input`, `HubEvent`, internal messages, `Effect`, `StoreOp`, `AuditRecord`, `DecisionKind`, `CoreFault`, `HubRules` (every value of section 8 in one table) |
| `hub/src/core/step.ts` | | `step`, `nextDeadline` and the dispatcher |
| `hub/src/core/<module>/` | | One folder per module of section 2: `state.ts`, `handle.ts`, `view.ts` (read-only selectors other modules may use), `deadlines.ts` |
| `hub/src/core/util/` | | `protocol-safe.ts` (the only place the core calls a protocol function that can throw), `entropy.ts` |
| `hub/src/ports/` | | Interfaces only (section 3) |
| `hub/src/shell/` | | Bun-specific: `main.ts`, `loop.ts`, `clock/`, `cipher/`, `links/` (serial, WebSocket, USB watch, the lockstep link adapter, the send queue and the link registry), `storage/` (writer, batch, send gate, reader, SQLite settings, WAL counts, migrations, `fatal.log`), `control/` (socket server; Windows refused, section 9), `advertise/` (mDNS, the hub's signing keys), `safe/` (every `try` in the hub lives here) |
| `hub/src/db/` | | The Drizzle schema (section 6) |
| `hub/drizzle/` | | Generated SQL migrations, committed |
| `hub/src/control-protocol/` | | The control socket's requests and replies as Zod schemas, shared with the CLI |
| `hub/cli/` | | The `hsn` command (section 9) |
| `hub/test/` | | `unit/`, `world/` (the scenario harness, the whole-hub `Home`, the scripted gateway, sensor and siren), `scenarios/` (alarm, gateways, home, sensors, setup), `budget/`, `crash/`, `lint-probes/`. `conformance/` waits for lockstep (section 12) |
| `tools/eslint-plugin-hsn/` | `eslint-plugin-hsn` | The `must-use-result` rule (section 10) and its tests |
| `tools/check-own/` | | `bun run check:own <folders>`: one owner's check (section 12) |
| `tools/bench-bridge/` | | Not written yet: relays the bench's network links between pseudo-terminals and the hub's WebSocket, for real-time runs (sections 11, 12) |

What each layer may import:

| Code | May import | May not use |
| --- | --- | --- |
| `core/**` | `@hsn/protocol` (pure names only), `neverthrow`, `core/model/**`, its own folder, and other modules' `view.ts` | `sealPacket`, `openPacket`, `createAesCcm`, `nodeAes128`, `nodeSha256`; any other package; `node:*`, `bun:*`; the globals `Date`, `setTimeout`, `setInterval`, `performance`, `process`, `Bun`, `crypto`, `console`, `Math.random`; `throw` and `try` |
| `ports/**` | `core/model/**` | everything else |
| `shell/**` | anything | — |
| `db/**` | `drizzle-orm` | core, shell |
| `control-protocol/**` | `zod` | everything else |
| `cli/**` | `control-protocol/**`, `@hsn/protocol` (to decode records for display), `node:net` | core, shell, db |

Enforced in the root `eslint.config.js`, by file globs: `no-restricted-imports` (paths, patterns and import names), `no-restricted-globals`, `no-restricted-properties` (`Math.random`) and `no-restricted-syntax` (`ThrowStatement`, `TryStatement`, with the exceptions of section 10). Each restriction has a probe file in `hub/test/lint-probes/` that must fail with exactly that rule, and a test runs ESLint's Node interface over the probes, as the firmware does with `core_sources` (FD 1). The root `package.json` workspaces must add `hub` and `tools/*`; today they list `packages/*` only.

## 2. The core

### Time and randomness

```ts
type Mono = number & { readonly __brand: "Mono" };   // microseconds on the monotonic clock since this boot
interface Now {
  readonly mono: Mono;
  readonly wall: number;          // milliseconds since 1970 as the system says, for records only
  readonly wallTrusted: boolean;  // false until the system clock is known to be set (section 5)
}
interface Input { readonly now: Now; readonly entropy: Uint8Array; readonly event: HubEvent } // entropy: 32 bytes
```

- Every deadline the core keeps is a `Mono`. A wall clock that jumps (a Pi setting its clock from the network, section 5) can never stretch or cut a countdown. `Mono` is an integer below 2⁵³, good for 285 years.
- The wall clock is used only to stamp records and to tell the user when something happened. Deadlines that must survive a restart are stored relative to the last commit (section 5), never as wall times.
- Randomness enters as data. Each input carries 32 bytes from the system's secure generator. The core takes what it needs through `ctx.entropy.take(n)`: 8 bytes for a welcome's hub random (§6), 4 for a new device address and 16 for its key (PR5). No step needs more than 28; running out is a `CoreFault`. In tests the bytes come from a seeded generator, so every run is repeatable.
- The core opens and seals packets through `deps.cipher`, a `DeviceCipher` (section 3). AES-CCM is deterministic, so the core stays a pure function of its inputs; the keys never enter the state, the effects or the records, with one exception: the step that provisions a device emits its new key once, in a `StoreOp` written now and inside the Provision setup message (section 9).

### Events

```ts
type HubEvent =
  | { kind: "boot"; snapshot: DurableSnapshot; boot: BootInfo }          // first input of every run
  | { kind: "linkOpened"; link: LinkId; linkKind: "usb" | "network"; label: string }
  | { kind: "linkClosed"; link: LinkId; reason: LinkCloseReason }
  | { kind: "frame"; link: LinkId; bytes: Uint8Array }                    // one packet or setup message
  | { kind: "sendFailed"; link: LinkId; ref: SendRef; error: LinkErrorCode }
  | { kind: "commit"; outcome: CommitOutcome }                            // a flush failed, or recovered
  | { kind: "command"; request: RequestId; actor: string; command: ControlCommand }
  | { kind: "inputRejected"; rejection: InputRejection }                  // refused by the shell: recorded, never acted on
  | { kind: "tick" };                                                     // a wake came; due timers run
interface BootInfo { readonly id: BootId; readonly previousExit: PreviousExit; readonly cause: string | undefined }
type InputRejection =
  | { source: "control"; reason: ControlLineRejection; bytes: number; issues: readonly string[] }  // never the line itself
  | { source: "frame"; link: LinkId; reason: "badFrame" | "tooLong" }                             // a USB frame COBS refused
  | { source: "core"; event: HubEvent["kind"]; origin: string; message: string; detail: Record<string, string | number | boolean> };  // a CoreFault, handed back (section 10)
```

The shell knows nothing of the protocol: a frame is bytes from a link. Which device is on a link, whether a frame is a hello or a forwarded packet, and whether it is valid are all decided in the core.

`inputRejected` was added at integration. A control line that is not JSON or not a known request, and a USB frame that fails COBS decoding, are refused by the shell before the core could see them; D110 wants them recorded, and only the core makes records, so the shell hands the core the rejection (a control line's length and Zod's issue paths, never its content, which may hold a Wi-Fi password).

`DurableSnapshot`, the boot event's data, also carries the committed key of each device still provisioning (`provisioningKeys`). A retry after a restart must send the same address and key (section 9), and the core makes the Provision message, so these are the only keys the core is ever given; they leave it only inside Provision. Everything else in the snapshot is the configuration tables, `device_state` (device 0's row being the last commit mark), `loss_daily`, the countdowns, the alarm and the previous boot's row.

### State

```ts
interface HubState {
  readonly clock: ClockSlice;        // boot, last now seen, wall trust, downtime estimate
  readonly registry: RegistrySlice;  // devices, addresses, names, roles, pairing state
  readonly links: LinksSlice;        // which link carries what
  readonly setup: SetupSlice;        // USB setup exchanges in progress
  readonly control: ControlSlice;    // commands waiting for an answer
  readonly gateways: GatewaysSlice;  // sessions, settings, clock mapping, transmit requests, noise
  readonly intake: IntakeSlice;      // replay windows, duplicate copies, rejection counts
  readonly alarm: AlarmSlice;        // armed state per sensor, countdowns, the alarm
  readonly site: SiteSlice;          // the site's channel and rate, and a move between them (D115)
  readonly sensors: SensorsSlice;    // settings and versions, reply rates, silence
  readonly slots: SlotsSlice;        // heartbeat slots, clock correction estimates
  readonly sirens: SirensSlice;      // settings, what each should do and does, commands in flight, paths
  readonly audit: AuditSlice;        // record sequence, rejection minute counts, retention timers
}
```

Every slice is a tree of `readonly` interfaces, `ReadonlyMap` and `ReadonlyArray`. Each slice holds its own timers and its own sending counters: a device's key belongs to exactly one module (sensors, sirens or gateways), so no counter is shared.

### Effects

```ts
type Effect =
  | { kind: "write"; durability: Durability; op: StoreOp }               // section 5
  | { kind: "record"; durability: Durability; record: AuditRecord }
  | { kind: "cadence"; everyMs: 1_000 | 300_000 }                        // a countdown or alarm started or ended
  | { kind: "send"; link: LinkId; bytes: Uint8Array; ref: SendRef; counters: readonly CounterUse[] }
  | { kind: "close"; link: LinkId; reason: string }
  | { kind: "respond"; request: RequestId; reply: ControlReply }
  | { kind: "advertise"; identity: Uint8Array; port: number };
type Durability = "now" | "routine";
interface CounterUse { readonly device: DeviceId; readonly counter: number } // every hub counter in `bytes`
```

The core decides each item's durability (section 5's table), so which items force a commit is a rule tested in the core, not a choice of the writer. Every `record` effect is also what `hsn log --follow` streams (section 9). A `SendRef` names one send so that a `sendFailed` input can find its owner. There is one scheme for all modules: the module's place in the dispatcher order, plus one, times 2⁴⁰, plus a number the module counts (`moduleSendRef`), so references never collide between modules and `sendRefModule` tells whose a failure is. They are not kept across a restart. A `send` lists every hub counter its bytes use: one for a packet on a siren's WebSocket, two for a transmit request (the gateway packet and the device packet inside it). The shell's send gate uses the list (section 4). Every `StoreOp` is a full-value upsert or delete of one row, never a delta, so a write can be repeated after a failed commit without harm.

### Timers

A timer is data: `{ at: Mono; key: TimerKey }`, kept in the slice that owns it, with `TimerKey` a discriminated union per module (`{ module: "alarm"; kind: "countdownEnd"; sensor: DeviceId }`). Each module exports `deadlines(slice)`; `nextDeadline(state)` is the earliest of all. The dispatcher runs every due timer at the start of every step, whatever the event, as the firmware's roles do (FD 2). The shell sets one system timer for the earliest of the core's wake and the writer's flush deadline; when it fires, the input is a `tick`.

### The function

```ts
function step(state: HubState, input: Input, deps: CoreDeps): Result<Stepped, CoreFault>;
interface Stepped { readonly state: HubState; readonly effects: readonly Effect[]; readonly wake: Mono | undefined }
interface CoreDeps { readonly cipher: DeviceCipher; readonly rules: HubRules; readonly deepFreeze?: boolean }
function emptyState(): HubState;   // the state before the boot event
```

Restoring is not a special path: the first input of every run is `boot`, carrying everything read from the database, and the core rebuilds its state from it (section 7, "Hub restart"). `rules` holds every value of section 8, so a scenario test or the bench can change one without touching code. `deepFreeze` is set by tests: the core may not read `process`, so it cannot tell a test build by itself, and the caller says so. `makeCore(modules)` builds `step`, `nextDeadline` and `emptyState` over any set of modules, which the dispatcher's own tests use.

### Modules and the dispatcher

`step` puts every due timer on one queue, earliest first (equal times in module order), then the input's event. It then takes messages from the front until the queue is empty. **Every message goes to all thirteen modules in the order of the table below; a timer goes to its owner only.** A handler returns its slice unchanged for a message it ignores. This replaced the per-message subscriber lists first planned: one rule is simpler to check than thirteen lists, and a module that ignores a message costs a function call. A handler gets its own slice, the message and a context, and returns its new slice plus messages and effects:

```ts
interface Context {
  readonly now: Now; readonly view: HubState; readonly deps: CoreDeps;
  readonly entropy: EntropyCursor;
  readonly records: RecordCursor;            // take(): the next record sequence number
  readonly event: HubEvent["kind"];          // this step's input kind, for the CoreFaults a handler returns
}
type Handler<K extends keyof HubState> =
  (slice: HubState[K], message: Internal, ctx: Context) => Result<{ slice: HubState[K]; out: readonly (Internal | Effect)[] }, CoreFault>;
```

- A handler can change only its own slice: its return type is that slice. It reads the others through `ctx.view`, which is the state after every earlier handler, and only through their `view.ts` selectors (lint, section 1).
- Modules talk only through messages, which are plain data. The order is fixed, so the same input always gives the same output.
- A step that would handle more than 10,000 messages is a `CoreFault` (a loop). With `deps.deepFreeze`, the state is deep-frozen after every step, so a mutation fails at once.
- `records` was added because the audit module runs last, yet every module names a record's sequence number when it makes it (a decision names the packet that caused it). The cursor starts at the boot's first number on the boot input and at the audit slice's next one otherwise; modules send their records to audit as `auditRecord` messages, and audit applies the warning cap and passes them on as `record` effects. `event` was added because every `CoreFault` must name the input's kind (section 10).

| Order | Module | Owns | Messages it acts on (it sees every one) | Emits |
| --- | --- | --- | --- | --- |
| 1 | `clock` | boot id, last `now`, wall trust, downtime estimate | `boot`, every input | `wallTrustChanged`, `downtimeKnown` |
| 2 | `registry` | devices: address, role, name, chip, firmware, state (provisioning, paired, contacted, reset, removed, left behind) | `deviceAdded`, `provisionAnswered`, `deviceRemoved`, `deviceLeftBehind`, firmware from Started | device rows, written now |
| 3 | `links` | link table: kind, label, what it carries | `linkOpened`, `linkClosed`, `frame` | `setupFrame`, `gatewayPacket`, `devicePacket` |
| 4 | `setup` | USB identify and provision exchanges, auto-add (D100) | `setupFrame`, setup commands | setup frames, `deviceAdded` |
| 5 | `control` | commands waiting for answers | `command`, `answer`, `inputRejected` from the control socket | the command's `commands` record first, then a request message carrying that record's number, the request id and the actor; `respond` |
| 6 | `gateways` | sessions, gateway counters, settings, clock mapping, transmit requests in flight, status, noise baseline, silence | `gatewayPacket`, `radioOut`, `siteMove`, timers | `devicePacket`, `radioResult` (with the transmit request's gateway counter, so the packet's `tx` row can carry it), `gatewayUp`, `gatewayDown` |
| 7 | `intake` | replay windows, copies seen | `devicePacket` | `accepted` (marked `newest` when its counter is the highest), `rejected` (a duplicate copy through a gateway carries the copy's gateway and signal, for a siren's best gateway) |
| 8 | `alarm` | armed state per sensor, countdowns, the alarm, what each siren should do | `accepted` (sensor status), arm and disarm, timers, `downtimeKnown` | `armedChanged`, `countdownCancelled`, `sirenIntent`, rows written now |
| 9 | `site` | the site's channel and rate; a move in progress: stage, target, confirmations, followers (section 8) | `accepted` (the settings version and the channel and rate a packet arrived on), site commands, `downtimeKnown`, timers | `siteMove` (read by sensors, gateways and sirens through its view), rows written now |
| 10 | `sensors` | sensor settings and versions, reply rates, sensor counters, silence | `accepted`, `armedChanged`, `countdownCancelled`, `radioResult` | `radioOut` (replies, notices) |
| 11 | `slots` | slot plan, clock samples and corrections | `accepted` (heartbeats, Started), `deviceAdded` | slot and correction values read by `sensors` |
| 12 | `sirens` | siren settings and versions, siren counters, desired and reported state, command in flight, Wi-Fi link, best gateway, silence | `accepted` (siren packets), `sirenIntent`, `gatewayUp`, timers | sends on Wi-Fi, `radioOut` |
| 13 | `audit` | record sequence, rejection minute counts, the warning cap, retention timers | `auditRecord`, `rejected`, `inputRejected`, timers | `record` effects; retention's `PruneOp` writes |

`site` runs before `sensors`, so a reply is built with the move's current stage. `slots` runs after `sensors` in the table, yet a reply needs the slot. So `sensors` asks the `slots` view for the next heartbeat when it builds a reply, and `slots` updates its estimates from the same `accepted` message afterwards. The value used is the one from before this packet; that is deliberate, because a slot is always planned from earlier arrivals.

Records get their sequence numbers from the core: `seq = bootId × 2³² + n`, through `ctx.records`. It is the record's row id, so a decision can name the packet that caused it before either is written, row ids grow with time across restarts, and retention deletes by row-id range (section 6).

## 3. Ports

The interfaces between the core and the world. All are implemented in `hub/src/shell/`; tests have a fake for each.

| Port | Interface | Blocking | Ordering | On failure |
| --- | --- | --- | --- | --- |
| `Clock` | `now(): Now` | No, never fails | `mono` never goes back; the core treats a smaller one as a `CoreFault` | — |
| `TimeTrust` | `wallTrusted(): boolean`, refreshed in the background (section 5) | No; returns the cached answer | — | Probe failure: stays untrusted, recorded once |
| `Random` | `bytes(32): Result<Uint8Array>` from `crypto.getRandomValues` | No | — | Fatal: the hub stops (section 10), because it cannot make keys or welcomes |
| `KeyStore` | `key(device): Uint8Array \| undefined` from memory; loaded from the database at start; `applyCommitted(ops)` applies the `device_keys` writes of a commit after it succeeded | No | — | A missing key is an unknown device to the core |
| `DeviceCipher` | `seal(device, message, {direction, address, counter, binding, maxLength}): Result<Uint8Array, HubError>` and `open(device, packet, {binding, maxLength}): Result<OpenedPacket, OpenFailure>` | No; pure | — | `seal` errors are programmer errors in the core (`sealPacket` throws `RangeError`; the shell wraps it); the core turns them into a `CoreFault`, since only it knows the input's kind. `OpenFailure` carries the protocol error and, when the tag verified but the body did not decode, the plaintext |
| `Links` | Emits `linkOpened`, `linkClosed`, `frame` and `inputRejected` (a frame COBS refused) inputs; `send(link, bytes, ref): Result<void, LinkError>`; `close(link, reason)`, whose `linkClosed` follows | `send` queues and returns at once | Frames from one link reach the core in arrival order; sends to one link leave in effect order | A failure `send` can see at once (closed link, a queue past 64 frames, back-pressure, a dropped message) is its `Err`, which the loop gives the core as `sendFailed` with `ref`; a write that fails later is emitted as `sendFailed` with the same `ref`, and closes the link |
| `Writer` | `stage(items)`, `flush(reason): Result<CommitInfo, StorageError>`, `due(now): Mono \| undefined`, `setCadence(everyMs)` (the core's `cadence` effect), `durable(device)` (the highest committed resume point, for the send gate). The loop's writer adds `flushIfDue(now)`, `takeOutcome()` and `maintain()` (checkpoints and `PRAGMA optimize`, after the sends) | `flush` blocks for one SQLite commit (bun:sqlite is synchronous) | Items are applied in staging order; a flush is one transaction with the commit mark | Nothing is half-written; the items stay staged and the core gets `commit {failed}` (section 4) |
| `Reader` | `snapshot(): Result<DurableSnapshot>` at start; `query(q)` for `hsn log` only | Synchronous, on the writer's connection, after a flush | Sees everything committed | `Err` to the caller, recorded |
| `Control` | Emits `command` and `inputRejected` inputs; `respond(request, reply)`; `stream(subscriber, record)` for `--follow` | No | One request at a time per client connection; streamed records in the order the core made them | A malformed line is answered with an error and recorded through `inputRejected` |
| `Advertiser` | `advertise(identity, port)`, `stop()` | No | — | Recorded; Wi-Fi devices cannot find the hub until it works (§10) |

Notes:

- **Serial links.** The protocol's `UsbFrameDecoder` and `encodeUsbFrame` (§10) over a port opened as a terminal and read through Node's `node:tty`. `serialport` lists ports, but its native add-on crashes Bun 1.4.2 the moment it opens one (O18); a USB CDC port and a pseudo-terminal are both terminals, so `node:tty` serves both, on macOS and Linux.
  - **Byte-clean.** Node's `setRawMode(true)` leaves output processing on (each 0x0A written leaves as 0x0D 0x0A), so the hub does not use it. Before the first read it sets the terminal through the C library (`tcgetattr`, `cfmakeraw`, `tcsetattr` with `TCSAFLUSH`, by `bun:ffi`), then reads it back and refuses the port if anything is left on: input IGNBRK BRKINT PARMRK ISTRIP INLCR IGNCR ICRNL IXON IXOFF IXANY INPCK off; OPOST off; ECHO ECHONL ICANON ISIG IEXTEN off; CS8 CREAD CLOCAL on, PARENB and CRTSCTS off; VMIN 1, VTIME 0. `TCSAFLUSH` discards what arrived while the terminal was still as it was opened, so plugging a board in never costs a rejected frame. `struct termios` is laid out for macOS and Linux.
  - **macOS names.** Each port has a `/dev/tty.X` name, whose open waits for a modem's carrier (on the hub's only thread), and a `/dev/cu.X` one, which opens at once. A listed `tty.` port is opened by its `cu.` name; a `--serial` path is opened as given, so give the `cu.` name.
  - **Closing.** Under Bun 1.4.2 a destroyed `tty.ReadStream` keeps its descriptor until the read it holds returns, at the board's next byte, and that waiting read would take the first bytes meant for the next opener; closing the descriptor under it blocks the process on macOS, and on Linux leaves the read alive and lets the stream close a reused descriptor number later. So the hub makes the waiting read return before destroying the stream, which then closes the descriptor itself: on macOS by setting VMIN 0 and VTIME 0 (the read re-reads them); on Linux, where a read keeps the VMIN it began with, by making the open file non-blocking (`fcntl`, O_NONBLOCK) and then setting the terminal, which wakes the read into EAGAIN. The board sees the host go at once. `hub/test/linux/serial.sh` (`bun run check:serial-linux`) runs the serial tests in Bun's Debian image.
- **WebSocket links.** Hono on `Bun.serve`, path `/device`, port 8443 ‡ by default, binary messages only, one packet per message (§10). A message over 1,024 bytes (§3) is passed on and refused by the core as `tooLong`. A text message closes the socket with code 1003, counted by the core as a `textFrame` rejection. Bun answers the siren's pings. A socket idle for 60 s ‡ is closed. Bun's `send` reports back-pressure and drops; both become `sendFailed`.
- **`DeviceCipher`** is a thin wrapper over the protocol's `sealPacket` and `openPacket` with keys from `KeyStore`. The shell keys one AES block cipher per device once and passes it in their `cipher` option, which is also the D94 seam; without it they would build one per packet.
- **The writer** is the only code that touches the database while the hub runs. It is called only from the loop, at the points of section 4. If a Pi's commit times turn out too long for the event loop (budget, section 5), it moves to a worker thread behind the same interface.
- **Reads never defeat the batching.** Anything live (`hsn status`, the bench's questions in lockstep) is answered by the core from its state in memory, through the `control` module, with no database access. Only `hsn log`, which a person asked for, flushes and then reads. `hsn log --follow` streams the `record` effects as the loop stages them and never polls the database.

## 4. The order of persistence and sending

### The rule

**Nothing leaves the hub, and no command is answered, until every item written "now" that justified it has been committed.** A routine item never holds anything back.

One turn of the loop:

1. Take the waiting inputs, at most 64, in arrival order. Run `step` on each in turn; a `CoreFault` leaves the state as it was for that input and is recorded (section 10).
2. Stage every `write` and `record` effect of the turn with the writer, in order.
3. If any staged item is `now`, flush now: one transaction holding everything staged, "now" and routine alike, committed with `synchronous = FULL`. Otherwise flush only when the writer is due (section 5).
4. Perform the turn's `send`, `close` and `respond` effects in order, each `send` through the **send gate**.
5. Set the system timer to the earliest of the core's `wake` and the writer's flush deadline.

In the code (`shell/loop.ts`) step 2 also hands each `record` to the control socket as it is staged, for `--follow`; step 3 asks the writer whether a flush is due (`flushIfDue`), which is at once when anything "now" was staged; the writer's outcome, a failure or a recovery, becomes the core's next `commit` input; and step 5 first runs the writer's upkeep (`maintain`: a checkpoint a "now" commit put off, and the daily `PRAGMA optimize`). While the turn's "now" commit failed, its sends are held back by the gate and its answers wait until a commit succeeds.

**The send gate.** The writer keeps the highest committed resume point per device key, `durable[device]` (`shell/storage/send-gate.ts`, `admitSend`). A `send` goes only if every one of its `counters` is below `durable` for that key. Otherwise it is held back and the core gets `sendFailed {notDurable}`. The gate turns "a counter is never reused" from a convention into a check the shell makes on every packet, whatever the core does.

### Counters, precisely

- The hub's counters follow §4: one per device key, direction from the hub, starting at 1, with resume points every 1,024. They are `SendCounter`s from the protocol package, held in the slice of the module that owns the key.
- At pairing the device row, its key and a resume point of 1,024 are written through in one transaction (section 9), so counters 1 to 1,023 are usable at once.
- When `takeSendCounter` gives a counter that is a multiple of 1,024, it asks for `counter + 1,024` to be saved. The module emits that as a `now` write in the same step as the `send`. Step 3 commits it, and the gate then lets the send pass.
- If that commit fails, the gate holds the packet back. The core re-emits the current resume point of every key whose durable value is behind its own on the next step, and every module retries what it was sending as usual: a siren command at its next repeat (2 s), a heartbeat reply never (the sensor's next link check covers it), an event reply never (the sensor's retry covers it). Meanwhile every key keeps sending with the counters below its durable resume point, up to 1,023 packets each. So a broken disk stops the siren path only after a siren has used 1,023 more packets, which at one command a second is 17 minutes, longer than any alarm.
- A packet may be sealed and never sent (a turn's sends are dropped after a crash). That only skips its counter, which §4 allows.
- The disarmed notice and siren command repeats are sealed once and sent many times: the same bytes carry the same counter, which is safe (identical plaintext under an identical nonce reveals nothing new). Each LoRa repeat travels in a new transmit request, so the gateway's packet takes a new gateway counter each time.

### What a crash leaves behind

"Process crash" means the hub dies but the computer keeps running: everything committed survives. "Power cut" means the computer stops: everything committed with a full sync survives, which is every commit here (section 5).

| Crash point | Left behind | Why it is safe |
| --- | --- | --- |
| During `step` (a `CoreFault` or worse) | The previous state in memory; nothing staged from this input | The input is lost. A device packet's sender retries or reports again; a command gets no answer and the CLI says so. |
| After staging, before the flush | Committed state as of the last flush; up to five minutes of routine items lost (one second while a countdown or the alarm runs), and no item written "now", because those are flushed before step 4 | Nothing that depended on a "now" item was sent. The routine loss is recorded at the next start (section 10). |
| During the commit | SQLite rolls the transaction back on the next open | As the row above: nothing was sent. |
| After the commit, before the sends | Everything committed, nothing sent | Counters were saved but not used: skipped, never reused. A countdown is saved but its reply never went: the sensor gets no answer, retries (§7), and its retry is answered "countdown started" from the restored countdown. If the hub stays down, nothing sounds until it is back (D113's accepted limit, below). |
| After the sends, before the next routine commit | Packets sent; up to five minutes of routine records, readings and estimates lost, with the replay windows of routine packets | The protocol accepts this (§4, "Known limits"). Section 5 states what replaying each routine packet can do; no event report can be replayed. |
| During a checkpoint | The WAL is still complete; the checkpoint runs again on the next open | SQLite's own guarantee. |

Section 11 tests every row of this table.

## 5. Durability and efficiency (D112, HB35)

### Durability classes

Two kinds of item, as D112 has them. **Now**: committed at once with a full sync, and nothing that depends on it is sent or answered before the commit. **Routine**: held in memory and committed every five minutes, or sooner (below). A flush always takes everything staged, so routine items also reach the disk with every "now" commit.

| State | Class | Why | What a power cut loses | Why that is safe |
| --- | --- | --- | --- | --- |
| Hub sending counters' resume points, per device key | Now | A reused counter breaks the encryption (§3, §4) | Nothing used: the counter is committed before the packet goes (section 4) | — |
| Countdowns: sensor, opening, deadline, newest report counter, the reply's gateway and rate (D80, HB30) | Now, before the reply that says "countdown started" | A crash during a countdown must not cancel the alarm (D80) | Nothing acted on | — |
| The alarm: triggers, what each siren should do and until when (D80, D95) | Now, before any siren command | As above, and so a restart does not re-trigger (D80) | Nothing acted on | — |
| Armed state per sensor, including "waits for the door to close" (D50, D67, D74) | Now, before the CLI is told and before any reply carries it | A house that comes back from a power cut disarmed is a failure no later packet corrects | Nothing acknowledged | — |
| Settings and settings versions of every device, the clock correction included (§6), with the reply rate of recent versions; each sensor's slot phase | Now, together with the change | A lost version would be reused for different settings, and a sensor holding the reused number would never be updated (§6, D72). A lost phase would be planned again differently while the sensor keeps the old one | Nothing acknowledged | — |
| A site move (D115): its stage, target channel and rate, who asked, whether forced, the switch time; each sensor's next settings with the version that carries them, its confirmation and its first packet on the new settings; the gateways' and sirens' new settings | Now, before any reply announces it, before any gateway or siren is switched, and as each sensor confirms or follows | A restart must resume the move at its stage, never announce settings it then forgets, and never switch twice | Nothing acted on | — |
| Device registry, keys, pairing data, hub signing key, site settings (channel, rate, Wi-Fi details), house settings | Now, before the Provision message or the CLI answer | A device must never hold a key the hub has forgotten (PR2) | Nothing acknowledged | — |
| The highest counter accepted in a gateway's hello | Now, when the hello is accepted (a few a day) | §4: a hello must carry a counter above any accepted from that gateway; a lost value would let a recorded hello be replayed after a power cut | Nothing | — |
| Every accepted door, cover, button and Started report, with what it changed: its record, its device's replay window and reading, its decisions (D112) | Now, before its reply | A replayed event report is not corrected by the next real one (below) | Nothing | — |
| Every record at warning level or above: decisions, hub events, device log entries (D112), at most 60 an hour per source ‡; beyond that counted into the routine batch, with one warning that the cap was reached | Now | A warning is what someone will look for after an incident. The cap stops a faulty device's warnings from committing every second and wearing out the card | Nothing within the cap | — |
| Boot record and clean-stop mark | Now, at start and at a clean stop | Tells the next start how the last run ended (HB34) | — | — |
| Commit mark: boot, `mono`, wall time and its trust at this commit | In every commit | How long the hub was down is measured from it (below) | — | — |
| Routine packet records: heartbeats, regular siren reports and checks, siren answers, gateway statuses, replies and other packets sent (D110, HB15) | Routine | Volume (budget) | Up to five minutes | Bounded, and recorded at the next start: "records after `t` may be missing" |
| Info and debug records: decisions below warning, hub events, device log entries, commands' records beyond their effect, rejection counts | Routine | Volume | Up to five minutes | As above. A command's effect (arming, settings) is a "now" item; its record may be lost |
| Device readings and last-seen state (battery, temperature, flags, signal, best gateway, door state, each gateway's last uptime) | Routine | Volume | Up to five minutes | Every reading is repeated by the device's next packet |
| Replay windows of routine packets | Routine (§4) | Volume | The windows of routine packets accepted since the last commit | What replaying each can do is below |
| Estimates: clock samples, reply-rate margins, loss counts (D107, D108), noise baselines | Routine | Rebuilt from arrivals | Up to five minutes of samples | Estimates converge again |
| Gateway sessions, siren commands in flight, transmit requests in flight, best gateway, link table, rejection counts of the current minute | Memory | Rebuilt after any restart: gateways send a new hello, sirens are asked to report (§7 "Hub restart"), counts restart | All | Rebuilt within a minute; the restart is recorded |

**What replaying a routine packet up to five minutes later can do.** After a power cut the hub has forgotten the routine packets it accepted since its last commit, and someone who recorded them could replay each once (§4, "Known limits"). For each kind:

| Packet | What a replay could do | What stops it doing more |
| --- | --- | --- |
| Heartbeat | Show an old door state, change count, battery or settings version; draw one reply, bound to the old counter, which the sensor ignores (§4) and which costs one reply's airtime | **A heartbeat never starts a countdown, sounds a siren or changes a sensor's arming state.** A heartbeat whose door state or change count the hub did not expect gives a recorded warning (and, while armed, a critical notice in M2), nothing more (section 8). Readings change only on a packet with the highest counter accepted from that device. A replayed heartbeat never makes a clock sample (section 8) |
| Regular siren report, LoRa check, siren answer (reasons 0, 1, 2) | Show an old state; keep a path looking alive for one more interval; arrive on a WebSocket the siren does not use | The siren correction rule (section 8) acts only on the highest-counter report; a replay cannot confirm a command sent after the start, because its "last counter acted on" names an older one; commands on Wi-Fi go to every socket that carried an accepted packet from the siren in the last 60 s ‡, so a replay on a stranger's socket cannot steer them away from the siren's own |
| Siren report, reason 3 (Wi-Fi report failed) | — | It raises a warning, so it is committed "now" and cannot be replayed |
| A siren's info log entries over Wi-Fi | A duplicate record | Marked `repeat_of`, as for sensors (section 8) |
| Gateway status, interference, transmit result, gateway log entries | — | Bound to the session (§4), so they cannot enter a new one; a replayed hello is refused, its counter being committed "now" |
| Door, cover, button, Started | — | Committed "now" before they are answered, so never replayable |

So no routine replay can start a countdown, sound or silence a siren, change arming, confirm a command or take over a link. The worst it does is show stale readings until the device's first real packet after the start, draw one wasted reply, or delay a "path lost" warning by one interval.

**Why event reports cannot wait.** A replayed **door changed** report carries an age counted from when it was first sent, so the hub would date the opening to the replay and, if armed, start a countdown and sound the sirens: a false alarm made from a recording. A replayed **cover changed** report would raise a false tamper alert (D9), and a **button** report with action 4, "factory reset going ahead" (§6), would make the hub believe a working sensor had erased itself. Committing them "now" costs one commit per event, about 20 a day per sensor, and lengthens the event reply by one commit, a few milliseconds to tens on a memory card, inside the 1.5 s listen time at SF7 †.

### The commit mechanism

- **One writer.** The shell's `Writer` owns the only database connection while the hub runs. Nothing else reads the database while the hub runs, except `hsn log` through the writer's connection after a flush (section 3).
- **Staged items.** Inserts are kept in order. Upserts are kept by row, so a device reading updated ten times in five minutes is written once.
- **The writer flushes:**
  - at once, when an item marked "now" is staged (section 4, step 3);
  - five minutes after the first routine item entered an empty batch (D112);
  - when it holds 2,000 items or 512 KB ‡, whichever comes first; five minutes of home B hold about 150 (budget);
  - at least once a second while a countdown or the alarm runs (the core's `cadence` effect), even with only the commit mark to write, so that a restart knows the time left to within a second (below);
  - when `hsn log` asks;
  - at a clean stop, then writes the clean-stop mark.
  With nothing staged and nothing running, nothing is written.
- **A failed flush** keeps the batch staged, sends the core `commit {failed}`, and retries after 1, 2, 4, then every 10 s ‡. The core records the failure as a critical hub event, which reaches the database when a flush next succeeds and `fatal.log` at once (section 10). A batch that passes 10,000 items while the database is failing drops its oldest records; the writer has no record sequence of its own, so the count goes in the `commit {failed}` outcome's message, which the audit module records.
- **The commit mark** is the hub's own row in `device_state` (device 0), written in every commit. It shares a page with the device rows that most commits touch anyway.

### SQLite settings

| Setting | Value | Reason |
| --- | --- | --- |
| `journal_mode` | `WAL` | A commit appends to one file and syncs it once; a rollback journal syncs two or three files per commit. |
| `synchronous` | `FULL` for every commit | With `NORMAL`, WAL commits survive a process crash but not a power cut until the next checkpoint, so a "now" item could be lost after the hub acted on it. The two kinds differ in **when** they commit, not in how. |
| `fullfsync`, `checkpoint_fullfsync` | `ON` on macOS only | macOS's ordinary `fsync` does not reach the disk; Linux's does. |
| `wal_autocheckpoint` | `0`; the writer checkpoints itself (`PASSIVE`) after a commit once the WAL holds 1,000 pages ‡ or an hour has passed ‡, never before a send that waits on a "now" item | A checkpoint writes each changed page to the main file once, however often it changed, so rare checkpoints save main-file writes. |
| `journal_size_limit` | 8 MB ‡ | The WAL file is reused, not truncated and regrown, so the file system does not log its size changing at every checkpoint. |
| `page_size` | 4,096, set before the first table | The file system's block and the memory card's write unit; a smaller page would not make a smaller physical write. |
| `cache_size` | −4,096 (4 MB) | The hot set is a few hundred pages: device state, the tails of the audit tables, the configuration. |
| `temp_store` | `MEMORY` | No temporary files on the card. |
| `mmap_size` | 0 | Reads are rare; mapped pages would only blur the memory budget. |
| `auto_vacuum` | `NONE` | Retention frees pages that new rows reuse, so the file reaches a steady size; vacuuming would only add writes. |
| `max_page_count` | 61,440 (240 MB) ‡ | The size guard's hard stop (section 6). |
| `foreign_keys` | `ON` | Configuration integrity; audit tables have no foreign keys, so the hot path pays nothing. |
| `busy_timeout` | 0 | One connection: any `SQLITE_BUSY` is a fault to record, not to wait out. |
| `PRAGMA optimize` | daily, after a commit | Keeps the planner's statistics current at no regular cost. |

The hot inserts and upserts use prepared `bun:sqlite` statements made once at start. Drizzle defines the schema, generates migrations and serves the reads.

### Budget

Two homes, each with one Wi-Fi gateway: **A**, 10 sensors and 4 sirens; **B**, 30 sensors and 4 sirens. Packet counts come from the load tests and FD 5: a sensor sends about 500 packets a day (480 heartbeats at 3 minutes, about 20 door events and their retries, a few log entries); a siren reports 2,880 times a day on Wi-Fi and 288 LoRa checks; a gateway sends 2,880 statuses. The hub sends each sensor a link-check reply on every 5th heartbeat (96), about 20 event replies and a few version replies: about 120 a day. The day also holds two countdowns of 30 s (leaving and coming home, each disarmed in time) and no alarm.

**Records a day.**

| | A | B |
| --- | --- | --- |
| Packets in: sensors | 10 × 500 = 5,000 | 30 × 500 = 15,000 |
| Packets in: sirens | 4 × 3,168 = 12,672 | 12,672 |
| Packets in: gateway status | 2,880 | 2,880 |
| Packets out (replies, notices, settings) | 10 × 120 = 1,200 | 3,600 |
| Decisions, logs, commands | about 50 | about 100 |
| **Total** | **≈ 21,800** | **≈ 34,300** |

**Commits a day.**

| Cause | A | B |
| --- | --- | --- |
| Routine flushes, one every five minutes | 288 | 288 |
| Door, cover and button reports: 20 a sensor | 200 | 600 |
| Warnings and worse (assumed) | 20 | 30 |
| Settings and arming: 4 arm or disarm, about one version change a sensor while estimates settle, resume points (a sensor key every 1,024 ÷ 120 ≈ 8.5 days, the gateway's every 1,024 ÷ 1,300 ≈ 0.8 days) | 15 | 40 |
| Once a second during two 30-second countdowns | 60 | 60 |
| **Total** | **≈ 580** | **≈ 1,020** |

The routine flushes are an upper bound: an event commit empties the batch, so the next five minutes start later. An alarm adds a commit a second for its five minutes, 300 commits.

**Bytes written a day.** A commit writes in full every page it changed, plus a 24-byte frame header. A routine flush or an event commit changes the tails of the tables it adds to (routine packets, sent packets, event packets, decisions: 3 to 4 pages) and device state with the commit mark (1 to 2 pages): about 5 pages, 20 KB. A once-a-second commit during a countdown changes about 1.5 pages, 6 KB; a warning commit about 2.5, 10 KB. The rows themselves fill new pages once each: about 60 bytes a row (section 6).

- A: 288 × 18 KB + 200 × 18 KB ≈ 8.8 MB; 60 × 6 KB + 35 × 10 KB ≈ 0.7 MB; new pages 21,800 × 60 B ≈ 1.3 MB; checkpoints about 1.5 MB; retention about 0.6 MB. **≈ 13 MB a day.**
- B: 288 × 22 KB + 600 × 21 KB ≈ 19 MB; 60 × 6 KB + 70 × 10 KB ≈ 1.1 MB; new pages 34,300 × 60 B ≈ 2.1 MB; checkpoints about 2.5 MB; retention about 1 MB. **≈ 26 MB a day.**

That is about 5 and 9 GB a year as the operating system counts it, against the 60 to 85 GB that one-second batches would have written. A 32 GB card rated for even 500 erase cycles takes about 16 TB. Cards amplify small synced writes by a factor nobody publishes, which is why the figure is measured on a real Pi (`/proc/diskstats`, sectors written), not assumed.

**Database size at D57's retention** (routine readings 30 days, events a year). A packet row is about 60 bytes with SQLite's overhead (section 6), about 68 to a page.

| | A | B |
| --- | --- | --- |
| Routine rows a day (heartbeats, siren reports, statuses, link-check replies) | 21,330 | 32,890 |
| Kept 30 days | 640,000 rows ≈ 38 MB | 987,000 rows ≈ 59 MB |
| Event rows a day (door, cover, button, Started, their replies, decisions, logs, commands) | ≈ 450 | ≈ 1,300 |
| Kept a year | 166,000 rows ≈ 10 MB | 475,000 rows ≈ 29 MB |
| Configuration, device state, rejection counts | < 2 MB | < 2 MB |
| **Total, plus a WAL of at most 8 MB** | **≈ 50 MB** | **≈ 90 MB** |

**Measured on the real core.** The write-budget test (section 11) runs a simulated day of each home on the whole hub: every real module, the loop of section 4, the real writer on a real SQLite file, scripted gateways, sensors and sirens, with section 5's traffic (about 20 door changes a day per sensor, two disarmed countdowns, one gateway). Measured on a Mac with Bun 1.4.2 on 2026-11-13:

| | A | A with an alarm | B | B with an alarm |
| --- | --- | --- | --- | --- |
| Commits a day | 510 (244 now, 232 routine, 34 cadence) | 841 (250 now, 230 routine, 361 cadence) | 926 (689 now, 203 routine, 34 cadence) | 1,258 (695 now, 202 routine, 361 cadence) |
| WAL frames written (4,096 + 24 bytes each) | 4,022 = 15.8 MB | 4,467 = 17.6 MB | 7,070 = 27.8 MB | 7,613 = 29.9 MB |
| Rows a day, routine (`rx_routine`, `tx_routine`, `rejects`) | 20,733 (19,807; 926; 0) | 20,730 | 32,660 (29,900; 2,760; 0) | 32,638 |
| Rows a day, event (`rx_event`, `tx_event`, `decisions`, `device_log`, `hub_events`, `commands`) | 903 (238; 263; 377; 20; 1; 4) | 953 | 2,541 (662; 757; 1,087; 30; 1; 4) | 2,631 |
| File at D57's retention, projected | 61 MB | 62 MB | 106 MB | 107 MB |
| Estimate above | 580 commits, 13 MB, 50 MB | +300 commits | 1,020 commits, 26 MB, 90 MB | +300 commits |

The measured commits sit below the estimate because an event commit also carries the routine batch, so routine flushes fall from 288 to 232 and 203; the event commits match the estimate's door reports. The measured megabytes count WAL frames only, not checkpoints or retention, which the estimate adds; they are higher than the estimate's commit bytes because event rows are more numerous than assumed (about three decisions and replies per door change). The file projection takes each table's measured bytes per row (SQLite's `dbstat`), times the day's rows, times its retention, plus the other tables and an 8 MB WAL; it is higher than the estimate for the same reason.

**The whole budget, to measure on a Raspberry Pi 4 before release** (HB35). Each line has a test or a measurement in section 11.

| Item | Budget A | Budget B | Estimate and its basis |
| --- | --- | --- | --- |
| Resident memory, steady, after 24 h | ≤ 90 MB ‡ | ≤ 100 MB ‡ | S1 measured 26–29 MB at rest and 45–55 MB busy for a hub skeleton on Linux arm64 in Docker, not on a Pi. The core's state is a few kilobytes per device; five minutes of staged items are about 150, well under 1 MB; SQLite's cache is 4 MB |
| Resident memory, peak (30-door burst) | ≤ 150 MB ‡ | ≤ 150 MB ‡ | |
| Processor time per accepted forwarded packet, with its reply and records, without the commit | ≤ 1 ms at the 99th percentile ‡ | | Two openings and two sealings at tens of microseconds each, the step and the staging: about 0.5 ms |
| Commit time, full sync | ≤ 30 ms at the 99th percentile ‡ | | Depends on the card; it lengthens an event reply, and decides whether the writer moves to a worker (section 3) |
| Processor time a day | ≤ 60 s | ≤ 90 s | B: about 36,000 packets × 1 ms + commits |
| Idle processor load | ≤ 0.5% of one core ‡ | | No polling: the hub wakes only for inputs and deadlines |
| Commits a day | ≤ 800 ‡ | ≤ 1,400 ‡ | Estimated 580 and 1,020; measured 510 and 926 (above) |
| Bytes written a day | ≤ 20 MB ‡ | ≤ 35 MB ‡ | Estimated 13 and 26 MB; measured 15.8 and 27.8 MB of WAL frames |
| Database size at D57 | ≤ 70 MB | ≤ 120 MB | Estimated 50 and 90 MB; projected from the measured day 61 and 106 MB |
| Everything in the data folder, any site | ≤ 500 MB | | The product owner's ceiling (D112): what a Pi handles comfortably. Held by the size guard (section 6); see below |

**Against the 500 MB ceiling.** The two homes use about an eighth and a fifth of it. The largest site the protocol allows (64 sensors, taken here with 8 sirens and 3 gateways) was calculated at about 205 MB (71,000 routine rows a day kept 30 days and 5,400 event rows a day kept a year, at home B's 50 bytes a row) and then projected from a measured day at 197 MB, 205 MB with the WAL. The copy made before a migration (section 6) doubles the database for as long as it is kept, so the largest site would then stand at about 400 MB. The homes' own budgets of 70 and 120 MB stay as they are: they are what the write-budget test fails on, so that a change which doubles the records is noticed long before the ceiling. Retention by age alone would not hold the ceiling, so the size guard of section 6 holds the database under 240 MB by deleting the oldest history first; the largest site at D57's retention stays under its mark, so the guard acts only on a longer retention or a faulty device.

### Raspberry Pi

- **Which Pi.** Bun runs only on 64-bit ARM, so the Pi needs a 64-bit system: Pi 3, 4, 5 or Zero 2 W (D112). The Pi 4 and 5 are the targets. The Zero 2 W's 512 MB is enough for the budget above but leaves little room and is not a target.
- **The clock.** A Pi 4 has no battery-backed clock. After a power cut it starts with the time it last saved, or none, until the network sets it, which may take minutes or, with the internet down, never.
  - The core's timers run on `mono` only, so nothing waits on the wall clock (section 2).
  - `TimeTrust` says whether the wall clock is set. On Linux it is set when systemd's time service reports it synchronised (`/run/systemd/timesync/synchronized`, or `timedatectl show -p NTPSynchronized`); the shell checks every 10 s until it is, then every hour. On macOS and Windows, which have a battery-backed clock, it is trusted. On every system it is untrusted while it reads earlier than the hub's build time or than the last commit mark.
  - Every audit row says whether its wall time was trusted (section 6). When the clock becomes trusted, the hub records the step between the two readings in the boot record, so the rows before it can be shown corrected.
- **How long was the hub down?** The restart rule of D80 needs it. The hub knows it, in this order of preference:
  1. both the last commit mark's wall time and the wall clock now are trusted: their difference;
  2. otherwise, from a gateway that did not restart: its first status after the start gives its uptime, and the last status before the stop, saved with the commit mark, gave its uptime then; the difference, less the time between that status and the last commit, is the downtime, to within a second plus the status interval;
  3. otherwise it does not know.

  When no countdown or alarm was running, the last commit may be up to five minutes older than the stop, so the downtime is over-estimated by as much; nothing depends on it then. While one runs, commits come every second, so the time left is known to within a second.
- **What the hub does on a start where it cannot know how long it was down.**
  1. Every saved countdown resumes with the time it had left at the last commit, counted from the start. The alarm can come up to one countdown late (at most 255 s, 30 s by default), never early and never lost.
  2. A saved alarm: every siren is asked to report (§7 "Hub restart"). A siren that reports sounding is believed: its time left becomes what the alarm expects of it. A siren that reports off, or that sent Started after a power-on, is not commanded again, because sounding it might re-trigger an alarm that has ended (D80); the hub records a critical event that the alarm may have been cut short.
  3. The moment the downtime becomes known (the clock is set, or a gateway reports), every resumed countdown and the alarm are judged again as if they had been restored with it: a countdown that ran out while the hub was down sounds the sirens for what is left of their time, counted from when the countdown would have ended, or only records the alarm if even that has passed (D106's rule, used here for restarts); a siren that should still sound and reports off is commanded for what is left.
  4. Records written meanwhile say their wall time is untrusted.

  This is D113.
- **A hub or gateway that dies during a countdown.** Nothing sounds until the hub is back and resumes the countdown (D113, §7). A check-in by the sensor at the countdown's end was considered and turned down by the product owner, so this is an accepted limit; the sensor's own buzzer and alarm (DS6, D88) cover only a sensor that got no answer in the first place.
- **Power.** A Pi that loses power takes the hub and a gateway on its USB port with it. Sirens on their own supply keep sounding on their own timer (SR5), and an armed sensor that gets no answer sounds its own buzzer and alarm (DS6, D88). A gateway on Wi-Fi with its own supply keeps a second path and is also the downtime witness above; the installer should recommend one where the hub has no network time.
- **Storage.** The installer should warn about an ordinary memory card, as it warns about a laptop (HB21), and recommend a high-endurance card or a USB drive.
- **Processor.** The Pi 4's chip has no AES instructions; the cost in the budget assumes software AES, which is ample for 30-byte packets.
- **Unverified (from memory):** Raspberry Pi's system runs the Pi 5 with 16 KB memory pages by default, and some runtimes built for 4 KB pages fail there. Check Bun on it with the D94 checks.

## 6. The database

One file, `hub.db`, in the hub's data folder, readable only by the hub's account. Times are integers: `*_ms` is wall time in milliseconds, `*_mono` is microseconds on one boot's monotonic clock and always goes with a `boot` column. Packet bodies and device texts are stored as raw bytes, decoded by `@hsn/protocol` when shown. The only indexes are primary keys and the two unique keys on `devices`.

### Configuration and durable state (written now)

| Table | Columns | Key |
| --- | --- | --- |
| `devices` | `id`, `address`, `role`, `name`, `chip_id` blob, `firmware` (major·65,536 + minor·256 + patch), `development`, `state` (0 provisioning, 1 paired, 2 contacted, 3 reset by its owner, 4 removed, 5 left behind by a forced move: must be paired again), `added_ms`, `removed_ms` | `id`; unique `address`, unique `name`. Device 0 is the hub itself |
| `device_keys` | `device_id`, `key` blob(16) | `device_id`. Kept apart so no query of `devices` reads a key |
| `send_counters` | `device_id`, `resume_point` | `device_id` |
| `hub_keys` | `signing_private` (PKCS #8), `signing_public` blob(64), `identity` blob(8) | single row |
| `site` | `channel`, `rate_mask`, `move_id`, `move_stage` (0 none, 1 announcing, 2 switched, 3 done, 4 cancelled), `move_channel`, `move_rate`, `move_actor`, `move_requested_ms`, `move_forced`, `move_switched_boot`, `move_switched_mono`, `wifi_name` blob, `wifi_password` blob, `countdown_default_s`, `auto_stop_s`, `reply_power_dbm`, `siren_power_dbm`, `retention_routine_days`, `retention_event_days` | single row |
| `sensor_config` | `device_id`, `arm` (0 disarmed, 1 armed, 2 armed, waits for the door to close: open when armed, 3 armed, waits for it to close: after an alarm), `armed_boot`, `armed_mono`, `countdown_s`, `heartbeat_units`, `link_check_every`, `send_rate`, `reply_rate`, `reply_rate_fixed`, `correction_units`, `correction_fixed`, `next_channel`, `next_rate` (what its current version announces; 0xFF: that one stays as it is, both 0xFF: no move), `move_confirmed`, `move_followed` (the move id each happened for, 0 for none), `version`, `version_history` blob (the last 16 versions, 3 bytes each: version, reply rate, the move it announces or 0) | `device_id` |
| `siren_config` | `device_id`, `version`, `wifi_interval_s`, `lora_check_units`, `max_sound_s`, `send_rate`, `command_rate`, `site_channel` (§6, Siren settings), `version_history` blob | `device_id` |
| `gateway_config` | `device_id`, `version`, `status_interval_s`, `interference_db`, `interference_s`, `default_power_dbm`, `siren_power_dbm` | `device_id` |
| `countdowns` | `sensor_id`, `boot`, `opened_mono`, `deadline_mono`, `newest_counter`, `reply_gateway_id`, `reply_rate`, `cause_seq` | `sensor_id` |
| `alarm` | `boot`, `started_mono`, `cause_seq` | single row while an alarm runs |
| `alarm_triggers` | `sensor_id`, `kind` (countdown end, zero countdown, late report), `boot`, `at_mono` | `sensor_id` |
| `alarm_sirens` | `siren_id`, `boot`, `until_mono`, `commanded` | `siren_id` |
| `boots` | `id`, `started_ms`, `started_trusted`, `previous_exit`, `cause`, `clean_stop_ms`, `trusted_at_mono`, `clock_step_ms` | `id` |

All the move's columns are written now (section 5).

### Readings and estimates (routine)

| Table | Columns | Key |
| --- | --- | --- |
| `device_state` | `device_id`, `boot`, `last_seen_mono`, `last_seen_ms`, `window` blob(12) (`encodeReplayWindow`), `reading` blob (the latest status body, raw), `rssi`, `snr_q`, `best_gateway_id`, `uptime_s` (gateways), `estimates` blob (a format byte, then the role's estimates: slot phase, clock samples, margin statistics, noise baseline) | `device_id`. Device 0's row is the **commit mark**: `boot`, `last_seen_mono` and `last_seen_ms` of this commit, and whether the wall time was trusted |
| `loss_daily` | `device_id`, `day`, `received`, `expected` | (`device_id`, `day`), without row id. 30 days |

### The audit record (routine, except what section 5 writes now)

| Table | Columns | Rows | Kept |
| --- | --- | --- | --- |
| `rx_routine` | `seq`, `at_ms`, `clock_ok`, `device_id`, `type`, `counter`, `path` (0 LoRa through a gateway, 1 Wi-Fi, 2 USB), `gateway_id`, `gw_us`, `rssi`, `snr_q`, `rate`, `body` blob (decrypted, after the type byte) | heartbeats, regular siren reports and LoRa checks, gateway statuses | 30 days (D57) |
| `rx_event` | the same | everything else accepted: door, cover, button, Started, siren answers and change reports, hello, interference, packets of an unknown type | 1 year |
| `tx_routine` | `seq`, `at_ms`, `clock_ok`, `device_id`, `type`, `counter`, `path`, `gateway_id`, `request_counter`, `rate`, `power`, `outcome` (0 sent, 1 too late, 2 no airtime, 3 radio busy, 4 not valid, 5 no result, 6 handed to a link, 7 held back, 8 send failed), `gw_sent_us`, `body` blob | link-check replies | 30 days |
| `tx_event` | the same | every other packet to a device, one row per transmission, so each repeat of a siren command is a row | 1 year |
| `decisions` | `seq`, `at_ms`, `clock_ok`, `kind`, `device_id`, `cause_seq`, `value`, `detail` blob | every decision (section 8, `DecisionKind`) with the record that caused it | 1 year |
| `device_log` | `seq`, `at_ms`, `clock_ok`, `device_id`, `counter`, `made_ms`, `level`, `code`, `text` blob, `repeat_of` | every entry of every log entries packet (§6), repeats included | warning and above 1 year, the rest 30 days |
| `hub_events` | `seq`, `at_ms`, `clock_ok`, `level`, `origin`, `code`, `message`, `detail` | the hub's own errors, warnings and notices (HB34) | 1 year; debug 30 days |
| `commands` | `seq`, `at_ms`, `clock_ok`, `actor`, `kind`, `args`, `outcome`, `detail` | every control command and who sent it (AL8) | 1 year |
| `rejects` | `minute`, `via`, `reason`, `count`, `address`, `sample` blob(16) | one row per source and reason per minute (HB15): `via` is the gateway, or the link when no device is known; `address` and `sample` keep the first rejected packet's address and first 16 bytes | (`minute`, `via`, `reason`), without row id. 30 days |

Notes:

- `seq` is the core's record sequence (section 2), the table's row id. It grows with time, also across restarts,; a `CoreFault` is recorded by the core itself, from an `inputRejected` input, so it takes the next number too (section 10).
- `device_state` also has a `clock_ok` column, for the commit mark's trust. A gateway's row keeps the highest counter accepted in its hello in `window`, and that row is written now with each hello (section 8); section 6 had named no column for it.
- `loss_daily` and `rejects` are tables without row id. Drizzle cannot declare that, so the first migration's two `CREATE TABLE` statements end in `WITHOUT ROWID`, added after generation; a test checks it. The core's row types (`core/model/rows.ts`) have the same columns as `schema.ts`, which a test also checks.
- **Retention** is a `PruneOp` with a wall-time cutoff (`beforeMs`) and a limit, plus levels for `device_log` and `hub_events`. The writer finds the cutoff's `seq` inside the commit, by a binary search of `at_ms` (by `minute` for `rejects`), so the core needs no sequence number for it, and the op can be repeated after a failed commit.
- `at_ms` never decreases within a table: after the wall clock steps backwards, rows keep the last value until the clock passes it, and the step is in `boots`. With that, finding a time range is a binary search over `seq`, and no time index is needed.
- **Forwarded packets and transmit requests are not rows of their own.** The packet inside is the row, with the gateway's fields; the transmit result's outcome and the gateway's sent time are filled into the packet's `tx` row, which is written when the result arrives, or after its timeout as "no result" (section 8). This is also the reply-timing measurement O10 asks for: `gw_sent_us` against the answered packet's `gw_us`. **A reply's outcome is not a decision of its own:** the `reply`, `transmit_result`, `too_late` and `reply_skipped` the bench names are read from the packet's `tx` row, which is kept as long as the packet it answers (D57), instead of doubling every link check with a decision row. The `radioResult` message carries the transmit request's gateway counter for the row's `request_counter`. For lockstep, `benchActions(record)` (`core/model/bench-actions.ts`) rebuilds the bench's names from the records: a decision gives its kind; a LoRa `tx` row gives `transmit_result` when a gateway answered and `too_late` when it missed its moment; a heartbeat reply's row also gives `reply`, and `reply_skipped` when it did not go. They come when the outcome comes, where the bench names `reply` at the hand-over, so a lockstep check compares them by packet, not by instant.
- A row is about 60 bytes with SQLite's overhead: a record header of 14 bytes, a 6-byte row id, about 8 bytes of times, about 12 of small integers, a 7- to 16-byte body and 4 bytes of cell overhead. That is the figure section 5 uses.

Named queries and how each is served:

| Query | Served by |
| --- | --- |
| A device's history over a time range (`hsn log --device`) | Binary search of `seq` by `at_ms`, then a scan filtered by `device_id`: a day of home B is about 33,000 rows |
| The newest records (`hsn log`) | `seq` descending, with a limit |
| What one alarm decided | `decisions` from the alarm's `cause_seq` onwards |
| Rejection counts | `rejects`' key |
| Loss over 7 days (D107) | `loss_daily`'s key |
| Restoring at start | full reads of the configuration tables, `device_state`, `countdowns` and the alarm tables, all small |

### Retention

Every 10 minutes ‡, while the wall clock is trusted, the audit module finds in each table the first `seq` whose `at_ms` is inside its retention and deletes up to 2,000 ‡ rows below it, inside the next routine commit. A day of home B is about 33,000 routine rows, so 144 rounds a day have room to spare (retention does not force a commit of its own) and no round frees more than a few dozen pages. `device_log` and `hub_events` delete their lower levels by `seq` range and level. Retention never runs on an untrusted clock, which could be far in the future. `loss_daily` is pruned in the same rounds, by `day`, at the routine retention.

### The size guard (D112's ceiling)

Retention by age does not bound the file: a retention set far longer than D57's, or a faulty device sending as fast as its airtime allows, could fill the card, and a full card stops commits and, in time, sending (section 4). So the data folder is held under 500 MB by size as well. This one runs on any clock: it deletes in row order, and counts its protected ages back from the later of the wall clock and the last commit's time, which is how the rows themselves are stamped.

- **The shares.** The database file may reach 240 MB ‡. The copy made before a migration is at most as large, and only the newest copy is kept: the older ones are deleted before a new one is made, so the folder never holds two. The WAL is at most 8 MB outside a burst, and `fatal.log` is cut back to its newest half when it passes 1 MB ‡. Together under 500 MB.
- **The hard stop.** `max_page_count` is set to 240 MB of pages (61,440); SQLite never sets it below a file's present size, so a file already larger opens with its own size as the stop. SQLite then refuses to grow the file, so the ceiling holds even if the trimming below has a fault; a refused commit is a failed flush like any other (section 5), recorded and retried.
- **The measure** is the pages in use: `page_count` less `freelist_count`, times the page size, read from the file's header inside a routine commit. Deleted rows free pages for reuse without shrinking the file (`auto_vacuum` is off), so the file's own size says nothing once it has been large.
- **Trimming** starts when the pages in use pass 220 MB ‡ and goes on until they are back under 205 MB ‡. While it goes on, every routine commit also deletes, oldest first by `seq` and whatever their age:
  1. up to 5,000 ‡ rows from each of `rx_routine`, `tx_routine` and `rejects`, never a row of the last 24 hours ‡;
  2. only when those three have nothing left older than 24 hours: up to 5,000 ‡ rows from each of `rx_event`, `tx_event`, `decisions` and the lower levels of `device_log` and `hub_events`, never a row of the last 30 days ‡.

  It never touches configuration, device state, keys, counters, `commands`, or a warning or worse in `device_log` and `hub_events`. At 5,000 rows a commit it frees about 70 MB a day, nearly three times what the worst device traffic can add.
- **Nothing silent (D110).** The writer reports each trimming commit to the core in its commit outcome: the rows deleted of each kind and the time of the oldest routine and event row left. The audit module records a warning hub event when trimming starts and once a day while it goes on ("history shortened to stay within the disk limit; routine history now starts at …"), a critical one the first time event rows are deleted in each spell of trimming, and a notice when it ends. A trimming commit that deleted nothing is not reported, except once per spell when everything left is inside the protected ages, as a warning that the database is near its limit and nothing more can be trimmed. `hsn status` shows the database's size and whether history is being shortened.
- **When trimming cannot help** (everything left is inside the protected ages) the hard stop is reached and commits fail: the critical event of a failed flush says the database is full, and the hub keeps sending on its durable counters as section 4 describes.

The marks measure database pages only; the WAL has its own share. Measured by the write-budget test's projection, the largest site (64 sensors, 8 sirens, 3 gateways) holds 197 MB of pages at D57's retention, under the upper mark. The marks, the row counts and the protected ages are parameters of the writer, so a test runs the whole rule on a database of a few megabytes.

### Migrations

drizzle-kit generates SQL migrations into `hub/drizzle/`, committed with the code. At start, before the boot event, the shell applies the outstanding ones in one transaction with Drizzle's bun:sqlite migrator. Before a migration that changes or drops an existing table it copies the database with `VACUUM INTO hub.db.before-<n>` ‡. A database newer than the code is refused, recorded in `fatal.log` and on standard error, and the hub exits, which is what lets D54 switch back to the previous version. Every migration has a test that applies it to a fixture of the previous schema holding rows. Every blob with a layout of our own starts with a format byte.

## 7. Each exchange of §7 from the hub's side

Common settings: site channel 868.3 MHz, one sending rate, DR5 (SF7), so replies use DR5 too. Gateway `gw1` (device 2) is on Wi-Fi, with a session open, its next gateway counter 61,440, both powers 22 dBm ‡. Sensor `front` (device 3, address 0x5E000001): countdown 30 s, heartbeat 12 units (3 minutes), link check every 5th, settings version 7, the hub's next counter to it 9,410. Siren `hall` (device 5): on Wi-Fi and LoRa, version 3, the hub's next counter to it 4,096, longest sound 300 s; automatic stop 300 s (D40). Times are seconds on the hub's monotonic clock; G is the gateway's microsecond clock. Airtime from §2: heartbeat 62 ms, reply 72 ms, notice 51 ms, siren command 57 ms.

### Heartbeat and link check (§7 "Sensor heartbeat", "Heartbeat slots")

| t | Event | The core decides | Stored | Sent: rate, moment |
| --- | --- | --- | --- | --- |
| 0.000 | — | `front`'s 5th heartbeat (reply wanted, version 7, counter 3,331) ends at G = 500,000,000 | — | — |
| 0.030 | `frame` on gw1's link: ForwardedPacket {G, −95 dBm, SNR +8 dB, DR5, channel 1}, gateway counter 88,213 | gateways: session binding good, 88,213 above 88,212; the clock mapping puts the packet's end at 0.000. intake: address known, tag good, 3,331 accepted. sensors: version equal, reply wanted, so a link check (D72). slots: the next occurrence of `front`'s slot at least half an interval away is at 180.0, so 1,800 tenths; the clock estimate is within 50 ppm ‡ of the held correction, so no change | routine: `rx_routine`, window, reading | Reply {v7, not armed, countdown 30, 12 units, every 5th, DR5, DR5, next 1,800, held correction} bound to 3,331, counter 9,410, inside TransmitRequest {at a given time G + 1,000,000 †, DR5, 22 dBm, normal}, gateway counter 61,440 |
| | | 61,440 is a multiple of 1,024: resume point 62,464 for gw1, written now | flush now: the resume point and everything staged, one commit | sent after the commit, at about 0.04 |
| 1.000 | — | gw1 sends the reply (72 ms) | — | — |
| 1.10 | TransmitResult {61,440, sent, G + 1,000,012} | gateways: hands the outcome to sensors | routine: `tx_routine` with outcome and sent time | — |

A heartbeat that is not a link check and holds the current version gives only the routine row and window; nothing is sent and nothing is committed until the next routine flush (D72).

### Door opens while armed, then a disarm (§7 "Door opens while armed")

| t | Event | The core decides | Stored | Sent: rate, moment |
| --- | --- | --- | --- | --- |
| 0.000 | — | door opens; DoorChanged {v7, door open, reply wanted, age 0}, counter 3,392, ends at G₁ | — | — |
| 0.035 | `frame`: ForwardedPacket | intake accepts. alarm: `front` armed, opened at 0.000, after it was armed, no countdown running: countdown to 30.000; decision `countdown_started`, caused by the packet's record. sensors: event reply | now: `countdowns` {front, deadline 30.000, newest 3,392, gw1, DR5}, and, as an event report, its `rx_event` row, window, reading and decision; flush now | Reply {v7, armed, countdown started, 30, 30 left, …, next 0} bound to 3,392, counter 9,411, in TransmitRequest {as soon as possible, latest G₁ + 1,500,000 − 72,000: the event listen time at DR5 † less the reply's airtime}, after the commit |
| 0.17 | TransmitResult sent | — | routine: `tx_event` | — |
| 12.300 | `command` disarm all, from the CLI | alarm: every sensor disarmed; `front`'s countdown cancelled; decision `disarmed` with the actor. sensors: every version bumped (front 7 → 8); disarmed notice for `front` | now: `sensor_config` rows, `countdowns` row deleted; routine: `commands`, `decisions`, in the same commit; flush now | DisarmedNotice bound to 3,392, counter 9,412, DR5 through gw1, as soon as possible, no limit; then the CLI's answer |
| 14.300 | timer | sensors: the second copy (D24) | routine: `tx_event` | the same bytes in a new TransmitRequest |
| ≈ 180 | `front`'s next heartbeat holds version 7 | sensors: version differs, reply at the fixed moment | routine | Reply {v8, not armed, …} |

### Countdown ends: alarm and siren command (§7 "Siren command")

| t | Event | The core decides | Stored | Sent: rate, moment |
| --- | --- | --- | --- | --- |
| 30.000 | timer `countdownEnd(front)` | alarm: `front` still armed, so the alarm starts with trigger `front`; `hall` should sound until 330.000; decision `alarm`. sirens: `hall` should sound and was last commanded off, so SoundAlarm 300 s, counter 4,096, a multiple of 1,024: resume point 5,120 | now: `alarm`, `alarm_triggers`, `alarm_sirens`, `countdowns` row deleted, resume point, the critical `alarm` decision; flush now; `cadence` stays at 1 s | after the commit: on `hall`'s WebSocket at once; and in TransmitRequest through `hall`'s best gateway {as soon as possible, no limit, DR5 (the command rate of version 3), 22 dBm, siren priority}. Timers: Wi-Fi repeat 32.0, LoRa repeat 35.0, give up 90.0 |
| 30.08 | `frame` on `hall`'s link: SirenReport {v3, sounding, 300 s, last command low bits 4,096, reason 1} | sirens: confirmed; repeats cancelled; decision `siren_confirmed` (Wi-Fi) | routine: `rx_event` (committed within the second, the alarm running) | — |
| 30.3 | the LoRa copy reaches the siren, which answers its repeat on LoRa (§7) | intake accepts; sirens: already confirmed, nothing | routine | — |
| 31.000 | another door's countdown ends | alarm: trigger added; `hall` already sounds for this alarm, so no new command (§7, D95) | now: `alarm_triggers` | — |
| 330.000 | timer | alarm ends by itself (D67): `front`'s door last reported closed, so it stays armed; a trigger whose door is open waits for it to close (version bumped) | now: alarm rows deleted, `sensor_config`; `cadence` back to five minutes | the new version goes out at those sensors' next heartbeats |

### Late door reports (§7, D106)

Armed, countdown 30 s, automatic stop 300 s; the report ends at hub time T.

| Report | The core decides | Stored | Sent |
| --- | --- | --- | --- |
| age 20 s | opened T − 20, ends T + 10: the countdown runs with 10 s left | now: countdown | Reply: countdown started, 10 left |
| age 100 s | would have ended T − 70; sirens until T − 70 + 300 = T + 230: alarm, decision `late_report_sirens` | now: alarm | Reply: armed, no countdown; siren commands for 230 s |
| age 400 s | would have ended T − 370; even the sirens' time ran out at T − 70: decision `late_report_notification` with the opening's time | now: critical | Reply: armed |
| any, while disarmed | `report_while_disarmed` (AL2b) | now: an event report | Reply: not armed |
| opened before the sensor was armed | the door was open at arming: it arms when it closes (section 8) | now | Reply: not armed |

### No reply from the hub, and the data-rate fall-back (§7)

- Each retry is a new packet with a new counter. The first that gets through is an opening with its age, judged as above. While the countdown runs, each later try is `countdown_continued` and becomes the countdown's newest report, the disarmed notice's binding (§4): the `countdowns` row is written now (it is an event report anyway), because a notice sent after a restart must bind to it.
- Flag bit 5 (local alarm sounded) gives decision `local_alarm_reported`. Flag bit 7 makes the reply go at the rate the packet arrived at, and counts as a failed faster reply (section 8).
- A door change count that advanced by more than the reports the hub accepted gives decision `door_changes_missed` (§7).

### Siren reports and lost paths (§7 "Siren reports")

| Event | The core decides | Stored | Sent |
| --- | --- | --- | --- |
| Wi-Fi report, reason 0, every 30 s | Wi-Fi path seen; what it does matches what it should do | routine: `rx_routine` | — |
| LoRa report, reason 3 (Wi-Fi report failed) | Wi-Fi path lost, a warning (D73) | now: the warning, with the report's row and window | — |
| No Wi-Fi packet for 70 s ‡ | Wi-Fi path lost, if not already | now: a warning | — |
| On LoRa alone at DR5, nothing for 70 s ‡ | siren silent (D52), critical while any sensor is armed | now | — |
| A command while Wi-Fi is down | LoRa only, repeated every 5 s | as above | — |
| Report shows version 2, hub has 3, nothing in flight | settings on both paths, repeated like a command until a report shows version 3 | — | SirenSettings |

### Gateway connection (§7 "Gateway connection")

| Event | The core decides | Stored | Sent |
| --- | --- | --- | --- |
| `linkOpened` (WebSocket) | links: a network link, carrier unknown | — | — |
| Hello {random g, firmware, v4}, counter 70,001 | gateways: address is gw1; 70,001 is above the highest counter seen from gw1, so a new session (section 8); hub random h from the input's entropy | now: the hello's counter as gw1's highest; routine: `rx_event` | Welcome {h} bound to g; GatewaySettings {v4, …} bound to g‖h |
| Started on the new session | session proven; an older link of gw1 is closed; `gatewayUp` (sirens waiting to send "report now" do so) | routine: `rx_event` | — |
| Status every 30 s | settings version checked; noise judged (section 8); silence timer reset | routine: `rx_routine` | settings again if the version differs |
| Interference started or ended | decision, critical while any sensor is armed (D82) | now: a warning or worse | — |
| Log entries | one `device_log` row per entry | now for warnings and worse (within the cap), routine for the rest | none: not answered (§6) |
| Nothing for 60 s | gateway offline (D97), naming the sensors no other gateway heard in the last hour; their own silence held back | now: a warning | — |

### A busy gateway (§7 "Reply timing and a busy gateway")

| Transmit result | The core decides |
| --- | --- |
| Heartbeat reply: radio busy or too late | Skipped; the sensor gets its settings at the next link check. A version change that missed it is resent at the next heartbeat that holds the old version |
| Event reply: too late | Recorded; the sensor's retry is answered |
| Siren command: radio busy or no airtime | Recorded; the next repeat, 5 s later, covers it |
| No result within the latest moment + 5 s ‡ (10 s ‡ with no limit), or the session closed | Outcome "no result", handled as not sent |

### Changing the site's rate, DR5 to DR2 (§7 "Changing the site's channel or rate", D115)

The site stays on 868.3 MHz. `front` (version 7) is idle; `back` (version 11, armed) has its door opened just after the switch; `hall` is on Wi-Fi with version 3. At DR2 (SF10) the heartbeat interval keeps its 3 minutes (no floor below SF11, §7); a heartbeat takes 412 ms and a reply at DR2 453 ms (§2). Both sensors' margins allow replies at DR5, three steps faster (section 8).

| t | Event | The core decides | Stored | Sent: rate, moment |
| --- | --- | --- | --- | --- |
| 0 | `command` `site change rate=DR2` | site: no move in progress; move 1 announcing to 2 sensors. sensors: `front` 7 → 8, `back` 11 → 12, both versions announcing {channel 0xFF (stays), DR2}; decision `move_requested` with the actor | now: the move, both `sensor_config` rows | CLI: "announcing DR2 to 2 sensors" |
| 40.0 | `back`'s heartbeat, version 11 | sensors: version differs, so a reply | routine | Reply {v12, armed, send DR5, reply DR5, next heartbeat, next channel 0xFF, next rate DR2} at the fixed moment, DR5 |
| 100.0 | `front`'s heartbeat, version 7 | the same | routine | Reply {v8, …, next 0xFF, DR2} |
| 220.0 | `back`'s heartbeat names version 12, reply wanted (it now asks on every heartbeat) | site: `back` confirmed, 1 of 2 | now: `move_confirmed` | the reply at the fixed moment, still announcing |
| 280.0 | `front`'s heartbeat names version 8 | site: 2 of 2 confirmed, no countdown or alarm running: **switch**. The site's rate becomes DR2; gw1's settings version 5 (listen DR2); `hall`'s version 4 (send DR2, command DR5, channel 868.3); slots planned again with 412 ms heartbeats; `front` and `back` get versions 9 and 13 ready: send DR2, reply DR5, nothing announced; decision `move_switched` | now: all of it, one commit | after the commit: GatewaySettings v5 to gw1; then SirenSettings v4 on `hall`'s Wi-Fi and through gw1 at DR5, siren priority. The reply to `front`'s heartbeat, at 281.0 at DR5, still announces: it answers a packet sent on the old settings |
| 280.1 | `hall`'s report, version 4, reason 1 | sirens: settings confirmed; site: `hall` switched | routine; now: `move_followed` for `hall` | — |
| 281.0 | `back`'s door opens; DoorChanged at DR5 | — | — | — (gw1 listens at DR2; unheard) |
| ≈ 283.6 | `back`'s retry at DR2, flag bit 7, age 2 s | site: `back` followed. alarm: opened ≈ 283.6 − 2 = 281.6 (the age is whole seconds; the door opened at 281.0), armed, so a countdown to ≈ 311.6 counted from the opening (D106). sensors: the reply goes at the arrival rate, DR2, and names version 13 as current | now: the report, the countdown, `back`'s version 13 and follow | Reply {v13, armed, countdown started, 28 left, send DR2, reply DR5, next 0xFF, 0xFF} at DR2, as soon as possible, starting no later than the end + 2.2 s (event listen time at DR2) − 453 ms |
| 460.0 | `front`'s heartbeat at DR5 | — | — | — (unheard; `front` notes the miss) |
| 640.0 | `front`'s heartbeat at DR2, flag bit 7 | site: `front` followed; every device on the new settings: move done; decision `move_done` | now: follow and done | Reply {v9, send DR2, reply DR5, next heartbeat in its new slot, next 0xFF, 0xFF} at the fixed moment, at DR2 |

`front`'s silence was held back until 280 + 4 × 180 = 1,000 s; it was heard at 640.

### Hub restart (§7 "Hub restart", D80, HB30)

1. Migrations; `Reader.snapshot()`; the boot event.
2. The core restores counters from their resume points, replay windows, settings and armed states; works out the downtime (section 5); re-expresses each countdown and the alarm in this boot's clock by that rule (D113 when the downtime is unknown); writes the boot record and the re-expressed rows now, and flushes before anything is sent. A countdown or alarm restored sets `cadence` to 1 s.
3. mDNS advertising starts; links open; gateways send new hellos and sirens reconnect.
4. As each siren's path becomes available, within 120 s ‡ of the start, the hub sends it "report now" (§7) on that path, as an ordinary command: one at a time, repeated until a report answers. A siren that reports sounding while the alarm expects it to is adopted, not commanded again (D80).
5. Sensors need nothing: their packets are answered as they arrive, and silence clocks start from the start.

## 8. Rules the hub owns

The values below live in `HubRules` (section 2), each with its source.

### Site channel and data rate

- **Channel.** Chosen during setup as the quietest of the three on the first gateway's noise (§2). No message asks a gateway to measure another channel, so the hub surveys by settings: for each channel in turn it sends the gateway settings with that channel, discards the first status (it covers the old channel), and averages the median noise of the next four (2 minutes ‡). It takes the lowest; on a tie, the lowest highest reading; then 868.3 MHz. `hsn site survey` runs it; adding the first sensor or siren runs it if no channel is set and a gateway is connected, and refuses otherwise. `hsn site set channel` sets it by hand.
- **Rate.** One sending rate per site until O14 is settled (§2). DR5 by default ‡; `hsn site set rate` before pairing. Gateways listen at it; every device is paired with it as the only rate allowed.
- **Changing them later** is a move of the whole site over the air (D115), below. `hsn site set channel=… rate=…` works only before the first sensor or siren is paired; after that, `hsn site change` (section 9).

### Changing the site's channel or rate (D115, §7)

The site module owns the move. Its state, all written now (section 5): the move's id, its stage (announcing, switched, done, cancelled), the target channel and rate, who asked, whether forced, and the switch time on the monotonic clock with its boot; for each sensor, the next settings its current version carries, its confirmation and its first packet on the new settings.

- **Request** (`hsn site change`). Refused while another move is in progress, or when the target equals the current settings, naming the reason. Otherwise the move starts announcing: every paired sensor gets a new settings version carrying the next channel and rate, all in one commit, before any reply carries it. A field that does not change is sent as 0xFF, "stays as it is" (§6); both 0xFF means no move.
- **Pairing during a move** (§7). While announcing, a new device is given the current settings, gets a version announcing the move like every other sensor, and the hub waits for its confirmation too. After the switch, pairing gives the new settings.
- **Announce.** Every reply to a sensor whose current version carries the move names the next settings (§6, Reply); the reply's own sending and reply rates stay the current ones. A sensor has **confirmed** when a packet from it, the newest by counter, names a version that carries this move (from the version history; versions wrap at 255, so the history decides, not a comparison). Each confirmation is written now and recorded as `move_confirmed`. With every sensor in touch this takes about two intervals: one for the reply that announces, one for the heartbeat that confirms (§7). If any sensor has not confirmed after 4 of its heartbeat intervals †, a `move_stalled` warning names it; the hub keeps waiting and never switches by itself: the user forces or cancels (§7).
- **Switch,** when every paired sensor has confirmed, or when forced; never while a countdown or the alarm runs: it waits for them to end (§7). A siren command still unconfirmed only delays that siren's settings, by the one-at-a-time rule. One commit: the stage, the switch time, the site's channel and rate, every gateway's new settings and version, every siren's new settings and version (send rate, channel), the new slot plan, and each sensor's next version (current: the new settings; nothing announced; its reply rate chosen again, below). Then, in this order on every link: the gateway settings to every connected gateway, which listen at once; then the siren settings, on Wi-Fi where the siren is connected and as a LoRa command through a switched gateway otherwise (§7). A gateway that is offline gets its settings at its next welcome, as always. Recorded as `move_switched`, with whether it was forced.
- **Follow.** A packet that arrives on the new channel and rate (the forwarded packet names both, §6) from a sensor not yet followed makes it followed, written now and recorded as `device_followed`. Its reply goes at the rate it arrived at, as for flag bit 7, which the sensor sets, names that rate as the rate to send at, and announces nothing (§7). The sensor then holds the new channel and rate in place of those from its pairing, for good: from then on the site's rate is the one rate it may send at (§7, "Data rate"). A packet that still arrives on the **old** settings after the switch (a gateway that has not applied its new settings yet) is answered still announcing the move (§7). A siren has followed when a report shows its new version. The move is done when every sensor and siren has followed, or when the grace below has run out for the rest; `move_done` names any that did not follow.
- **Silence across the switch.** A sensor not yet heard on the new settings has its silence alert held back for 4 heartbeat intervals † after the switch, counting the larger of its old and new effective interval (at SF11 and SF12 the sensor lengthens its interval, §7). A siren's LoRa path and silence rules wait likewise until it has confirmed its new settings or 4 of its paces have passed. After that the ordinary rules of this section apply, and the sensor is named as not having followed.
- **Siren settings during a move** follow the one-at-a-time rule (§7), but are repeated every 60 s ‡ after the first minute until confirmed: a siren on LoRa alone that missed them sends on settings no gateway hears, so the correction rule cannot see it.
- **Cancel,** only while announcing: stage cancelled; every sensor gets a new version announcing nothing, written now; their replies say so, and a sensor that misses one clears its next settings at its next reply, since it asks for one on every heartbeat (§7). After the switch there is no cancel; moving back is a new move.
- **Force,** only while announcing: the switch goes ahead at once. Every sensor that has not confirmed will keep sending on the old settings and must be paired again (§7). Each is set to state 5 in `devices` (section 6), named in a critical `move_forced` decision, and from then on raises that one alert instead of silence alerts.
- **A restart in each stage.** Announcing: versions, next settings and confirmations are all committed, so the hub carries on waiting. Switched, whether or not the settings had been sent: the site's and every device's new settings are committed, so gateways get them at their welcome, sirens through "report now" and the ordinary settings rule (a report holding the old version is answered with the new settings), and sensors follow as above; the switch time is re-expressed like a countdown, and with an unknown downtime (D113) the silence grace counts from the start. Done or cancelled: nothing more.
- **Heartbeat slots.** At the switch every sensor's effective interval and slot span are computed for the new rate (the heartbeat's airtime, and at least 3 minutes at SF11, 5 at SF12, §7) and the plan is made again, phases written now. Each sensor learns its new slot from the reply to its first heartbeat on the new settings; until then it is unslotted and may cross others. Clock corrections carry over, since they belong to the sensor's clock; no sample spans the switch, because the settings version changes.
- **Reply rates.** Before the switch nothing changes: replies go at the rate of the version the packet names. At the switch each sensor's reply rate is chosen again from its SNR samples, which describe the path and carry over, bounded by the new sending rate (never slower, at most 3 steps faster). The first reply on the new settings goes at the arrival rate and carries the new reply rate; later replies use it. Sirens' command rates the same way.
- **What is recorded** (D110): `move_requested` with the actor, `move_confirmed` per sensor, `move_stalled` warnings, `move_switched`, `move_forced`, `move_cancelled`, `device_followed` per device, `move_done`.

### Heartbeat slots (§7, D108)

- Each sensor has a phase φ on the hub's monotonic clock, in its own effective interval I (the heartbeat interval, at least 3 minutes at SF11 and 5 at SF12, §7). A slot occupies a span w: the heartbeat's airtime, the reply moment (1 s †), the reply's airtime, and a guard of 2 s ‡ for clock wander. The span covers the link-check reply, which keeps reply moments clear of other heartbeats, because the gateway is deaf while it sends (§7).
- A new sensor takes the phase with the largest clearance to every other span over an hour. Existing phases do not move, until the smallest clearance falls below 2w ‡; then all are planned again, evenly in order of pairing. With one interval for all, which one sending rate makes the usual case, the plan is even spacing. Removing a sensor leaves a gap that the next new one takes.
- **Telling the sensor.** In a reply answering heartbeat end e, the next heartbeat is the first t with t ≡ φ (mod I) and t ≥ e + I/2, sent as round((t − e) ÷ 0.1 s) tenths (§6). The answered packet's end is the gateway's arrival time mapped onto the hub's clock: the per-session offset is the smallest (hub time of the frame − unwrapped gateway time) of the last 64 frames, which removes network delay; the 32-bit gateway clock is unwrapped against the hub's.
- **Which replies carry one** (§6, Reply). Heartbeat replies (link checks and version changes) and replies to Started. Replies to door, cover, button and log entries packets carry 0, which keeps the schedule: the sensor takes a slot only from the reply to its latest packet (FD 7), and an event does not move the rhythm.
- **The phase is written now** whenever it changes (section 5), which is rare: a sensor added or removed, or a plan made again. The estimates behind it are routine.
- **The early heartbeat after Started.** A reply to Started gives the first occurrence of the sensor's slot at least 30 s ‡ after the Started ended, which can be well under an interval. A restarted sensor is otherwise unslotted, sending at its interval ±10% (§7) across other sensors' slots, and the hub hears its settings version only at its next heartbeat. The early heartbeat puts it back in its slot at once and confirms the settings the Started reply gave.

### Clock correction (§7, D108)

- **Samples.** Two heartbeats of the same sensor, each the highest counter accepted from it when it arrived (so a replay never makes a sample), both slotted, heard by the same gateway, with no Started between, holding the same settings version, m intervals apart (m = the gap ÷ I, rounded, at most 4): gap G on that gateway's clock. The sensor sleeps I × (1 + c) on its own clock, c being the correction it held; its clock runs fast by d, so G = m·I·(1 + c) ÷ (1 + d), and d = m·I·(1 + c) ÷ G − 1.
- **Estimate.** The median of the last 5 samples ‡; a sample more than 0.5 s ‡ off the current estimate's prediction is dropped, which removes the 0.2 to 2 s waits of a busy channel check (§2).
- **Change.** A new correction c' = d̂ is sent when |d̂ − c| ≥ 50 ppm ‡, with at least 3 samples, at most once every 6 hours ‡, rounded to units of 10 ppm and limited to ±32% (§6).
- **The correction is a setting** (§6, Reply). Changing it bumps the sensor's settings version (D72), so the version in each heartbeat says which correction the sensor held, which the sample formula needs. The cost is one reply at the next heartbeat and one flash write on the sensor per change, a few a year if the clock is steady (FD 5 counts about 10 settings writes a year).
- **Fixed by hand.** `hsn sensor set <name> correction=<units>` fixes it, which the bench uses where the test hub sets `clock_correction_ten_ppm`.

### The reply rate (§7 "Faster replies", D108)

- **Which rate a packet goes at.** With flag bit 7: the rate the answered packet arrived at. Otherwise the reply rate of the settings version the packet says the device holds, from the last 16 versions kept; for a version not kept, the arrival rate. A log entries packet names no version: the hub goes by the sensor's most recent status packet, as the test hub does. A siren gets the command rate of the version it last reported, and before any report the rate of version 1.
- **Choosing the setting.** From the SNR of the sensor's last 20 accepted packets at its best gateway: s = the 10th percentile. The downlink estimate is s + (reply power − 14 dBm); 14 dBm is the sensor's power (§2). The demodulation limit at spreading factor F is −7.5 − 2.5 × (F − 7) dB, the bench's figure (`lora_physics.cpp`). The reply rate is the fastest at most 3 steps faster than the sending rate (§8) whose limit is at least 10 dB ‡ (§14, "Reply rate margin") below the estimate. With fewer than 10 samples, the sending rate.
- **Changing it.** Faster only when the condition holds with 3 dB to spare, at most once every 6 hours ‡; slower at once when it fails. A packet with flag bit 7 means two replies at the faster rate were just lost (§7): one step slower at once ‡. Every change bumps the version. A siren's command rate follows the same rule from its LoRa packets.
- **With today's one rate at DR5**, nothing is faster: the reply rate is DR5 and the rule does nothing until a slower site rate is chosen.
- **Fixed by hand.** `hsn sensor set <name> reply-rate=<DRn>`, which the bench uses where the test hub's settings fix it.

### When to reply (§6, §7, D72)

- Heartbeat: when the version it holds differs, or it asks. At the moment the sensor will be listening: it sleeps 1 s † on its own clock, which is nominal × (1 + c) ÷ (1 + d̂) of true time, c being the correction it holds and d̂ the slots module's estimate of how fast its clock runs (`sensorWaitMs`); 1 s exactly before any estimate and once the correction holds. Sent on the delivering gateway's clock. The code aims at this instead of a flat 1 s: a sensor more than 2% slow would open its window (20 ms † early, §8) after a flat moment, never hear a heartbeat reply, and so never be corrected by one. If the step that decides runs more than 700 ms ‡ after the packet's end, the reply is skipped, because the gateway would answer "too late" anyway (§6, 20 ms †).
- Door, cover, button, Started and log entries: always. As soon as possible, starting no later than the end of the answered packet plus the event listen time at the arrival rate, less the reply's airtime. The event listen time is the table in `@hsn/protocol` (`EVENT_LISTEN_MS`, the same values as the firmware's `kEventListenMs`; §8 †): 3.0, 2.6, 2.2, 1.9, 1.7 and 1.5 s at DR0 to DR5.
- Siren reports, gateway packets, and the log entries of sirens and gateways: never (§6, §7).

### Silence

- **Sensor (D107, HB25).** Silent when nothing has been accepted from it for n × I + 30 s ‡, counted from its last packet or from the hub's start, whichever is later. n is chosen daily from its last 7 days: loss p = 1 − received ÷ expected, with expected the counter's advance between accepted packets, not counting the jump to a resume point after a Started. With H = heartbeats a year (365 × 86,400 ÷ I) and S sensors on the site, n is the smallest from 3 to 8 with H × pⁿ ≤ 1 ÷ S, so the site stays under one false alert a year; if none, 8. Example: home B, I = 3 minutes, H = 175,200, S = 30: p = 1% gives n = 4, p = 0.2% gives n = 3. A sensor with p above 20% is shown as having a poor link (D107). Before it has a day of data, n = 5 ‡, the smallest that gave at most one false alert a year in every case of the gateway load simulation. In M1a silence is a decision record, critical while armed; notifications come in M2 (HB9). While a gateway is silent, the sensors only it heard raise none of their own (D97).
- **Siren on both paths (D73).** Wi-Fi path lost when its link closed and is not back within 70 s ‡, when nothing came on Wi-Fi for 2 × the report interval + 10 s (70 s ‡), or at once on a LoRa report with reason 3. LoRa path lost when nothing came on LoRa for 2 × the check interval + 30 s (630 s ‡) while Wi-Fi works. Each is a warning; a packet on that path clears it.
- **Siren on LoRa alone (§7, D52).** With Wi-Fi lost, the siren paces its reports to P = the larger of the report interval and 200 × the airtime of a 28-byte report at its sending rate: 30 s at DR5, 82.4 s at DR2, 329.4 s at DR0. It is silent when nothing came for 2P + the larger of 10 s and P ÷ 10 ‡: 70 s, 175 s and 692 s.
- **Gateway.** Offline after 60 s with nothing (§7, D97).

### Which gateway a packet goes through

- **A reply** goes through the gateway that delivered the first accepted copy (§7, GW9). If that session closed before the reply goes: a heartbeat reply is skipped (its moment is on that gateway's clock); an event reply goes through another connected gateway, as soon as possible, its latest moment converted to that gateway's clock through the hub's mappings, less 20 ms ‡; with none, decision `no_path`.
- **A disarmed notice** goes through the gateway the countdown's latest reply went through; if it is gone, any connected gateway; as soon as possible, no limit.
- **A siren command over LoRa** goes through the gateway that heard the siren best (§7): the highest SNR among the siren's authentic copies, duplicates included, in the last 15 minutes ‡, among open sessions; on a tie the most recent. With none heard recently, any connected gateway; with none connected, Wi-Fi only, recorded.
- **A siren command on Wi-Fi** goes to every open WebSocket that carried an accepted packet from that siren in the last 60 s ‡, normally one. A packet replayed after a power cut (section 5) could otherwise make a stranger's socket look like the siren's, and the same bytes on an extra socket reveal nothing.
- **Powers.** Replies and notices at the gateway's default transmit power, siren commands at its siren power, both from its settings, both 22 dBm ‡. The faster reply rates assume the higher power (D108).

### What the siren should do, and commands (§7 "Siren command", D95, SR4)

- The alarm module keeps for each siren what it **should** do: off, sounding until a time, or testing until a time. The sirens module keeps what it last **commanded** and what the siren last **reported**.
- **"What the siren should do changes"** means a decision of the hub moves "should" from one kind to another: off to sounding (an alarm starts or adds this siren), sounding to off (a disarm ends the alarm), off to testing and back. Time running out is not a change: the siren stops by itself (SR5) and nothing is sent. Another trigger within the same alarm, for a siren already sounding, is not a change: its time is not extended (agreed, section 13). So thirty doors cost one command per siren (§7).
- A siren's "until" is never later than its first command's time plus its longest sound setting, so re-commanding cannot stretch the cap.
- **Correcting a siren.** With nothing in flight, a report with the highest counter accepted from the siren that contradicts "should" is answered by a command: "should sound" with at least 10 s ‡ left and the report says off, then sound for what is left; "should be off" and the report says sounding for an alarm, then off. A test the siren reports while the hub expects off is left to end. This is how the hub recovers a siren that lost power during an alarm, or a command that gave up after a minute.
- **One at a time** (§7 step 5): while a command is unconfirmed, a newer command replaces it and its repeats; settings wait. A report confirms a command or settings packet when its "last counter acted on" equals that packet's counter in its low 16 bits. The hub sends a siren far fewer than 65,536 packets in the minute a command can wait, so the match is unambiguous.
- **Repeats** every 2 s on Wi-Fi and every 5 s on LoRa, for up to a minute (§8); then decision `siren_unreachable`, a warning. The correction rule above sends it again when the siren is next heard.

### The gateway's noise against its long-term level (D82, §14)

- **Baseline.** For each gateway the hub keeps B, a slow average (time constant 24 hours ‡) of the median noise in its statuses. A status updates B only when its median is at most B + 3 dB ‡, so interference is never learned. A new gateway's B starts as the 20th percentile of the medians in its first hour, and no hub-side alert is raised before then.
- **Hub-side interference.** Raised when the median is at least B + the alert level (10 dB †) in 2 ‡ consecutive statuses. A median above the level means at least half of the readings are, which catches the interference that comes and goes that §14 says the gateway can miss. It ends after 2 statuses below B + the level − 3 dB.
- **A gateway that learned interference as normal.** Raised when the gateway's own learned normal level is at least B + the level (§14).
- **Damaged packets.** A warning when packets failing the radio's CRC are more than half of those received over 2 statuses with at least 10 packets ‡.
- Each is recorded as a decision with the gateway's figures, critical while any sensor is armed (D82). It never sounds a siren.

### Gateway sessions (§4, §7)

- **A hello must carry a counter above any the hub has accepted from that gateway** (§4); one at or below it is a replay, counted as `tooOld`. The hub keeps that highest counter in memory as packets arrive, and writes it now each time it accepts a hello (a few a day), so a power cut cannot lose it: the routine batch would otherwise forget up to five minutes of it, and a hello recorded in that time could be replayed.
- **A live session is kept until the new one is proven** (§4). While gw1 has a session, a hello on another link starts a second, unproven one: the hub answers with a welcome and settings, but keeps the old session for everything. The new one is proven by its first session-bound packet (the gateway sends Started straight after the settings, FD 7); then it becomes the session and the old link is closed. Unproven after 10 s ‡, the new link is closed. With no live session (after a start), several unproven ones may wait at once, and the first proven wins.
- Settings go after every welcome, after any status that names another version, and on every change.

### Arming and the countdown (D50, D67, D74, D86, D95, D106, AL3, AL4)

Each sensor is in one of four states: **disarmed**; **armed**; **armed, waiting for the door to close** because it was open when armed (D50); **armed, waiting for the door to close** after an alarm it set off ended by itself (D67). Both waiting states count as armed for the user and send "not armed" to the sensor, so a sensor never buzzes for a door the hub ignores. A door changed report saying closed moves either to armed, with a version change; nothing else does (below).

- **Arm** (`hsn arm`). A sensor whose last known door state is open is named, and the command stops unless given `--continue` (D50); with it, that sensor waits for the door to close. Every armed sensor records when it was armed.
- **A door-open report**, with opened = the packet's end − its age:
  - disarmed or waiting: recorded only (AL2b);
  - armed, opened more than 2 s ‡ before it was armed (the age is whole seconds): the door was open at arming, so it waits for it to close (agreed, section 13);
  - armed with a countdown running: `countdown_continued`, and the report becomes the countdown's newest (closing the door never cancels, D86; a second opening does not restart, AL3);
  - armed with a countdown of 0: an alarm at once, no buzzing (D86);
  - otherwise the late-report rules of section 7.
- **Countdown end.** If the sensor is still armed, an alarm trigger.
- **The alarm** is the set of its triggers and the sirens they sound. With no groups in M1a, every sensor sounds every siren (D74). A new trigger adds the sirens not yet sounding, each until now + the automatic stop (or, for a late report, until the countdown's would-be end + the automatic stop).
- **Disarm** (`hsn disarm`). Every running countdown of a disarmed sensor is cancelled with the disarmed notice twice (D24). The alarm ends only when every trigger is disarmed; the sirens are then commanded off. Otherwise they sound on to their automatic stop (D95).
- **Ending by itself** when every siren's time has passed. Each trigger whose door is open then waits for it to close (D67).
- **A heartbeat never starts a countdown, sounds a siren or changes a sensor's arming state.** Only door changed reports do, and those are committed before they are answered, so they cannot be replayed (section 5). A heartbeat whose door state or change count the hub did not expect (the door open while the last report said closed, or a change count ahead of the reports accepted) gives a recorded warning, `door_state_unexpected` or `door_changes_missed`; while armed, M2 adds a critical notice. A sensor waiting for its door to close therefore stays waiting until its next door report, even if a heartbeat shows the door closed: the price of never acting on a packet that might be a replay.

### Accepting a device packet (§3, §4, §5)

- The checks run in the order the protocol fixes: header, address and counter; a known address, else counted as `unknownAddress` with no AES spent; the tag; then the counter against the replay window.
- A packet on a path its type does not use (§5, "Paths": a sensor status that arrives on a link instead of through a gateway, a gateway packet inside a forwarded one) is rejected as `wrongPath`.
- An authentic packet of a type this version does not know is accepted into the window, so its replays are refused, recorded with its raw body, and otherwise dropped (§5, §11).
- A copy heard by a second gateway is a `duplicate`, counted per gateway and minute; for a siren it still counts towards the best gateway.
- A log entry already recorded from an earlier packet of the same device (same level, code and text, made within 15 s ‡) is kept again and marked `repeat_of` that packet's counter, as the test hub does for sensors (FD 8); for sirens too, whose info entries could come again in a replay (section 5).
- **Readings follow the newest packet.** A device's readings (door state, battery, flags, signal, settings version held) change only on a packet whose counter is the highest accepted from it. A packet accepted from below the highest, a late LoRa copy of a siren report or a replay, is recorded and changes nothing else.

### The values

| Value | Setting | Source |
| --- | --- | --- |
| Heartbeat reply moment | 1 s † | §8 |
| Event listen time by rate, DR0 to DR5 | 3.0, 2.6, 2.2, 1.9, 1.7, 1.5 s † | §8, `kEventListenMs` |
| Too late to ask for a heartbeat reply | 700 ms after the heartbeat's end ‡ | this design |
| Disarmed notice | twice, 2 s apart | §8, D24 |
| Siren repeats | 2 s Wi-Fi, 5 s LoRa, 1 minute | §8 |
| Siren "report now" after a start | within 120 s, as each path appears ‡ | this design, D80 |
| Siren correction threshold | 10 s left ‡ | this design |
| Best gateway for a siren | last 15 minutes ‡ | this design |
| Slot guard | 2 s ‡ | wander (gateway load: ±10 s still worked for 10 sensors at 5 minutes) |
| Early heartbeat after Started | at least 30 s after it ‡ | this design |
| Clock correction | median of 5, change at 50 ppm, at most every 6 h ‡ | this design, S8 |
| Reply-rate margin | 10 dB, 3 dB hysteresis, 6 h ‡ | §14, S6 |
| Sensor silence | n from 3 to 8 (5 before a day of data ‡) × I + 30 s | D107 |
| Siren Wi-Fi path lost | 70 s ‡ | D73 |
| Siren LoRa path lost | 630 s ‡ | D73 |
| Siren silent on LoRa alone | 2P + max(10 s, P ÷ 10) ‡ | §7, D52 |
| Gateway offline | 60 s | §7, D97 |
| Interference | 10 dB † over 2 statuses ‡; baseline 24 h ‡ | D82, §14 |
| Unproven gateway session | 10 s ‡ | this design |
| Routine batch | five minutes | D112, HB35 |
| Commit while a countdown or alarm runs | every second | D112, D113 |
| Written at once | write-through state, event reports, warnings and worse (60 an hour per source ‡), clean stop | D112 |
| Flush size | 2,000 items or 512 KB ‡ | this design |
| Siren Wi-Fi sockets used for a command | those with an accepted packet in the last 60 s ‡ | this design |
| Opened before arming | 2 s tolerance ‡ | this design |
| Site move: silence held back after the switch | 4 heartbeat intervals † (the larger of old and new) | §7, D115 |
| Site move: warning while sensors have not confirmed | after 4 of their intervals † | §7, D115 |
| Site move: siren settings repeated after the first minute | every 60 s until confirmed ‡ | this design |
| Entry countdown default, automatic stop | 30 s, 300 s | D40 |
| Transmit powers | 22 dBm ‡ | §2, D108 |

## 9. The command-line tool

`hsn`, in `hub/cli/`, run with Bun. It reaches the running hub through the **control socket**: a Unix domain socket, `control.sock` in the hub's data folder, readable and writable only by the hub's account; on Windows a named pipe with the same access rule ‡. One JSON request per line, one JSON reply per line, both checked with the Zod schemas in `hub/src/control-protocol/`; `--follow` streams.

Why a local socket:

- **Not the app port.** Every request there must be authenticated (HB3), and M1a has no authentication yet. A tool that can disarm must not be reachable from the home network.
- **Not a localhost TCP port.** Any program of any user on the computer could reach it, and so could web pages aimed at local addresses (D62). A socket file carries the operating system's own permissions, which is the trust D61 and D62 give the hub computer.
- **Not the database directly.** One writer (section 5), and every change must pass the core's rules and be recorded with its cause (D110). The CLI never opens `hub.db`.
- **The same channel serves the bench** (section 11) and later the installer's setup checks.

Every command is recorded in `commands` with its actor (the user name the CLI reports; the socket's permissions are the real check). The control module makes that record first, and every request message it sends on carries the record's number, so each decision a command causes names it (D110). The requests are Zod strict objects: a field the schema does not name refuses the line, as a typo in a command must not be silently dropped.

**On Windows the control socket is refused for now.** Node's `net` can listen on a named pipe but cannot set its access list, and a pipe made without one is open to every user of the computer, which this section forbids. Until a way to limit it to the hub's account is chosen (a native helper, or a pipe created with a security descriptor by the service), the hub does not open it; with O18 (section 3), the hub is not usable on Windows yet.

| Command | What it does |
| --- | --- |
| `hsn status` | Armed state per sensor, doors, countdowns, the alarm, each siren (should, commanded, reported, paths), each gateway (session, link, last status, noise against its baseline), last commit and staged items |
| `hsn arm [--all \| <sensor>…] [--continue]` | Arms (section 8); without `--continue` it stops and names any open door (D50) |
| `hsn disarm [--all \| <sensor>…]` | Disarms; cancels countdowns with the notice; ends the alarm when its triggers are all disarmed (D95) |
| `hsn devices`, `hsn device show <name>` | The registry, readings, settings and versions |
| `hsn usb list` | Open USB links and each board's latest Identity: role, chip, firmware, paired and to whom, development build |
| `hsn usb add <port> --name <name> [--role sensor\|siren\|gateway]` | Sets the role if asked (§10, Set role), then provisions the board (below) |
| `hsn usb erase <port>` | Erase, development builds only (§10) |
| `hsn device rename <old> <new>`, `hsn device remove <name>` | Rename; remove (the key is deleted, the history kept) |
| `hsn sensor set <name> countdown=<s> heartbeat=<units> link-check=<n> reply-rate=<DRn\|learn> correction=<units\|learn>` | Settings; each change bumps the version (D86, HB8) |
| `hsn siren set <name> max=<s>`, `hsn siren test <name> [<s>]` | Siren settings; a short test (D65, SR9) |
| `hsn site show`, `hsn site survey`, `hsn site set channel=<868.1\|868.3\|868.5> rate=<DRn> countdown=<s> auto-stop=<s>`, `hsn site wifi --name <n> --password <p>` | Site settings; channel and rate only before the first device is paired (section 8) |
| `hsn site change channel=<868.1\|868.3\|868.5> rate=<DRn>` | Starts a move (D115, section 8). Answers: refused, with the reason (a move in progress, or nothing to change); or "announcing <channel, rate> to N sensors"; a countdown or alarm running only delays the switch, which `status` shows |
| `hsn site change status` | The stage and target; while announcing, confirmed of total, naming each sensor still to confirm and how long it has been; after the switch, followed of total and when the silence grace ends; from the core's state, no database read |
| `hsn site change cancel` | Only while announcing. Answers "cancelled; N sensors clear the next settings at their next reply"; after the switch, refused: "switched; a move back is a new move" |
| `hsn site change force [--yes]` | Only while announcing. Without `--yes` it names the sensors that would have to be paired again and changes nothing; with it, the switch goes ahead and the answer names them again |
| `hsn log [--device <name>] [--since <time>] [--kind rx\|tx\|decision\|log\|event\|reject] [--follow]` | Reads the audit record through the hub, decoded with `@hsn/protocol` |

**Adding a device over USB** (PR5, D100, D103, §9, §10):

| Step | The core decides | Stored | Sent |
| --- | --- | --- | --- |
| A USB link opens | setup: Identify | — | 0xF1 0x01 |
| Identity arrives | records role, chip, firmware, paired, hub identity, development build. A gateway that is not paired is **added at once** with the name `gateway-<chip>` (D100). One paired to another hub, or not a gateway, is left alone | routine: `hub_events` (the automatic add writes now) | — |
| `hsn usb add` (or the automatic add) | refuses a board paired to another hub unless it is a development build; refuses one already ours. Draws a 4-byte address (not 0, not 0xFFFFFFFF, not in use; the next 4 bytes if so) and a 16-byte key from the input's entropy | now: `devices` (provisioning), `device_keys`, `send_counters` (1,024), its settings with version 1; flush now | Provision: format 1, address, key, hub identity, signing key, site channel, the site's rate mask, Wi-Fi name and password (required for sirens and Wi-Fi gateways, PR2) |
| Provision result: accepted | paired, waiting for first contact; the board restarts | now: `devices` | CLI: added |
| Refused or not valid | the rows are deleted | now | CLI: why |
| No answer in 5 s ‡ | stays provisioning; the CLI is told to retry. A retry sends the same address and key | — | — |
| First authentic packet from it | contacted | now: `devices` | — |

A crash between storing and sending leaves a provisioning row and an untouched board; one after sending leaves a board that holds a key the hub also holds. Either way the retry is the same Provision. The key never appears in a record: the Provision frame is recorded with the key bytes zeroed.

The hub's signing key pair (P-256, §9) is made at first start with Web Crypto, written through, and its identity (§9) is what mDNS advertises (§10).

## 10. Errors and logging

### Result types

```ts
type HubErrorKind = "storage" | "link" | "codec" | "crypto" | "config" | "control" | "random" | "internal";
interface HubError {
  readonly kind: HubErrorKind;
  readonly origin: string;                                     // "shell/storage/writer", "core/sirens"
  readonly message: string;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}
type CoreFault = HubError & { readonly kind: "internal"; readonly event: HubEvent["kind"] };
```

- `neverthrow`'s `Result` and `ResultAsync` everywhere in `hub/`. The protocol package keeps its own small `Result`; `core/util/protocol-safe.ts` turns it into a `HubError`.
- Our own code never throws. `throw` and `try` are forbidden by lint in all of `hub/` except `hub/src/shell/safe/**`, `hub/src/core/util/protocol-safe.ts` and `hub/src/shell/main.ts`.

### Where library exceptions are wrapped

| Library | Throws on | Wrapped in |
| --- | --- | --- |
| `bun:sqlite` | prepare, run, transaction, pragmas | `shell/safe/sqlite.ts`, used by the writer and reader |
| Drizzle migrator | a failed migration | `shell/safe/migrate.ts` |
| `serialport` | open and write (callbacks and `error` events) | `shell/safe/serial.ts` |
| `Bun.serve` WebSocket | send status codes (back-pressure, dropped), a closed socket | `shell/safe/websocket.ts` |
| `node:fs`, `node:net` | data folder, socket file, `fatal.log` | `shell/safe/fs.ts` |
| `crypto.getRandomValues`, `crypto.subtle` | entropy, the signing key | `shell/safe/crypto.ts` |
| `@hsn/protocol` `sealPacket`, `openPacket` | `RangeError` on a bad key or binding, a type in the wrong direction | `shell/cipher/` (the `DeviceCipher`) |
| `@hsn/protocol` `timeOnAirMs`, `dataRateMask`, `tenPpmUnitsFromPpm`, `resumeSendCounter`, `checkReplayWindow` | `RangeError` on values out of range | `core/util/protocol-safe.ts` via `Result.fromThrowable`; the core may import these names nowhere else (lint) |
| `JSON.parse` on the control socket | malformed input | `shell/safe/json.ts`; Zod's `safeParse` then checks the shape |
| mDNS library | advertising | `shell/safe/mdns.ts` |

### The top-level handler

`shell/main.ts` registers `process.on("uncaughtException")` and `process.on("unhandledRejection")`. Either writes the error, synchronously, in a commit of its own to `hub_events` if the database works, always to `fatal.log` (append, flushed) and to standard error, then exits with code 70 for the service manager to restart (HB20). At the next start the boot record says how the last run ended: `clean` (clean-stop mark), `crash` (an entry in `fatal.log` newer than the last boot) or `unknown` (neither: a power cut or a kill). A `restarted` hub event records it, with the cause, and with "records after `t` may be missing" when the end was not clean (HB34).

### How every rejection and error reaches the audit record

- **Rejected packets**: the intake, gateways and setup modules count them per source, reason and minute (`rejects`, HB15). The reasons are the protocol's error codes (`truncated`, `badTag`, …, as the vectors' README names them) plus `unknownAddress`, `wrongPath`, `noSession`, `duplicate`, `tooOld`, `badFrame` and `textFrame`.
- **Link errors** come back as `sendFailed` and `linkClosed` inputs; the core records them as decisions or hub events.
- **Commit failures** come back as `commit {failed}`; the core records a critical hub event, which `fatal.log` holds until a flush succeeds.
- **Core faults**: `step` returns `Err(CoreFault)`; the shell keeps the previous state and hands the fault back to the core as the next input, an `inputRejected` with source `core` (the input's kind, origin, message and detail). The audit module records it as a critical hub event, written now, with the next record number like any other, so records stay in time order. A fault on that input is reported to `fatal.log` and standard error only, so a fault cannot loop. More than 100 in an hour exits for a restart ‡.
- **Inputs the shell refused** (a malformed control line, a USB frame COBS refused) reach the core as `inputRejected` and are recorded (section 2).
- **Device errors**: Started's reset cause and last fatal error (FW5) are decisions; log entries are `device_log` rows (D110).
- **Control errors**: answered with the error, and the command recorded with its outcome.
- **The lint rule** below makes sure no `Result` is dropped on the way.

### The rule that every result is used

ESLint 10's flat configuration has no maintained plugin for this (the original `eslint-plugin-neverthrow` predates flat config, and its forks state no ESLint 10 support), so it is our own small typed rule.

- **Where.** `tools/eslint-plugin-hsn/src/rules/must-use-result.ts`, built with typescript-eslint's `RuleCreator` and the type checker of `parserServices`. Registered in the root `eslint.config.js` as `hsn/must-use-result`, an error for `hub/**/*.ts` and `tools/**/*.ts` (and the relay later).
- **What it flags.** An expression whose type is, or is a union containing, `Result`, `Ok`, `Err` or `ResultAsync` declared in the `neverthrow` package (matched by symbol name and declaring file), the protocol package's `Result`, or a `Promise` of any of these, when the value is not used:
  - an expression statement, including a call statement and `await x;`;
  - the operand of `void`;
  - any but the last operand of a comma expression;
  - the concise body of an arrow function whose contextual return type is `void` (`items.forEach((i) => save(i))`);
  - a statement of an optional call (`a?.b()`).
- **What it does not flag.** A value returned, assigned or declared (TypeScript's `noUnusedLocals`, on in `tsconfig.base.json`, catches a variable never read), passed as an argument, put in an object or array literal, used in a condition, or consumed by a method call (`match`, `map`, `andThen`, `isOk`). A method that returns a new `Result` is checked in its turn, so `r.map(f);` alone is flagged.
- **How it is tested.** `tools/eslint-plugin-hsn/test/must-use-result.test.ts` runs typescript-eslint's `RuleTester` under Bun's test runner, with a fixture `tsconfig.json` and the real `neverthrow` types, over valid and invalid cases for every form above. A repository probe, `hub/test/lint-probes/drops-result.ts`, must fail with exactly this rule. The rule's tests run on every `bun run check`, against the pinned ESLint 10.13, typescript-eslint 8.72 and TypeScript 6.0.

## 11. Test strategy

### Unit tests of the core, against the protocol's vectors

- `hub/test/world/vector-cipher.ts` is a `DeviceCipher` keyed from the vector files.
- **Packets in:** every case of every to-hub vector file (`heartbeat.json`, `door-changed.json`, `cover-changed.json`, `button.json`, `started.json`, `siren-report.json`, `hello.json`, `forwarded-packet.json`, `gateway-status.json`, `transmit-result.json`, `interference.json`, `log-entries.json`) is opened through the intake or gateways module and must give the case's fields. Every case of `rejected-packets.json` must give its error as the right rejection reason, counted and not acted on.
- **Packets out:** for every from-hub file (`reply.json`, `disarmed-notice.json`, `siren-command.json`, `siren-settings.json`, `welcome.json`, `transmit-request.json`, `gateway-settings.json`), the core is put in the state that makes it send that case's message with that case's counter and binding, and its bytes must equal `packet` exactly.
- `counters.json`, `units.json`, `time-on-air.json` and `pairing-data.json` check the core's use of the package: windows saved and restored, rounding of tenths, ppm and seconds, the timing rules, the Provision message.
- Every rule of section 8 has unit tests at its boundaries: the slot formula, the clock-correction formula with drifts of ±3%, the reply-rate choice at each margin, D107's n, each silence threshold at each rate, the noise baseline, the late-report ranges, the arming states, the siren correction rule, gateway session takeover and hello replay.

### Scenario tests: days of hub time in milliseconds

- `hub/test/world/` holds a `World`: the real `step`, a virtual `Now` (mono, wall, trust), seeded entropy, fake links, the vector cipher, and scripted devices written in TypeScript on `@hsn/protocol`: a gateway (hello, forwarding with a gateway clock and drift, transmit results with a modelled busy radio and the 20 ms rule), sensors (heartbeats in slots with clock drift, events with retries and ages, flag bits 5 and 7), sirens (Wi-Fi and LoRa, pacing, reports). The world jumps from deadline to deadline; nothing sleeps. A simulated day of home B should take under 2 s on a Mac.
- The writer is a real one on an in-memory or temporary SQLite file where a test needs persistence, otherwise a recording fake.
- The test hub's rules each become a scenario, so nothing the bench relies on is lost: heartbeat replies only on a version change or when asked, at the reply moment; a reply skipped when the radio is busy; event replies as soon as possible, bound to the report; a countdown per sensor and the notice twice; sirens on both paths until a report confirms; repeats every 2 s and 5 s for a minute; settings at the held rate until confirmed; replies at the rate the sensor listens at; one at a time (settings wait; a newer command replaces; a late copy is dropped by the siren); the three late-report ranges; one command per siren per alarm; an alarm that ended by itself commanded afresh by the next; log entries recorded, repeats marked, a sensor's answered at its listening rate, a siren's and a gateway's not; two gateways, one copy accepted, the reply through the first.
- New scenarios: D50 arming with a door open; D67 after an alarm; D95 a partial disarm; D106 an opening before arming; D107 n chosen over a week of losses; slots and corrections converging for 30 sensors with drifts between −3% and +3%; reply rates on a DR2 site; every silence rule; interference, the learned-as-normal case and damaged packets; gateway takeover by a replayed hello; heartbeats that show an unexpected door state or change count, armed and disarmed (a warning, never a countdown); the hub restarting with the downtime known by wall clock, known by a gateway's uptime, and unknown, each during a countdown and during an alarm; a wall clock that steps forward and back; site moves (D115): DR5 to DR2 with an idle sensor, a door opening just after the switch and a siren on Wi-Fi (section 7's table), DR5 to DR0 with the SF12 interval floor and new slots, a channel-only move, a siren on LoRa alone that misses its settings, a gateway offline at the switch whose old-settings packets are answered still announcing, a sensor out of touch through the announcement (the stall warning, then force, then state 5), cancel with one sensor missing the cancelling reply, a switch that waits for a countdown and for an alarm, a sensor paired during the announcement and waited for, a sensor paired after the switch on the new settings, the silence grace, and a hub restart at each stage, including between the switch's commit and its sends.

### Write budget

`hub/test/budget/` runs a simulated day of home A and of home B on the whole hub (`test/world/home.ts`: every real module, the loop of section 4, the real writer on a real SQLite file, scripted gateways, sensors and sirens). The day follows section 5's traffic: about 20 door changes a day per sensor, two disarmed countdowns, one gateway in each home. Before the day, the rows that retention would be deleting are laid out, so retention runs as it would. The writer counts commits by reason, and WAL frames from the WAL index's frame count after each commit (`shell/storage/wal.ts`: the `mxFrame` field of the `-shm` header, read without writing anything), times the page size plus the 24-byte frame header. It fails above section 5's budgets: 800 and 1,400 commits, 20 and 35 MB. A second day adds one five-minute alarm at 23:00 and allows 300 more commits. It projects the file at D57's retention (section 5) and fails above 70 and 120 MB. It also checks that `hsn status` and an open `--follow` stream cause no commit, and that a device sending a warning every second costs no more than its 60 an hour. Section 5 has the figures it measured.

### Crash tests

`hub/test/crash/` runs a day of home A on the whole hub (`crash.test.ts`, `harness.ts`): ten openings while disarmed by day; armed at 08:00 and 22:00, disarmed at 18:00 and 23:10; the back door opening at 23:00 for an alarm; a board added over USB at noon. The hub loses power at one of six points (`CRASH_POINTS`): `inStep`, `afterStaging`, `inCommit`, `afterCommit`, `afterSends`, `inCheckpoint`. "Losing power" keeps exactly the committed transactions, which is what `synchronous = FULL` guarantees: the database and its WAL are copied as they are at that moment, never the WAL index; inside a commit the WAL is cut anywhere among the frames that commit appended; inside a checkpoint the main file holds any mix of its pages before and after. The copy is the next run's disk, the hub starts again from it, and the scripted devices carry on without it meanwhile. Each point is tested at four moments that stage something written now (08:00:30, noon, 22:59:59 and 23:00:45), then 500 ‡ seeded random points over the day. After every restart:

1. no (key, counter) pair was ever sent by two runs of the hub (the same bytes sent again, a siren command on two paths, are one use);
2. every "countdown started" reply that left the hub has a countdown, an alarm or a disarm after the restart;
3. every arm or disarm the CLI was told of survives;
4. an alarm saved before the stop is still there to resume, no alarm is cancelled by the restart, and no siren is commanded for an alarm that had ended;
5. every committed item is in the database and only the batch staged since the last commit is missing; the restart says records after the last commit's time may be missing;
6. every packet accepted since the last commit, and the last 20 before it, is forwarded again: none causes a countdown, an alarm, an arming change, a confirmed command, a report while disarmed or a device restart (`countdown_started`, `countdown_continued`, `late_report_sirens`, `alarm`, `armed`, `disarmed`, `siren_confirmed`, `report_while_disarmed`, `device_started`);
7. every key a board was given is in the database.

A second layer (`kill.test.ts`) runs the real process, `src/shell/main.ts`, with a scripted gateway on the `/device` WebSocket, kills it with `kill -9` at random moments and starts it again on the same data folder: 8 runs by default, 100 a night in continuous integration (`HSN_KILL9_RUNS=100`). After every run the database passes SQLite's integrity check, each run was a boot of its own, and no counter the hub sealed for the gateway was used by two runs. Before release, a Pi 4 has its power cut 50 times ‡ under load, with the same checks.

### Conformance with the firmware, through the bridge to the bench

Two ways to join the real hub to the firmware's simulation.

**Real time: M1a's "done when".** The bench runs in real time; the real hub runs as usual; they meet on pseudo-terminals.

The hub's side:
- `--serial <path>` opens a pseudo-terminal as a USB serial link (section 3). A gateway's USB link is used exactly as a board's would be, setup messages included, so the bench's boards are provisioned by `hsn usb add` like real ones (PR5).
- Network links (the siren's Wi-Fi, a gateway's Wi-Fi) go through `tools/bench-bridge`: it opens the bench's pseudo-terminal for each, decodes COBS frames, and holds one WebSocket to the hub's `/device` per link, one frame per message, both ways. So the hub's own WebSocket code is what the siren reaches. Closing either end closes the other.
- The scenario's arm and disarm are `hsn` commands; the checks read the bench's timeline and `hsn log`.

What the bench must provide:
1. **A real-time driver** for the `Simulation`: true time follows the host's monotonic clock; external input is delivered at its arrival instant; it never runs ahead of the host clock and reports any lag over 5 ms.
2. **An external link peer**, a `LinkPeer` (FD 8) that joins a device's `LinkWire` to a pseudo-terminal, framed with COBS and a zero byte as on USB (§10), for USB and network links alike. A network link is up while the far end holds the terminal open; `drop()` closes it.
3. **A manifest** (JSON) naming each device, its role, its link kinds and each terminal's path, written when the run starts.
4. **Unpaired development builds at start**, sensors on USB power until the script turns it off, so the hub provisions everything (§10).
5. **A script interface** on standard input or a socket: door, cover and button inputs, power loss, restart, path loss, cutting a link, scripted noise, USB power, quit; and the timeline written as JSON lines while it runs.

Done when, as the build plan states it: the bench's sensor, gateway and siren reach the real hub; opening the armed door starts the buzzer; the siren role switches when the countdown ends, unless `hsn disarm` comes first. That is `chain_test.cpp`'s two cases, run in about two minutes of real time, with "the hub restarts during the countdown and the sirens still sound" added.

**Lockstep: the bench's system tests against the real hub.** Real time cannot run a day in a test. The hub is to have a second mode, `--bench-lockstep <socket>`: its clock driven by the bench, its links carried on that socket. Built so far: the lockstep messages and the manifest as Zod schemas (`control-protocol/lockstep.ts`, `manifest.ts`) and the `Links` side (`shell/links/lockstep.ts`), which releases the bench's frames in time order and keeps every frame the hub sends for the next `idle`; `main.ts` does not yet take the option (section 12).
- The hub's side: a `Clock` that returns the time the controller last gave; a `Links` implementation whose frames arrive on the socket; the real core, the real writer on a temporary file, the real control commands. After `advance {to}`, the hub handles every frame given with time ≤ `to`, commits what is due by the rules of section 5 (so the bench also tests the batching), performs its effects, and answers `idle {frames: [...], records: [...], wake}`: the frames it sent, the records it made, and its next deadline.
- What the bench must provide: a `RemoteHub` in `hsn_host` with the parts of `TestHub`'s interface the system tests use (`add_sensor`, `add_siren`, `add_gateway`, `arm`, `disarm`, `command_siren`, `change_gateway`, `drop_link`, `decisions`, `received`, `received_from`, `sent_to`, `log_entries`, `dump`), turning each into control commands, answering the record questions from the records the hub streams in its `idle` answers (never from the database, which in lockstep sees only five-minute commits), and scheduling the hub as one more actor whose wakes come from `idle`. `HubAction` names map onto the hub's records through `benchActions` (section 6): the hub's decision kinds include every `HubAction` name, and the ones about a packet's outcome are read from its `tx` row; a test checks the names stay a superset. `HubOptions` and the config structs map onto site and device settings: `alarm_seconds` onto the automatic stop, fixed reply rates and clock corrections onto `reply-rate=` and `correction=`.
- Expected differences: the real hub always plans slots (the test hub only with `heartbeat_slots`); boards are provisioned over USB, so each starts with one more boot and a few more flash writes, which tests that count flash writes must allow for.

Which of the firmware's tests the real hub must pass in place of the test hub:

| Test | Mode | Why |
| --- | --- | --- |
| `tests/system_roles/chain_test.cpp` (2 cases) | real time and lockstep | M1a's "done when" |
| `tests/system_roles/restarts_test.cpp` (3) | lockstep, and the first in real time | D80, §6 Started, SR5 |
| `tests/system_roles/lost_path_test.cpp` (4) | lockstep | DS6, D88, D106, D73, D80 |
| `tests/system_roles/two_gateways_test.cpp` (1) | lockstep | GW9, D28 |
| `tests/system_roles/sirens_test.cpp` (1) | lockstep | §7, D52, D73 |
| `tests/system_roles/interference_test.cpp` (2) | lockstep | GW11, D82, DS6, LR4 |
| `tests/system_roles/heartbeat_reply_test.cpp` (4, and the 3 day-long) | lockstep | D108, §8, D72 |
| `tests/system_roles/load_test.cpp` (4, and the 5 day-long) | lockstep | D95, D110, D111, D52, D107, D108 |
| `tests/system/armed_door_test.cpp` | lockstep | M1a's chain with the scripted gateway |
| `tests/host/test_hub_gateway_test.cpp` (5) | lockstep | the hub's side of the gateway link |
| `tests/system_roles/site_move_test.cpp`, to be written once the sensor, siren and gateway roles implement §7's move | lockstep | D115: section 7's table with the real roles (idle sensor, door just after the switch, siren on Wi-Fi), and a siren on LoRa alone; the test hub needs the same rules first, so the bench can check the roles before the real hub joins |

Not applicable: the tests of `tests/host/` that run the test hub in direct radio mode (`test_hub_test.cpp`, `test_hub_log_test.cpp`, `readme_example_test.cpp`, `hub_radio_test.cpp`), because the real hub has no radio of its own; their rules are the scenarios above. The bench's own tests (`medium_test.cpp`, `simulation_test.cpp`, `timeline_test.cpp`, `replay_window_test.cpp`, `fake_link_test.cpp`) test the bench.

### Measurements on a Raspberry Pi 4 before release (HB35)

A week of home B's load from the scripted devices against a hub on a Pi 4 with a memory card: resident memory (`/proc/<pid>/status`), processor time (`/proc/<pid>/stat`), per-packet times from the core's own timing records, commit times, sectors written (`/proc/diskstats`), file size; the 50 power cuts above; and a start with no network, to check the unknown-downtime rule.

## 12. The order of work

**Step 0, one engineer, frozen before anyone else starts.**

- Workspaces: `hub` and `tools/*` added; `hub/package.json` with `neverthrow`, `hono`, `drizzle-orm`, `drizzle-kit`, `zod`, `serialport` and an mDNS library, pinned.
- Lint: the layer rules of section 1 and `hsn/must-use-result`, each with its probe.
- `hub/src/core/model/`: `Now`, `Input`, `HubEvent`, `Internal` (every internal message kind), `Effect`, `StoreOp`, `AuditRecord`, `DecisionKind` (a superset of the bench's `HubAction`), `CoreFault`, `HubRules`, `TimerKey`, ids, `HubState` with every slice's type as an opaque interface, the `Handler` and `Context` types.
- `hub/src/core/step.ts`: the dispatcher with stub modules that accept nothing.
- `hub/src/ports/`: every interface of section 3.
- `hub/src/db/schema.ts` and the first migration: every table of section 6.
- `hub/src/control-protocol/`: every command of section 9.
- `hub/test/world/`: the `World`, the vector cipher, and a scripted gateway.
- For the site move (D115): the internal messages `siteChangeRequested`, `siteMove` (stage and target, read by sensors, gateways and sirens), `siteConfirmed`, `siteFollowed`; the decision kinds `move_requested`, `move_confirmed`, `move_stalled`, `move_switched`, `move_forced`, `move_cancelled`, `device_followed`, `move_done`; the store operations for the `site` move columns, the `sensor_config` and `siren_config` columns of section 6 and device state 5; the control commands `site change`, `site change status`, `site change cancel`, `site change force`.
- The event listen time comes from `@hsn/protocol` (`EVENT_LISTEN_MS`, beside `timeOnAirMs`); the firmware's tests should check `kEventListenMs` against it, so hub and sensor cannot drift apart (§8).
- The bench lockstep messages (`advance`, `frame`, `idle`) and the manifest format, agreed with the firmware engineer.

**Step 1, in parallel.** Each engineer owns the folders named, and changes a frozen interface only by asking the step 0 owner.

| Engineer | Owns | Delivers |
| --- | --- | --- |
| E1 | `core/gateways/`, `core/links/`, `shell/links/` | sessions and takeover, settings, forwarded packets, transmit requests and results, clock mapping, status, noise rules, gateway silence; serial and WebSocket adapters, USB watching |
| E2 | `core/intake/`, `core/sensors/`, `core/slots/`, `core/site/`, the scripted sensor in `test/world/` | acceptance and rejection, replay windows, replies and their timing and rates, versions, reply-rate choice, slots, clock correction, sensor silence and D107; the site move (D115) end to end, with E1 sending the gateway settings and E3 the siren settings it asks for |
| E3 | `core/alarm/`, `core/sirens/`, the scripted siren | arming states, countdowns, late reports, the alarm, what sirens should do, commands, repeats, one at a time, correction, paths, siren silence, the restart rule |
| E4 | `shell/storage/`, `shell/safe/`, `core/audit/`, `core/clock/`, `test/budget/`, `test/crash/` | the writer and its commit rules, SQLite settings, the send gate, the reader and snapshot, migrations, records, rejection counts, retention, wall trust and downtime, the top-level handler, the budget and crash tests |
| E5 | `core/registry/`, `core/setup/`, `core/control/`, `shell/control/`, `hub/cli/`, `shell/advertise/` | the registry, USB setup and provisioning, auto-add, the control socket and every command, the signing key and identity, mDNS |
| E6 (firmware) | `firmware/platform/host/` additions, `tools/bench-bridge/` | the real-time driver, the external link peer, the manifest, the script interface; `RemoteHub` and lockstep |

**Each owner's check.** Five engineers worked in one checkout at once, so `bun run check` failed for everyone while one of them was mid-edit. `bun run check:own <folders>` (`tools/check-own/`) checks one owner's folders: the type check on the whole project, reporting only the errors inside the named folders and counting the others; ESLint and Prettier on the named folders; the tests under them and the lint probes. It fails only for the named folders. Before merging, `bun run check` must pass for the whole repository.

**Step 2, integration**, by the step 0 owner with each engineer: `shell/loop.ts` and `shell/main.ts`; the scenario days; the write-budget and crash tests green. Done. The changes integration made to the frozen interfaces are described where they belong: `inputRejected` (section 2), `deviceLeftBehind` (section 2's table, for a forced move's state 5), the command's record on every request (section 9), `radioResult`'s request counter and a duplicate's copy in `rejected` (section 2's table), `PruneOp`'s time cutoff (section 6), `OpenFailure` (section 3), the provisioning keys in the snapshot (section 2), strict request schemas (section 9).

**What remains before the bench.** On the hub's side: `--bench-lockstep` in `main.ts`, joining the lockstep link adapter to a lockstep clock and the `advance`/`idle` exchange; and `tools/bench-bridge/` for the real-time run's network links. On the firmware's side (E6): the real-time driver, the external link peer, the manifest and the script interface; then `RemoteHub`. Then the real-time "done when", and the lockstep suite, test by test, in the order of the table in section 11.

**Step 3**, on the boards and a Pi: M1b's boards against the same hub; the Pi measurements; the values marked ‡ revisited.

## 13. Risks, open questions and gaps

### Decided by the product owner, 2026-11-13

| # | Question | Decided | Where |
| --- | --- | --- | --- |
| 1 | A hub that cannot tell how long it was off (a Pi 4 with no clock battery and no network): what happens to a saved countdown and alarm? | A countdown resumes with the time it had left and sounds the sirens at its end unless disarmed; an alarm is not sounded again unless a siren reports it is still sounding; both are judged again as D80 says once the real time off is known (section 5) | D113 |
| 2 | Commit door, cover, button and Started reports at once, so they can never be replayed after a power cut? | Yes, with every warning or worse | D112; protocol.md §4 "Known limits" |
| 3 | How long may routine records wait in memory? | Five minutes; once a second while a countdown or alarm runs. Efficiency comes first (section 5) | D112, HB35, stack.md "Database writes" |
| 4 | A delayed report says the door opened before the sensor was armed | It counts as a door open at arming: it arms when it closes, with no countdown (section 8) | D114, refining D106 |
| 5 | Does a later trigger extend the sirens' time in an alarm? | No; each siren sounds for the automatic stop from its first command in the alarm (section 8) | D114, refining D95 |
| 6 | Site channel and data rate travel only in the pairing data, so changing either means pairing every device again | The hub changes them over the air in three steps, announce, switch, follow; no device is paired again unless a forced move leaves it behind (section 8) | D115; protocol.md §2, §6, §7 |
| 7 | How many missed heartbeats make a sensor silent before it has a day of loss data? | 5 (section 8) | D114, refining D107 |
| 8 | A second door during an alarm: its own countdown or sirens at once? | Its own countdown (section 8) | D114, refining D95 |
| — | A check-in by the sensor at the countdown's end, so that a hub or gateway failing during a countdown still ends in sirens | Turned down: nothing sounds until the hub is back (section 5); an accepted limit | D113; protocol.md §7 |

### Gaps that remain in other documents (not edited here)

| Where | Gap | Reading taken |
| --- | --- | --- |
| protocol.md §2, §9 | The site channel is chosen "on the first gateway's noise measurement", but a gateway measures only its current channel | The hub surveys by changing the gateway's settings (section 8) |
| protocol.md §4 "Known limits" | Says routine replays are "corrected by the next real one". That holds only with section 8's rules: readings follow the newest packet, a heartbeat never changes arming or starts a countdown, and siren commands on Wi-Fi go to every recent socket | Those rules; §4 could name them |
| protocol.md §5 | Whether an authentic packet of an unknown type enters the replay window | It does, so its replay is refused |
| protocol.md §7 "Reply timing", §8 | The heartbeat reply goes "at a fixed moment, the heartbeat reply moment after the packet finished arriving, on the gateway's own clock"; the sensor counts that second on its own uncorrected clock, so a sensor more than 2% slow never hears a heartbeat reply and is never corrected by one | The hub aims at the moment the sensor will be listening, from its clock estimate (section 8); §7 should say the moment is the sensor's |
| architecture.md D16, D29 | Windows is a supported host, but the hub cannot open a USB port there (O18) and refuses its control socket (section 9) | Open: O18, and the installer work (O7) |
| build-plan.md, spike table | S8 is listed as sleep current only, but protocol.md §7 and §14 give S8 the sleep clock's wander, which the slot guard and correction need | Both; the build plan's order list already buys crystals "for the sleep-clock test (S8)" |
| `packages/protocol` | Has no README; only `vectors/README.md` exists | — |

### Risks

| Risk | What settles it |
| --- | --- |
| Commit times on a memory card block the event loop longer than the budget | Pi measurement; the writer moves to a worker thread behind the same port (section 3) |
| Cards amplify small synced writes by an unknown factor | `/proc/diskstats` over a week on two card brands; the event and warning commits dominate, so their caps (section 5) are the lever |
| A device that floods warnings | The 60-an-hour cap per source (section 5); the budget test checks it |
| The largest site sits at 197 MB, 10% under the size guard's upper mark (section 6) | Projected from a simulated day, not from a real 64-sensor home; if a real one trims at D57's retention, the marks or the shares move |
| A sensor whose door-closed report was lost waits for its door to close until its next door event (section 8) | Accepted: the price of never acting on a heartbeat; its heartbeat raises a warning meanwhile |
| `TimeTrust` on systems without systemd's time service | Check on Raspberry Pi OS, Debian and Ubuntu; otherwise the hub treats the clock as untrusted and relies on a gateway's uptime for downtime (section 5) |
| Bun on the Pi 5's 16 KB memory pages (from memory, unverified) | The D94 checks, on a Pi 5 |
| `serialport` port listing spawns udev on Linux | Watching `/dev` instead (section 3); measure |
| `serialport` crashes Bun on opening a port (O18); the hub opens ports through `node:tty`, untried on a real board's USB port | M1b; on Windows a port opener or a fixed Bun |
| The control socket on Windows: refused until a pipe can be limited to the hub's account (section 9) | The installer work (O7) |
| The mDNS library under Bun as a background service | S1 passed advertising; recheck as a service (O7) |
| Lockstep and the real-time bridge are not finished (section 12): conformance with the firmware is untested against the real hub | They gate conformance, not the hub's own tests; the scenario, budget and crash tests carry every rule meanwhile |
| Slots and clock correction rest on a sleep clock not yet measured (S8) | Guard and thresholds are ‡ and live in `HubRules` |

### What the firmware's test hub does that a real hub must not

- A hello always replaces the live session, whatever its counter: a replay cuts the real gateway off (section 8).
- Counters start at 1 on every run and are never saved, and keys are derived from the address and a seed. Right for a bench, wrong anywhere else.
- Arming is one flag for the whole house, and arming or disarming bumps every sensor's version, changed or not. A real hub holds armed state per sensor (D74) and bumps only what changed.
- A late report that sounds the sirens is not recorded as a trigger of the alarm, so D95's "a disarm ends the alarm only when every trigger is disarmed" cannot be applied; and an opening reported from before the arming starts a countdown.
- The best gateway for a siren never ages: a gateway that once heard it loudly stays first.
- Transmit requests that never get a result are kept forever and never recorded as unanswered.
- Replies go at 14 dBm by default, while the faster reply rates of D108 assume the gateway's higher power.
- An authentic packet whose body fails to decode is not marked as seen, so each replay of it is opened and logged again.
