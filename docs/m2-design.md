# M2 design: the hub and the app's web build

Proposed 2026-11-14 and revised with the product owner's answers (D116 to D122) and a protocol review, for review before any code is written. It designs milestone M2 of [build-plan.md](build-plan.md), "Hub and the app's web build", on top of the hub that M1a built and proved, which [hub-design.md](hub-design.md) describes. Done when, as the build plan states it: **a fresh computer goes from installer to an armed house using the web app, and the M1 boards work against it.**

"HD" means a section of [hub-design.md](hub-design.md), "§" a section of [protocol.md](protocol.md). D and O numbers refer to [architecture.md](architecture.md); HB, AL, AP, GW, PR, RA and SR numbers to [software.md](requirements/software.md). Values marked † are provisional values from those documents. Values marked ‡ are this design's own choices, each to be set by a measurement or confirmed in review; section 7 lists the rule values, the others are marked where they appear. Section 12 records what the product owner decided and the one question still open.

The design in eight lines:

- The core stays one pure function with its thirteen modules in their order. M2 adds seven modules (`people`, `layout`, `app`, `schedules`, `health`, `notify`, `upkeep`) at fixed places, and changes `alarm` and `control`. Nothing in the device path changes, so everything lockstep proved stays proved.
- Apps talk to the hub over a WebSocket carrying the Noise protocol: `Noise_IK` for every session, `Noise_XXpsk3` once, for linking. Inside, JSON requests, replies and events, checked by Zod schemas in `@hsn/protocol`. Every request is authenticated by the client's own key; every change also carries a per-client sequence number, so no request can be replayed.
- The shell owns the sockets, TLS and the Noise sessions, as it owns serial ports and device keys today. The core sees an authenticated client id and a validated request, and decides everything: who may do what, which sensors a mode arms, what is notified to whom.
- Armed state stays per sensor (D74). Modes and groups are only ways of choosing which sensors to arm; the M1 commands `arm --all` and `disarm --all` become switches to the fixed modes Away and Disarmed (D90).
- Every new table is configuration, written now and a few kilobytes in size. M2's own records add about 320 rows and 15 commits a day: under 1% of the write budget and about 2.5 MB at D57's retention.
- The web app is the Expo export of the one app codebase (D93), served by the hub with no service worker (D105): to the hub computer's own browser on a loopback port, and to other browsers on the home network over HTTPS with the hub's own certificate.
- The installer registers the hub as a service on macOS, Linux, Raspberry Pi and Windows (D118). Windows needs two problems solved that M1a left open, a serial port under Bun (O18) and a command socket only the right accounts can reach; spikes settle both before anything depends on them (sections 9 and 11).
- Backups hold the configuration and keys, which is what D53 lists, so they are small; their key is held by linked phones (D78), so restoring one becomes usable with M3 and nothing stands in for it before (D119). Hub updates install beside the running version and roll back on a failed start (D54).

## 1. What M2 builds, and what stays

### The build plan's rows, and where each is designed

| M2 piece | Requirements | Here |
| --- | --- | --- |
| Data model: users, permissions, devices, groups, modes, schedules, history | HB4, HB5, HB5a, HB7, HB29, HB32, D90 | Sections 2, 4, 7 |
| Arming rules: modes and groups, open-door arming, countdown, alarm, siren choice, automatic stop, post-alarm rule, restart resume | AL1–AL11, HB30 | Section 7, "Modes, groups and arming"; the countdown, alarm, automatic stop, post-alarm rule and restart resume are built (HD 8) and change only where groups choose sirens |
| Device health: silence detection, tamper, low battery, siren paths, gateway silence, jamming | HB8–HB10, HB25, HB33, SR6, GW6, GW11 | Section 7, "Device health"; detection is built (HD 8), M2 adds battery percentages, tamper notices and the notifications |
| Schedules as single actions, timing logic carried over | HB13, HB31, AL2, AL10, D87 | Section 7, "Schedules" |
| Notifications engine with categories | D75, D76, D92 | Section 7, "Notifications" |
| App messages and live updates inside the encrypted channel, every request authenticated | HB3, HB3a, HB14 | Sections 5 and 6 |
| Linking of phones and browsers with keys, invites, removal | D61, D62, D99 | Section 5, "Linking"; section 7, "People and permissions" |
| History and retention | HB15, HB24 | Section 7, "History" |
| The app, web build: setup, linking QR code, modes, arming, groups, schedules, devices, history, users | AP0, AP1, AP4, AP5, AP7, D93 | Section 8 |
| Installer and background service for Windows, macOS, Linux, Raspberry Pi; sleep prevention; gateway discovery | HB18–HB21, HB28, GW8 | Section 9 |
| Backup, export, restore | HB22 | Section 9 |
| Hub updates | HB23 | Section 9 |
| Gateway over USB, added automatically | GW10, PR7 | Built in M1a (D100, HD 9); M2 adds only that the app shows it was added |

### What does not change

These are proved by the hub's tests and the firmware's lockstep suite, and M2 must leave them proved:

- **The core's shape.** One pure `step(state, input, deps)`; timers as data; every message to every module in a fixed order, a timer only to its owner; modules write only their own slice and read others through `view.ts` (HD 2). The thirteen modules keep their relative order.
- **The ports and the layer rules** (HD 1, 3). M2 adds ports; it changes none.
- **The durability classes, the commit rules and the send gate** (HD 4, 5). Every M2 item is put in one of the two classes; no third class.
- **The write budget and the size guard** (HD 5, 6), with the limits the budget test fails on.
- **The device path.** Intake, gateways, sensors, slots, sirens, site and the protocol are untouched. So is the lockstep wire, version 2 (HD 11): M2 adds control commands, which the wire carries unchanged inside its `control` message, and records, which it carries in `idle`.

What changes, and why:

| Module | Change |
| --- | --- |
| `alarm` | A trigger sounds the sirens of its groups, every siren for a sensor in no group (AL2a, D41, D74), instead of every siren. Arm and disarm requests arrive already resolved to sensors, with the actor and whether confirmation was given; `alarm` keeps the per-sensor states it has. It reports open doors and low batteries for a request that needs confirmation (D50, AL12) |
| `control` | The hub computer's commands gain the M2 commands (section 6); `arm --all` and `disarm --all` become mode switches to Away and Disarmed, with the same effect on the sensors as before |
| `audit` | New record kinds: requests from apps (as `commands` rows), notifications, people's actions |

### Arming in M1 and in M2

M1 has one house, every sensor armed or disarmed by hand. M2 keeps the per-sensor state exactly and puts a layer over it:

- `hsn arm --all` is now "switch to Away", which arms every sensor (D90); `hsn disarm --all` is "switch to Disarmed". The sensors end in the same states as before, and the decisions are the same per sensor (`armed`, `disarmed`), with one new decision before them, `mode_switched`.
- `hsn arm <sensor>` and `hsn disarm <sensor>` are unchanged: a single sensor armed by hand (AL1).
- A site with no groups and only the two fixed modes behaves exactly as M1: every sensor is in no group, so every trigger sounds every siren.

The recorded lockstep sessions (HD 11) change only by the added `mode_switched` records. They are regenerated and their diff reviewed with the firmware side, as HD 11 says for any change of records.

## 2. The core in M2

### The modules, in order

The new modules go where their inputs and outputs need them. Every existing module keeps its relative place.

| Order | Module | New or changed | Owns | Acts on | Emits |
| --- | --- | --- | --- | --- | --- |
| 1 | `clock` | | as built | | |
| 2 | `registry` | | as built | | |
| 3 | `links` | | as built | | |
| 4 | `setup` | | as built | | |
| 5 | `control` | changed | as built, with the M2 commands | `command` | requests to the owning modules, with the hub computer as actor |
| 6 | `people` | **new** | people, linked clients and their public keys, permissions, the user-management switch, link tokens and invites, each client's last accepted sequence number | `clientLinked`, `linkFailed`, people and permission requests, `downtimeKnown`, timers (token expiry) | `clientAdded`, `clientRemoved` (the shell closes its sessions), rows written now |
| 7 | `layout` | **new** | groups and their members, the sirens of each group, modes and their groups, the current mode | layout requests, `deviceAdded`, `deviceRemoved`, mode-switch and group requests | arm and disarm requests resolved to sensors (`armSensors`, `disarmSensors`), rows written now |
| 8 | `app` | **new** | app sessions (connection, client, person, protocol version, subscriptions), the live revision | `clientConnected`, `clientRequest`, `clientClosed`, every `auditRecord` and state message (to build events) | requests to the owning modules with the person as actor, `appSend` effects (replies and events) |
| 9 | `schedules` | **new** | schedule entries, each one's next time, the hub's time zone | schedule requests, timers, `wallTrustChanged`, `timeZone`, `downtimeKnown` | mode-switch, arm and disarm requests with the schedule as actor, rows written now |
| 10 | `gateways` | | as built | | |
| 11 | `intake` | | as built | | |
| 12 | `alarm` | changed | as built, with the sirens of each trigger's groups | as built, plus `armSensors`, `disarmSensors` | as built, plus `needsConfirmation` answers |
| 13 | `site` | | as built | | |
| 14 | `sensors` | | as built | | |
| 15 | `slots` | | as built | | |
| 16 | `sirens` | | as built | | |
| 17 | `health` | **new** | battery percentages and low-battery state per device, tamper state | `accepted` (readings), decisions of silence and paths | health decisions (`battery_low`, `battery_ok`, `tamper_opened`, `tamper_closed`, `long_press_ignored`) |
| 18 | `notify` | **new** | notifications, who each is for, each client's categories and what it has read | every decision record, `clientConnected` | `notification` records, and a `notificationRaised` message naming the clients to tell; `app` sends the events, so every event carries `app`'s `rev` |
| 19 | `upkeep` | **new** | backup settings, whether a backup is due and since when, the backup key and its epoch, a restore in progress, the update state (section 9) | the decisions and messages that change people, clients, permissions, user management or paired devices; `fileReady`, `restoreOpened`, `restoreKey`; its operations (`backup.*`, `restore.start`, `update.*`); timers (the daily backup, the 60 s coalescing, the 5-minute retry, the 1-hour warning, the update's wait) | `fileJob` effects, its decisions, rows written now |
| 20 | `audit` | changed | as built | as built | as built |

Why this order:

- `people` before `layout` and `app`: a request is checked against a person's permissions, and the permissions must already reflect a removal in the same step.
- `layout` before `app`: to check HB5a ("may switch to a mode only if they can manage every sensor the switch would arm or disarm"), `app` reads from `layout` which sensors a switch touches. It reads the view, so `layout` must have handled any change to the mode earlier in the queue.
- `app` and `schedules` before `alarm`: both produce arming requests. `layout` resolves them to sensors in a later turn of the same step's queue (a message emitted joins the back of the queue, HD 2), and `alarm` acts on the result in the same step. One input, one step, one commit.
- `health` after the device modules, `notify` after every module that makes decisions, `audit` last as before.
- `upkeep` after `notify`, so it sees every change of the step that a backup must hold before it decides that one is due; its own decisions reach `notify` in a later turn of the same step's queue.

**Requests for M1a's modules.** Some operations change what an M1a module owns (`OP_OWNERS` names `registry`, `sensors`, `sirens`, `gateways`, `setup`, `site`). Those modules are unchanged in M2 and take only their own request messages (`sensorSettingsRequest`, `deviceRenameRequest`, …), answered with `answer {request, reply}`. So `app`, after its checks (client, `seq`, permission), sends the M1a module the same request message `control` would send for the matching `hsn` command, with the person's actor text, and turns the module's `answer` into the reply. Its request numbers start at 2⁴⁰ ‡, above any the shell gives control requests (below 2³²), so `control` and `app` each take only the answers to their own. `m2OwnerOf` stays as built, for the owners that take `opRequest`. An answer that comes in a later step (`usb.add` answers when the board does, HD 9) commits the client's new last `seq` in the request's own step with the stored reply `pending`; the reply replaces it when the answer comes, and a retry of that `seq` meanwhile is answered when it does.

The `SendRef` scheme numbers modules by their place (HD 2), so the existing modules' numbers move. References are never stored, so nothing breaks; the dispatcher's tests check `sendRefModule` against the new order.

### New events and effects

```ts
type HubEvent =
  | …                                                          // every event of HD 2, unchanged
  | { kind: "clientConnected"; conn: ConnId; client: ClientId; listener: "lan" | "console"; proto: number; app: string }
  | { kind: "clientRequest"; conn: ConnId; client: ClientId; request: AppRequest }   // authenticated, decrypted, schema-checked
  | { kind: "clientClosed"; conn: ConnId; reason: ConnCloseReason }
  | { kind: "linkCompleted"; conn: ConnId; token: TokenId; staticKey: Uint8Array; listener: "lan" | "console"; link: LinkRequest }
  | { kind: "linkFailed"; token: TokenId; reason: "badPsk" | "malformed" }
  | { kind: "timeZone"; zone: string }                         // the hub computer's zone, at boot and when it changes
  | { kind: "fileReady"; job: JobId; outcome: FileOutcome }    // a backup, export or update file the shell finished
  | { kind: "restoreOpened"; conn: ConnId; token: TokenId }    // a restore handshake completed with a restore token (section 9)
  | { kind: "restoreKey"; conn: ConnId; token: TokenId; key: Uint8Array; epoch: number }; // the phone's backup key, after message 4
type InputRejection = | … | { source: "app"; conn: ConnId; reason: AppRejection; bytes: number; issues: readonly string[] };

type Effect =
  | …                                                          // every effect of HD 2, unchanged
  | { kind: "appSend"; conn: ConnId; message: AppMessage }     // a reply or an event, for the shell to encrypt and send
  | { kind: "closeClient"; client: ClientId; reason: string }  // every session of a removed client
  | { kind: "linkSecret"; token: TokenId; psk: Uint8Array | null } // a link token the shell may now accept, or no longer
  | { kind: "fileJob"; job: JobId; work: FileWork }            // write a backup, build an export, unpack or switch an update
  | { kind: "historyRead"; conn: ConnId; id: number; query: HistoryQuery; allowed: HistoryFilter }; // a history page (section 7)

type UploadRef = { conn: ConnId; job: number };               // a file the client uploaded on that connection (section 6)
type FileWork =
  | { kind: "backup"; folder: string; keep: number; key: Uint8Array; epoch: number } // also deletes this hub's files of older epochs
  | { kind: "export"; conn: ConnId; history: boolean; key: Uint8Array; epoch: number } // streamed as `fileChunk` events
  | { kind: "stageUpdate"; upload: UploadRef }                 // check the signature, unpack beside the running version
  | { kind: "switchUpdate"; version: string }                  // stop cleanly; the launcher switches (D54)
  | { kind: "readRestore"; upload: UploadRef }                 // read the header only
  | { kind: "applyRestore"; upload: UploadRef; key: Uint8Array } // decrypt, check and prepare the restored database
  | { kind: "switchRestore" };                                 // put it in place and exit 70 (section 9)
type FileOutcome =
  | { kind: "backupWritten"; name: string; bytes: number }
  | { kind: "exportSent"; bytes: number }
  | { kind: "updateStaged"; version: string }
  | { kind: "restoreRead"; identity: Uint8Array; epoch: number; madeMs: number; lastChangeMs: number }
  | { kind: "restoreReady" }
  | { kind: "failed"; reason: "unreachable" | "full" | "badFile" | "badSignature" | "notNewer" | "wrongKey" | "io"; message: string };
interface HistoryFilter {                                      // what the person may see (section 7, "History")
  devices: readonly DeviceId[] | "all";
  person: PersonId | null;                                     // their own requests and notifications
  clients: readonly ClientId[];
  hub: boolean;                                                // rows naming no device: manage system only
}
```

- **The client's key never enters the core as a secret.** A client's static key is public; `people` keeps it to list and remove clients. The shell holds the mapping from static key to client id (the `ClientKeys` port, section 5) and checks it during the handshake.
- **Link tokens and the backup key are the secrets the core makes in M2.** A token's pre-shared key comes from the input's entropy, as a device key does (HD 2), leaves the core once in a `linkSecret` effect and once in the answer that shows it (the QR code or typed code), and is stored in its own table, apart from every query, as device keys are. The backup key is made the same way by `upkeep` (at the first start of M2 and at each replacement, section 9), stored in its own table `backup_key`, and kept in `upkeep`'s slice because three things carry it: a phone's `LinkResult` and `backup.key` reply, and the backup and export jobs. It never enters a record, an event or any other row; a test checks every record and event of the scenario days for its bytes. A phone's restore key enters the core once, in `restoreKey`, and leaves it only in the `applyRestore` job.
- **The time zone is data.** The core may not read the system, so the shell gives the zone name at boot and whenever the computer's zone changes (checked every hour ‡).
- **Calendar arithmetic is a dependency.** `CoreDeps` gains `calendar: Calendar`, a pure function set over a fixed time-zone database (section 7, "Schedules"), as `cipher` is a pure function over keys. The core cannot use Temporal (HD 1's layer rules), so the shell passes it in. The shell's calendar uses Bun's built-in `Temporal` (stack.md: "built in or polyfilled"); no polyfill is installed, and the Bun version is pinned with the calendar's tests. Every call to it is made in `hub/src/shell/calendar/temporal.ts` through neverthrow's `Result.fromThrowable`, the one file that touches Temporal, as `core/util/protocol-safe.ts` wraps the protocol's functions; HD 10's table of wrapped libraries gains that row (section 13). The core's lint configuration refuses the globals `Temporal` and `Intl` and the methods that use them (`toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`, `localeCompare`) through ESLint's `no-restricted-globals` and `no-restricted-properties`.

```ts
interface Calendar {
  /** The first instant at or after `fromMs` (wall, UTC) when the local time in `zone` is `at` on a day `days` allows. */
  next(rule: { at: LocalTime; days: DaySet | { date: LocalDate } }, zone: string, fromMs: number): number | undefined;
  /** The local date and time of a wall instant, for records and the app. */
  local(ms: number, zone: string): { date: LocalDate; time: LocalTime; offsetMinutes: number };
}
```

### What the core sees of an app request

```ts
interface AppRequest {
  readonly id: number;              // per connection, for the reply
  readonly seq: number | undefined; // per client, required for every request that changes anything (section 5)
  readonly op: AppOp;               // the operation and its body, one variant per row of section 6
}
```

The shell has already checked the request's shape against `@hsn/protocol`'s schemas, and its sequence number's presence. The core checks everything else: that the client is linked and not removed, that the sequence number is above the client's last, that the person may do it, that the objects named exist and the revisions match.

## 3. Durability, the write budget and the disk ceiling

### Classes of the new state

Every M2 item is in one of HD 5's two classes. The rule HD 4 states is unchanged: **nothing is sent or answered before the "now" items that justify it are committed.** For an app request that changes something, that is the change, its `commands` record and the client's new last sequence number, in one commit.

| State | Class | Why | What a power cut loses |
| --- | --- | --- | --- |
| People, permissions, the user-management switch | Now | A removed person who comes back after a power cut keeps access | Nothing acknowledged |
| Linked clients: public key, person, kind, name, removed | Now, before `LinkResult` and before `closeClient` | A client told it is linked must be linked after a restart; a removed one must stay removed | Nothing acknowledged |
| Each client's last `seq` and the replies of its last 16 changes ‡ | Now, in the commit of the change they came with | A change must have one effect, also when its reply was lost or the hub restarted (section 5) | Nothing: a reply is sent only after it is committed |
| Link tokens and invites, with their keys; who linked whom | Now, before the code is shown, and as each link completes | A shown code must work after a restart, and a used one never again (D121) | Nothing shown or acknowledged |
| The backup key and its epoch, and which phone holds which epoch | Now, when made, replaced (section 9) or given | A phone must never hold a key the hub has replaced without knowing it | Nothing |
| Groups, members, group sirens, modes, the current mode | Now | Arming depends on them | Nothing acknowledged |
| Schedule entries; each entry's last run | Now; the last run in the commit of the arming it caused | An entry must not run twice, nor be forgotten | Nothing: the run and its arming are one commit |
| Critical notifications (countdown, alarm) | Now, in the commit of the decision that raised them, which is "now" already | They are what the owner looks for after an incident | Nothing |
| Other notifications, and what each client has read | Routine | Volume; a notification is also its decision's record | Up to five minutes of reads and non-critical notices |
| Battery percentages | Not stored: computed from the stored reading | Derived | — |
| Low-battery and tamper states (HB33's "raised once") | Now, when they change | A warning raised once must not be raised again after a restart | Nothing |
| Backup settings, the backup key, update state, whether a backup is due and since when (`backup_state.due_since_ms`, set in the commit of the change that makes it due, D122) | Now | Few and decisive; a backup due must still be due after a restart | Nothing |
| A backup's result (`backup_state`'s newest file, last result and attempt, the due mark cleared) | Routine | Losing it costs at most one more backup after a restart, which finds the mark still set | Up to five minutes of results |
| App sessions, subscriptions, the live revision | Memory | Rebuilt: clients reconnect and take a snapshot | All; the clients reconnect within seconds |

### The write budget with M2's records

What M2 adds to a day, for a household of 4 people with 6 linked clients (browsers in M2; phones from M3, when the phone build arrives) ‡:

| Item | Rows a day | Class | Commits a day |
| --- | --- | --- | --- |
| Mode switches and arming from the app, with their `commands` and `mode_switched` rows | 6 actions → about 12 rows | now | 6 |
| Schedule runs, each with its `schedule_ran` decision | 4 | now | 4 |
| Settings edits (groups, schedules, people) | about 5 | now | 5 |
| Notifications: arm and disarm to 4 people (24), schedule runs (16), health (20), countdowns (8) | about 70 | routine, except the critical ones, which ride on commits already counted | 0 |
| Notification reads | about 105 | routine | 0 |
| Client sessions opened and closed, as info `hub_events` | about 120 | routine | 0 |
| Backup results: the daily backup's, and one per day with changes | 1 to 2 | routine | 0 |
| The warning that no backup folder is chosen (`backup_no_folder`), first day only | 1 | now (a warning, D112) | 1, first day |
| **Total** | **≈ 320** | | **≈ 15** |

Against the budget (HD 5), with the measured figures and the largest site, home C (64 sensors, 8 sirens, 3 gateways), whose day HD 5 projected but did not measure:

| | A | B | C |
| --- | --- | --- | --- |
| Commits a day, measured or projected (HD 5) | 510 | 926 | ≈ 1,700 ‡ (the 288 routine flushes, 1,280 door reports, about 130 others; to be measured) |
| M2 adds | +15 | +15 | +15 |
| **M2 total, against the budget** | **525 ≤ 800** | **941 ≤ 1,400** | **≈ 1,715 ≤ 2,400 ‡** |
| WAL bytes a day, measured or projected | 16.3 MB | 28.4 MB | ≈ 50 MB ‡ (B scaled by its event commits) |
| M2 adds (15 commits of about 20 KB, and the rows) | +0.3 MB | +0.3 MB | +0.3 MB |
| **M2 total** | **16.6 ≤ 20 MB** | **28.7 ≤ 35 MB** | **≈ 50 ≤ 60 MB ‡** |
| Database at D57's retention, projected (HD 5) | 63 MB | 109 MB | 206 MB |
| M2 adds: 95 rows a day kept a year (notifications, requests, decisions) ≈ 2.1 MB; 225 kept 30 days (reads, sessions) ≈ 0.4 MB; configuration tables < 0.1 MB | +2.5 MB | +2.5 MB | +2.5 MB |
| **M2 total** | **66 ≤ 70 MB** | **112 ≤ 120 MB** | **≈ 208.5 MB, under the guard's 210 MB lower mark** |

### The loop's time while the hub listens

**No work of the hub's may hold its loop for more than 20 ms ‡ at a time on a Raspberry Pi 4 while the hub is listening** (coordinator's ruling). The source is HD 5's budget, which already lets a full-sync commit hold the loop for up to 30 ms at the 99th percentile and a packet's handling for 1 ms: a door report that arrives behind a 20 ms piece and a commit is still handled within about 50 ms, far inside the 700 ms after which a heartbeat reply is skipped (HD 8) and the 1.5 s a sensor listens at its fastest rate (§13). Work longer than that is done **in pieces between the loop's turns**, about 256 KB a piece ‡ (provisional, so that a piece stays under 20 ms on a Pi with a memory card), never in a worker thread: the hub keeps one thread and one order of events. It covers every operation that touches a whole file while the hub listens: staging an update (measured by A8 in one piece at 441 to 444 ms on a Mac for a 49 MB release holding a 112 MB program: hash 205 ms, gunzip 190, writing 27 to 47; several seconds on a Pi), a backup's write and prune, restore's read and rebuild, an export's chunks. A copy made before the hub listens (the pre-migration copy at start) blocks nobody and is exempt. Staging is not covered by "never during a countdown or alarm", which is the switch's rule, so this limit is what protects a door report during it.

**Jobs in pieces, the loop's contract** (the step 0 owner's loop; A8's and A2's jobs): a file job that cannot finish within the limit exposes `pieces: { next(): {done: false} | {done: true; outcome: FileOutcome}; abort(): void }`. The loop calls one `next()` per turn, after the turn's inputs and effects (so after its commit and answers), for each open job in turn, each call within the limit; `done` becomes the job's `fileReady`. On a stop the loop calls `abort()` on every open job, which deletes its temporary files and gives no `fileReady`. A job's upload is freed when the job ends, done or aborted. No job runs in a worker thread, and none reads or writes `hub.db` but through the writer.

**Measured "now" commits a day** (the budget test, after wave 2 was wired, before the daily backup's result was made routine): A 245, B 690, C 1,448; before wave 2, 244, 689 and 1,447. **Corrected:** the extra commit is not a backup's result (the budget's homes choose no folder, so none is written) but the hub's one warning that no backup folder is chosen, written now as D112 requires of every warning. It is raised once, on the first day, and never again until a folder is set, so the figures stay at 245, 690 and 1,448 for the simulated first day, and 244, 689 and 1,447 on every later day; the test checks both.

Home A's file comes within 4 MB of its budget, and home C within 1.5 MB of the size guard's lower mark (210 MB, under which a database never trims; trimming starts only above the upper mark, 225 MB, HD 6). The household above is the assumption: ten people with twenty clients roughly triple the notification rows. The budget test (section 10) adds M2's traffic and home C, so the margins are measured, not argued.

The 500 MB is the product owner's figure for what is comfortable on a Pi (D112), not a wall, so this design does not chase its last megabytes. **If the measured home C passes 210 MB**, the marks move with it: the lower mark becomes the measured figure plus 10% ‡, the upper mark the lower plus 15 MB, and the hard stop (`max_page_count`, HD 5) the upper plus 15 MB; at a measured 215 MB, that is 237, 252 and 267 MB. With the copy kept before a migration (HD 6), the data folder can then stand at about 545 MB while a copy exists, which D112 allows. Home A's budget line in the test moves the same way, to its measured figure plus 10% ‡, if it passes 70 MB.

### The 500 MB ceiling (D112)

The folder's shares (HD 6) are the database 240 MB, the pre-migration copy as large, the WAL 8 MB and `fatal.log` 1 MB: 489 MB. M2 adds:

- **Backups.** D53 lists what a backup holds: settings, users, device keys and the signing key. That is the configuration tables and keys, about 200 KB ‡ a file. The newest 20 ‡ are kept, whether written daily or at once after a change (D122): about 4 MB. History is never in a scheduled backup, only in an on-demand export, which is streamed to the browser and never written to the hub's disk (section 12, Q9).
- **Exports** are streamed to the browser that asked, never written to the hub's disk.
- **Updates** need a second copy of the program (about 110 MB on Linux arm64, S1) while both are installed. The program is not "what the hub stores for a home" in D112's words, but on a small card it matters; section 9 keeps two versions at most.
- **The web app's files** are part of the program (about 5 MB ‡), served from the install folder.

So the data folder stays under 500 MB with M2: the database and copy shares unchanged, plus about 3 MB of backups.

## 4. The database: new tables

All new tables are configuration or small state, written now unless marked. Times as in HD 6: `*_ms` wall milliseconds, `*_mono` with `boot`. Every object edited through the app's configuration screens (people, groups, modes, schedules, notification preferences) has a `revision`, raised by one at each change, for the optimistic checks of section 5. Devices have none: their settings already carry a settings version (HD 8), a rename or removal needs no conflict check (section 6), and a live view stays consistent by the live revision `rev`, not by revisions per object (section 5).

**Indexes.** No index for reading: every table is small and read whole at start. The unique keys the table below names are constraints, not read paths, and SQLite keeps each as an index; they stay, as step 0 built them (`clients_static_key_unique`, `link_tokens_lookup_unused` and `people_name_live` partial where the key says "among", `groups_name_unique`, `modes_name_unique`). They cost a write only on configuration changes, and they turn a core bug that would give two clients one key, or two live tokens one lookup, into a failed commit instead of an ambiguous handshake.

**One writer per row.** Every row is written by one module only, always as a full value (HD 2), so state two modules would write goes in separate tables. `site` stays exactly as M1a built it, the `site` module's alone, and M2 adds no column to it; `hub_keys` stays the shell's, which makes its keys at start. M2's single rows each have one owner, named below.

| Table | Columns | Key | Class |
| --- | --- | --- | --- |
| `people` | `id`, `name`, `created_ms`, `removed_ms`, `revision` | `id`; unique `name` among those not removed | now |
| `clients` | `id`, `person_id` (null for the console), `static_key` blob(32), `kind` (0 console, 1 web, 2 phone), `name`, `linked_by_client`, `created_ms`, `removed_ms`, `last_seq`, `last_seen_ms` (routine), `backup_key_epoch` (the epoch it holds; phones only) | `id`; unique `static_key` | now, `last_seen_ms` routine |
| `client_replies` | `client_id`, `seq`, `reply` blob (the reply as sent, UTF-8 JSON) | (`client_id`, `seq`), without row id; the last 16 per client ‡, older ones deleted in the same commit | now |
| `permissions` | `person_id`, `device_id`, `manage`, `view` | (`person_id`, `device_id`), without row id | now |
| `person_roles` | `person_id`, `manage_users`, `manage_system`, `revision` | `person_id` | now |
| `link_tokens` | `id`, `lookup` blob(4) (section 5), `kind` (0 link a new person, 1 link a device for an existing person, 2 console; a restore token is never stored, section 9), `person_id` (for kind 1), `created_by_client` (null for the console and the installer), `created_boot`, `created_mono`, `expires_after_ms`, `typed` (1 for a typed code, whose lookup is its token id), `failures`, `used_ms` | `id`; unique `lookup` among unused tokens | now |
| `link_secrets` | `token_id`, `psk` blob(32) | `token_id`. Kept apart as `device_keys` is | now |
| `groups` | `id`, `name`, `all_sirens` (1: every siren, the default, AL2a), `revision` | `id`; unique `name` | now |
| `group_members` | `group_id`, `sensor_id` | (`group_id`, `sensor_id`), without row id | now |
| `group_sirens` | `group_id`, `siren_id` (used when `all_sirens` is 0) | (`group_id`, `siren_id`), without row id | now |
| `modes` | `id`, `name`, `fixed` (0 user-made, 1 Away, 2 Disarmed, D90), `revision` | `id`; unique `name` | now |
| `mode_groups` | `mode_id`, `group_id` | (`mode_id`, `group_id`), without row id | now |
| `mode_state` (`layout`) | `current_mode_id` (null when arming matches no mode), `mode_modified` (1 when arming has changed since the last switch) | single row | now |
| `people_settings` (`people`) | `user_management` (0 off, the default, D13) | single row | now |
| `schedule_state` (`schedules`) | `time_zone` (the zone last given by `timeZone`, null before the first) | single row | now |
| `backup_state` (`upkeep`) | `folder` (null: none chosen), `hour` (null: 03:00 ‡), `keep` (null: 20 ‡), `last_change_ms` (the last change to people, clients, permissions, user management, paired devices or the backup key: the header's field, D122), `due_since_ms` (the first such change no backup holds yet; null when none), `overdue_raised` (1 once the 1-hour warning is raised, so it is raised once), `newest_name`, `newest_ms`, `last_result` (0 never, 1 written, 2 failed), `last_attempt_ms`, `restored_from_ms` (the restore mark: set in a restored database, cleared when `restored` is recorded, section 9) | single row | now |
| `backup_key` (`upkeep`) | `key` blob(32), `epoch` | single row. Kept apart as `link_secrets` is | now |
| `schedules` | `id`, `name`, `action` (0 switch to mode, 1 arm, 2 disarm), `mode_id`, `group_id`, `sensor_id` (one of the three), `local_time` (minutes after midnight), `days` (a bit per weekday, Monday bit 0; 0 for a one-time entry), `date` (for a one-time entry, days since 1970-01-01), `enabled`, `created_by`, `last_run_ms`, `last_run_local_date`, `missed_due_ms`, `missed_why` (0 hub off, 1 clock not set, 2 clock stepped), `missed_count`, `revision` | `id` | now |
| `health_state` | `device_id`, `battery_low`, `tamper_open` | `device_id` | now |
| `notification_prefs` | `client_id`, `categories` (a bit per optional category, 1 on), `revision` | `client_id` | now |
| `hub_keys` (changed; the shell's) | adds `app_static_private` blob(32), `app_static_public` blob(32), `tls_private` (PKCS #8), `tls_certificate` (DER) | single row | now |
| `update_state` (`upkeep`) | `staged_version`, `staged_ms`, `approved_by`, `approved_ms`, `switching_ms`, `previous_version` | single row | now |

Audit tables (HD 6's rules: integer times, raw bytes, `seq` row ids, no index):

| Table | Columns | Rows | Kept |
| --- | --- | --- | --- |
| `notifications` | `seq`, `at_ms`, `clock_ok`, `kind`, `category`, `critical`, `device_id`, `cause_seq`, `recipients` blob (person ids, u32 LE each), `detail` blob | one per notification raised | 1 year |
| `notification_reads` | `seq`, `at_ms`, `clock_ok`, `notification_seq`, `client_id` | one per client that marked it read | 30 days |

Requests from apps that change something are `commands` rows as the hub computer's commands are (HD 6); so is `backup.key`, the one read that hands out a secret, routine. Other reads are not recorded: they are not actions in AL8's and D110's sense (they change nothing), and a `pong` every 20 s ‡ per session would outweigh every other row of section 3. Each row has `actor` the person's name and the client's number (`"Anna (client 7)"`), `kind` the operation, `args` the request body as JSON with every secret field removed (a Wi-Fi password is replaced by `"***"`), and `outcome` the reply's code. Sessions are `hub_events` rows (`client_connected`, `client_closed`, info level, routine). People's and clients' changes are decisions (`person_added`, `person_renamed`, `person_removed`, `client_linked`, `client_renamed`, `client_removed`, `permissions_changed`, `user_management_changed`), written now with the change; a rename's detail holds the old and new names.

The migration is HD 6's: one generated migration, `VACUUM INTO hub.db.before-<n>` first because it changes `site` and `hub_keys`, a test that applies it to a fixture of the M1a schema holding rows. It also creates the two fixed modes, Away and Disarmed (D90), and inserts `mode_state`'s row from the sensors' states: Disarmed if no sensor is armed, which includes a site with no sensor and a new installation; otherwise Away if every sensor is armed; otherwise none, with `mode_modified` set. A sensor waiting for its door counts as armed. Disarmed for an empty site is the honest reading: nothing protects the house, and Away would say it is. It inserts `people_settings` (off), `schedule_state` (no zone) and `backup_state` (no folder, nothing due) with their defaults; `backup_key` is inserted by `upkeep` at the first start, from the input's entropy.

## 5. The app's channel

Exact enough to build both ends and to write test vectors. The schemas live in `packages/protocol/src/app/`, the vectors in `packages/protocol/vectors/app-*.json`, beside the device protocol's, and the hub, the web app and later the phone app and the relay all build against them (stack.md, "Shared protocol package").

### Listeners

| Listener | Address | Serves | Who uses it |
| --- | --- | --- | --- |
| Devices | TCP 8443 ‡ on every address, plain WebSocket, `/device` | Device packets (§10), as built | Gateways and sirens |
| Apps on the home network | TCP 8444 ‡ on every address, HTTPS with the hub's own certificate | The web app's files at `/`, and the app channel at `wss://…/app` | Browsers on the home network (D105), and the phone app from M3 |
| The hub computer's console | TCP 8445 ‡ on 127.0.0.1 only, plain HTTP | The same files and `ws://127.0.0.1:8445/app` | The browser on the hub computer (D61, D62) |

Three listeners where D101 and stack.md promised one port. One port cannot serve both: devices speak plain `ws://` by protocol (§10, D101), and browsers need HTTPS (D79, D105). Two LAN ports were chosen (section 12); D101 and stack.md are being amended. The console listener is loopback only, so it opens no firewall rule. The mDNS record (§10) gains a `app=8444` text field ‡, so the phone app can find the apps' port.

**The certificate.** At first start the hub makes a P-256 key and a self-signed certificate naming every address the computer has on the home network, its host name and `<host>.local`, valid 800 days ‡ (Apple's platforms refuse longer for TLS servers, from memory, unverified). It keeps them (`hub_keys`), so a browser that trusted it once is not asked again (D105). A new address, or the renewal at 700 days ‡, means a new certificate and one new warning. **Encoding.** Writing a certificate's DER is serialisation, not cryptography (the key and the signature are Web Crypto's), so stack.md's rule does not forbid it, and A2's own encoder of about 120 lines does it, with no library (reviewer's decision): a certificate it made is parsed by OpenSSL 4.1 with the right version, key type, constraints, usage and names, verifies against itself and matches its key, and `node:crypto`'s parser reads it back in the hub's own code; a library such as `@peculiar/x509` would add a dependency tree to the hub's security path for no check it does not already have. Permanent tests in A2's folder check: OpenSSL over a fresh certificate when `openssl` is present; the read-back through `node:crypto`; the encoder's edges (long names, IPv6 addresses, a serial whose top bit is set, dates on both sides of 2050, where the encoding changes from UTCTime to GeneralizedTime); and, as for every certificate it makes: OpenSSL parses it (`openssl x509 -text`) and verifies it against itself; version 3; a random positive 16-byte serial; `ecdsa-with-SHA256`; issuer and subject the host name; not before an hour ‡ before it was made, not after 800 days later; subject alternative names for every address, the host name and `<host>.local`; basic constraints not a CA; key usage digital signature; extended key usage server authentication; the fingerprint the console shows the SHA-256 of these exact bytes; and Chrome, Safari and Firefox accept it after the click-through (O12). The console shows the certificate's SHA-256 fingerprint, so a user clicking through the warning on another computer can compare it. From M4 the per-hub name and its real certificate (D79, RA11) take over; the listener does not change.

**Defences on every HTTP and WebSocket request** (D62):

- The `Host` header must be one of the certificate's names or addresses (the console: `127.0.0.1:8445` or `localhost:8445`); otherwise 421. This stops a page that rebinds its own name to the hub's address from reaching it.
- A WebSocket upgrade's `Origin` must be the listener's own origin; otherwise 403. A page from anywhere else cannot open the channel, and could not authenticate on it anyway.
- Every response carries a strict content security policy ‡: scripts, styles, fonts and images only from the hub itself, connections only to the hub, no frames, no inline script except what the build hashes. The web app loads nothing from outside (stack.md).
- **Styles under the policy.** Step 0's harness saw two refusals, both styles: Expo's `<style id="expo-reset">` in `index.html`, and the empty `<style>` element React Native Web adds at run time and then fills through `insertRule`, which the policy does not govern. The policy is therefore `style-src 'self'` plus hashes: the web build's last step computes the SHA-256 of every inline `<style>` and `<script>` in `index.html` and writes them, with the hash of the empty string for React Native Web's element, into `web/csp.json`, which the hub's listeners and the test harness read to build the header. `script-src` gains only the hashes of inline scripts, if the build has any. The Playwright tests then fail on any refusal, of a style as of a script. **If a browser of the list still refuses React Native Web's styles under the hashes**, `style-src` becomes `'self' 'unsafe-inline'`, for styles only, without asking again: injected styles can change how a page looks but cannot run code, and with `img-src`, `font-src` and `connect-src` limited to the hub they cannot send anything out; section 13 then says so.
- No cookies, no HTTP endpoints besides the static files: everything else travels inside the channel.

### The channel: Noise

- **Sessions** use `Noise_IK_25519_ChaChaPoly_SHA256` (stack.md). The client knows the hub's static key from linking; the hub learns the client's in the first message.
- **Linking and restore** use `Noise_XXpsk3_25519_ChaChaPoly_SHA256`: neither side knows the other's static key yet, and a pre-shared key carried by the user from one screen to another proves each to the other.
- **The hub's keys.** One static X25519 key for apps, made at first start of M2 and kept in `hub_keys`, apart from the P-256 signing key of devices (§9). The hub's app identity is the first 16 bytes of SHA-256 of its public key, written as 26 characters of lower-case base32 without padding (RFC 4648). It names the hub to apps and, from M4, to the relay (D55). The identity is always checked against the static key a handshake presents, never taken from mDNS or any other unauthenticated source.
- **A client's key.** Each client makes its own static key when it links. A browser makes it with the browser's own cryptography (Web Crypto's X25519) as a **non-extractable** key and keeps the key object in IndexedDB: script on the page can use it while it runs, but cannot read it out, so nothing that runs on the origin for a while (a script injected behind a certificate the user clicked through, an extension) can carry the key away to use later. A browser that cannot do this cannot be linked, and says so ‡; spike K1 (section 11) checks Chrome, Safari and Firefox behind the certificate warning. The phone app keeps its key in the phone's secure storage (stack.md). The Noise code takes the static key's Diffie-Hellman as a function, so the same code serves a browser's Web Crypto key and the hub's and phone's own.
- **Prologues,** one per purpose, so a handshake made for one can never be taken for another:

  | Purpose | Prologue |
  | --- | --- |
  | A session (IK) | the ASCII bytes `hsn-session/1`, a zero byte, the hub's app identity (16 bytes) |
  | Linking (XXpsk3) | the ASCII bytes `hsn-link/1`, a zero byte |
  | Restore (XXpsk3) | the ASCII bytes `hsn-restore/1`, a zero byte |

  Only a session's prologue carries the identity, because only there does the client know it; in linking and restore the client checks the hub's static key from message 2 against the identity it was given with the secret, when it was given one (below).
- **Library.** `@noble/curves` (X25519), `@noble/ciphers` (ChaCha20-Poly1305), `@noble/hashes` (SHA-256, HMAC, HKDF), with our own Noise state machine in `packages/protocol/src/app/noise.ts`, checked against the published Noise test vectors for both pattern names (stack.md). Every Diffie-Hellman result that is all zero, which a low-order public key produces, ends the handshake, whether or not the library already refuses such keys; vectors include those keys. No cryptography beyond Noise is ours: nothing in this design needs a password-authenticated key exchange (below).
- **One path per handshake.** A WebSocket upgrade names what it will carry: `/app` a session (IK), `/app/link` a link (XXpsk3, link prologue), `/app/restore` a restore (XXpsk3, restore prologue), defined once as `APP_PATHS = {session: "/app", link: "/app/link", restore: "/app/restore"} as const` in `packages/protocol/src/app/constants.ts`, which the hub's router and the client both import (a test refuses the literal paths elsewhere), on both listeners, under the same `Host` and `Origin` checks; any other path is 404. The hub reads message 1 only as the path says, so it never reads one message three ways. Trial reading would be sound (each first message authenticates only under its own protocol name and prologue), but it spends an X25519 on every link attempt read as IK, records a failed link as a refused session, and gains nothing: the kind is visible to an observer anyway from the messages' sizes and count. The Noise bytes and A1's vectors do not change; A7's client opens the path for what it does, and A2 routes by it.
- **Framing.** Each binary WebSocket message carries exactly one Noise message: a handshake message or a transport message. Text messages close the socket. A Noise message is at most 65,535 bytes, so a plaintext is at most 65,519; a reply that would be larger is split into pages by the operation itself (history, section 6).
- **Order.** Each end encrypts and sends its transport messages through one queue per session, in order, so the receiver's nonces always follow; the receiver handles them in the order they arrive.
- **Failure.** Any message that fails to decrypt closes the socket at once: Noise sessions do not recover. The client reconnects with a new handshake.
- **Lifetime.** The hub closes a session after 24 hours ‡ and the client opens a new one; Noise's rekeying would not reset the nonce, and the lifetime bounds what one session key protects. The hub's session layer enforces it (A2, `hub/src/shell/app/`), from the session's admission on the shell's monotonic clock: it closes the WebSocket with close code 4000 ‡ and gives the core `clientClosed {reason: "lifetime"}` (as step 0 built it); no message is sent first and no error code is needed. The Noise objects have no clock; they refuse only a nonce at its limit, which 24 hours never reach.
- **Who refuses which version.** The prologue's `/1` is the handshake's own format: a peer with another prologue fails to decrypt message 2 (or message 1's payload), inside Noise (A1). The channel's version, `proto`, is read by the shell from `ClientHello` or `LinkHello` after Noise has read message 1, and the shell closes before message 2 when no version is shared (A2). Confirmed as A1 split it.

### Admitting a session (IK)

| Message | Direction | Noise | Payload, UTF-8 JSON |
| --- | --- | --- | --- |
| 1 | client → hub | `e, es, s, ss` | `ClientHello {proto: [min, max], app: "<version>", first?: AppRequest}` |
| 2 | hub → client | `e, ee, se` | `HubHello {proto, hub: "<version>", boot, rev, client: {id, person, kind}, features: [...]}`, or the session is closed |
| 3 | client → hub | transport | a request: `first`'s companion, `snapshot`, or `pong`. The first transport message from the client is what proves it holds its key |
| then | both | transport | requests, replies and events |

- The hub looks the client's static key up in `ClientKeys` after reading message 1. An unknown or removed key gets no message 2: the socket closes, and the attempt is a `client_refused` hub event (routine; a warning after 10 in an hour from one address ‡). The shell counts refusals per address per minute, as the minimal hub counts rejected packets per source (HD 6), and gives the core at most one input per address per minute, `clientRefused {address, reason, count}`; beyond 64 ‡ addresses in a minute, one more with `address: "many"` sums the rest. `app` records each as one `client_refused` row, routine, info, and once an hour per address a warning when the hour's count passes 10, which `audit`'s cap then bounds as any warning.
- **A session counts only once proven.** Message 1 of IK can be recorded and sent again (Noise documents it), and a replayed one draws a message 2 that nobody can answer. So a connection is a *handshake* until the hub decrypts the client's first transport message, and only then a *session*. At most 16 handshakes are open at once ‡, each closed if its first transport message has not come within 5 s ‡. Sessions are limited to 4 per client and 64 in all ‡; a client's fifth session closes its oldest ‡, so a reconnecting client always gets in; with 64 in all, new handshakes are refused until one closes. Replays therefore cost a few seconds of one handshake slot, never a session.
- **Liveness is inside Noise, and the shell's** (A2): it sends `ping` and takes `pong` without the core, which needs nothing of a session's liveness but its end (`clientClosed`). WebSocket pings are not authenticated, so they prove nothing. The hub sends an encrypted `ping` event to a session that has been quiet for 20 s ‡; the client answers with a `pong` request; a session with nothing authenticated from the client for 60 s ‡ is closed. A held-open connection that cannot speak Noise is closed by the handshake rule above.
- **Limits on work.** At most 10 handshakes a second from one address and 100 in all ‡, refused before any X25519 is computed. A handshake costs two to four X25519 operations, about a millisecond each on a Pi 4 ‡.
- **A console client** (kind 0) is accepted only on the console listener, never on the home network's. The console's full trust (D61) belongs to the computer, not to a key copied off it.
- **`first`**, a request inside message 1, is what keeps a lock-screen Disarm (from M5) to one round trip (stack.md, D51). It may be replayed, so it must carry `seq` (below); the hub acts on it as soon as the session is proven, never before: a message 1 can be held back by someone on the path and sent later, and only the client's first transport message, which nobody else can make, shows the request is being made now. So the shell gives the core `clientConnected` and then `first` as that session's first `clientRequest`, before anything else of that connection (as A2 built it); its `seq` and stored reply then make a repeated `first` harmless, as for any request. The client sends its first transport message as soon as message 2 arrives, so a lock-screen Disarm costs one and a half round trips, not two.
- **Versions.** `proto` is the channel's version, an integer; this document is version 1. The client gives the range it speaks; the hub picks the highest it also speaks, names it in `HubHello`, or closes with no message 2 when there is none. The web app is served by the hub, so the two always match; the phone app may be older or newer. Adding an operation, an event or a field is a new version; the hub's schemas are strict, so a client must not send what the version it agreed does not name, and the hub sends a client only what its version names.
- **`features`** in `HubHello` names optional capabilities of this hub that do not change any message's shape, so they need no new version: what a particular installation can do, not what the protocol says. **Version 1 defines none, and the hub sends `[]`.** A name is 1 to 32 characters, `^[a-z][a-zA-Z0-9]*$`, at most 32 names. A client ignores any name it does not know, and must work fully with none: a feature may only offer something extra, never be needed to use what the version names. Anything that adds an operation, an event or a field is a new version, never a feature. Each later name is defined here when added, with what it means.
- **One session per browser.** The tabs of one browser share one key; one tab holds the session for all of them, chosen with Web Locks, and the others talk to it through a BroadcastChannel ‡ (both need a secure context, which the console and the HTTPS page are; K1 checks them). A tab that takes over after the holder closes opens a new session.

### Requests, replies and events

Inside transport messages, one JSON object each:

```text
client → hub   {"t":"req","id":N,"seq":S?,"op":"<name>","body":{…}}
hub → client   {"t":"res","id":N,"ok":true,"body":{…},"repeat"?:true}
               {"t":"res","id":N,"ok":false,"error":{"code":"<code>","detail":{…}}}
               {"t":"evt","rev":R,"ev":"<name>","body":{…}}
```

- `id` is the client's, an integer from 1 to 2³² − 1, unique among its requests on this connection that are not yet answered; the hub's reply carries it back. Requests are answered in any order.
- **`seq` gives every change exactly one effect**, across connections and restarts. Inside a session, Noise's nonces already refuse a replayed message; `seq` covers what they cannot: message 1's `first`, and a change whose reply was lost. Every operation section 6 marks as a change carries one: an integer from 1 to 2⁵³ − 1, higher than any the client has used before. The client writes the next number to its storage before it sends, so a crash skips a number and never reuses one.
  - A `seq` above the client's last: the change is made, and the change, the new last `seq` and the reply are committed together (section 3) before the reply is sent.
  - A `seq` at or below the last whose reply the hub still keeps (the last 16 changes of each client ‡): that reply is sent again, marked `repeat`, and nothing is done. So a client whose reply was lost (a dropped connection, a hub that committed and then lost power) **retries a change with the same `seq`**, and a `siren.test` or a `link.create` happens once.
  - Any other `seq` at or below the last: `seqTooLow {last}`, and nothing is done. An honest client then knows the change was not made by this request, and sends it again with a new number; an attacker learns nothing it could use, since only the key's holder can send on the session.
  - Reads carry no number.
- Errors (`code`): `unauthorized` (with the sensors the person may not manage, or the permission missing), `needsConfirmation` (with the open doors and the low batteries, D50, AL12), `conflict` (the object's revision has moved on: with the current one), `seqTooLow`, `notFound`, `invalid` (a value out of range, with which), `busy` (a site move, an update switch or a provisioning in progress), `consoleOnly` (an operation only the hub computer may do: USB, the backup folder), `unavailable` (the database is failing: changes are refused, reads still work), `protoUnsupported`.
- **Every error's `detail`**, exactly (four as step 0 built them, the others settled here):

  | Code | `detail` |
  | --- | --- |
  | `unauthorized` | `{devices?: [device], permission?: "manageUsers" \| "manageSystem"}`, as built |
  | `needsConfirmation` | `{openDoors: [device], lowBattery: [device]}`, as built |
  | `conflict` | `{revision, object}`: `object` is required, the object as that operation's reply carries it (the group, mode, schedule, person, permissions or preferences), so the app can show the change it lost to. An object deleted meanwhile is `notFound`, never `conflict` |
  | `seqTooLow` | `{last}`, as built |
  | `notFound` | `{what, id}`: `what` one of `person`, `client`, `group`, `mode`, `schedule`, `device`, `token`, `notification`, `job`, `upload`; `id` the number the request gave |
  | `invalid` | `{field, reason, refs?}`: `field` the path in the body, dotted (`devices.2.manage`, `name`); `reason` one of `format` (the shape or a name's rule), `range`, `taken` (a name already used), `unknownReference` (an id that names nothing of that kind), `fixed` (a fixed mode, D90), `inUse` (named by schedules: `refs` their ids), `lastManager` (the last person with *manage users*), `tooOld` (a removal's `also` linked more than 30 days ago), `noDevicesRequired` (`restore.start` on a hub with devices), `noAnswer` (a board that did not answer, HD 9), `noGateway` (an operation that needs a gateway, with none connected) |
  | `busy` | `{because}`: `siteMove`, `updateSwitch`, `provisioning`, `countdown`, `alarm`, `restore` as built, and `upload` (a second upload on one connection) |
  | `consoleOnly` | `{}`, as built |
  | `unavailable` | `{}`, as built: the hub computer's console and `hsn status` say why |
  | `protoUnsupported` | `{speaks: [min, max]}`, the hub's range, as built. Sent by the shell to a request whose operation the agreed version does not name (the `notInVersion` rejection, which the core records); a request of the wrong shape is answered `invalid {field, reason: "format"}` by the shell, recorded as `badShape` |
- **Events** carry `rev`, the live revision: an integer that rises by one at every step that changes anything an app shows, kept in memory and starting again at each boot (HubHello names the boot). `rev` orders a snapshot against events: an event with a `rev` at or below the snapshot's is already in it and is dropped. A gap in `rev` means nothing: `rev` is one counter for the whole hub, so a person with fewer permissions sees jumps over steps they may not see, and a session cannot lose an event (its stream is ordered and authenticated, and any failure closes it). A client asks for a new snapshot only on a new session or a new boot, never on a gap. A jump tells a viewer only that something happened somewhere in the house, never what, which a household member may know.

### Live updates (HB14)

- After `HubHello` a client asks for `snapshot` (section 6), then `subscribe` with the topics it shows. The snapshot carries the revision it was made at; events follow from the next one.
- Every event comes from something the core did in a step: a record (a decision, a notification) or a change of state a module announced. Nothing is polled, and nothing reads the database: the snapshot is built from the core's state, as `hsn status` is (HD 3). Live views therefore never cause a commit.
- **Every event of the live stream, and what raises it** (the step 0 owner's test sends each from a scenario and fails on one never sent, as the test of operations fails on `notBuilt`; all are sent by `app`, section 7, but `ping`, `fileChunk` and `fileFailed`, which are the shell's):

  | Event | Raised by |
  | --- | --- |
  | `arming` | `armedChanged` (alarm), and `mode_switched` or `arming_changed` (layout) for the mode and `modified` |
  | `countdown` | the countdown's decisions: started, continued, cancelled (`countdownCancelled`), ended |
  | `alarm` | `alarm`, `alarm_trigger_added`, each siren's `sirenIntent` and report, the alarm's end |
  | `door` | an `accepted` door changed report |
  | `reading` | an `accepted` packet whose readings changed, at most once a minute per device ‡ |
  | `health` | `sensor_silent`, `siren_silent`, `siren_wifi_lost`, `siren_lora_lost` and their returns, `gateway_offline`, `interference_*`, `noise_interference_*`, `poor_link`, `battery_low`, `battery_ok`, `tamper_opened`, `tamper_closed`, `cover_state_unexpected`, `door_state_unexpected` |
  | `device` | `deviceAdded`, `deviceRemoved`, `deviceLeftBehind`, a rename's `opAnswer`, a device's state changing |
  | `notification` | `notificationRaised` (notify) |
  | `record` | every `auditRecord`, to sessions subscribed to `history`, filtered as history is |
  | `config` | every `opAnswer` of a group, mode, schedule, site setting or retention operation, whoever asked, and each mode a group's deletion changed |
  | `people` | every `opAnswer` of a people, permission, client or user-management operation, `clientAdded`, `clientRemoved` |
  | `site` | the site module's `siteMove`, `siteConfirmed`, `siteFollowed`, and its settings' `opAnswer` |
  | `hub` | by `what`, to people with *manage system* and the console: `updateStaged` (`update_staged`), `updateRefused` (`update_refused`: a file refused, or a switch refused for space), `updateSwitching` (`update_switching`), `backup` (any backup decision or `backup_written`, `backup_failed`, with `detail.kind` naming it), `databaseFailing` (the first `commit_failed` of a run of failures), `databaseRecovered` (the first commit after them), `databaseSize` (the size guard's state changing), `historyShortened` (`history_shortened`). Not events, since they come before any client can be connected (at boot, or at the first facts after a switch): `update_healthy`, `update_rolled_back` and `restored` reach people as notifications, which wait until read (section 7), and an update's outcome is also state, in `update.status`'s `lastResult` with its `lastResultMs` (`update_state.last_result`, `last_result_ms`) |
  | `session` | `clientRemoved` for that session's client, just before `closeClient` |
  | `ping` | the shell's channel (A2), not the core: the session quiet for 20 s ‡ on the shell's monotonic clock, as the 24-hour lifetime is. Its `rev` is the last one sent on that session, unchanged. The shell handles the client's `pong`, which is the answer to its `ping`, so it gets no reply of its own and never reaches the core; any authenticated message from the client counts as heard, a `pong` or anything else. The core learns of a dead session only by `clientClosed {reason: "liveness"}` |
  | `forget` | `permissions_changed` taking a device's view away |
  | `backupKeyChanged` | `backup_key_replaced` (upkeep), to phones |
  | `fileChunk`, `fileFailed` | the shell's `export` job (section 6), not the core: tested in the shell |

- **Configuration in the snapshot**: `modes: readonly ModeObject[]`, `groups: readonly GroupObject[]`, `schedules: readonly ScheduleObject[]`, the objects section 6's replies already carry, built by `app` (A3) from `layout`'s view (A4) and `schedules`' view (A5). A person who may not view every sensor sees every mode (to switch, they still need HB5a's *manage*), every group with only the sensors they may view in its `sensors` (its sirens in full, as sirens are everyone's), and every schedule but those whose target is a sensor they may not view, or a group none of whose sensors they may view. After the snapshot, `config` events keep each current, filtered by the same rule, and `arming` the current mode.
- Readings (battery, signal, temperature) are sent at most once a minute per device ‡; changes of state (a door, a cover, silence, a path, arming, a countdown, the alarm) at once.
- **Each event is checked against the permissions as they are when it is made**, not as they were at `subscribe`: it goes only to sessions whose person may view the device it names (HB5a), and events about the hub as a whole go to people who may manage the system. When a person loses the right to view a device, their sessions get a `forget` event for it, and the app drops what it showed ‡.

### Linking (D34, D61, D62, D99, D120, D121, HB3a)

A link token is made by a linked client or by the hub computer, carried by the user to the new device as a QR code, a link address or a typed code, and spent by one handshake. A valid code links at once, with no second step, and works once and never again (D121).

**Two strengths of secret.** A QR code, a link address and the console's token, which nobody types, carry a 128-bit secret, since that costs the person nothing (D120). A typed code is short, of the length people are used to (D120). In XXpsk3 the new client sends message 3, sealed with the pre-shared key, before the hub has shown that it knows that key, so someone already on the home network who pretends to be the hub and captures one attempt with a typed code can work the code out offline, and then use it at the real hub before the person tries again. D120 accepts this: whoever is on the home network is treated as trusted for this step. Everything that costs the person nothing stays in place around it, below.

| Message | Direction | Noise | Payload |
| --- | --- | --- | --- |
| 1 | new client → hub | `e` | `LinkHello {proto: [min, max], find: "<lookup>"}`: readable by anyone, though encrypted (below) |
| 2 | hub → new client | `e, ee, s, es` | `{hub: "<version>", proto, askName}`: the highest version both speak, as in IK (with none, the hub closes before message 2, which is no failed try); `askName` true when the token is for a new person and was made without a name, so the client asks the person for theirs before message 3 and sends it as `person`. Otherwise `person` is ignored. A false hub could ask for a name for nothing, which costs the person nothing |
| 3 | new client → hub | `s, se, psk` | `LinkRequest {name, kind: "web" \| "phone", person?: {name}}` |
| 4 | hub → new client | transport | `LinkResult {client, person}`, then the hub closes and the client connects again with IK |

- **Message 1 and the pre-shared key** (checked against the Noise specification, revision 34, section 9.2). In a handshake with a psk, every `e` token is followed by `MixKey(e.pubkey)`, so message 1's payload is encrypted, but under a key derived only from the protocol name, the prologue and the ephemeral public key that travels in it: anyone who sees message 1 can read it. The psk enters only at the `psk` token, at the end of message 3. So `find` stays inside message 1's payload, where the transcript hash binds it to the handshake (one Noise message per WebSocket message, as framing has it), and the responder learns which token is meant by reading message 1, which needs no psk. **The XXpsk3 responder takes its psk after message 1**, at any time before it reads message 3 (A1's change, accepted); a responder asked to read message 3 without one fails. A `find` that names no live token closes the socket before message 2, and counts as no try against any token; it is a `clientRefused` with reason `unknownToken`, counted per address like every refusal, so a stream of guesses from one address reaches the hourly warning. The same holds for restore.
- **A 128-bit secret** is 16 random bytes. Its pre-shared key is SHA-256 of the ASCII bytes `hsn-link/1`, a zero byte, and the secret. Its lookup, sent in `LinkHello`, is the first 4 bytes of SHA-256 of `hsn-find/1`, a zero byte, and the secret, written as 8 hex digits: the secret never travels, and someone who does not know it cannot even name the token.
- **A typed code** is 12 characters of Crockford base32, `XXXX-XXXX-XXXX` ‡: a token id (4 characters, 20 bits, chosen by the core among those not in use), the secret (7 characters, 35 bits; as the pre-shared key's input, 5 bytes, big-endian, the top 5 bits zero), and a check character (mod 37, as Crockford defines), which catches a mistyped code before any handshake. Its pre-shared key is made as a 128-bit secret's, from the 5 bytes: SHA-256 of `hsn-link/1`, a zero byte, and the 5 bytes (as step 0 built it). Its lookup in `LinkHello` is the token id itself, never anything computed from the secret: a lookup made from so short a secret would let anyone who merely watches the network work the code out from message 1. The token id is readable by anyone who sees message 1, so anyone on the home network can use a typed code's 5 tries ‡ up with wrong guesses; the code is then void and the person makes another, which D120's trust in the home network accepts.
- **Which flows may use a typed code:**

  | Flow | Typed code | Why |
  | --- | --- | --- |
  | Linking a new person, or another device of one's own, from an app (D34, D61) | yes, beside the QR code and the link address | D34 and D61 ask for a code one can type |
  | An invite for someone not present (D99) | yes | The same, for a person who will type it later |
  | The first code the installer prints for a hub with no screen (D62) | yes, printed with a QR code and a link address | A terminal may be read and typed from |
  | The hub computer's own browser (`hsn open`) | never | It is a one-time 128-bit token that `hsn open` puts in the address it opens; nobody types it |
  | Restore (section 9) | never | The new hub's console shows a QR code and the phone that unlocks the restore scans it: the phone has a camera, and the person types nothing |

- **The real hub limits tries and expires codes.** A typed code is void after 5 failed tries ‡; a 128-bit one has no such limit, since nobody can guess it, and its failures are counted per address. Failures are recorded as routine, a warning after 10 in an hour from one address ‡.
- **The client checks the hub** when it was given the hub's identity (a QR code or a link address carry it): message 2's static key must hash to that identity, or the client stops before message 3. A typed code carries no identity, so there is nothing to check; that is the case D120 accepts.
- **The client sends nothing it must keep secret until message 4**, the hub's first transport message, has decrypted and so proved that the hub knows the pre-shared key. Message 3 carries only a device name and kind.
- **A QR code** is a URL, so a phone's camera opens the app with it: `hsn://link/1?h=<identity>&s=<secret, 22 base64url>&a=<addresses, comma-separated>&p=<apps' port>&c=<certificate fingerprint, 43 base64url>`.
- **A link address**, for another browser on the home network: `https://<address>:8444/#link=<identity>.<secret>`. The fragment never reaches a server; the web app reads it, removes it from the address bar and the history at once, and starts the handshake. The identity in it was put there by the device that made the token, so even a page served from a forged certificate cannot pass a forged hub's key off as the real one, though such a page could do anything else (threats, below).
- **The console.** There is no `console.secret` file. `hsn open` asks the running hub, over the control socket (HD 9), for a one-time console token (128 bits, valid for 2 minutes ‡) and opens `http://127.0.0.1:8445/#console=<secret>` in the computer's browser, without putting that address on any command line, where other accounts can read it in the list of processes. `hsn` (run by an administrator, section 9) writes a small page, readable only by the user whose browser opens it, holding a script that replaces itself with that address (`location.replace`, so it stays out of the history), in that user's own folder: macOS `~/Library/Caches/HSN Hub/`, Linux `$XDG_RUNTIME_DIR/hsn-hub/` (or `~/.cache/hsn-hub/` without one), Windows `%LOCALAPPDATA%\HSN Hub\`, the folder made only that user's (and, on Windows, SYSTEM's and Administrators') and the file named at random. It opens that file's path, which is no secret, as that user (`launchctl asuser` and `open` on macOS, the user's session on Linux, the installer's unelevated launch on Windows), waits until the token is used or expires, says which, and deletes the file. It learns which from the hub, not from the file's access time (which many file systems never update): after getting the token it sends `consoleTokenWait {token}` on the control socket, answered when the token is used or expires (`{used: boolean}`), as `usb.add` is answered when the board answers. A page left by an installer, which cannot wait, holds a token that works once and expires; `hsn open` and uninstalling delete old pages in that folder. The installer's console token lasts 10 minutes ‡, not 2, since the person may linger on the last dialog. A browser confined from that folder (a snap package's, on Linux ‡) is checked in step 3. The web app links with it as a console client, kind 0, removing the fragment from the address bar and history at once. The token works once and only on the console listener. A browser on the computer that lost its storage runs `hsn open` again.
- **Token kinds and who may make them.** A new person: someone with *manage users*, or anyone while user management is off (D13). Another device for oneself: any linked person (section 12, Q10). Restore: the console of a hub being restored (section 9).
- **Token numbers.** Link tokens and restore tokens share the `TokenId` type, the `linkSecret` effect and the shell's table of keys, so their numbers must never meet. **Two ranges**, in `hub/src/core/model/ids.ts` (`TOKEN_RANGES`): link tokens 1 to 2³¹ − 1, allocated by `people` as `link_tokens.id`, the next above the highest ever stored (a row's number is never reused, so a stale `linkSecret` can never name a new token); restore tokens from 2³¹ upward, allocated by `upkeep` in memory, counting up from 2³¹ at each boot, since none is stored and the shell's table is empty at start. `linkSecret` gains `purpose: "link" | "restore"`, so the shell picks the prologue from the effect, not from the number; each module ignores `linkFailed` for tokens outside its range. A typed code's 4-character token id is a separate number, its lookup (section 4), and is not a `TokenId`. Tokens expire: codes made in an app after 10 minutes ‡; invites for someone not present after 24 hours (D99); the installer's first code (D62) after 7 days or its first use ‡. That 7 days belongs only to a new-person code the hub computer makes while no person exists; every other code the hub computer makes (`hsn op link.create`) lasts 10 minutes, as an app's, and an invite 24 hours. Every token works once (D121). Each records the client that made it, and each client records the client whose token linked it.
- **Every new client is notified** to the other clients of its person (section 7), so a person learns of a device linked in their name that they did not link; and the person a leaked code was meant for finds it refused (D121).
- **Expiry and an untrusted clock.** A token's age is measured on the monotonic clock from its creation, carried across restarts as countdowns are (HD 5). After a restart whose downtime is not known (D113) every token counts as expired and must be made again.
- **`LinkResult`** gives the client its number and its person; a phone (from M3) is also given the backup key and its epoch (D78, D99, section 9). Browsers are not given the backup key: a browser's storage belongs to the hub's address, and with no offline copy of the web app (D105) a browser could not use the key once the hub that served it is gone.

**Restore's messages** (XXpsk3 with the restore prologue, section 9). The hub's static key is its own app key, the one the restore will replace; the QR code names its identity.

| Message | Direction | Noise | Payload, UTF-8 JSON |
| --- | --- | --- | --- |
| 1 | phone → hub | `e` | `LinkHello {proto: [min, max], find}`, the 8-hex lookup of the restore token's 128-bit secret, as linking has it |
| 2 | hub → phone | `e, ee, s, es` | `{hub: "<version>", proto}` |
| 3 | phone → hub | `s, se, psk` | `RestoreHello {app: "<version>"}`: nothing secret |
| 4 | hub → phone | transport | `RestoreOffer {identity, epoch, madeMs, lastChangeMs}`: the file's hub identity (26 characters), its backup key's epoch, when it was made, how old its people and permissions are. This message proves the hub knows the pre-shared key |
| 5 | phone → hub | transport | `RestoreKey {key, epoch}` (`backupKeyPayload`), only after message 4 decrypted, and only for the identity and epoch it names; a phone without that key closes instead |
| 6 | hub → phone | transport | `RestoreResult {ok: true}`, or `{ok: false, reason: "wrongKey" \| "expired" \| "busy"}`; then the hub closes, and on success restarts as the restored hub, to which the phone connects with IK as the client the file holds |

The shell runs messages 1 to 3 and gives the core `restoreOpened`; message 5 reaches it as `restoreKey`. Messages 4 and 6 are the core's `appSend`s on that connection, as `LinkResult` is.

### Threats, and what answers each

| Threat | What it could do | What stops it |
| --- | --- | --- |
| Someone on the home network pretending to be the hub (spoofed mDNS or addresses) | During linking with a typed code: capture one attempt, work the code out, and link as the person at the real hub. With a QR code or link address: nothing | **Accepted for typed codes (D120)**: the home network is trusted for this step. QR codes and link addresses: 128-bit secrets, and the client checks the hub's static key against the identity it was given. In every flow nothing secret leaves the client before the hub has proved it holds the pre-shared key. Restore never uses a typed code. Sessions are IK with the hub's static key pinned since linking |
| A link code that leaks (a QR code seen over a shoulder, an address forwarded) | Link a device as a new person, with every permission while user management is off | A code works once (D121): whoever uses it first is linked, and the person it was meant for finds it refused and knows. Codes expire. Every new link is notified to the person's other clients; removing a client offers to remove what it linked (section 7) |
| A stolen phone (from M3) | Everything its person may do while its key works; link further devices that outlive it | The app lock (D63) where turned on; removal by another client of the person or by *manage users*: written now, every session closed at once, its tokens void, and the devices it linked offered for removal with it (section 7). Its backup key is replaced (section 9). D63 accepts that notification actions do not ask for the lock |
| A removed person | Use a client they still hold | Removing a person removes all their clients and their tokens in one commit; their history stays, under their name |
| A replayed request | Run a recorded change again | Inside a session, Noise's nonces. Message 1's `first`, the one part that can be replayed: its `seq` must be new. After a restore, every client's last `seq` is raised (section 9), so a request recorded before the restore cannot pass either |
| Replayed message 1s held open | Fill the hub's sessions and lock clients out | A connection counts as a session only after the client's first transport message, which a replayer cannot send; handshakes close after 5 s; liveness is checked inside Noise |
| A web page or script on the app's origin: a page served behind a forged certificate the user clicked through (the origin is the same whatever the certificate), cross-site script, a browser extension | Act as the linked browser while it runs | The browser's key is non-extractable, so it cannot be carried away and used later; the hub sees only that browser's sessions, which another client can remove. While such script runs, it can do what that browser's person may do. The defences are those of D105 (the first click-through is accepted; the console shows the fingerprint to compare), no outside scripts and a strict content security policy. This risk is not closed and is stated to the user in the app's security notes ‡ |
| A browser on the home network altering the app as it loads | As the row above | HTTPS to the hub's certificate; the `Host` and `Origin` checks stop pages that rebind names |
| A web page in a browser on the hub computer | Reach `127.0.0.1:8445` | It cannot open the channel (`Origin`), cannot read the console client's key (another origin; non-extractable), and cannot link without a one-time console token, which only `hsn open` gets, over the control socket |
| A stolen backup file | Read the home's configuration and every key | ChaCha20-Poly1305 under the backup key, which only linked phones hold (D78), and which is replaced whenever one of them is removed (section 9) |
| A flood of handshakes | Use the hub's processor | The limits above, applied before any key operation |
| The relay, from M4 | Read or change app traffic | It carries the same Noise messages, end to end (RA2). M2 must keep it possible: no authentication by address or cookie; nothing that assumes one TCP connection per client (sessions and `seq` are per client, not per socket); the hub's app identity as the name the relay routes by (D55); `first` in message 1 for the lock-screen Disarm. The relay will see only the hub identity, the timing and the size, as D59 accepts |

## 6. The messages

Every operation, with whether it is a change (and so carries `seq`), who may make it, and what it answers. Permissions: **V(d)** may view device d; **M(d)** may manage device d; **MU** manage users; **MS** manage system (D33); **any** any linked person; **C** only on the console listener (the hub computer). While user management is off every person has every permission (D13), but C stays C. The hub computer's own commands (`hsn`, the control socket) have every permission, as HD 9 has them, and gain the same operations under the same names.

**`hsn op`.** Every operation of `CONTROL_OPS` (`hub/src/control-protocol/`) is given as `hsn op <operation> [<body>]`: `<operation>` the name in this table (`mode.switch`); `<body>` one argument holding a JSON object, the operation's body as this section gives it, or `-` to read that object from standard input; omitted, it is `{}`. Example: `hsn op mode.switch '{"mode": 3}'`. It sends `{kind: "op", op, body}` on the control socket, as step 0 built it. A change needs no `seq`: the control socket's requests are answered on one connection and are not retried by `hsn` (HD 9). On success `hsn` prints the reply's body as JSON on standard output and exits 0; on a refusal it prints `{code, detail}` as JSON on standard error and exits with HD 9's refusal code. `--json` changes nothing here: the output is always JSON. Operations `hsn` already has under its own names stay there and are not in `CONTROL_OPS`.

**Commands that carry a file** have their own forms, not `hsn op`, since a path names a file on the user's side, which the hub's account may not be able to read:

| Command | Does |
| --- | --- |
| `hsn update install <file>` | uploads the release, then `update.upload {job}`; prints the version staged |
| `hsn restore <file>` | uploads the backup, then `restore.start {job}`; prints the file's identity, its dates and age, asks before going on (D122), then shows the restore QR code in the terminal and its `hsn://restore/1` address, and waits for the restore to end |
| `hsn backup export <file> [--history]` | `backup.export {history}`; writes the streamed chunks to `<file>` through a temporary file, renamed when the hash matches |

`hsn` reads and writes the file itself, as the user who runs it. It uploads with `{kind: "fileChunk", job, n, data, end?}` control requests, the same body as the app's `fileChunk` (48 KB ‡ of data, base64url), each answered by the shell, one upload at a time per connection; a download comes back after its reply: the reply `{job}` first (the export has started), then `{kind: "fileChunk", …}` lines on the request's connection, the last with its end mark, or `{id, kind: "fileFailed", job, reason}`. So a file job runs after the turn's answers, as every file job does (section 9), on the control socket and the app channel alike. A failure half-way (`reason`: `io` for the shell's read or the database, `stopping` for a hub stopping) ends the stream with `fileFailed`; `hsn backup export` deletes its temporary file, prints the reason and exits with HD 9's refusal code, and the app says "the export failed: nothing was saved". A stream that simply stops (a closed connection) is the same failure to the receiver, which keeps nothing without the end mark and its hash. The shell numbers each control connection with a `ConnId` from the same counter as app connections, so `UploadRef {conn, job}` and the `export` job's `conn` serve both. A control line is then at most 64 KiB ‡, above the largest chunk's line.

| Operation | Change | Who | Body | Reply |
| --- | --- | --- | --- | --- |
| `snapshot` | no | any | `topics?` | the state the person may see: hub, site, current mode, sensors (arm state, door, battery %, health, countdown), sirens (should, commanded, reported, paths), gateways, the alarm, the site move, unread notifications, `modes`, `groups` and `schedules` (section 5, "Live updates"), and `rev` |
| `subscribe` | no | any | `topics`: any of `arming`, `devices`, `alarm`, `notifications`, `history`, `config`, `people`, `hub` | the topics accepted |
| `hub.info` | no | any | — | versions, app identity, certificate fingerprint, time zone, clock trusted, boot |
| `hub.status` | no | MS | — | last commit, staged items, database size and the size guard's state, records that may be missing after a restart |
| `mode.switch` | yes | M of every sensor whose state would change (HB5a) | `mode`, `confirm?: {openDoors, lowBattery}` | `{armed, disarmed, waiting, lowBattery}` sensor lists, `mode.switch`'s also `heldBack` (D117: the sensors a schedule's switch left armed; empty otherwise), or `needsConfirmation` |
| `arm` | yes | M of every sensor whose state would change | `target: {group} \| {sensor}`, `confirm?` | as `mode.switch` |
| `disarm` | yes | M of every sensor named; `mine` needs none | `target: {group} \| {sensor} \| "mine"` | `{disarmed, alarmEnded, alarmContinues?: {triggers}, heldBack}` (D76, D95; `heldBack` the sensors a schedule's disarm left armed, D117, empty for a person) |
| `group.create`, `group.update`, `group.delete` | yes | MS | `name`, `sensors`, `sirens: "all" \| [ids]`, `ifRevision` | the group with its revision |
| `mode.create`, `mode.update`, `mode.delete` | yes | MS | `name`, `groups`, `ifRevision`; the fixed modes are refused (D90) | the mode |
| `schedule.create`, `schedule.update`, `schedule.delete` | yes | MS | `name`, `action: switchMode \| arm \| disarm`, `target`, `at: "HH:MM"`, `days: [weekdays] \| "everyDay"` or `date`, `enabled`, `ifRevision` | the entry with its next time |
| `device.list`, `device.show` | no | V(d) (sirens and gateways: any ‡) | `device?` | readings, health, settings, versions |
| `device.rename`, `device.remove` | yes | MS | `device`, `name` (rename only); no `ifRevision`: devices have no revision (section 4) | the device |
| `sensor.settings` | yes | M(d) for countdown and heartbeat (D86, HB8, AP5); MS for reply rate and correction | as `hsn sensor set` (HD 9) | the new settings version |
| `siren.settings`, `siren.test` | yes | MS | as `hsn siren set`, `hsn siren test` | the version; for a test, the request's `commands` record, which the test's decision names as its cause (`sirens` records it after answering, so the reply cannot name it) |
| `gateway.settings` | yes | MS | as `hsn gateway set` | the version |
| `usb.list` | no | MS, C | — | as `hsn usb list` |
| `usb.add`, `usb.erase` | yes | MS, C | as `hsn usb add`, `hsn usb erase` | the device added, or why not (answered when the board answers, HD 9) |
| `site.show` | no | any | — | channel, rate, Wi-Fi name (never the password), defaults, retention |
| `site.set`, `site.wifi`, `site.survey` | yes | MS (`site.wifi`: C ‡, since the password should not cross the home network more than needed) | as `hsn site set`, `hsn site wifi`, `hsn site survey` | the settings |
| `site.change` | yes | MS | `start {channel?, rate?}` \| `cancel` \| `force {yes}` | as `hsn site change` (HD 9) |
| `site.changeStatus` | no | MS | — | as `hsn site change status` |
| `history.query` | no | V of each device it returns | `devices?`, `kinds?`, `since?`, `until?`, `before?` (a `seq`), `limit` ≤ 500 ‡ | `{rows: [{kind, row}], next?}`: HD 6's rows, as `hsn log --json` writes them |
| `notifications.list` | no | any (own) | `before?`, `limit` | the person's notifications, read or not |
| `notifications.read` | no: idempotent and routine, so it carries no `seq` and is answered at once (section 7) | any (own) | `seqs` | — |
| `notifications.prefs` | yes | any (own client) | `categories` (the optional ones on) | the preferences |
| `people.list` | no | MU; any for oneself | — | people, their clients, permissions |
| `person.create`, `person.rename`, `person.remove` | yes | MU | `name`, `ifRevision` | the person |
| `permissions.set` | yes | MU | `person`, `devices: [{device, manage, view}]`, `manageUsers`, `manageSystem`, `ifRevision` | the permissions |
| `userManagement.set` | yes | MU | `on` | — |
| `clients.list` | no | any for own; MU for all | — | clients with kind, name, last seen, and which client linked each |
| `client.rename` | yes | own; MU for others | `client`, `name` | — |
| `client.remove` | yes | own; MU for others | `client`, `also: [clients]`: the clients it linked that go with it (section 7), each one the remover may remove | — |
| `link.create` | yes | MU for a new person; any for one's own device | `kind: newPerson {name?} \| ownDevice`, `form: qr \| code \| url`, `invite?` (24 h) | `{token, qr?, code?, url?, expiresInMs}` |
| `link.cancel` | yes | the maker, or MU | `token` | — |
| `pong` | no | any | — | — (the answer to a `ping` event, section 5) |
| `backup.key` | no | a phone that holds an older epoch | — | the backup key and its epoch (section 9) |
| `backup.status` | no | MS | — | folder, schedule, newest file, last result |
| `backup.settings` | yes | MS; the folder C | `folder?`, `hour?`, `keep?` | — |
| `backup.now` | yes | MS | — | the job; its result as a `hub` event |
| `backup.export` | yes | MS | `history: boolean` (section 12, Q9) | `{job}` at once, meaning started; then the file as `fileChunk` events for that job, the last with its end mark, or a `fileFailed {job, reason}` event |
| `restore.start` | no: nothing durable changes until the phone's key arrives | C, on a hub with no devices | `job`: the backup file's upload | the identity it came from, when it was made, how old its people and permissions are, and the restore token as a QR code (section 9) |
| `update.status` | no | MS | — | staged version, approval, switching, last result |
| `update.upload` | yes | MS, C | `job`: the release file's upload | the version staged, or why not |
| `update.approve`, `update.cancel` | yes | MS | — | when it will switch (D54) |

A file travels as `fileChunk` requests or events of at most 48 KB ‡ each, numbered from 0, ending with a SHA-256 of the whole; the receiver refuses a gap, a wrong total or a wrong hash. A chunk's bytes travel in the JSON as base64url without padding (as step 0 built it).

- **File bytes never enter the core.** The shell owns `fileChunk` (`OP_OWNERS`: `shell`). An **upload** goes only on the console listener ‡, since the two operations that take one (`restore.start`, `update.upload`) are C: the client picks a `job` number, unique among its uploads on that connection, and sends the chunks as `fileChunk` requests, which are not changes (no `seq`; a repeated chunk is the same bytes) and which the shell answers itself, keeping them in a temporary file in the data folder's `uploads/`, at most 256 MB ‡, one upload at a time per connection. Then the operation names the finished upload by its `job`; the core refers to it as `UploadRef {conn, job}`. The shell deletes an upload when its job ends, when its connection closes, and at every start. A **download** (`backup.export`) is the shell's `export` job, sent as `fileChunk` events on the asking connection.
- **`history.query`** is `app`'s (`OP_OWNERS`), not the shell's: `app` checks the person and computes what they may see, then gives the shell a `historyRead` effect with the query and that filter; the shell reads the page (committed rows merged with the staged ones, section 7), filters it, and sends the reply itself on that connection's queue. A row is `{kind, row}` with `row` as `hsn log --json` writes it: the schema `recordJson` moves from `hub/src/control-protocol/` to `packages/protocol/src/records.ts`, which both `hsn` and the app import, so one schema serves both.

Events (`ev`), each to the sessions whose person may see what it names:

| Event | When | Body |
| --- | --- | --- |
| `arming` | a sensor's arm state or the current mode changes | the sensors changed, the mode, `modified` |
| `countdown` | started, continued, cancelled, ended | sensor, seconds left, the trigger |
| `alarm` | started, a trigger added, a siren's state, ended | triggers, sirens, how it ended |
| `door` | a door report accepted | sensor, open, at |
| `reading` | a reading changed, at most once a minute per device ‡ | device, battery %, signal, temperature |
| `health` | silence, a path lost or back, offline, interference, battery low or back, tamper | device, what, since |
| `device` | added (an automatically added gateway too, D100), removed, renamed, its state | the device |
| `notification` | a notification for this person | section 7's fields, with `delayed` |
| `record` | a record a person subscribed to `history` may view | the row |
| `config` | a group, mode, schedule or setting changed | the object with its revision |
| `people` | a person, client or permission changed | the change |
| `site` | settings or the move's stage | as `site.changeStatus` |
| `hub` | an update staged or switching, a backup's result, the database's size, history shortened | the fields |
| `session` | this client was removed, just before the close | — |
| `ping` | the session has been quiet for 20 s ‡ | — |
| `forget` | this person may no longer view a device | the device |
| `backupKeyChanged` | the backup key was replaced; to phones | the new epoch (the phone fetches the key with `backup.key`) |

## 7. Rules

### People and permissions (D13, D33, D61, D62, D76, D99, HB3a, HB4, HB5, HB5a, AP7)

- **People and clients.** A person is a named member of the household; a client is one linked browser or phone, with its own key, belonging to one person. A person may have many clients (D61). History names the person and the client.
- **The first person** is made in first-time setup on the console, which asks for a name. On a hub with no screen, the first linking code the installer prints (D62) makes the first person instead, from a browser on the home network behind the certificate warning (D105), or from the phone app from M3. The console itself is a client of kind 0 that belongs to no person (`clients.person_id` null): it has every permission whatever user management says (D61: trusted without sign-in), acts as "hub computer", and receives every notification ‡. The control socket (`hsn`) is the same trust, as HD 9 has it.
- **User management off** (the default): every person has every permission, and the permission screens are hidden (D13). The `permissions` rows exist and are kept, but not applied.
- **Switching it on** keeps every existing person with every permission until someone changes them ‡ (D13: switching it on "reveals" the settings). Switching it off again keeps what was set, for next time.
- **A person made while it is on** (by `person.create` or a new-person link) has no permission at all, as A3 built it: no device, no *manage users*, no *manage system*. The app shows them as "no access yet", and the screen that made them goes straight to their permissions; their clients link and see nothing until someone with *manage users* grants something.
- **Per device** (D33): *manage* (arm, disarm, its settings) and *view history*, for each sensor and later each camera; *manage* includes *view* ‡. Sirens and gateways have no permission of their own: their settings are *manage system*, and every person may see their state ‡, since an alarm concerns everyone in the house.
- **Global** (D33): *manage users* and *manage system*. While user management is on, the hub refuses to take *manage users* from the last person who has it, or to remove that person ‡.
- **Arming needs** *manage* on every sensor whose state the request would change; otherwise it is refused, naming those sensors, and nothing changes ‡. This is HB5a's rule for modes, applied the same way to groups and sensors: a partial arming would leave the house in a state nobody asked for.
- **Disarm "mine"** (D51, D76) disarms every sensor the person may manage. It ends the alarm only when every trigger is then disarmed (D95); otherwise the sirens run on to their automatic stop and the reply says which triggers remain.
- **Removing a person** removes their clients and their unused tokens, in one commit; every session of their clients closes at once. Their name stays in the records, which hold it as text.
- **A new link** is active at once when a valid code is used (D121). Every new client is notified to the other clients of its person, in a category that cannot be turned off ‡ ("a new device, Ben's laptop, was linked to your account by Ben's phone"), so a person learns of a device linked in their name that they did not link.
- **A lost device** is removed by another person with *manage users*, or by its own person from another client (D61). Removing it also voids every unused token it made, and the app lists the clients it linked in the last 30 days ‡, each removed with it unless the remover unticks it: a thief's extra devices go with the stolen phone. The request names the ones left ticked (`client.remove`'s `also`), not the ones unticked, so a client linked after the list was shown is never removed unseen. Each must have been linked by the removed client within those 30 days and not yet removed, or the request is `invalid`; each must be one the remover may remove, or it is `unauthorized`; all go in the one commit. With no client left, a new one is linked on the console (D61), which can always link.
- **A permission taken away** takes effect on the next event: events are checked against the permissions when they are made, and a person who may no longer view a device is told to forget it (section 5).
- **Names** of people, clients, groups, modes and schedules (`displayName`, as step 0 built it, with one addition): 1 to 64 characters; not only white space; no control characters (Unicode category Cc), and none of the bidirectional controls U+202A to U+202E and U+2066 to U+2069 ‡, which could make one name display as another; no white space at either end; in Unicode NFC. The app trims and normalises before sending; the hub refuses, never alters. Uniqueness (section 4's keys) compares the exact text. Devices keep HD 9's names (1 to 64 characters, no spaces), since `hsn` takes them as words.

### Modes, groups and arming (D22, D41, D50, D67, D74, D90, D95, D109, D114, AL1–AL12, HB32)

- **Armed state stays per sensor** (D74, HB32), exactly as HD 8 keeps it, with its four states. Modes and groups only choose sensors.
- **A group** is a set of sensors and a choice of sirens: *every siren* by default (AL2a), or a list. A sensor may be in several groups (D74).
- **A mode** is a set of groups. Two are fixed (D90): **Away** arms every sensor, including ungrouped ones and any added since; **Disarmed** arms none. They cannot be edited or deleted. Every other mode is made by a person with *manage system*.
- **Switching to a mode** arms exactly its sensors and disarms the rest (D74): every sensor of the mode not armed is armed, every armed sensor not in it is disarmed, and a sensor already as the mode wants it is untouched (no new settings version, HD 8). The switch sets the current mode and clears `mode_modified`, unless a schedule's switch held sensors back (D117): then the house is not as the mode says, and `mode_modified` is set. A sensor added while a mode is current does not set it: no arming changed, and the app's notice at the addition says the sensor is disarmed until the next switch.
- **Arming a group or a sensor** adds to what is armed (D74); **disarming a group** disarms its sensors, even one that another armed group also holds ‡: armed state is the sensor's, not the group's. Either sets `mode_modified`, which the app shows as "Away, changed".
- **Confirmation** (D50, AL7, D109, AL12). A person's request that would arm a sensor whose door is open or whose battery is at 10% or below is answered `needsConfirmation`, naming each, unless its `confirm` says so; then the open door waits for it to close (HD 8) and the low battery is armed. A schedule never asks: it arms anyway and raises a warning naming them (AL7, AL12). The console client and `hsn op` are asked as a person is, and may answer with `confirm`; M1a's own commands keep M1a's behaviour (`hsn arm <sensor>` refuses an open door as built, `hsn arm --all` and `hsn disarm --all` ask nothing). A battery is low for this rule when `health`'s view says so (`batteryLow(view, device)`, the state of HB33), so the confirmation and the warning always agree.
- **Which sirens a trigger sounds** (AL2a, D41, D74): the sirens of every group the sensor is in, every siren if it is in none. A group's "every siren" means every siren paired at the time of the alarm ‡. A second trigger adds the sirens of its groups not yet sounding, and does not extend those already sounding (D95, D114).
- **A sensor added while a mode is current** starts disarmed, and is armed by the next switch to a mode that holds it (Away does); the app says so when it is added (section 12, Q8, decided).
- **Removing** a sensor takes it out of its groups. Removing a device in a countdown or an alarm is refused (`busy`) ‡. Removing the last siren of a group's list returns the group to "every siren" ‡, so no group can silently sound nothing. A request that names an empty list (`sirens: []`) is refused (`invalid {field: "sirens", reason: "range"}`, as A4 built it): a person who wants every siren says `"all"`, and the hub never guesses which was meant. The two rules differ on purpose: a person's empty list is a mistake to point out; a list emptied by a removal is no one's choice, so the default applies. Deleting a group, mode or sensor that a schedule names is refused, naming the schedules ‡ (`invalid {reason: "inUse", refs}`): `layout` checks its own deletions, and `app` and `control` check a device's removal before sending it to `registry`, all through `schedules`' view `schedulesNaming(target)` (A5). `schedules` checks a target exists when an entry is created or changed, through `layout`'s view `groupExists(id)`, `modeExists(id)` (A4) and the registry's for a sensor (`unknownReference`). So a target never disappears under an entry; if one is missing at a run all the same, `schedule_ran` records `layout`'s refusal and nothing is armed.
- **Deleting a group** removes it from every mode that holds it, each such mode taking a new revision and a `config` event; armed sensors stay armed (as A4 built it). **Deleting the current mode** is allowed: the hub then has no current mode, with `mode_modified` set, the same state the migration gives a house armed in no mode's way (section 4). The app shows "no mode" and the arming as it is; a schedule's next switch sets a mode again.
- **Editing a group while armed** changes no sensor's state ‡; its siren choice applies from the next trigger.
- The countdown, the alarm, late reports, the automatic stop, the post-alarm rule and restart resume are as built (HD 8, D113, D114).

### Schedules (D45, D68, D87, HB13, HB31, AL2, AL7, AL10, AL12)

- **An entry** is one action at one local time (D87): switch to a mode, or arm or disarm a group or a sensor; on chosen weekdays, every day, or once on a date.
- **Weekdays** travel as `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun` (as step 0 built them), Monday as bit 0 of `schedules.days`. A list holds 1 to 7 days without repeats, in any order; the hub answers in Monday-first order, and all seven as `"everyDay"`.
- **Its next time** is `calendar.next(rule, zone, wall)`, on the trusted wall clock, in the hub's time zone (HB31), daylight saving included. The core holds it as a monotonic deadline (`now.mono` + the difference), as every timer (HD 2), and computes it again when the wall clock steps or becomes trusted, when the zone changes, after a restart, and when the entry changes.
- **Daylight saving.** A local time that does not exist that day (the clock jumps over it) runs at the first minute after the jump ‡, on that same local date; a local time that happens twice runs once, at the first ‡. An entry runs at most once per local date, and that rule wins where the two meet: a date the zone skips altogether (Pacific/Apia, 30 December 2011), or a jump that lands on the next date, gives that date no run, and no miss either, since nothing fell due (as A5 built it).
- **Running.** The entry's action goes as a request with the actor "schedule <name>" and the schedule's own authority, never asking for confirmation (AL7, AL12). Its decision, `schedule_ran`, names what it armed, disarmed, left waiting and found low; the entry's last run is written in the same commit as the arming, so after a power cut it neither runs twice nor is lost.
- **Two entries due in the same minute** run in the order of their ids ‡.
- **AL10, D68** need no rule of their own: a person's disarm during a scheduled armed period lasts until the next entry runs, because entries are actions, not periods.
- **An untrusted clock** (a Pi with no network, HD 5). No entry runs; one warning, `schedules_waiting_for_clock`, goes to people with *manage system*. When the clock is trusted, every entry that fell due meanwhile is missed (below).
- **Missed entries are skipped, never run late (D116).** An entry is missed when it fell due while the hub was off, while its clock was untrusted, or inside a forward step of a trusted clock (a step of more than 60 s ‡, `clockStepMs`; smaller differences only move the anchor, `reanchorMs` 1 s ‡): three reasons, `hubOff`, `clockNotSet` and `clockStepped`, the last its own, since the clock was set and the person should look at the computer's time, not the hub's setup. The entry keeps its last miss (`schedules.missed_due_ms`, the last missed occurrence, and its `missed_why`; `missed_count`, the occurrences missed since the entry last ran, across gaps; the app shows "missed at 22:00: the hub was off", with "and 2 earlier" when the count is above one; written now with `schedule_missed`, cleared when it next runs), so the schedule's screen still shows it after a restart. The hub finds them when it can: at a start with a trusted clock and a known downtime, the occurrences between the last commit's time and now; when the clock becomes trusted, those between the last trusted commit and now. Each missed entry gives one decision, `schedule_missed` (a warning, written now), naming the entry, when it was due and why it was missed (hub off, clock not set); several occurrences of one entry in one gap give one decision with their count and the first and last ‡. It is notified to people with *manage system* and cannot be turned off ‡, since the house may now be armed or disarmed against the plan. The app shows it on the schedule's screen ("missed at 22:00: the hub was off") until the entry next runs, and in the history. The entry's next time is computed as usual; nothing runs late. When the downtime is unknown and the clock untrusted, the hub cannot tell what it missed until the clock is set, and says so.
- **During a countdown or an alarm, a scheduled disarm holds back (D117).** Every sensor that is a trigger of the alarm or has a countdown running stays armed; the rest of the entry is done as usual; the entry is recorded as `schedule_held_back` (a warning, written now) naming the sensors left armed, and notified with the alarm or countdown it concerns. The alarm runs until a person disarms or it stops by itself. A scheduled arm or mode switch that only adds arming runs as usual.

### Notifications (D46, D69, D75, D76, D82, D92, D97, D102, D109, HB9, HB10, HB33, AP6, AP9a)

The `notify` module turns decisions into notifications. Each has a kind, a category, whether it can be turned off, whether it is critical, and its recipients.

| From the decision | Notification | Can be turned off | Critical |
| --- | --- | --- | --- |
| `countdown_started` | countdown, with Disarm for those who may manage the sensor (D76) | no (D75) | yes (D92) |
| `alarm`, `late_report_sirens` | alarm, with Disarm | no | yes |
| `late_report_notification` | alarm, saying when the door opened and that the report was late (D106) | no | yes |
| `local_alarm_reported` | the sensor sounded its own alarm while the hub did not answer | no ‡ | no |
| `tamper_opened` | cover tamper (D9) | no (D75) | while armed ‡ |
| `long_press_ignored` | a pairing or reset hold while armed (HB10, D89) | no ‡ | no |
| `sensor_silent` while armed | device silent while armed | no (D75) | yes |
| `sensor_silent` while disarmed | device silent while disarmed | yes (D75) | no |
| `siren_silent` | siren silent | no (D75) | while any sensor is armed (the decision's value 1, HD 8) |
| `siren_wifi_lost`, `siren_lora_lost` | siren path lost (AP6) | yes ‡ (D73 calls it a warning; D75 does not list it) | no |
| `gateway_offline` | gateway offline, naming it and the sensors no other gateway hears (D97) | no while any of those is armed (D97), otherwise yes | no |
| `interference_started`, `noise_interference_started`, `interference_learned_as_normal` | jamming (D82) | no (D82) | while armed (D82) |
| `battery_low` | low battery, once on the way down (HB33) | yes (D75) | no |
| `mode_switched`, `arming_changed` | arm and disarm: one per action, from its summary decision only, never from the per-sensor `armed` and `disarmed` | yes (D75) | no |
| `schedule_ran` with an open door left waiting or a low battery armed | a schedule's warnings (AL7, AL12), beside its arming's own notice | yes (D75), in `armDisarm` | no |
| `door_state_unexpected`, `cover_state_unexpected` | a heartbeat shows a door or cover the hub did not expect (D114) | no ‡, in `stateUnexpected` | the door's while its sensor is armed (HD 8); the cover's never |
| `schedules_waiting_for_clock` | schedules wait for the clock, to *manage system* | no ‡, in `scheduleMissedOrHeldBack` | no |
| `schedule_missed`, `schedule_held_back` | a schedule entry missed (D116) or held back during an alarm (D117) | no ‡ | no |
| `update_staged`, `update_healthy` | updates | yes (D75) | no |
| `update_rolled_back`, `restored` | the hub itself: an update undone, a restore done | no ‡ | no |
| `backup_no_folder`, `backup_overdue`, `backup_key_replaced`, `backup_folder_on_data_disk` | backups (section 9) | no ‡ | no |
| `commit_failed`, `history_shortened` | the hub has a problem with its disk | no ‡ | no |

- **Recipients** (D69, D76): every person who may view the device it names; for those about the hub as a whole, every person with *manage system*. A door opening while disarmed is recorded only (D46).
- **Categories per client** (D69, AP9a): every optional category starts on; a client turns them off for itself. The ones that cannot be turned off are always delivered.
- **The categories' names**, as step 0 built them, with `hub` added. Optional, in the order of their bits in `notification_prefs.categories` (bit 0 first): `sensorSilentWhileDisarmed`, `sirenPathLost`, `gatewayOffline`, `batteryLow`, `armDisarm`, `updates`. A new optional category takes the next bit, never an old one. Always delivered: `countdown`, `alarm`, `localAlarm`, `tamper`, `longPress`, `sensorSilentWhileArmed`, `sirenSilent`, `jamming`, `scheduleMissedOrHeldBack`, `disk`, `newClient`, `backup`, `hub`, `stateUnexpected`. A `gateway_offline` while a sensor only that gateway hears is armed is delivered whatever `gatewayOffline` says (D97).
- **Restore and updates are decisions**, not hub events, as step 0 built them: they are the hub's own choices with consequences people are told of, and `notify` acts on decisions. `update_switching` is recorded and announced to the apps as a `hub` event, not notified: the hub stops a moment later. Section 9's "critical" and "a warning" describe the notification: not one that can be turned off.
- **Delivery in M2** is to open sessions only, as `notification` events. When a client connects it gets its person's unread notifications of the last 7 days ‡; one raised more than 60 s ‡ before it is delivered is marked `delayed`, with its time (D102's rule, applied to sessions). Push to phones is M4 (D32); nothing in M2 takes delivery to mean that a phone was reached, and the notifications table keeps who each was for, so M4's outbox is added beside it.
- **Critical in the web app** means a banner over every screen with the Disarm button where allowed, a sound if the browser allows one (most only after the user has touched the page), and the browser's own notification if the user granted it ‡. A web page is no substitute for push: a closed tab is told nothing (section 13).
- **No flood**, exactly: a notification is not raised when one of the same kind about the same device (or, naming no device, about the hub) was raised in the last 10 minutes ‡, unless it is critical, or its category is `armDisarm`, `scheduleMissedOrHeldBack`, `newClient` or `hub`. A6's reading is confirmed, with critical ones added (a second cover opening while armed is told). A notice not raised is still its decision's record in the history.
- **One per action** (D75's "one per action, not per sensor"). Every arming action has one summary decision: `mode_switched` for a switch (as built), and `arming_changed` (new, `layout`'s) for every other arm or disarm, of a group, a sensor or `mine`, by a person, `hsn` or a schedule; in M2 every arming request goes through `layout`, `hsn`'s included. The summary names the sensors the action changes. The notification comes from it alone; its recipients are every person who may view at least one of those sensors, and the console. A schedule's run adds a second notice only for its warnings (the table).
- **What notify reads**, through views as HD 2 has them, each read as the state stands when `notify` handles the message (so a change earlier in the same step is seen): `people`'s view (A3, as built in `core/people/view.ts`): `liveClient(client)` for a client's person (`ClientRow.personId`, null for the console), `clientsOf(person)`, `userManagementOn()`, `peopleWhoMayView(device)` and `peopleWith("manageSystem")`; no copy of permissions in `notify`'s slice, whose boot-snapshot interim goes. `notify` needs no `rev`: it emits `notificationRaised {notification, clients}`, the `NotificationObject` and the clients whose categories let it through, and `app` sends a `notification` event to each open session of those clients with its own `rev`. Unread notifications on connecting are in the `snapshot` (section 6), which `app` builds from `notify`'s view `unreadFor(person, sinceMs)`.
- **Reads are routine** (section 3). `notifications.read` is not a change: marking a notification read twice is the same as once, so it needs no `seq`, takes no stored reply and is answered at once; the read rows go into the routine batch. A power cut can lose five minutes of reads, and those notifications show unread again, which section 3 accepts.
- **Critical notifications are written now**, by `notify`, whatever the class of the decision that raised them. A "now" commit takes everything staged (HD 5), so the decision reaches the disk in the same commit even when `audit`'s cap moved it to the routine batch; nothing else must hold.

### History (D57, D110, HB5a, HB15, HB24)

- **What a person sees** is the records of HD 6 filtered: rows about devices they may view, their own requests and notifications, and, with *manage system*, the hub's own events (HB5a). Exactly, as `HistoryFilter` carries it: a row naming a device the person may view; a `commands` row whose actor ends in ` (client <n>)` for one of the person's clients ‡ (the actor text's fixed form, section 4); a `notifications` row whose recipients hold the person; and, only with *manage system*, every row naming no device. The console and the hub computer see every row. Live `record` events are filtered by the same rule, in `app`.
- **Reads never force a commit.** A history page is read from the committed rows merged, by `seq`, with the writer's staged records not yet committed (a new `Reader` capability); so a person reading history does not defeat the five-minute batch (HD 5). Only `hsn log` flushes first, as HD 3 has it.
- **Pages** of at most 500 rows ‡, newest first, continued by `before`.
- **Retention** is adjustable by *manage system* (HB24): routine 1 to 90 days, events 30 to 730 days ‡. The app says when a setting would take the database past the size guard's marks, which then shortens history by size (HD 6).
- **Display.** Packet bodies are raw (HD 6); the app decodes them with `@hsn/protocol`.

### Device health (D9, D97, D107, D109, HB7, HB8, HB9, HB10, HB25, HB33, AP4, AP5, SR6, GW6, GW11)

- **What is built** (HD 8): sensor silence by D107, siren paths and siren silence, gateway silence (D97), interference and damaged packets, and every reading (battery voltage, temperature, signal, firmware, the gateway that heard it) for HB7.
- **Battery percentage** (HB33, D109) comes from a table for the fitted cell: a piecewise-linear curve of voltage against charge, held in `HubRules`. Until it is measured on the board (sensor-board.md), the hub's 10% must be the firmware's own 3,500 mV (`kLowBatteryMillivolts`), so the sensor's buzzer warning and the hub's agree ‡. **Until the curve is measured** (section 12), `HubRules` holds this interim table for a single lithium-ion cell (4.2 V full; step 0's comment calling it lithium-iron is wrong), every point ‡ but the 10% one: 3,000 mV 0%, 3,500 mV 10%, 3,600 mV 15%, 4,200 mV 100%. The 15% point sits 100 mV above the 10% one, so the low-battery state does not flap on the reading's noise.
- **Low battery** is raised at 10% or below and cleared above 15% (HB33), on readings of a packet with the highest counter only (HD 8), with the state written now so it is raised once. Sirens and gateways count only while on their cell, not on mains (D109).
- **Tamper** comes from cover changed reports (an event packet, HD 5): open raises `tamper_opened`, closed `tamper_closed`. A heartbeat showing a cover the hub did not expect is a warning only, as for doors (D114): `cover_state_unexpected` (new, `health`'s), value 1 for a cover shown open, 0 shown closed, recorded once per change of what the heartbeats show, as `door_state_unexpected` is for doors.
- **A late cover report** (not the newest packet, HD 8) never changes the tamper state, which follows the newest packet. But an opening must be told: when it reports an opening at a time after the last `tamper_opened` of that sensor, `health` records `tamper_opened` with the report's own time, marked late (as D106 does for doors), and `notify` tells it as any other; no `tamper_closed` follows unless the state itself changes.
- **Gateways** report no cell voltage (protocol.md §7), so a gateway has no battery percentage (`null`), no low-battery state and no notice; the device screen shows only whether it runs on its cell. Sirens follow the battery rules while on their cell (D109). A gateway's voltage is a protocol addition for a later milestone (section 13).
- **Battery readers.** `health`'s view (`batteryPercent`, `batteryLow`) is the only place a voltage becomes a percentage or a low state. `alarm`'s confirmation rule (D50, AL12) reads `health`'s view, not the voltage in its own slice; A4's own `batteryPercent` in `alarm/plan.ts` goes.
- **Settings.** The heartbeat interval per sensor (HB8, AP5) is `sensor.settings`; the silence rule follows it as built.
- **The device screens** show battery %, signal, firmware, tamper, poor link (D107) and which gateway heard it last (AP4).

### Awkward cases

| Case | What happens |
| --- | --- |
| A schedule's disarm comes during an alarm | The triggers stay armed, `schedule_held_back` names them, everything else is disarmed; the sirens run on (D117) |
| A schedule's arm comes with a door open and a battery low | Both armed as far as they can be: the door waits for it to close, the low one is armed; `schedule_ran` names both, and the arm-and-disarm notification carries the warning (AL7, AL12) |
| Two people act at once | The loop takes requests in the order they arrive (HD 4); each is decided on the state the one before left. Anna switches to Away, Ben disarms the garage 100 ms later: Away, then the garage disarmed; both recorded with their names, both clients see both events. Edits carry `ifRevision`: the second of two edits to one group gets `conflict` and the group as it now is |
| A mode is switched while a countdown runs | A switch that disarms the counting sensor cancels its countdown with the disarmed notice twice (D24, HD 8); one that keeps it armed leaves it running; switching to Disarmed during an alarm disarms every trigger and ends it (D95) |
| The clock is not trusted | Schedules wait; token ages run on the monotonic clock and do not survive a restart with unknown downtime; records say their time is untrusted (HD 6); the app shows times as "about" with the reason |
| A person is removed while their request waits in the queue | The removal and the request are handled in arrival order: a request after the removal is refused (`unauthorized`), and the sessions close |
| A Disarm by someone who may not manage a trigger | Their sensors are disarmed; the alarm continues; the reply and the app say which triggers remain (D95) |
| An update is approved during a countdown | It waits until no countdown, alarm, site move or provisioning runs (D54, HB23) |
| A group is edited while armed | No sensor's state changes; the siren choice applies from the next trigger |
| The hub restarts | Sessions close; clients reconnect and take a snapshot; schedules are computed again; tokens follow the expiry rule above |

## 8. The web build of the app

### Structure

One codebase for the phone and the web (D93), in the workspace `app/` (`@hsn/app`), as stack.md lays it out: React Native with Expo and Expo Router, React Native Web for the web, TanStack Query and Zustand, React Hook Form with Zod, NativeWind, i18next. The Expo version is chosen and pinned in step 0 (section 11).

| Folder | Holds | Shared with the phone |
| --- | --- | --- |
| `app/src/app/` | Expo Router's routes: one file per screen | yes |
| `app/src/hub/` | The channel client: connection, Noise session and reconnection, requests with their `id` and `seq`, events with their `rev`, file chunks; all on `@hsn/protocol` | yes |
| `app/src/state/` | The live store (Zustand), built from `snapshot` and kept by events; queries and mutations (TanStack Query) for history, configuration and people, invalidated by `config`, `people` and `record` events | yes |
| `app/src/platform/` | `keys.web.ts` (IndexedDB) and `keys.native.ts` (the phone's secure storage); `qr.web.ts` (show a code; scan with the browser's camera, which O12 found present behind the warning) and `qr.native.ts` (expo-camera) | per platform |
| `app/src/ui/` | Components, styles, the banner for countdowns and alarms | yes |
| `app/locales/en/` | Every interface text (HB27, D58) | yes |
| `app/e2e/` | Playwright tests against the exported web build and a real hub (section 10) | web only |

- **Keys and sequence numbers.** A client keeps, per hub: the hub's identity and static key, its own static key, its client id and its last `seq`. The next `seq` is written to storage before the request is sent, so a crash in between skips a number and never reuses one. A client that finds its storage gone links again.
- **Connection.** One session per hub. On a drop the client reconnects after 1, 2, 4, then every 10 s ‡, takes a new snapshot, and shows a banner while it is out of touch. Requests made while out of touch are not queued for later: arming late is worse than being told it failed.
- **A change whose reply was lost** is sent again with the same `seq` on the next session, but only within 30 s ‡ of its first sending: a stored reply then answers it (`repeat`), or the hub does it now, still close to when it was asked. After 30 s the client never sends it again; it tells the person "the hub did not confirm this" and shows the state from the new snapshot, which says whether it was done (and the history shows its `commands` row if it was).
- **A connection closed before message 2** tells the client nothing certain: an unknown or removed key, no shared version, the limits on handshakes and a hub restarting all look the same, on purpose, so that nobody can ask the hub which keys it knows. The client retries as for a drop. After 5 ‡ such closes in a row, over at least a minute, while the hub's page itself still loads, it says "this browser may have been removed from the hub, or the hub is refusing it" and offers to link again; it keeps its keys until a new link succeeds.
- **The build.** `expo export --platform web` writes static files, which the hub's install carries in `web/` and serves on the apps' and the console's listeners (section 5). No service worker (D105, O12). The build is stamped with the channel version it speaks; the hub serves only a build whose version it speaks.

### Screens

| Set | Screens | Why now |
| --- | --- | --- |
| **For the "done when"** (built first) | The console's first link (`hsn open`); first-time setup: the first person's name, the site (channel by survey, rate), the Wi-Fi details for devices; the gateway shown as added when plugged in (D100); adding sensors and sirens over USB and naming them (PR5, development boards); the home screen: current mode, Away and Disarmed, each sensor's state and door, the countdown and alarm banner with Disarm; the device list with health | The milestone's own test (section 10) |
| **The rest of M2** | Groups; modes; schedules; history; people, permissions and the user-management switch; linking another browser (QR, typed code, link URL); notifications and their categories; device detail and settings (AP4, AP5); the site move (D115); backup and restore; updates; the hub's status | The build plan's M2 row lists each |
| **Later** | Bluetooth pairing and updates (M3), push and the lock-screen Disarm (M4, M5), presence (M5), the app lock (M5), several hubs (M5) | Need a phone or the relay |

### Accessibility and translation

- **Accessibility**: WCAG 2.2 level AA ‡. Every control has a role and a label; everything works from the keyboard with visible focus; a countdown or alarm is announced at once to screen readers (an assertive live region), its time left politely; state is never shown by colour alone; text stays usable at 200% zoom; motion follows the system's reduced-motion setting. Checked by axe in every Playwright test, and by a manual pass with VoiceOver and NVDA before release.
- **Translation** (HB27, D58): every text through i18next keys in `app/locales/en/`; a lint rule refuses literal text in components (an existing plugin if it works with ESLint 10, otherwise our own, as for `must-use-result`, HD 10); plurals by ICU messages; times shown in the hub's time zone (HB31) from `hub.info`, not the browser's ‡, so a schedule reads the same on every screen. The app does no calendar arithmetic and needs no Temporal: a schedule's next time comes from the hub (`nextMs`), and every instant is formatted with `Intl.DateTimeFormat` and the hub's zone, which current browsers have; whether the phone's JavaScript engine has time-zone data is checked with the phone build in M3.

## 9. Installer, service, backup and updates

### The installer and the service (D16, D29, D62, D64, D94, D118, HB18–HB21, HB28, GW8, O7, O18)

| | macOS | Linux (x64, arm64) and Raspberry Pi | Windows (x64) |
| --- | --- | --- | --- |
| Package | `.pkg`, unsigned until the developer account comes with M4 (D119): the user approves it in the system's security settings | `.deb` ‡ for Debian, Ubuntu and Raspberry Pi OS 64-bit (D112: 64-bit only) | `.msi` ‡, unsigned: Windows SmartScreen warns on first run (section 12) |
| Service | launchd daemon, run at load, kept alive, as a dedicated user `_hsnhub` ‡ | systemd unit, `Restart=on-failure`, as user `hsn` in group `dialout` for the USB port ‡ | a Windows service under the virtual account `NT SERVICE\HSNHub` ‡, hosted as spike W3 decides (below) |
| Data folder | `/Library/Application Support/HSN Hub/` | `/var/lib/hsn-hub/` | `%ProgramData%\HSN Hub\`, its access list the service account and Administrators ‡ |
| Sleep prevention (HB28) | the hub runs `caffeinate -s -w <its pid>` ‡ | the unit's command runs under `systemd-inhibit --what=sleep:idle` ‡ | the hub calls `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)` through `bun:ffi` ‡ |
| Laptop or battery warning (HB21) | `pmset -g batt` | a supply of type `Battery` in `/sys/class/power_supply/` | `GetSystemPowerStatus` through `bun:ffi` ‡ |
| Clock trust (HD 5) | trusted | systemd's time service | trusted (a battery-backed clock, as HD 5 has it) |
| USB port | as built (HD 3) | as built (HD 3) | Windows' own USB serial driver serves the board's port (Windows 10 and later) ‡; opened as spike W1 decides (below) |
| Command socket (`hsn`) | as built (HD 9) | as built (HD 9) | as spike W2 decides (below) |
| Opens the setup page (HB19) | the installer, as root, gets the console token and opens the address in the logged-in user's browser | the same through the user's session when there is one; otherwise prints the first linking code, the home-network address and the certificate's fingerprint (D62) | the `.msi`'s elevated part (a deferred action, as LocalSystem, which the data folder admits) gets a console token and writes the opening page into the installing user's own folder (the `UserSID` and `LocalAppDataFolder` of that user); the exit dialog's "Open the setup page" (ticked) then opens that page's path in the default browser from the installer's own interface, which runs as the installing person, unelevated. The token carries no command line, and the page is readable only by that user. A silent install opens nothing; the Start menu's "HSN Hub setup" runs `hsn open`, asking for elevation once |
| Firewall | the application firewall's own prompt for the hub's program ‡ | a rule for the two LAN ports when `ufw` is on ‡ | rules for the two LAN ports and mDNS through `netsh advfirewall` ‡ |

- **The program** lives in `<prefix>/versions/<version>/` (the Bun executable holding the hub and `hsn`, `web/`, the migrations), with `<prefix>/current` pointing at the running one, and a small separate launcher the service manager starts (below). At most two versions are kept.
- **Starts at boot with nobody logged in** and restarts after a crash (HB20). The service manager runs the launcher; the launcher runs the hub, and restarts it on **any exit but a clean stop's 0**. Exit 70 is only the hub's own request to be restarted (a restore's switch, an update's switch, HD 10) and restarts it at once; **an uncaught exception exits 71** ‡, no longer 70 (HD 10 changes, section 13), so a crash is never taken for a request. Every code but 0 and 70 (71, a kill, 78 for a database it refused, HD 9) is a failure, and so is a 70 that comes within a minute of a start three times in a row ‡, so a restart request cannot loop either. After a failure within a minute of starting, the next start waits 1 s, then 10 s, 30 s, then every 5 minutes ‡; a start that runs a minute resets the count. **It never stops trying**: a security hub that gave up would stay down after a cause that clears by itself (a disk remounted, a USB hub replugged). It says so instead: after the third failure in a row it writes `launcher-status.json` in the data folder (failing since, the count, the last exit code and the last lines of `fatal.log`), which `hsn status` shows when the hub does not answer, and logs each failure to the system's log (the journal, the unified log, the Windows event log). Each start records the previous exit (HD 10). The launcher itself exits only for a clean stop of the service, and the service manager restarts it on any other exit: launchd with `KeepAlive` and `SuccessfulExit` false, systemd with `Restart=on-failure` and `RestartSec=5`, WinSW with `<onfailure action="restart" delay="5 sec"/>` ‡.
- **Gateway discovery** (GW8) is the hub's mDNS, as built. The installer checks that multicast is not blocked by the firewall it set up.
- **Uninstalling** removes the service and the program and keeps the data folder unless asked.
- **Still open beyond Windows.** D94's other checks (Linux x64, a service at boot, a week-long run) run in step 3. The `.deb`'s use of `bun:ffi` for the terminal (HD 3) is untried on musl systems (O18), which the `.deb` does not target.

### Windows (D118)

M2 is not done until the hub installs and runs fully on Windows, with USB gateways and `hsn` (D118). Two problems M1a left open must be solved. The answer to each may change a transport or a library on every system, so each is settled by a short spike before step 0 freezes anything (section 11).

#### W1: a serial port under Bun on Windows (O18)

What must hold, as on macOS and Linux (HD 3): the link is byte-clean both ways (8 data bits, no parity, no flow control, no translation of any byte); reading never blocks the hub's one thread; a close takes effect at once and frees the port for the next opener; unplugging is seen as a close; ports are listed with their USB vendor number (Espressif's 0x303A, §10) and a new one is noticed without polling hard; opening the port does not reset the board, whose USB port can reset the chip through the modem-control lines (DTR, RTS) ‡; and the idle processor load stays within HD 5's 0.5% ‡.

| Option | How | Costs | Risks |
| --- | --- | --- | --- |
| (a) Win32 through `bun:ffi`, in a worker | `CreateFileW` on `\\.\COMn`; `SetCommState` with a `DCB` set to 8 bits, no parity, binary, no flow control, DTR and RTS held as the board needs; `SetCommTimeouts` so that a read returns as soon as a byte is there or after 500 ms ‡, letting the worker notice a close; `PurgeComm`; `ReadFile` and `WriteFile` in a Bun worker thread, so their blocking never stops the hub; `CloseHandle`. Listing through SetupAPI (the serial-port device class, each device's hardware id for `VID_303A`), and new ports through `RegNotifyChangeKeyValue` on the serial-ports registry key, also in the worker | About as much code as the termios path (HD 3), plus the hub's first worker thread | `bun:ffi` and FFI calls inside a worker on Windows are untried here (Bun's documentation says both are supported, from memory). The `DCB`'s bit fields are laid out by hand, and a wrong layout can fail quietly; the spike reads the settings back, as the termios path does |
| (b) A small native helper | A program of a few hundred lines in C or Rust that opens one port and copies bytes between it and its standard input and output, and lists ports; the hub starts one per port with `Bun.spawn` and reads its pipes | A second language and toolchain, and a second program to build, sign and ship on every platform | Low technically. If chosen, it replaces the termios path on macOS and Linux too, so there is one serial path, tested everywhere |
| (c) Another library | `serialport`'s Windows binding, in a Bun release that fixes O18, or another package | Nothing, if it works | Out of our hands: no date for a fix, and the same add-on fails today on every system |
| (d) Node for the serial port only | A Node process running `serialport`, started as (b) | A second runtime in the install (about 150 MB, S1), against D94's small install | Two runtimes to keep current |

**Recommendation: (a)**, because it keeps one program and mirrors the termios path, so the serial adapter's interface (HD 3) and everything above it is unchanged. **(b) is the fallback** if W1 fails, and then replaces the termios path on every system.

**Spike W1** ‡ (three days, on a real Windows 11 x64 computer with an Olimex ESP32-S3 board on development firmware; a hosted runner has no USB): open a port, set the `DCB` and read it back; all 256 byte values both ways, at the rate of frames the bench's load test sends; an Identify and Identity exchange (§10) through the hub's own frame decoder; the board not reset by opening or closing; a close that returns within 1 s and leaves the port free for another opener; unplugging seen within 1 s; the board listed by its vendor number; a newly plugged board noticed within 2 s; the idle load measured; a 24-hour run carrying the bench's frames. Any failure that a day's work cannot fix means (b).

#### W2: a command socket only the right accounts can reach (HD 9)

What must hold: the hub's own account and administrators of the computer can send commands; no other user of the computer, and no web page, can. (Settled after W2, below: "the user who installed it" reaches `hsn` through the administrator's rights installing needed, as on macOS and Linux, not as an account of its own.)

| Option | How | Costs | Risks |
| --- | --- | --- | --- |
| (a) A Unix-domain socket on Windows | Windows 10 (1803) and later have `AF_UNIX` sockets, guarded by the socket file's access list as on macOS and Linux. If Bun's `unix` listener and `net.connect(path)` use them on Windows, the hub's existing control server works unchanged, with the file's access list set to the three accounts (by `SetNamedSecurityInfoW` through `bun:ffi`, or by the installer) | Almost nothing | Node maps a path to a named pipe on Windows, and Bun may too (from memory, unverified); then `AF_UNIX` is out of reach |
| (b) A named pipe made through `bun:ffi` | `CreateNamedPipeW` with a security descriptor made from an SDDL string granting the service account, the installing user's SID (stored at install) and Administrators; each pipe instance served by blocking calls in a worker; `hsn` connects with `net`, which needs no access list as a client | A pipe server in Win32 calls: instances, connection and disconnection, all in a worker | The fiddliest of the three; the pipe server's behaviour under many connections is ours to get right |
| (c) Loopback TCP with a secret | The hub listens on 127.0.0.1 only; a connection's first line must carry a 32-byte secret read from a file whose access list admits only the three accounts; the rest is the existing control protocol | `net` and a file's access list: no new native code; the same on every system | A different trust model from HD 9's: any local program can connect, but without the file it gains nothing against a 256-bit secret; a web page can send to the port but cannot read the file, and the line protocol refuses whatever is not a JSON request after the secret |
| (d) A native helper owning the pipe | As W1 (b) | As W1 (b) | As W1 (b) |

**Recommendation: (a) if the spike shows Bun reaching `AF_UNIX` on Windows; otherwise (c)**, which needs no new native code, and is then used on every system so the control socket has one implementation and one set of tests. (b) only if both fail.

**Spike W2** ‡ (two days, on a hosted Windows runner, since no board is needed): for (a), listen, set the file's access list, and check that the installing user and an administrator connect while a second local user, made in the job, is refused; for (c), the same checks against the secret file, and a browser page's request to the port refused.

#### W3: the service and the rest

- **Hosting the service.** A Windows service must answer the Service Control Manager, which a Bun program does not do by itself. Options:
  - (a) **WinSW**, the "Windows Service Wrapper": an open-source program (MIT licence, github.com/winsw/winsw) that registers itself as a service and runs another program as its child, restarting it as its XML file says. Version **2.12.0**, its last release marked stable, built for .NET Framework 4.6.1, which Windows 10 and 11 include ‡ (from memory; v3 has been in pre-release for years). The build downloads `WinSW-x64.exe` of that release, checks its SHA-256 against the value pinned in `hub/packaging/windows/winsw.sha256`, refuses on any difference, and ships that file and its licence in the `.msi`; changing the version means changing the pinned value in a reviewed commit.
  - (b) **NSSM**: public domain, but its last release is from 2014 and some antivirus programs flag it ‡.
  - (c) **The launcher answers the manager itself** through `bun:ffi`: `StartServiceCtrlDispatcherW` calls back from a thread of its own, which Bun's FFI callbacks are not known to handle safely.
  - (d) **A service host in the helper's language**, if W1 chose a helper (option b there): a few dozen more lines in a program we already build.

  Recommendation: (a), unless W1 chose a helper, then (d) and no third-party program. WinSW is the one third-party executable the installer would ship, so its file is pinned and checked like a dependency's lock entry. **Spike W3** ‡ (a day, with W2 on the runner, and a reboot in a virtual machine): installed as a service, started at boot with nobody logged in, restarted after exit code 70, stopped cleanly.
- **Paths and access lists**: the data folder is limited to the service account, Administrators and SYSTEM (W2 chose the Unix-domain socket, in that folder).
- **Who may use `hsn`: administrators, on every system.** On macOS and Linux the socket is the hub account's alone (HD 9), so a person runs `sudo hsn …`; the installing user can because installing needed an administrator. Windows gives the same: `hsn` from an elevated prompt (an administrator's token with Administrators enabled), and from a normal prompt it says "run hsn from an administrator prompt" on the refusal. No user's SID is recorded and no group is made. Rejected: a socket-only subfolder granting the installing user's SID, since it would give one ordinary account the computer's full trust (D61: it can disarm and link a console) on Windows only, without the rights the other systems ask; and granting that user the data folder, which would let it read `hub.db` and every device key. The installer runs elevated, so it gets the first console token itself (`hsn open`'s request over the socket) and opens the address in the installing user's browser, unelevated (A8).
- **The folder's access list is set twice, as mode 0700 is on the other systems.** The installer sets it at install and at every upgrade (A8): inheritance removed, full control for `NT SERVICE\HSNHub`, Administrators (`S-1-5-32-544`) and SYSTEM (`S-1-5-18`), nothing else, applied to the folder and everything in it. The hub checks it at every start before opening the socket (A11, as built) and, finding any other entry, sets that exact list itself as a protected list (`SetNamedSecurityInfoW` with `PROTECTED_DACL_SECURITY_INFORMATION`, from `shell/safe/`), reads it back, and only then listens; it records a warning hub event, `data_folder_was_open`, since another account may have read the device keys before, which `hsn status` and the console show. If it cannot set the list (no right to change it), it refuses the socket as today, with the warning. So an upgrade from a folder made open is closed by the installer and, failing that, by the hub at its first start.
- **To try on the hosted runner** (with W3's job): an administrator in a normal prompt is refused and in an elevated one answered; an ordinary user, made in the job, is refused by the socket and cannot read `hub.db`; the `.msi` installed by an administrator for an ordinary logged-in user opens that user's browser unelevated with the console address; and a data folder made open before the hub's first start is closed by it, with the warning.

#### Testing Windows when the development machine is a Mac

- **A hosted Windows runner** (x64) proves: the `.msi` builds and installs; the service starts, restarts and stops; W2's access checks with a second user; the hub's tests that need no board (core, shell, budget, crash, the process-kill layer by `TerminateProcess`, lockstep); the web app's Playwright tests in Edge and Chromium. It cannot prove: a USB board (no USB), a reboot of itself, sleep on a laptop, or what a person sees when SmartScreen warns. A virtual COM-port pair driver (com0com) would let the serial adapter's tests run there, if the runner allows the driver to be installed ‡ (unverified); if not, they run only on the real computer.
- **A real Windows x64 computer with a board** (a small, inexpensive PC ‡) is needed for W1, the serial adapter's tests, unplugging and replugging, sleep prevention, and the "done when". It is kept as a self-hosted runner with a board attached, so the serial tests run every night, and the Mac's developer reaches it by remote desktop or SSH ‡.
- **A Windows virtual machine on the Mac** (Windows on ARM on Apple silicon, where Bun runs as x64 under emulation) is a useful first look with USB passed through, but proves nothing about an x64 computer's drivers or timing ‡.
- **When**: W1, W2 and W3 come first, before step 0's freeze; the self-hosted runner is set up in step 0; Windows packaging is A8's in step 1; the "done when" on Windows is in step 3 (section 11).

### Backup, export and restore (D53, D78, D99, HB22, O16)

- **What a backup holds** is what D53 lists: settings, people, clients' public keys and permissions, devices with their keys, the signing key, the app key and the backup's own header; also every counter's resume point and each device's replay window and each gateway's highest hello counter (HD 5). It does not hold link tokens or their secrets, pending links, or the clients' stored replies: a token restored could be used again, and a stored reply belongs to a session that is gone. No history (section 12, Q9). About 200 KB ‡.
- **The file**, `hsn-<identity>-<UTC date and time>.hsnb`: a 64-byte header (the 4 bytes `HSNB`, format 1, flags, the hub's app identity, the backup key's epoch, when it was made, the schema version, an 8-byte random salt, and the time of the last change to people, clients, permissions or devices it holds), then a SQLite database of exactly those tables, encrypted in chunks of 64 KiB with ChaCha20-Poly1305 (stack.md): each chunk 65,536 bytes of plaintext, the last 1 to 65,536, each followed by its 16-byte tag; the key 32 bytes of HKDF-SHA256 with the backup key as input key, the header's 8-byte salt as salt, and as info the 12 ASCII bytes `hsn-backup/1`, with no zero byte (unlike the prologues), as A1 built it; each chunk's nonce four zero bytes then the chunk's number as 8 bytes, big-endian; its associated data the header and a byte that is 1 on the last chunk, 0 on the others, so a cut file fails ‡. Vectors in `packages/protocol`.
- **Sealing and opening in pieces.** The backup interface (`backup-interface.ts`) gains an incremental form beside its one-shot functions, which become wrappers of it, so a seal or an open never holds the loop past section 3's limit; A1 builds it against the existing vectors, which do not change; A8 and A2 use it:

  ```ts
  interface BackupSealer {
    readonly headerBytes: Uint8Array;                     // the 64 bytes to write first
    /** Any number of plaintext bytes; returns the chunks they completed, each 65,536 + 16 bytes.
     *  The latest full chunk is held back until more data or `finish` says whether it is the last.
     *  After `finish`, or after an error, it is refused as `finished`. */
    add(plain: Uint8Array): BackupResult<readonly Uint8Array[]>;
    /** Seals what is held as the last chunk (0 to 65,536 bytes: empty data is one empty last chunk,
     *  as the vectors have it) and ends. */
    finish(): BackupResult<Uint8Array>;
  }
  interface BackupOpener {
    readonly header: BackupHeader;
    /** The next sealed bytes; returns the plaintext of the chunks completed, holding the latest
     *  back until more bytes or `finish` tell it whether it is the last; a chunk that fails is an error. */
    add(sealed: Uint8Array): BackupResult<readonly Uint8Array[]>;
    /** The file has ended: opens the held chunk as the last. */
    finish(): BackupResult<Uint8Array>;
  }
  function backupSealer(key: Uint8Array, header: BackupHeader): BackupResult<BackupSealer>;
  function backupOpener(key: Uint8Array, headerBytes: Uint8Array): BackupResult<BackupOpener>;
  ```

  The codec takes nothing from outside: HKDF-SHA256 and ChaCha20-Poly1305 come from `@noble/hashes` and `@noble/ciphers`, which the protocol package imports itself, as built. Its errors, as the vectors have them: `truncated` when fewer bytes than a tag are left at the end; `cut` when the last whole chunk opens only as not-the-last; `decryptFailed` for any other chunk that does not open; `finished` for a call after `finish` or an error (`BackupError` gains it). In a restore, `decryptFailed` on chunk 0 means the phone's key is not this file's: `RestoreResult {ok: false, reason: "wrongKey"}`, and the phone says "this key does not open that backup". Every other failure, `truncated`, `cut` or `decryptFailed` later, means a damaged file: `reason: "badFile"` (`RestoreResult`'s reasons gain it), and the console and phone say "the backup file is damaged or incomplete; choose another".

  A chunk's nonce is its position and its associated data carries the last-chunk byte, so a reordered, repeated or cut file still fails exactly as with the one-shot form; after an error or `finish` every call is refused as `finished`. Callers pass at most 256 KB ‡ per `add`.
- **The header's layout**, as step 0 built it, integers little-endian as in the device protocol: magic `HSNB` (bytes 0–3), format 1 (byte 4), flags (byte 5; all zero in format 1: a backup never holds history, which goes in the history file instead), the app identity's 16 bytes (6–21), the backup key's epoch u32 (22–25), when it was made, wall ms u64 (26–33), the schema version u32, the number of migrations applied (34–37), the salt (38–45), the last change u64 (46–53, `backup_state.last_change_ms`), and 10 reserved zero bytes (54–63). A reader refuses a nonzero reserved byte or unknown flag bit as `badFormat`. Only the chunk nonce's counter is big-endian, as above.
- **The backup key** is 32 random bytes with an epoch number, made at the first start of M2, written now, and given to each phone when it is linked (D78, D99). Phones arrive in M3, so a backup made in M2 can be restored from M3 on; nothing stands in for the phones before (D119). M2's tests give the key directly to the restore (section 10). It never appears in a record.
- **The key is replaced** whenever a client that holds it is removed (a phone lost, stolen, or of a person removed), since that phone and any backup file together would give every key of the home. In the commit that removes the client: a new key and epoch. Then at once: a backup under the new key; the files the hub wrote into the backup folder under the old key deleted; a `backupKeyChanged` event to the remaining phones, which fetch the key (`backup.key`) at once or at their next session, and which the hub records as holding the new epoch; and a warning to people with *manage system*, which cannot be turned off ‡ (`backup_key_replaced`): "copies of backups made before <time> outside the backup folder can still be opened with the removed phone's key; delete them". The new key is made by `upkeep` in the same step as the removal (`clientRemoved` reaches it later in the queue), so both are in one commit. The device keys inside those old copies stay as they were: only pairing a device again changes its key.
- **When** (D122). A backup is written:
  - **at once after a change** to people (added, renamed, removed), clients (linked, renamed, removed), permissions or the user-management switch, paired devices (added, renamed, removed, or left behind by a site move), or the backup key; changes within 60 s ‡ of one that started a backup go into one more backup when that one is done, so a setup session that adds thirty devices writes about one backup a minute, not thirty at once;
  - **daily** at a local hour chosen by *manage system*, 03:00 by default ‡, so that every other setting (groups, modes, schedules, site settings) is at most a day old in the newest file;
  - never while the clock is untrusted, since a backup's name and header carry its time; a change made then is written as soon as the clock is trusted.
- **Where and how.** Into a folder chosen on the console (a path on the hub computer). Each is written to a temporary file, synced, renamed, and the folder synced. The newest 20 files ‡ are kept, whatever wrote them: about 4 MB. A warning if the folder is on the same disk as the data folder ‡ ("a backup there dies with the disk").
- **Cost.** A backup is built from the database's configuration tables into its own file; it writes nothing to `hub.db` but its result, which is routine (section 3), so section 3's commits are unchanged. (Wave 2 first wrote the result now, which the budget test caught as one more "now" commit per home per day: the daily backup's.) Its own writes go to the backup folder: about 200 KB ‡ each, one a day plus one per day with changes in a settled home ‡, about 0.4 MB a day; a setup day of thirty additions, about 6 MB. When the folder is on the hub's own card, that is all M2 adds to the card's writes, against the tens of megabytes a day of HD 5.
- **When the folder cannot be reached** (a drive unplugged, a share down, a full disk): the change is committed as always; nothing waits for the backup. The hub marks a backup as due (`backup_state.due_since_ms`, set in the commit of the first change no backup holds and cleared by the backup that holds it; written now, so a restart keeps it), tries again every 5 minutes ‡ (a `backup_failed` hub event, warning, routine, each time), and when an hour ‡ has passed raises a warning (`backup_overdue`, once, `overdue_raised`) to people with *manage system* that cannot be turned off ‡: "the newest backup does not hold the changes since <time>". `hsn status` and the app show it until a backup succeeds. With no folder chosen, a different warning says so, once: `backup_no_folder` ("no backup folder is chosen: nothing is backed up"), raised at the first change a backup would hold, not at boot, and never again until a folder is chosen; `backup_overdue` is only for a chosen folder that cannot be reached, raised once per episode (`overdue_raised`) until a backup succeeds. Both cannot be turned off and are each one "now" commit when raised, never one a day.
- **Export on demand** (HB22) is streamed to the browser or `hsn` that asked (`backup.export`), never written to the hub's disk, and never a database image, which `bun:sqlite` can make only in one call (31.9 ms at the 240 MB limit on a Mac, some hundreds on a Pi, past section 3's limit). Two kinds, by `history`:
  - `history: false`: the configuration backup, exactly the file a scheduled backup writes (`.hsnb`, sealed, about 200 KB, built in one short call from the configuration tables); restorable.
  - `history: true`: **the history file**, `hsn-<identity>-<UTC>-history.jsonl`, UTF-8 JSON Lines, not sealed (it holds no key: device keys and secrets are never in the audit tables; it goes only to a person with *manage system*, over the encrypted channel). Line 1: `{"format": "hsn-history/1", "hub": "<identity>", "madeMs": …, "schema": <migrations applied>, "upToSeq": <the highest committed record's seq when it began>}`; then one line per record, `{"kind": …, "row": {…}}`, exactly as `history.query` and `hsn log --json` give them (`recordJson`, section 6), in `seq` order, every record committed up to `upToSeq`. **Then two parts for the audit tables without a `seq`**, each after a line `{"part": "rejects"}` or `{"part": "lossDaily"}`: `{"kind": "reject", "row": {minute, via, reason, count, address, sample}}` (`recordJson`'s existing `reject` kind), in (`minute`, `via`, `reason`) order up to the minute the export began; and `{"kind": "lossDaily", "row": {deviceId, day, received, expected}}` (a new `recordJson` kind), in (`day`, `deviceId`) order up to the day it began; both read in pages of 500 ‡ by their keys. Each keeps its own retention (30 days, HD 6), so the export holds what is still kept. `boots` is not exported: each run is already a `restarted` hub event among the records. Nothing else. It is read in pages of 500 ‡ rows per table by `seq`, merged by `seq`, one page a piece between turns (section 3), so the writer commits and checkpoints between pieces; a row retention trims during the export is simply absent, and the first line's `upToSeq` with the rows present says what it holds. The stream's own end mark carries its SHA-256 (section 6). A person reads it in the app's history screen or any tool for JSON Lines; **restore refuses it** (`badFile`: "this is a history export, not a backup"), as its first bytes are not `HSNB`. Rejected: a scratch copy (up to 240 MB more against shares already at 489 of 500 MB, and a copy kept consistent with a committing writer is a backup engine of our own), and an exception to the limit (several hundred milliseconds of no door report on a Pi).
- **Restore** (D53, D78), on a hub with no devices yet:
  1. On the console, the user uploads the file (section 6) and the console sends `restore.start`. `upkeep` checks that the hub has no devices and no restore under way, and has the shell read the header (`readRestore`). The console shows the identity of the hub the file came from, when it was made, and **how old its people and permissions are** (the time of the last change it holds), always, in plain words ("this backup's people and permissions are from 3 March; anyone removed since then can use the hub again"), and asks before going on (D122). The new hub cannot see the old hub's backup folder, so it cannot tell whether a newer file exists; saying the age every time is what D122 asks. `upkeep` then makes a restore token: a 128-bit secret from the input's entropy, its lookup and pre-shared key as linking's (section 5), given to the shell by `linkSecret`. It is never stored: a restart loses the upload too, and the console starts again. It expires after 10 minutes ‡ or at its first use, and is shown as a QR code only, `hsn://restore/1?h=<identity>&s=<secret>&a=<addresses>&p=<apps' port>&c=<certificate fingerprint>`, naming the new hub's own app key, which the restore replaces. Nobody types a restore code (section 5).
  2. A phone that holds the backup key for that identity (from M3) scans it and runs restore's messages (section 5): it checks message 2's static key against the code's identity, and **sends the backup key only after message 4 has decrypted**, which proves the hub knows the code's key. The hub's side is built and tested in M2 with a scripted phone (section 10).
  3. On `restoreKey`, `upkeep` has the shell decrypt and check the file (`applyRestore`) into a new database beside `hub.db`, in one transaction that replaces the configuration and keys with the backup's (its app key too, so it has the old identity) and then:
     - moves every hub sending counter's resume point forward by 2²⁴ (§4, O16);
     - raises every client's last `seq` by 2³² ‡, so that no request recorded before the restore can pass; each client's next change is answered `seqTooLow` once and the client continues above it (section 5);
     - keeps every client exactly as the file has it (D122): the newest file holds the people, clients and permissions as they stood at the last change;
     - writes a restore mark into `backup_state` (the file's time).
     On `restoreReady`, `upkeep` sends `RestoreResult`, then `switchRestore`: the shell stops cleanly, keeps the old file as `hub.db.before-restore`, puts the new one in place and exits 70, so the launcher starts the restored hub. At its start `upkeep` finds the mark, records `restored` (a decision, notified to people with *manage system*, section 7) and clears it, in one commit. A wrong key is `RestoreResult {ok: false, reason: "wrongKey"}`, and the token stays usable until it expires.
  4. Before step 2 the console says that the old hub must stay off: two hubs with the same keys would both command the sirens. A restored hub that hears its own identity advertised by mDNS from another computer refuses to start and says why ‡.
- **What a restore cannot undo, for devices.** Device packets sent between the backup and the restore, recorded over the air, can each be accepted once by the restored hub, whose replay windows are the backup's. protocol.md's §4 accepted that when backups were first designed (O16), on the reasoning that a replayed report is corrected by the next real one; but HD 5 showed that this is false for door, cover and button reports, which §4 now says can never be replayed: a replayed door report would start a countdown and could sound the sirens. M2 cannot close this without a change to the protocol and the firmware, and restore is usable only from M3 (D119), so the change belongs with M3 (section 13). What it needs:
  - **A key change**, not a counter change. Moving each device's counter base at the restore does not work: the hub does not know how far each device's counter has moved since the backup, so any floor it chose would either let recorded packets through or refuse the device's own for days. A new key makes every recorded packet fail at once.
  - In protocol.md: a hub-to-device message, a "key change", carrying a new 16-byte key, sealed under the old key with the usual binding (in a reply to a sensor, with a siren's settings, on a gateway's session), and acknowledged by the device's next packet under the new key; the device's counters restart under the new key from one step, as at pairing (§4).
  - In the firmware: store the new key and its resume point in flash before the acknowledgement, keep the old key until then, and on a reply that carries "key change, report again", send its current state again under the new key at once.
  - In the hub: after a restore, a packet under an old key is never acted on; it is answered with the key change and "report again". A real sensor that just sent it is listening and switches and reports again within seconds, its event age keeping the opening's time (D106); a recorded packet's answer reaches nobody.
### Hub updates (D54, D84, D96, HB23)

In the core, updates are `upkeep`'s (section 2), as backups and restore are.

1. **A release** is one file per platform, signed by the publisher's Ed25519 key, which every hub carries (D84). In M2 it comes from the console (`update.upload`, after an upload, section 6) or `hsn update install <file>`; fetching it, and checking for one, is M4's, through the relay (D84, D119; section 12, Q7): M2 downloads nothing. The hub checks the signature, that the version is newer, and the platform; unpacks it to `versions/<version>/`; and records it staged, with a notification to people with *manage system*.
   - **The file**, `hsn-hub-<version>-<platform>.hsnr`: the 4 bytes `HSNR`; **format 2** (a byte; format 1, a gzip'd tar, is refused as `badFile`); 3 zero bytes; the manifest's length (u32, little-endian, at most 1 MiB ‡); the manifest, UTF-8 JSON `{version, platform, madeMs, payloadBytes, payloadSha256, files: [{path, bytes, sha256, executable}]}`; the 64-byte Ed25519 signature; then the payload: **the files' bytes, uncompressed, concatenated in the manifest's order**, with nothing between them, `payloadBytes` their sum. **Uncompressed, by choice:** a release comes from a file in M2, so 112 MB instead of 49 MB costs a longer copy and nothing else, and the hub then holds no decompressor and no archive reader at all, its own or a library's; the only bytes it interprets are the signed manifest, through JSON and a Zod schema. A path is relative, `/`-separated, each part 1 to 64 of `A-Z a-z 0-9 . _ -` and not `.` or `..`, 255 bytes at most, unique; folders are implied; there are no links; at most 4,096 files ‡, each at most 256 MB ‡; `executable` sets mode 0755, otherwise 0644 (ignored on Windows). A manifest that breaks any of these is `badFile`. Compression, if a download ever makes it worth having (M4), is a format 3 of independent blocks, each inflated whole by the runtime's own call. The signature is over the ASCII bytes `hsn-release/1`, a zero byte, and every byte before the signature, so the manifest is signed and the payload is bound by its hash, which the hub computes while it streams the payload to disk (an Ed25519 signature cannot be checked in pieces). `platform` is one of `darwin-arm64`, `linux-x64`, `linux-arm64`, `windows-x64`. `version` is `MAJOR.MINOR.PATCH`, three decimal integers without leading zeros, compared as numbers, major first; releases carry no pre-release suffix ‡.
   - **What each bad file gets**, as `update.upload`'s `invalid {field: "job", reason}` and an `update_refused` hub event (warning, routine): a wrong magic, format or manifest, a truncated file, or a payload whose length or hash differs (tampered) is `badFile`; a signature that no trusted key verifies (a tampered manifest) is `badSignature`; another platform is `wrongSystem`; a version not above the running one is `notNewer`. Nothing is unpacked before every check, the payload's hash included, has passed, and a payload whose hash fails is deleted.
   - **The publisher's public key** is compiled into the hub (`hub/src/shell/update/publisher-keys.ts`, reviewed like any code), so each version carries the keys it trusts: at most two, the current and the next, so a release signed with the current key can bring a program that trusts the next one. Nothing on a running hub can add a key; a lost or leaked key is replaced only by installing a new package by hand. Owners' own builds (D84) are installed as packages, not as updates, in M2. The private key is the product owner's (section 12).
2. **Approval** by a person with *manage system* (D54).
   - **Staging in two passes, both in pieces** (section 3, "The loop's time"), on the uploaded file itself (section 6, `uploads/`): the header, manifest and signature are checked first; **pass 1** reads the payload about 256 KB ‡ a piece and computes its SHA-256, which must equal `payloadSha256` and its length `payloadBytes`; only then **pass 2** copies each file's byte range, about 256 KB a piece, into a temporary folder beside `versions/`, checking each file's SHA-256 against the manifest as it ends, and renames the folder to `versions/<version>/` once every file is in. A failure at any piece (a bad hash, a full disk, a stop) deletes the temporary folder and leaves nothing behind; the upload is freed when the job ends. While staging, the data folder holds the upload (up to the release's size, 112 MB today) until it ends.
3. **The switch** waits until no countdown, alarm, site move, provisioning or restore runs (D54, HB23). The hub records `update_switching` (now), tells the apps, and stops cleanly. The launcher points `current` at the new version and starts it.
4. **Health.** The new version migrates, **always copying the database first** (`VACUUM INTO hub.db.before-<n>`) whatever the migration, not only before one that changes or drops a table (HD 6 changes, section 13), boots, opens its listeners, and within 60 s ‡ records `update_healthy` and tells the launcher, which then keeps the old version only for the next rollback. `upkeep` records `update_healthy` on the first `hubFacts` (sent once the listeners are open, section 2) whose version is the staged one while `update_state.switching_ms` is set; after the commit that holds it, the shell writes the launcher's healthy mark. The copy is deleted then. A copy needs room: the switch is refused when the data folder's disk has less free space than the database plus 50 MB ‡, which the 500 MB shares already allow for (section 3: the copy's 240 MB share). The shell checks it at the switch, not at approval, since the free space then is what matters and the core has no input for it (no new input is added): `switchUpdate` ends in `fileReady {failed, reason: "full"}` before anything stops, `upkeep` withdraws the approval and records an `update_refused` hub event (warning), the apps get a `hub` event saying why, and the person frees space and approves again.
5. **Rollback.** If the new version exits with any code before its healthy mark (it gets no restarts of its own), or 60 s pass, the launcher stops it, puts back `hub.db.before-<n>` when a migration ran (losing only what the failed start wrote in those seconds), points `current` back and starts the old version, which finds the launcher's note and records `update_rolled_back` (a warning, notified). The old version then runs under the normal restarts above. Because every migration of a switch is copied, a rolled-back version never finds a database newer than itself. The test: an update whose migration only adds a table, made to fail after migrating, is rolled back, and the old version starts on its own database with every record it had; and an approval with too little free space is refused before anything stops.
6. Devices lose nothing: sirens keep their own timers (SR5), gateways reconnect with a new hello, and no switch happens during a countdown or an alarm. Telling the relay first, so that it raises no hub-offline alert (D96), is M4's.

The launcher is a small separate program with no dependencies, not updated by the hub in M2 ‡, and tested on each platform: it is what turns a broken update into a short outage instead of a dead hub.

## 10. Test strategy

This continues HD 11; everything there stays and must stay green.

- **Protocol package.** The published Noise test vectors for both pattern names. Our own vectors, with fixed static and ephemeral keys, as exact bytes, for **every handshake**: a session (IK) with its prologue, with and without `first`, then one transport message of every message kind; a link (XXpsk3) from a QR code, from a link address and from a typed code, each with the lookup (from the secret, or the typed code's token id), the pre-shared key and all four messages; a restore (XXpsk3) with the hub's proving message and the backup key sent after it; and the failures each must refuse: a wrong pre-shared key, a hub key that does not match the identity, a low-order public key and an all-zero Diffie-Hellman result, a prologue of another purpose. Also: the typed code's characters and check character; every operation's body accepted and refused by the schemas; the backup file's header and chunks; a release signature. Both ends test against them on every build, as the device vectors are; the browser's run uses a non-extractable Web Crypto key for the client's static key, the hub's and the phone's their own.
- **Core unit and scenario tests** (the `World` of HD 11, with scripted people and clients whose requests enter as `clientRequest` events, no cryptography needed): every rule of section 7 at its boundaries, and every awkward case of its table; permissions over a matrix of people and devices, checking requests, events, snapshots, history and notifications alike; siren choice by groups; a year of schedules across daylight saving in Europe/London and America/New_York, including the missing and the doubled hour; an untrusted clock, catch-up after downtime, deferral during an alarm; tokens across restarts with known and unknown downtime.
- **Shell tests**: the three listeners (TLS, loopback only, `Host` and `Origin`, headers, limits); Noise sessions against the vectors and under a fuzzed handshake; session admission (a replayed message 1 never takes a session; handshakes close after 5 s; a client's fifth session closes its oldest; liveness only inside Noise); the order of transport messages under load; `ClientKeys` after commits; the history reader merging staged records; file chunks; the backup writer (temporary file, sync, rename); the key's replacement after a phone's removal (new backup, old files gone, phones given the new epoch); restore, unlocked by a scripted phone with the backup key the test supplies (D119), with the `seq` jump and every client as in the file (D122); the immediate backup after each change of people, clients, permissions or devices, with an unreachable folder; the launcher's switch and its rollbacks on a crash, a hang and a failed migration.
- **The write budget** (HD 11) gains section 3's household and home C. It fails above A 800 commits, 20 MB, 70 MB; B 1,400, 35, 120; C 2,400 ‡, 60 ‡ and its database over 210 MB; and if app sessions, snapshots or history reads cause a single commit.
- **The loop's limit** (section 3): door reports are answered in the usual time, and no turn holds the loop more than 20 ms ‡ on a Pi 4, while each whole-file operation runs while the hub listens: staging the largest release, a backup's write and prune, a restore's read and rebuild, and an export with history. The test drives door reports through the scripted gateway throughout and fails on any reply later than without the operation's load by more than the limit.
- **Crash tests** (HD 11) gain the points of M2: an app request (answered only after its commit; retried after the crash with the same `seq`, given the stored reply and done once; replayed with an old `seq`, refused); a schedule's run (never twice, never late: an entry due during the outage is recorded as missed, D116); a link (a token works once across a crash; `LinkResult` only after its commit); a client's removal (still removed after the crash; no session reopens); a backup (no partial file); an update switch (the old version or the new one runs, never neither, and the database matches the one that runs).
- **Lockstep and the firmware bench.** The wire stays at version 2. The new `hsn` commands travel in its `control` messages, so the bench's `RemoteHub` can switch modes and arm groups; the recorded sessions are regenerated for the added records and reviewed with the firmware side. Two new system tests with the real roles ‡: `group_sirens_test.cpp` (two groups with their own sirens: each trigger sounds its own; a second trigger adds its group's sirens, D95) and `schedule_arm_test.cpp` (a scheduled Away at 22:00 on a trusted clock: every sensor learns it at its next heartbeat, D8; on an untrusted clock it waits).
- **The app.** Jest for stores, reducers, formatting and the `seq` logic; Playwright end-to-end against the exported web build and a real hub on a temporary data folder with the scripted devices of `hub/test/world`, in Chromium, WebKit and Firefox (which also covers part of O12); axe on every screen; a check that every text is a key and every key has English text. The "done when", automated (`app/e2e/done-when.spec.ts`): an empty data folder, the console linked, setup, the gateway added on its own, a sensor and a siren added over USB (scripted boards on pseudo-terminals), Away, a door opening, the countdown banner, a disarm; and again with the alarm.
- **The installer.** In continuous integration on macOS arm64, Ubuntu x64 and arm64, and Windows x64 runners: build the package, install it on a clean runner, check that the service runs and answers `hsn status`, that the console opens, then uninstall. A reboot test in a virtual machine ‡. A Pi 4 and a Pi 5 by checklist. D94's week-long run.
- **Windows** as section 9 lays out: on the hosted runner everything that needs no board, W2's access checks with a second user included; on the self-hosted Windows computer with a board, the serial adapter's tests every night and the "done when".
- **The "done when" for real**, on macOS, on Linux x64, on a Pi 4 and on Windows x64: from the package to an armed house in the web app, with the M1 boards (M1b), the gateway on USB on each (D118).
- **Browsers.** The person hosting this will use the app from a Windows PC, in Chrome or Edge. M2 is done when the "done when" passes in Chrome and Edge on Windows and in Chrome on macOS, with K1 run in Edge too; continuous integration runs it in Chromium. Safari and Firefox are run in step 3 with O12's remaining browsers, by K1 and the Playwright tests in WebKit and Firefox; a browser not yet run does not block M2, and is listed in the app's notes as not verified. One that fails K1 cannot be linked (section 5), and the notes say so.

## 11. The order of work

### Beside step 0: the Windows spikes

They run beside step 0, not before it: each may change a transport or a library on every system (section 9), but only behind the serial and control ports (HD 3), so items 1 to 5 of step 0 do not wait for them and item 6 does. W1 needs a Windows computer and any USB serial device; it does not need one of our boards until step 3:

- **W1**, a serial port under Bun on Windows, on a real Windows computer with a board: decides between Win32 through `bun:ffi` and a native helper, which would then replace the termios path on macOS and Linux too.
- **W2**, the command socket on Windows, on a hosted runner: decides between a Unix-domain socket and loopback TCP with a secret, which would then be the control socket on every system.
- **W3**, hosting the Windows service, with W2.
- **K1**, a browser's non-extractable key, on a Mac with Chrome, Safari and Firefox, behind the hub's clicked-through certificate and on the console's loopback page: Web Crypto's X25519 makes a non-extractable key; the key object survives in IndexedDB across reloads, a browser restart and a week ‡; `deriveBits` with it gives the same result as `@noble/curves` on the vectors' keys; Web Locks and BroadcastChannel work on both pages. It decides only how the browser's static Diffie-Hellman is done behind the Noise code's interface (section 5), so it waits for nothing and nothing but A1's browser path waits for it. If a browser fails it, that browser cannot be linked (section 5), and section 13 says which.

Each is a few days ‡ with written pass criteria and a short report in `docs/spikes/`. The self-hosted Windows runner with a board is set up during W1 and kept.

### Step 0: frozen first

One engineer, reviewed, before anyone else starts, as step 0 was for the hub (HD 12), with W1 to W3's answers in hand for item 6 only:

1. **The channel in code**: `packages/protocol/src/app/` with every type and Zod schema of sections 5 and 6 (hellos, link messages, requests, replies, errors, events, file chunks), the Noise and backup interfaces (not their implementations), and the vectors' file formats.
2. **The core's model**: the new events, effects and internal messages; the decision kinds of sections 4 and 7; the store operations of section 4; the new `HubRules` sections with every value of section 7; the module names in their order, as stubs; the `Calendar` dependency; the `ClientKeys` and `LinkSecrets` ports.
3. **The database**: the second migration with every table of section 4, its fixture test, and the row types.
4. **The control protocol's** new commands, so `hsn` and the lockstep bench can use them.
5. **The `app/` workspace**: routes stubbed, i18n and its lint rule, the Playwright harness against a real hub; and in `hub/test/world`, scripted people and clients.
6. **The serial adapter and the control socket** as W1 and W2 decided, behind their existing ports (HD 3), so step 1's owners build on the final transports.

### Step 0's questions, settled

Step 0 was built and stopped at thirteen questions and four readings of ownership; four loose ends followed (14 to 17). Each is settled in the section named; the step 0 owner makes the changes below to frozen code in one pass and removes the SPEC-QUESTION comments they answer. Where step 0's reading is confirmed, the code stands.

| # | Question | Settled | Where |
| --- | --- | --- | --- |
| 1 | Several modules write the whole `site` row | One writer per row: `site` stays M1a's; M2's single rows go in `mode_state` (layout), `people_settings` (people), `schedule_state` (schedules), `backup_state`, `backup_key` and `update_state` (upkeep). The backup key leaves `hub_keys`, which stays the shell's | 4 |
| 2 | No owner for backup, restore, update; no "backup due" | A new module, `upkeep`, 19th, before `audit`; `backup_state.due_since_ms` | 2, 4, 9 |
| 3 | Restore's payloads | Six messages: `LinkHello`, `{hub, proto}`, `RestoreHello`, `RestoreOffer`, `RestoreKey`, `RestoreResult`; the new hub's own app key, no temporary key (the design was wrong to need one); the token never stored; `restore.start` a read | 5, 9 |
| 4 | `client.remove`'s unticked clients | `also`: the clients to remove with it, the ones left ticked | 6, 7 |
| 5 | Devices have no revision | They keep none; `device.rename` and `device.remove` lose `ifRevision` (the design was wrong to ask for one); live views rely on `rev` | 4, 6 |
| 6 | The history row; who owns `history.query` | `recordJson` moves to `packages/protocol/src/records.ts`; `app` owns the operation and checks it, the shell reads through a new `historyRead` effect | 6, 7 |
| 7 | The content security policy refuses React Native Web's styles | Hashes of inline styles and the empty string, from the build; any refusal fails the tests; `'unsafe-inline'` for styles only if a browser still refuses | 5 |
| 8 | The battery curve | Interim table, 3,500 mV = 10% and 3,600 mV = 15%; the measurement is open | 7, 12 |
| 9 | `restored`, `update_*`: decisions or hub events | Decisions, as built; how each is notified | 7 |
| 10 | `linkHello`'s `proto`; `FileWork`; the typed code's key; the backup header | A range, with the hub's choice in message 2 (changed); `FileWork` as section 2 lists it (two variants added, uploads named by `UploadRef`); the typed key as built; the header as built, flags defined | 2, 5, 9 |
| 11 | Categories, weekdays, names | As built, plus the `hub` category, bit order, weekday rules, and two refusals for names | 7 |
| 12 | "No new index" against the unique keys | The keys stay; "no index" means none for reading | 4 |
| 13 | An empty site's starting mode | Disarmed, as built: nothing protects the house | 4 |
| 14 | `HubHello`'s `features` | None in version 1, `[]`; unknown names ignored; never needed, never a new shape | 5 |
| 15 | The details of six errors | Each named; `conflict` carries its object | 5 |
| 16 | `hsn op` and files | `hsn op <operation> [<json> \| -]`; `hsn update install`, `hsn restore`, `hsn backup export` carry files over control `fileChunk` lines | 6 |
| 17 | One `TokenId` numbering for two modules | Two ranges in `ids.ts`: people below 2³¹, upkeep from 2³¹; `linkSecret` gains `purpose` | 5 |

The four readings of ownership:

- **A1's files** are new files beside the frozen ones in `packages/protocol/src/app/` (section 11's table): the frozen ones are those step 0 wrote; A1 adds `noise.ts`, `backup.ts`, their tests and vectors, and two export lines in `index.ts`.
- **A11 and `shell/safe/`**: A11 owns `serial*.ts` and the new `safe/` files its paths need; the other files stay as built.
- **Which module owns which `site` column**: none of M2's; question 1.
- **`OP_OWNERS` entries naming M1a modules** are right: those modules own the change. `app` reaches them with their own request messages, numbered from 2⁴⁰ ‡ (section 2, "Requests for M1a's modules"). `fileChunk` becomes `shell`'s; `backup.*`, `restore.start` and `update.*` become `upkeep`'s; `history.query` becomes `app`'s.

**What the step 0 owner changes in frozen code:**

- `hub/drizzle/0002_m2.sql`, `hub/src/db/schema.ts`, `rows.ts`, `events.ts` (`M2Snapshot`), store operations: drop the seven `site` columns and `hub_keys.backup_key`, `backup_key_epoch`; add `mode_state`, `people_settings`, `schedule_state`, `backup_state`, `backup_key`; the migration inserts their rows (the mode into `mode_state`); `link_tokens.kind` loses 3. A regenerated migration and its fixture test.
- `modules.ts`: `upkeep` 19th, `audit` 20th; its stub; the dispatcher's `sendRefModule` test. `ops.ts`: the owners above.
- `events.ts`: `restoreOpened`, `restoreKey`; `FileOutcome` as section 2. `effects.ts`: `historyRead`; `FileWork` as section 2, with `UploadRef`. `messages.ts`: nothing new; `RequestId` documents the 2⁴⁰ range.
- `decisions.ts`: add `backup_overdue`, `backup_key_replaced`, `backup_folder_on_data_disk`; and the hub event kinds `backup_written` (info) and `backup_failed` (warning), both routine.
- `rules.ts`: the interim battery table and its comment.
- `packages/protocol/src/app/`: `linkHello.proto` a range; the link and restore message 2 `{hub, proto}`; `RestoreHello`, `RestoreOffer`, `RestoreResult`; `client.remove` gains `also`; `device.rename` and `device.remove` lose `ifRevision`; `restore.start` a read; `fileChunk` not a change; `historyRow.row` as `recordJson`, moved into `packages/protocol/src/records.ts` with `hub/src/control-protocol/records.ts` re-exporting it; `displayName` refuses the bidirectional controls, white space at either end and text not in NFC; the `hub` category; `restore.start`'s reply loses `newestInFolder` and gains `madeMs`; the header's flag bit.
- `app/e2e/support/harness.ts` and the web build: the policy from `web/csp.json`, and the test failing on any refusal.
- Items 14 to 17: `handshake.ts`, the `features` rule; `errors.ts`, the details above (`notFound` and `invalid` as enums, `conflict.object` required, `busy` gains `upload`); `control-protocol`: `fileChunk` requests and lines, the 64 KiB line limit, the three file commands in `hsn`; `ids.ts`, `TOKEN_RANGES`; `effects.ts`, `linkSecret.purpose`.

### Step 1's questions, settled

Raised by step 1's owners while they build; each is settled in the section named. "Frozen" changes are the step 0 owner's, made once; the rest are the named owner's own.

| From | Question | Settled | Where | Changes |
| --- | --- | --- | --- | --- |
| A6 | Where notify reads people, permissions and `rev` | `people`'s view as A3 built it; no `rev` in notify: it emits `notificationRaised` and `app` sends the events | 2, 7 | Frozen: the message `notificationRaised {notification: NotificationObject, clients: readonly ClientId[]}` in `messages.ts`. A3: `app` sends it to the clients' sessions; the snapshot's unread from `notify`'s view. A6: drop the boot-snapshot permissions and `UNKNOWN_REVISION`; add `unreadFor` to `notify/view.ts` |
| A6 | `notifications.read`: now or routine | Routine, and not a change: no `seq` | 6, 7 | Frozen: `notifications.read` a read in `ops.ts`. A3: no `seq` or stored reply for it |
| A6 | `siren_silent` critical | Only while a sensor is armed | 7 | A6 |
| A6 | `door_state_unexpected`, `schedules_waiting_for_clock` | Rows added; category `stateUnexpected` | 7 | Frozen: `stateUnexpected` in `NOTIFICATION_CATEGORIES`. A6 |
| A6 | The flood rule | A6's reading plus every critical notice exempt | 7 | A6 |
| A6 | Which decision carries an action's notice | Its summary, `mode_switched` or the new `arming_changed`; recipients the viewers of any changed sensor | 7 | Frozen: `arming_changed` in `decisions.ts`. A4: `layout` records it for every arming action, `hsn`'s through `layout`. A6 |
| A6 | Late cover reports | Told as `tamper_opened`, late, with its own time; state unchanged | 7 | A6 |
| A6 | Gateways' batteries | None in M2 | 7, 13 | A6 |
| A6 | Notifications in `M2Snapshot` | Yes: `notifications: readonly NotificationRow[]` and `notificationReads: readonly NotificationReadRow[]`, those of the last 7 days ‡ before the last commit's wall time, so unread survives a restart | 7 | Frozen: `events.ts`, the shell's snapshot reader. A6 |
| A6 | `cover_state_unexpected` | Yes, `health`'s, value 1 open, 0 closed, once per change | 7 | Frozen: `decisions.ts`, and in `WARNING_DECISIONS`. A6 |
| A6 | A critical notice and the cap | Written now by `notify`; its decision rides in the same commit (HD 5) | 7 | A6 |
| A6, A4 | Who turns a voltage into a percentage | `health`'s view only | 7 | A4: `alarm` reads `health`'s view; its own `batteryPercent` goes |
| A1 | Message 1 and the psk | Message 1 is readable by anyone; `find` stays in its payload; the responder takes its psk after message 1, before message 3 | 5 | Frozen: `noise-interface.ts`, the XXpsk3 responder made without a psk and given it by `setPsk(psk)` after reading message 1; reading message 3 without one is an error. A1, A2 |
| A1 | The 24-hour lifetime | The shell's session layer, close code 4000, `clientClosed {reason: "lifetime"}` | 5 | A2 |
| A1 | Who refuses which version | Prologue: Noise; `proto`: the shell | 5 | None |
| A1 | Backup chunks | 65,536 bytes of plaintext, tag after each; info `hsn-backup/1`, no zero byte; 32-byte key | 9 | None: as A1 built it |
| A1 | The vectors' tooling | The app's vectors get their own place: the device generator writes and deletes only its own files (an explicit list), and the device vector tests and the verifier read only those; `packages/protocol/src/app/vectors/` holds the app's generator and tests (A1). The independent verifier checks the app's vectors too, rebuilding them with Node's own `crypto` (X25519, `chacha20-poly1305`, SHA-256, HMAC, `hkdfSync`) and a separate Noise state machine of about two hundred lines written by someone other than A1; the published cacophony and snow vectors stay the independent check of our Noise | 10 | Frozen tooling (the step 0 owner): the generator's and the device tests' file lists. A1: the app's generator and tests. A9: the verifier's app part |
| A5 | No Temporal polyfill | Bun's built-in `Temporal`, as stack.md allows; the app needs none | 2, 8 | Section 11's A5 row reworded. None in code |
| A5 | Where Temporal is wrapped | `shell/calendar/temporal.ts`, as A5 built it | 2, 13 | None; HD 10's table gains the row when hub-design next changes |
| A5 | A skipped or repeated local time | First minute after the jump, the same date; a repeated time at its first; a skipped date has no run and no miss | 7 | None: as A5 built it |
| A5 | A forward clock step's misses | Its own reason, `clockStepped` | 7 | Frozen: `missed.why` in `packages/protocol/src/app/objects.ts` gains `clockStepped`. A5 |
| A5 | What a schedule's arming is answered with | Every arming reply carries `lowBattery: [device]` (the sensors armed at 10% or below, for a person too, after confirming) and every `disarm` reply `heldBack: [device]` (D117; empty for a person) | 6, 7 | Frozen: the `mode.switch`, `arm` and `disarm` reply schemas in `ops.ts`. A4: `alarm` fills both. A5: drop the fallback from the alarm's view |
| A5 | Schedule targets | Checked at create and change; deletions of named targets refused | 7 | A4: `groupExists`, `modeExists` in `layout/view.ts`, and the refusal. A5: `schedulesNaming` in `schedules/view.ts`. A3 and A4: `app` and `control` check a device's removal |
| A5 | `AnswerTo` for a schedule | Yes: `{kind: "schedule"; schedule: ScheduleId; record: Seq}` | 2 | Frozen: `messages.ts`. A5; A4 answers it as any other |
| A5 | Misses lost at a restart | Yes: `schedules.missed_due_ms` integer null (the last missed occurrence), `missed_why` integer null (0 `hubOff`, 1 `clockNotSet`, 2 `clockStepped`), `missed_count` integer not null default 0 | 4, 7 | Frozen: schema, migration, `ScheduleRow`. A5 |
| A5 | Clock rules | Yes: `HubRules.schedules.clockStepMs: 60_000` ‡ and `reanchorMs: 1_000` ‡ | 7 | Frozen: `rules.ts`. A5 |
| A5 | Temporal and `Intl` in the core | Yes, through ESLint's `no-restricted-globals` (`Temporal`, `Intl`) and `no-restricted-properties` (`toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`, `localeCompare`) for `hub/src/core/` | 2 | Frozen: the lint configuration |
| A3 | `CoreDeps.sha256` | Yes: `sha256(data: Uint8Array): Uint8Array`, a pure function as `cipher` is, the shell passing `@noble/hashes`' (the protocol package's `Sha256` type). The core hashes a token's secret for its pre-shared key and lookup (section 5) and the app key for the hub's identity; handing those in from the shell would put the secret in an input as well as an effect | 2, 5 | Frozen: `CoreDeps`, `step`'s tests. A2 passes it. A3 |
| A3 | `linkSecret.lookup` | Yes: `{kind: "linkSecret"; token; purpose; lookup: string; psk: Uint8Array}` to accept, `{kind: "linkSecret"; token; purpose; lookup: null; psk: null}` to withdraw; `lookup` the text `LinkHello.find` carries | 5 | Frozen: `effects.ts`. A2, A3, A8 |
| A3 | `LinkResult` and refused links | `AppMessage` gains `{kind: "handshake"; body: LinkResult \| RestoreOffer \| RestoreResult}`, sent as the transport message's JSON; a new effect `{kind: "closeConn"; conn: ConnId; reason: "linkRefused" \| "restoreRefused"}` closes one handshake's connection. After `LinkResult` or `RestoreResult` the shell closes the connection itself | 2, 5 | Frozen: `effects.ts`, `messages.ts`. A2, A3, A8 |
| A3 | The hub's facts | Yes: an input `{kind: "hubFacts"; version: string; addresses: readonly string[]; appsPort: number; certificateSha256: Uint8Array}`, after `boot` and whenever one changes (the shell checks addresses every minute ‡ and renews the certificate, section 5); `app` keeps it and its view gives `hubFacts()`, which `people` reads for the link formats | 2 | Frozen: `events.ts`. A2 sends it. A3 |
| A3 | `link_tokens.person_name` | Yes: text, null; the name given in `link.create`'s `newPerson {name?}` | 4 | Frozen: schema, migration, `LinkTokenRow`. A3 |
| A3 | `linkFailed`'s address | Yes: `address: string`, the peer's IP address as text | 5 | Frozen: `events.ts`. A2, A3 |
| A3 | `sirenTest`'s decision number | No: the reply names the request's `commands` record (section 6) | 6 | None. A3 as built |
| A3 | `siteObject.channel` | Yes: `siteChannelValue.nullable()`, null until the first survey; the app shows "not chosen yet" | 6 | Frozen: `objects.ts`. A3, A7 |
| A3 | Renaming decisions | Yes: `person_renamed`, `client_renamed`, written now, detail the old and new names; `upkeep` counts them as changes a backup must hold (section 9) | 4 | Frozen: `decisions.ts`. A3, A8 |
| A3 | A person made while user management is on | No permission at all, as built | 7 | None |
| A3 | The hub computer's codes | 7 days only for the installer's first; otherwise 10 minutes | 5 | A3 |
| A3 | Reads as `commands` rows | Changes only, and `backup.key` | 4 | A3 |
| A3 | M1a refusals as app errors | `unknownDevice` → `notFound {what: "device"}`; `nameTaken` → `invalid {taken}`; `unknownPort` → `invalid {unknownReference}`; `boardRefused` and `badRequest` → `invalid {format}`; `nothingToChange` → `invalid {field: "", reason: "format"}`; `noAnswer` → `invalid {noAnswer}` and `noGateway` → `invalid {noGateway}` (two new reasons); `sitePaired` → `invalid {fixed}`; `moveInProgress`, `notAnnouncing` → `busy {siteMove}`; `doorsOpen` → `needsConfirmation` with the doors; `failed` → `unavailable`. A refusal not listed is a fault in the step (HD 2), so a new M1a code is mapped when it is added | 5 | Frozen: `invalid`'s reasons in `errors.ts`. A3 |
| A3 | `linkCheck`'s permission | *Manage system*, as built: it is a radio setting, like the reply rate | 6 | None |
| A3 | A typed code's stored lookup | Its 4 upper-case Crockford characters as 4 ASCII bytes, as built; the `typed` column tells the kinds apart. A 128-bit secret whose lookup is already taken among unused tokens is drawn again | 4 | None |
| A3 | `record`, `health`, `config`, `hub` events | A3, a second pass, once A4, A5, A6 and A8 have their views: `record` from `auditRecord` messages, filtered as history is; `health` from `health`'s decisions; `config` from every `opAnswer` of a configuration operation, whoever asked (so `hsn`'s changes are announced too); `hub` from `upkeep`'s decisions and view | 6 | A3; A8's `upkeep` view |
| A3 | `hub.status` | The shell answers it, as `historyRead`: `app` checks *manage system* and emits `{kind: "hubStatusRead"; conn: ConnId; id: number}`; the shell replies from the writer and size guard, as `hsn status` does | 6 | Frozen: `effects.ts`. A2 builds the reply. A3 |
| A3 | `usb.list` | Read from `setup`'s view, as `hsn usb list` is (corrected: `setup` has no request message for it) | 6 | A3 as built |
| A3, A4 | HB5a's selector | `layout/view.ts`: `sensorsChanged(view: HubState, target: {kind: "mode"; mode: ModeId} \| {kind: "arm"; group: GroupId} \| {kind: "disarm"; group: GroupId}): readonly DeviceId[] \| undefined`, the sensors whose arm state the request would change (undefined: no such mode or group); a sensor target and `mine` need none | 7 | A4 builds it; A3 drops its interim |
| A4 | `disarmSensors.mode` | None: a switch is always one `armSensors {mode, sensors: the mode's}` (Disarmed: `sensors: []`), which arms those and disarms the rest, as A4 built it. D117's holding back applies to every request whose actor is a schedule, switches included, so it follows the actor | 7 | Frozen: `disarmSensors` loses `mode` and `holdBack`. A4 |
| A4, A5 | How a schedule learns its run's outcome | Its `opRequest` carries `answerTo {kind: "schedule"; schedule; record}`; `layout` passes it on in `armSensors` or `disarmSensors`; `alarm` answers with `opAnswer` whose body is the reply of section 6, `lowBattery` and `heldBack` included; `schedules` records `schedule_ran` and `schedule_held_back` from it, in the same step. `AnswerTo`'s `none` goes: nothing else used it | 2, 7 | Frozen: `messages.ts`. A4, A5 |
| A4 | Confirmation from the hub computer | The console and `hsn op` as a person; M1a's own commands as built (`--all` asks nothing) | 7 | None: as A4 built it |
| A4 | A held-back switch and `mode_modified` | Set, not cleared (A4 corrected) | 7 | A4 |
| A4 | A new sensor and "changed" | Not changed, as built | 7 | None |
| A4 | `layout` reading `alarm`'s plan | The intended split: `alarm` owns what arming does; `layout` asks it first, so a refused switch records nothing. `armingPlan` is read through `alarm/view.ts`, as every cross-module read is (HD 2), not `alarm/plan.ts` | 2 | A4 |
| A4 | The reply's format for `hsn` | Corrected: `alarm` answers every arming one way, with `opAnswer` and section 6's body; `control` turns that into M1a's reply for its own `arm` and `disarm` commands, so `--all` answers as M1a did and `alarm` reads nothing of `control` | 2 | A4 |
| A4, A6 | The battery `alarm` checks | `health/view.ts`'s `batteryLow(view, device)`; `alarm`'s own percentage goes | 7 | A4 |
| A3, A4 | `disarm mine` | `people/view.ts`'s `mayManage(view, actor, device)` over the armed sensors | 7 | A4 |
| A4, A10 | The lockstep sessions | Intended: `hsn arm --all` and `disarm --all` are switches to Away (value 1) and Disarmed (value 2), each recorded as `mode_switched` before its per-sensor decisions (section 1), and every later record of the boot moves by the records added; frames, replies and wakes unchanged. Reviewed with the firmware side (section 10). `mode_switched` is written with the arming's "now" commit | 10 | A4, A10 |
| A4, A6 | `arming_changed` | `layout` records it for every arming action that is not a switch (A6's row) | 7 | Frozen: `decisions.ts`. A4 |
| A5 | `heldBack` in `mode.switch`'s reply | Yes: `{armed, disarmed, waiting, lowBattery, heldBack}`, each `readonly DeviceId[]`; `heldBack` empty but for a schedule's switch during a countdown or alarm (D117) | 6, 7 | Frozen: `ops.ts`. A4 fills it, A5 reads it, A3 and A7 see it |
| A5 | Which miss is kept | The last missed occurrence, with the count since the entry last ran; `objects.ts`'s description stands | 7 | A5 stores the last, not the first |
| A4 | Deleting a group held by modes | Confirmed: removed from them, each mode a new revision | 7 | None |
| A4 | Deleting the current mode | Allowed; no current mode, `mode_modified` set, a state the app and schedules already handle | 7 | None |
| A4 | `mode_switched`'s class | Now. It costs nothing: every switch already commits now with its `commands` row or its arming, so section 3's six commits a day stand | 3 | A4 |
| A3 | A site move's counts | `site/view.ts` gains `moveCounts(view): {confirmed: number; total: number} \| undefined`: the paired sensors whose `move_confirmed` is the latest move's id, and all paired sensors; written by A3 as a read-only selector, reviewed by the step 0 owner | 6 | A3 |
| A3, A6 | `poorLink` | `health/view.ts` gains `poorLink(view, device): boolean`, the same 7-day loss above a fifth (D107) that gives `poor_link`, from `intake`'s daily loss rows | 7 | A6 builds it; A3 reads it |
| A3, A5 | `hub.info.timeZone` | From `schedules`' view `timeZone(view): string \| null`, the stored zone until the shell's `timeZone` arrives; the shell sends `timeZone` in the turn after `boot`, before it opens any listener, so a client never sees it empty | 2 | A5 adds the selector; A2 sends it in order; A3 reads it |
| A3 | `rev` and permissions | One counter, as built; a gap is no signal; a client re-snapshots only on a new session or boot | 5 | A7: no re-snapshot on a gap |
| A11 | Who may use `hsn` on Windows | Administrators from an elevated prompt, as `sudo hsn` on macOS and Linux; no recorded SID, no group, no access for the installing user's own account | 9 | A11: the refusal's message; A8: the installer opens the first console address itself |
| A11 | Who sets the folder's access list | The installer at install and upgrade, and the hub at start when it finds it open (it then warns, `data_folder_was_open`); refused only when it cannot set it | 9 | A11: set, re-read, warn; A8: the `.msi`'s list. No frozen change: the hub event kind is the shell's |

### Step 1, wave 2: questions settled

| From | Question | Settled | Where | Changes |
| --- | --- | --- | --- | --- |
| A2 | Which handshake a connection carries | A path each: `/app` (IK), `/app/link`, `/app/restore`; no trial reading | 5 | Wire: the WebSocket path. A2 routes by it; A7 opens it; A1's vectors unchanged |
| A2 | `first` | Acted on only once the session is proven: `clientConnected`, then `first` as the first `clientRequest`, as A2 built it | 5 | None |
| A2 | The console token on a command line | A page in the opening user's own folder that replaces itself with the address; `hsn` opens its path as that user, waits, deletes it | 5 | A2 (`hsn open`); A8 (the installers' first opening uses the same) |
| A2 | `clientRefused` | Yes: `{kind: "clientRefused"; address: string; reason: "unknownKey" \| "removedKey" \| "consoleOnLan" \| "noVersion" \| "timeout" \| "malformed" \| "rateLimited"; count: number}`, at most one per address per minute, 64 ‡ addresses then `"many"`; `app` records `client_refused`, routine, info, a warning past 10 an hour per address | 5 | Frozen: `events.ts`. A2 sends it; A3 records it |
| A2 | The certificate's encoding | A2's own encoder, no library (reviewer's decision: serialisation, about 120 lines, checked by OpenSSL and read back by `node:crypto`); section 5's checks become permanent tests, with the encoder's edges | 5 | A2 |
| A7 | Configuration in the snapshot | Yes: `snapshotObject` gains `modes: z.array(modeObject)`, `groups: z.array(groupObject)`, `schedules: z.array(scheduleObject)`, filtered as section 5 says; kept current by `config` and `arming` events | 5 | Frozen: `objects.ts`. A3 fills it from A4's and A5's views; A7 shows it |
| A7 | A new person's name | The hub's message 2 says so: `linkHubPayload` gains `askName: boolean`; `linkSecret` gains `askName: boolean` so the shell can say it (false for restore) | 5 | Frozen: `handshake.ts`, `effects.ts`. A3 sets it, A2 sends it, A7 asks |
| A7 | Retrying a lost change | Same `seq` within 30 s ‡ only; then "the hub did not confirm this" and the new snapshot | 8 | A7 |
| A7 | A close before message 2 | Nothing certain; after 5 ‡ in a row over a minute, "may have been removed", with linking again offered | 8 | A7 |
| A7 | Browsers for M2 | Chrome and Edge on Windows, Chrome on macOS; Safari and Firefox in step 3, listed as not verified until then, not blocking | 10 | A7, A9 |
| A8 | The release file | As section 9: `HSNR` header, signed manifest, payload bound by its hash; `badFile`, `badSignature`, `wrongSystem`, `notNewer`; keys compiled in, two at most; no download in M2 | 9, 12 | Frozen: `errors.ts`'s `invalid` reasons gain `badFile`, `badSignature`, `wrongSystem`, `notNewer`, `full`; `FileOutcome.failed.reason` gains `wrongSystem`. A8 |
| A8 | A hub that crashes at every start | Crash exits 71, restart request 70; backoff 1 s, 10 s, 30 s, then 5 minutes, never stopping, with `launcher-status.json` and the system log; a new version gets no restarts before its healthy mark, only the rollback | 9 | Step 0 owner: exit 71 in `shell/main.ts`. A8: the launcher |
| A8 | Rollback after an additive migration | Every migration at a version switch copies first; approval refused without room | 9 | Step 0 owner: the migrator copies always. A8: the approval check and the test |
| A8 | The control connection's `ConnId` | Yes: the `command` input gains `conn: ConnId`, from the shell's one counter (section 6), and `AnswerTo`'s control variant becomes `{kind: "control"; request: RequestId; conn: ConnId}`, which `control` fills from `command.conn`; `upkeep` names an upload from it (`uploadOf`) | 6 | Frozen: `events.ts`, `messages.ts`. The step 0 owner's control server numbers it; A4 (`control`) fills it; A8 uses it |
| A8 | `update_state.last_result` | Yes: `last_result` integer not null default 0 (0 none, 1 healthy, 2 rolled back), `last_result_ms` integer null | 4, 9 | Frozen: schema, migration, `UpdateStateRow`. A8 |
| A8 | `backupWritten.sameDiskAsData` | Yes: `{kind: "backupWritten"; name; bytes; sameDiskAsData: boolean}`, the folder's and the data folder's devices compared; `backup_folder_on_data_disk` raised once per folder chosen | 9 | Frozen: `events.ts`. A8 |
| A11 | `data_folder_was_open` | Yes, in `M2_HUB_EVENTS` (warning, routine). It arrives by a new input, not `inputRejected`, which means a refused input: `{kind: "shellWarning"; code: ShellWarningCode; message: string; detail: string \| null}`, with `ShellWarningCode` a closed union starting `"data_folder_was_open"`, so each new code is a reviewed change; `audit` records it as a hub event of origin `shell`, under its cap | 9 | Frozen: `events.ts`, `M2_HUB_EVENTS`. A11 sends it; the step 0 owner's `audit` records it |
| A8, A3 | The backup key's epoch and `backupKeyChanged` | Corrected: `upkeep` (A8) makes the new key and epoch in the removal's step and records `backup_key_replaced`; `app` (A3) sends `backupKeyChanged` to the phones' sessions on it (`app` sends every event); `people` (A3) writes `clients.backup_key_epoch` when a phone fetches the key with `backup.key` | 9 | A3, A8 |
| A8 | The loop's wiring | Confirmed: `fileJob` runs only after the commit that justifies it and after the turn's answers (the send gate, HD 4); `switchUpdate` and `switchRestore` stop cleanly and exit 70; the healthy mark is written after the commit holding `update_healthy`, which comes after the listeners are open | 9 | Step 0 owner |
| A8 | The Windows install's setup page | The elevated deferred action gets the token and writes the page in the installing user's folder; the exit dialog opens its path as that user. The hosted runner proves: the page is written with an access list of that user, SYSTEM and Administrators only; no process's command line holds the token (checked through WMI while it runs); an interactive install, driven by UI automation, opens the default browser on the console address. A person at a real PC checks: the first minute as the host will see it (SmartScreen, UAC's prompt, the page opening in Chrome or Edge, linking) | 9 | A8 |
| A2 | An unknown `find` | `clientRefused`, reason `unknownToken`, counted per address; no token's tries | 5 | Frozen: the reason in `events.ts`. A2 |
| A2 | Knowing the page was read | From the hub: `consoleTokenWait {token}`, answered `{used: boolean}` on use or expiry; no access times, no port | 5 | Frozen: the control protocol's command and reply. A2 (`hsn open`), A3 (`people` answers it) |
| A2 | `APP_PATHS` | `{session: "/app", link: "/app/link", restore: "/app/restore"}` in `packages/protocol/src/app/constants.ts`, imported by both ends | 5 | Frozen: first in the list. A2, A7 |
| A7 | Reading a client's categories | The snapshot gains `notificationPrefs: {categories: readonly OptionalCategory[]; revision: number}`, this client's, kept current by the `notifications.prefs` reply | 6 | Frozen: `objects.ts`. A3 fills it from `notify`'s view (A6); A7 |
| A7 | `device.show`'s settings | Its reply becomes `{device: DeviceObject; settings: SensorSettings \| SirenSettings \| GatewaySettings}`, each the matching `*.settings` request body's fields made required, without the device, plus `version` | 6 | Frozen: `objects.ts`, `ops.ts`. A3 fills it from the M1a modules' views; A7 |
| A7 | Setting retention (HB24) | `site.set` gains `retentionRoutineDays: z.int().min(1).max(90).optional()` and `retentionEventDays: z.int().min(30).max(730).optional()` ‡, and `hsn site set` the same two options; `siteObject` shows both. The size guard still trims by size whatever the setting (HD 6), so it always holds; the app warns, from `hub.status`'s size and marks, when the new setting scaled from today's size would pass the lower mark | 6, 7 | Frozen: `ops.ts`, the control protocol. A3: the `site` module's settings change (reviewed by the step 0 owner); A7 |
| A7 | QR codes in M2's web build | Showing yes: the link address as a QR code, which a phone's camera opens in its browser, and the restore code on the console; with `toqr` 0.1.1, as the hub uses it, drawn as SVG. Scanning no: nothing in M2's web build needs it, and the phone app scans from M3 (`qr.native.ts`, D119) | 8 | A7 (`qr.web.ts` shows only) |
| A7 | Decoding packets in the browser | In the browser, through a new entry `@hsn/protocol/messages`: the message decoders without any crypto, with a test that its import graph holds no `node:` module. The history screen shows a packet as its message type and fields, its bytes in hex on request | 7 | Frozen: the package's `exports`. A7 |
| A7 | Where decision kinds live | `DECISION_KINDS` and the hub event kinds move to `packages/protocol/src/records.ts`, beside `recordJson`, the hub re-exporting them; the app's text keys are `history.decision.<kind>` and `history.event.<kind>`, and the i18n test fails on a kind with no English text. A kind the app does not know is shown by its raw name, in a neutral style, with its detail | 7, 8 | Frozen: `records.ts`, `decisions.ts`. A7 |
| A7 | The restore code hidden until "go on" | Right: the console shows the backup's age and asks first (D122); the code, already made, appears only after "go on" and expires in 10 minutes ‡ unseen otherwise | 9 | None |
| A7 | A lint rule for React hooks | Yes: `eslint-plugin-react-hooks`, a version that supports ESLint 10, pinned, with `rules-of-hooks` and `exhaustive-deps` as errors, for all of `app/` | 8 | Frozen: the lint configuration (step 0 owner adds the dependency); A7 fixes what it finds |
| Step 0 owner | An export's order | The reply `{job}` first, then the chunks, ending with the end mark or `fileFailed`; on both channels | 6 | Frozen: `APP_EVENTS` gains `fileFailed: {job: jobRef, reason: "io" \| "stopping"}`, the control protocol the line `{id, kind: "fileFailed", job, reason}`. A8 (the job), A2 (the channel), the step 0 owner (the loop and the control server); A7 shows it |
| Step 0 owner | One more "now" commit a day | The daily backup's result, written now by `upkeep`; it is routine. The backup key made at first start is once, not daily | 3, 9 | A8: `backup_state` written routine on a backup's result; section 3's tables say so |
| Coordinator, A8 | Staging blocks the loop | No work holds the loop more than 20 ms ‡ on a Pi 4 while the hub listens (HD 5's budget); whole-file work in pieces of about 256 KB ‡ between turns, never a worker; staging, backup, restore and export alike; the start's copy exempt; a test of door reports during each | 3, 9, 10 | A8 (staging, backup, restore, export in pieces), A9 (the test); none frozen |
| A8 | Free space for the update's copy | Checked at the switch by the shell, not at approval; no free-space input | 9 | A8 |
| A8 | `PUBLISHER_KEYS` empty | Open for the product owner with the key's holder (section 12) | 12 | None |
| Coordinator, A8 | No decompressor of ours | Release format 2: an uncompressed payload, the files concatenated, each file's path, size and SHA-256 in the signed manifest; staging verifies the whole payload's hash (pass 1) before copying any file out (pass 2), both in pieces. A8's inflate goes | 9 | A8 |
| Coordinator, A1, A8 | Sealing and opening a backup in pieces | `backupSealer` and `backupOpener` added to `backup-interface.ts`, the one-shot functions wrapping them; vectors unchanged | 9 | Frozen: `backup-interface.ts`. A1 implements; A8, A2 use |
| Step 0 owner | Jobs in pieces | The `pieces` contract of section 3: one `next()` per turn after inputs and effects, `abort()` on stop, the upload freed at the end | 3 | The step 0 owner (the loop); A8, A2 |
| A1 | The codec's text against its vectors | The text follows the vectors: no `deps`; empty data sealed as one empty last chunk; `truncated`, `cut`, `decryptFailed` as the vectors give them; restore's `wrongKey` for chunk 0, `badFile` otherwise; `add` after `finish` refused as `finished` | 9 | Frozen: `backup-interface.ts` (`add` returns `BackupResult`, `BackupError` gains `finished`), `handshake.ts` (`RestoreResult`'s reasons gain `badFile`). A1; A8, A7 |
| Step 0 owner | The extra "now" commit | The one backup warning of the first day, correctly now; once until a folder is set; a hub with no folder says `backup_no_folder`, not "overdue" | 3, 9 | Frozen: `decisions.ts` gains `backup_no_folder`. A8; A6 notifies it in `backup` |
| A8 | An export holds the loop | Not a database image: `history: false` is the configuration backup; `history: true` the history file, JSON Lines of `recordJson` rows read in pages by `seq`, not sealed, refused by restore; no scratch copy, no exception | 9 | Frozen: the backup header's flag bit 0 retired (flags all zero). A8 (the export job), A7 (reads and saves it) |
| A4 | A group with an empty siren list | Refused, as built; a list emptied by a removal returns to every siren | 7 | None |
| A3, step 0 owner | Events never built | Every event and what raises it, listed in section 5; a test sends each | 5 | The step 0 owner (the test); A3 |
| A8 | `rejects` and `loss_daily` in the history file | Two parts after the merged records, each in its key's order: `reject` rows (existing kind) and `lossDaily` rows (new kind); `boots` left out, its runs being `restarted` events | 9 | Frozen: `records.ts`'s `recordJson` gains `{kind: "lossDaily"; row: {deviceId, day, received, expected}}`. A8 |
| Step 0 owner, A2 | Who sends `ping` | The shell, as built: liveness is the transport's, per session on its monotonic clock, like the lifetime; the core gets `clientClosed {reason: "liveness"}` | 5 | Frozen: `OP_OWNERS.pong` becomes `shell`. The step 0 owner's test: the exception becomes the rule; A3 drops any `pong` handling |
| A3 | `hub.what`'s values | Eight, each with what raises it (section 5); `updateHealthy`, `updateRolledBack` and `restored` removed after the every-event test (they come before any session): notifications and `update.status` carry them | 5 | Frozen: `hub.what` becomes `z.enum(["updateStaged", "updateRefused", "updateSwitching", "backup", "databaseFailing", "databaseRecovered", "databaseSize", "historyShortened"])`; `update.status`'s reply gains `lastResultMs: wallMs.nullable()`. A3 fills, A7 shows; the test requires the eight as events and the three as notifications delivered to the first session after them, and `lastResult` in `update.status` |

**The frozen changes of wave 2, in the order to apply them** (the step 0 owner, with the wiring, in one pass):

1. `packages/protocol/src/app/constants.ts`: `APP_PATHS = {session: "/app", link: "/app/link", restore: "/app/restore"}` (A2, A7).
2. `packages/protocol/src/app/handshake.ts`: `linkHubPayload` gains `askName: boolean` (A2, A3, A7).
3. `packages/protocol/src/app/objects.ts`: `snapshotObject` gains `modes`, `groups`, `schedules` (A3, A7).
4. `packages/protocol/src/app/errors.ts`: `invalid`'s reasons gain `badFile`, `badSignature`, `wrongSystem`, `notNewer`, `full` (A8, A7).
5. `hub/src/core/model/events.ts`: `clientRefused {address, reason, count}`, its reasons including `unknownToken` (A2, A3); `command` gains `conn: ConnId` (A8; the control server), carried on in `messages.ts` as `AnswerTo`'s `{kind: "control"; request; conn}` (A4 fills it, A8 reads it); `shellWarning {code, message, detail}` with `ShellWarningCode` (A11; `audit`); `FileOutcome`: `backupWritten.sameDiskAsData`, `failed.reason` gains `wrongSystem` (A8).
6. `hub/src/core/model/effects.ts`: `linkSecret` gains `askName: boolean` (A2, A3).
7. The hub event kinds: `M2_HUB_EVENTS` gains `data_folder_was_open` (warning) and `update_refused` (warning), both routine (A8, A11).
8. `hub/src/db/schema.ts`, `0002_m2.sql` (still unreleased, regenerated), `rows.ts`, the fixture test: `update_state.last_result`, `last_result_ms` (A8).
8a. `hub/src/control-protocol/`: `hsn site set`'s two retention options (A3); the command `consoleTokenWait {token: number}`, answered `{used: boolean}` when the console token is used or expires (A2, A3); the console token's lifetime a parameter of its request, 2 minutes for `hsn open`, 10 for an installer ‡ (A3, A8).
8b. `packages/protocol`: `objects.ts` (snapshot `notificationPrefs`; `SensorSettings`, `SirenSettings`, `GatewaySettings`; `siteObject`'s retentions), `ops.ts` (`device.show`'s reply; `site.set`'s retentions), `records.ts` (`DECISION_KINDS` and the hub event kinds, moved), and the entry `./messages` in `exports` (A3, A6, A7).
8c. The lint configuration: `eslint-plugin-react-hooks` for `app/` (A7).
8d. `packages/protocol/src/app/events.ts`: `fileFailed {job, reason: "io" | "stopping"}`; the control protocol's line `{id, kind: "fileFailed", job, reason}` (A2, A7, A8, the step 0 owner).
8e. `packages/protocol/src/app/backup-interface.ts`: `BackupSealer`, `BackupOpener`, `backupSealer(key, header)`, `backupOpener(key, headerBytes)`, the one-shot functions over them, `add` returning `BackupResult`, `BackupError` gaining `finished` (A1; A2, A8); `handshake.ts`: `RestoreResult`'s reasons gain `badFile` (A7, A8). The release format 2 lives in A8's `hub/src/shell/update/`, not frozen.
8f. The loop: the `pieces` contract for jobs (the step 0 owner; A2, A8).
8g. `decisions.ts`: `backup_no_folder` (A8, A6).
8h. `backup-interface.ts`: the header's flag bit 0 retired, every flag zero in format 1 (A1, A8).
8i. `packages/protocol/src/records.ts`: `recordJson` gains `lossDaily` (A8, A7).
8j. `hub/src/core/model/ops.ts`: `OP_OWNERS.pong` is `shell` (A2, A3).
8k. `packages/protocol/src/app/events.ts`: `hub.what`'s eight values; `ops.ts`: `update.status`'s reply gains `lastResultMs` (A3, A7, A8).
9. The shell, the step 0 owner's: an uncaught exception exits 71; the migrator copies before every migration; the loop's `fileJob`, switches and healthy mark as confirmed above; and the wiring of every module and listener.

Then `bun run check` and `bun run m1a`, and A2, A3, A7, A8 and A11 remove their interims.


**The frozen changes of step 1, in the order to apply them** (the step 0 owner, in one pass; each line names who then builds on it):

1. `packages/protocol/src/app/objects.ts`: `stateUnexpected` in `NOTIFICATION_CATEGORIES` (A6); `missed.why` gains `clockStepped` (A5, A7); `siteObject.channel` nullable (A3, A7).
2. `packages/protocol/src/app/ops.ts`: `notifications.read` a read, no `seq` (A3, A6, A7); `mode.switch` and `arm` replies gain `lowBattery: [device]`, `mode.switch`'s and `disarm`'s gain `heldBack: [device]` (A4 fills them, A5 reads them, A3 and A7 see them).
3. `packages/protocol/src/app/errors.ts`: `invalid`'s reasons gain `noAnswer` and `noGateway` (A3).
4. `packages/protocol/src/app/noise-interface.ts`: the XXpsk3 responder made without a psk, given it by `setPsk(psk)` after reading message 1; reading message 3 without one is an error (A1, A2).
5. `packages/protocol` tooling: the device vector generator and tests read and write only their own files, by an explicit list (A1; A9 adds the verifier's app part).
6. `hub/src/core/model/messages.ts`: `AnswerTo` gains `{kind: "schedule"; schedule: ScheduleId; record: Seq}` and loses `none` (A4, A5); `notificationRaised {notification: NotificationObject; clients: readonly ClientId[]}` (A3, A6); `disarmSensors` loses `mode` and `holdBack` (A4); `AppMessage` gains `{kind: "handshake"; body: LinkResult | RestoreOffer | RestoreResult}` (A2, A3, A8).
7. `hub/src/core/model/events.ts`: the input `hubFacts {version, addresses, appsPort, certificateSha256}` (A2, A3); `linkFailed.address: string` (A2, A3); `M2Snapshot.notifications` and `notificationReads`, the last 7 days ‡ before the last commit's wall time, with the shell's reader (A6).
8. `hub/src/core/model/effects.ts`: `linkSecret` gains `lookup: string | null` (A2, A3, A8); `closeConn {conn, reason: "linkRefused" | "restoreRefused"}` (A2, A3, A8); `hubStatusRead {conn, id}` (A2, A3).
9. `hub/src/core/model/decisions.ts`: `cover_state_unexpected`, also in `audit`'s `WARNING_DECISIONS` (A6); `arming_changed` (A4, A6); `person_renamed`, `client_renamed` (A3, A8).
10. `hub/src/db/schema.ts`, `0002_m2.sql` (regenerated, not yet released), `rows.ts`, its fixture test: `link_tokens.person_name` text null (A3); `schedules.missed_due_ms` integer null, `missed_why` integer null, `missed_count` integer not null default 0 (A5).
11. `hub/src/core/model/rules.ts`: `schedules.clockStepMs: 60_000` ‡, `reanchorMs: 1_000` ‡ (A5).
12. `CoreDeps.sha256(data: Uint8Array): Uint8Array`, and `step`'s tests (A2 passes it; A3).
13. The core's lint configuration: `no-restricted-globals` for `Temporal` and `Intl`, `no-restricted-properties` for `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString` and `localeCompare` (A5; every core owner).

Then `bun run check` and `bun run m1a`, and each owner removes its interim (A3: `notBuilt` for `link.create`, the console token, `snapshot`, `hub.info`; A4: its battery percentage and reply formats; A5: the outcome fallback; A6: the boot-snapshot permissions and `UNKNOWN_REVISION`).
### Step 1: in parallel

Each owner changes only the folders named; a frozen interface changes only through the step 0 owner. Each item below is a reviewable step of its own.

| Owner | Folders | Steps |
| --- | --- | --- |
| A1 | `packages/protocol/src/app/noise.ts`, `backup.ts`, their tests, `packages/protocol/vectors/app-*.json`: new files beside step 0's frozen ones, implementing `noise-interface.ts` and `backup-interface.ts`; A1 adds their two export lines to `index.ts` and changes no other frozen file | 1. Noise state machine for both patterns against the published vectors, the static key's Diffie-Hellman as a function, the all-zero check. 2. Our vectors for every handshake (section 10). 3. The backup format and its vectors. 4. The browser's Web Crypto path, as K1 decided |
| A2 | `hub/src/shell/app/`, `hub/cli/` (`hsn open`) | 1. The two new listeners with TLS, the certificate and the checks of section 5. 2. Handshakes and session admission, liveness inside Noise, the ordered send queue, `ClientKeys`, `LinkSecrets`. 3. File chunks. 4. `hsn open` and the one-time console token |
| A3 | `hub/src/core/people/`, `hub/src/core/app/` | 1. People, clients, permissions and their rules. 2. Tokens (128-bit and typed), linking, invites, expiry, removal with what a client made and linked. 3. Request routing, permission checks, `seq` with stored replies. 4. Snapshot, subscriptions, events checked at the time they are made, `forget` |
| A4 | `hub/src/core/layout/`, `hub/src/core/alarm/`, `hub/src/core/control/` | 1. Groups and modes, the fixed modes and the migration's mode. 2. Requests resolved to sensors; confirmations. 3. Sirens by group in the alarm. 4. `arm --all` and `disarm --all` as mode switches; the recorded sessions regenerated with A10 |
| A5 | `hub/src/core/schedules/`, `hub/src/shell/calendar/` | 1. The calendar over Bun's built-in Temporal, with its tests. 2. Entries, next times, running. 3. Untrusted clock, missed entries (D116), held-back disarms (D117) |
| A6 | `hub/src/core/health/`, `hub/src/core/notify/` | 1. Battery percentage, low battery, tamper. 2. The notification table, recipients, categories. 3. Delivery to sessions, unread and delayed |
| A7 | `app/` (not `app/e2e/`) | 1. The channel client (one tab holds the session; `seq` written before sending; retries with the same `seq`) and the store. 2. The "done when" screens. 3. The rest of M2's screens, one review each, linking among them |
| A8 | `hub/packaging/`, `hub/launcher/`, `hub/src/core/upkeep/`, `hub/src/shell/backup/`, `hub/src/shell/update/` | 1. The launcher and its rollback. 2. The `.deb` and its unit. 3. The `.pkg` and its daemon. 4. The `.msi` and its service, as W3 decided. 5. Backup and export. 6. Restore. 7. Updates |
| A11 | `hub/src/shell/safe/serial*.ts`, and any new file in `hub/src/shell/safe/` its paths need (`ffi-*.ts`, `worker-*.ts`, `control-socket*.ts`); `hub/src/shell/control/`; the helper's folder if W1 or W2 chose one. Every `try` of its work lives in those `safe/` files (HD 10); the other files of `safe/` stay as built, and a change to one goes through the step 0 owner | 1. The Windows serial path (or the helper on every system). 2. The Windows control socket (or the chosen socket on every system). 3. Their tests on the hosted runner and the self-hosted computer |
| A9 | `hub/test/budget/`, `hub/test/crash/`, `app/e2e/`, the CI workflows | 1. Home C and M2's traffic in the budget. 2. M2's crash points. 3. The end-to-end tests and the "done when". 4. The installer matrix |
| A10 (firmware) | `firmware/platform/host/`, `firmware/tests/system_roles/` | 1. `RemoteHub`'s new commands. 2. The regenerated sessions reviewed. 3. The two new system tests |

What could collide, and why it does not: `core/step.ts`, `core/model/`, `db/schema.ts`, the control protocol and `packages/protocol/src/app/` types are the step 0 owner's alone; `alarm` passes from its M1a owner to A4 alone; the serial and control code pass to A11 alone (A2 owns only the new listeners); every other folder has one owner.

### Step 2: integration

The step 0 owner with each engineer: the new modules in `step.ts`'s order; the loop's handling of the new effects (`appSend` to sessions, `closeClient`, `linkSecret`, `fileJob`); the listeners in `main.ts`; the scenario days, the budget and crash tests; the "done when" in continuous integration.

### Step 3: real computers

The packages on macOS, Linux x64, a Pi 4 and 5, and Windows x64; the "done when" with the M1 boards on each, the gateway on USB (D118); O12's remaining browsers; the week-long run; the values marked ‡ revisited.

## 12. Decided, and what is still open

| # | Question | Decided | Where |
| --- | --- | --- | --- |
| Q1 | One port or two on the home network | Two: devices on plain `ws://`, apps on HTTPS; the console on loopback (section 5) | Taken as recommended; D101 and stack.md amended |
| Q2 | Who holds the backup key before phones are linked | Linked phones only, as D78 says: restore becomes usable with M3; M2 builds and tests backup and restore with a key the test supplies; no recovery code | D119 |
| Q3 | Schedule entries missed while the hub was off or its clock unset | Skipped, never run late; recorded and shown (section 7) | D116 |
| Q4 | A scheduled disarm during a countdown or an alarm | The triggers and counting sensors stay armed; the entry is recorded as held back; the alarm runs on (section 7) | D117 |
| Q5 | Windows in M2 | Windows is part of M2: USB gateways and `hsn` included (section 9) | D118 |
| Q6 | Signing the macOS installer | Unsigned until the developer account comes with M4 | D119 |
| Q7 | Hub updates before the relay | From a file in M2, which D84 keeps anyway for owners' own builds; through the relay from M4 | D119, D84 |
| Q8 | A sensor added while a mode is current | Starts disarmed; armed by the next switch that holds it (section 7) | Taken as recommended |
| Q9 | Backups with or without history | Scheduled backups hold configuration only; history only in an on-demand export (section 9) | Taken as recommended |
| Q10 | Linking further devices of one's own without *manage users* | Allowed (section 5) | Taken as recommended |
| Q11 | How long a typed linking code is | Short, the length people are used to; QR codes and link addresses carry 128 bits. Someone already on the home network who pretends to be the hub can work a typed code out from one captured attempt: accepted (section 5) | D120 |
| Q12 | A second approval step for each new link | None: a valid code links at once and works once (section 5) | D121 |
| Q13 | Clients after a restore | As the backup has them, with nothing to review; a backup is written at once after every change of people, clients, permissions or devices, so the newest file holds them as they stand; an older file says how old its permissions are (section 9) | D122 |

**What D119 removed from this design**, as built only to cover the time before a later milestone:

- the recovery code that showed the backup key on the console, and restoring by typing it there;
- giving the backup key to browsers, already dropped (section 5), so restore waits for phones (M3);
- the one-hour catch-up of missed schedule entries went by D116, not D119, but it too is gone.

Nothing else in the design was interim: linking browsers, the console, notifications to open sessions, updates from a file (D84 keeps them for owners' own builds) and the first linking code for a hub with no screen (D62) are part of the finished product.

**Still open for the product owner**:

- **Styling the app** (noted, put to the product owner by the coordinator): stack.md names NativeWind; A7 used React Native's own `StyleSheet`, since NativeWind is not installed and downloads were not allowed. Until answered, `StyleSheet`.

- **Who holds the publisher's private key** (D84), which signs every hub release. Until it exists, `PUBLISHER_KEYS` is empty, so every real release is refused (`badSignature`); only the test key verifies, in tests. Recommendation: made and kept on a hardware key or an offline computer by the product owner, never on a build machine or in the repository; releases signed there by a small tool (`tools/release-sign`, A8) from the build's unsigned file. **Until answered**, A8 builds and tests with a test key kept in the repository and marked as such; the release build refuses to embed it, so no hub ever trusts it.

- **The sensor's cell and its curve** (HB33). No document names the fitted cell (chemistry, capacity, maker), so no curve of voltage against charge can be written; the 4.2 V full charge of hardware-notes.md says only that it is a lithium-ion cell. Recommendation: choose the cell for the M1b board now, and measure its discharge at the sensor's real load (a sleeping board with a report every few minutes ‡) on two boards, at room temperature and at 0 °C ‡, before M2's step 3; the measured table replaces the interim one in `HubRules`, keeping 10% at the firmware's 3,500 mV or moving both together. **Until answered**, the hub uses the interim table of section 7 (3,000 mV 0%, 3,500 mV 10%, 3,600 mV 15%, 4,200 mV 100% ‡), and the low-battery warning, which depends only on the 10% and 15% points, behaves as specified.

- **Signing the Windows installer.** D119 holds the macOS installer unsigned until the Apple account of M4, but no milestone brings a Windows code-signing certificate. Unsigned, SmartScreen warns on every new download until the file has a reputation. Options: buy a certificate when the product is released (a yearly cost, and for the best SmartScreen treatment a hardware-held key); or ship unsigned. Recommendation: plan the certificate for the same milestone as Apple's account, M4, so both platforms are signed together.

## 13. Gaps, contradictions and risks

### In other documents (not edited here)

| Where | Gap or contradiction | Reading taken |
| --- | --- | --- |
| D101, stack.md (Hub: one port; Link to the hub off LoRa: "one firewall rule"), protocol.md §10 ("the same port as the apps") | One port for plain `ws://` devices and HTTPS apps is not possible as specified | Two ports (Q1); D101 and stack.md are being amended, §10 needs the same |
| HB22 ("backup of the database") against D53 | What a backup holds | Configuration only (Q9); HB22's wording should follow |
| stack.md, "Browser to hub: HTTPS on the per-hub name (D79)" | Per-hub names are M4's (RA11); in M2 every browser but the console's uses D105's direct address | As D105 |
| stack.md, "USB gateway: the `serialport` package" | Out of date: ports open through `node:tty` (O18, HD 3) | — |
| stack.md, App to hub: "the first message of a connection can already carry a request" | Noise's IK first message can be replayed; the design needs sequence numbers, which stack.md does not mention | Sequence numbers (section 5) |
| AL7a and D51 ("stops the siren") against D95 | A Disarm by someone who may not manage every trigger does not stop the sirens | D95 |
| D75 against AP6 | AP6 notifies "siren path lost"; D75 does not say whether it can be turned off | It can (section 7) |
| D90 | Silent on a sensor added while a mode is current | Starts disarmed (Q8); not yet recorded as a decision |
| HB24 ("both adjustable") against D112 | Retention is adjustable only within what the size guard allows | The app warns; the guard shortens by size |
| AP0 | The web app "shows the QR code that links the first phone": no phone app exists in M2 | The web app links browsers; phones from M3 |
| D69 ("on their own phone") | Silent on browsers' notification categories | Per client, browsers included |
| protocol.md §4, "Known limits", and O16 | §4 says door, cover and button reports can never be replayed (D112), yet still accepts that packets recorded between a backup and its restore can each be replayed once (O16), with a reason that holds only for routine packets. A replayed door report after a restore can sound the sirens | A hub-initiated key change after a restore, in protocol.md and the firmware, with M3 (section 9 says what it needs) |
| stack.md, "Encryption in one place" | Says the browser's key "is stored where page scripts can read it" and that linking does not depend on a secure context; the design now keeps it non-extractable through Web Crypto, which needs one | As section 5; stack.md should follow |
| D61 against HB3 | "Trusted without sign-in" and "authenticate every request" | The console is a linked client, through a one-time token `hsn open` gets over the control socket (D62) |
| D55, §9 | Two hub identities: the signing key's (§9, for devices) and the app key's (this design, for apps and the relay) | Both; architecture.md should name them |
| protocol.md §7, D109 | A gateway's status carries no cell voltage, so "count only while on their cell" cannot apply to gateways | No battery rules for gateways in M2 (section 7); a voltage field is a protocol change for a later milestone |
| HB33 | "A table for the fitted cell": no document gives the curve, nor names the cell | 10% = 3,500 mV, 15% = 3,600 mV, an interim table until measured (section 7); the cell is the product owner's (section 12) |
| build-plan.md, M2 | "Gateway over USB, added automatically" was built in M1a | Only the app's notice remains |
| hub-design.md sections 6 and 10 | Exit 70 serves both a crash and a restart request; a copy is made only before a migration that changes or drops a table, so a rolled-back version can find a newer database | An uncaught exception exits 71; every migration at a version switch is copied first (section 9) |
| hub-design.md section 10, "Where library exceptions are wrapped" | No row for Temporal | `hub/src/shell/calendar/temporal.ts`, through `Result.fromThrowable` (section 2) |
| hub-design.md sections 3, 9 and 13 | Say Windows refuses the control socket and cannot open a USB port, which D118 now requires | As W1 and W2 decide (section 9); hub-design changes with them |
| D117 against AL7a, D51 and D95 | D117 narrows D95 for schedules; AL11 and AL7a still read as if any Disarm may end an alarm | AL11 should name D117's exception |
| D119 against Windows signing | D119 holds the macOS installer unsigned until M4's account; nothing says when Windows is signed | Section 12, still open |
| D105 ("trusting it once is enough") | Apple's platforms refuse TLS certificates valid longer than about two years (from memory, unverified), and a new home-network address needs a new certificate | Renewal at 700 days, one new warning (section 5) |

### Risks

| Risk | What settles it |
| --- | --- |
| Home A's database at 66 MB against its 70 MB budget, home C at 208.5 MB against the 210 MB below which trimming never starts | The budget test with M2's traffic and home C (section 10); if they cross, the household assumption or D57's retention for routine rows is revisited, not the guard |
| A larger household (ten people, twenty clients) triples notification rows | Measured; notification rows could keep 30 days, not a year, as routine readings do |
| A web page is a poor alarm channel: a closed tab hears nothing, and browsers limit sound | Stated to the user in the app; push in M4 is the answer |
| The first visit behind the certificate warning is unverified (D105) | The fingerprint on the console; per-hub names in M4 |
| The Noise implementation is ours | Published vectors, our vectors, a fuzzed handshake, and a review by someone outside the project before M4 exposes it through the relay |
| The browser's key can be read by any script on the page (stack.md accepts it) | No outside scripts, a strict content security policy, and removal by another client |
| Bun's built-in Temporal, and the time-zone database's age | Pinned with the calendar's tests over daylight saving changes; updated with each release |
| The launcher is the one piece that must never fail | Small, dependency-free, tested on each platform, not updated by the hub in M2 |
| Expo's web export with a strict content security policy | Step 0's first page met two style refusals and no script refusal; hashes from the build answer both, and every Playwright test fails on any refusal (section 5). If a browser still refuses React Native Web's styles, styles alone become `'unsafe-inline'` |
| W1 fails, so a native helper replaces the termios path on every system | Found before step 0 freezes (section 11); the serial adapter's port (HD 3) does not change, so only A11's folder does |
| W2 finds no Unix-domain socket under Bun on Windows, so loopback TCP with a secret becomes the control socket everywhere | The same: the control protocol and `hsn` do not change, only the transport and its tests |
| No real Windows computer with a board until W1 starts | It is bought or borrowed first; nothing else can prove the serial path |
| Bun's own Windows support (`bun:ffi`, workers, the service) | W1 to W3 test exactly these |
| A browser that cannot keep a non-extractable X25519 key cannot be linked | K1; Web Crypto's X25519 is in current Chrome, Safari and Firefox (from memory) |
| Script on the app's origin can act as the linked browser while it runs (section 5) | Not closed: no outside scripts, a strict content security policy, the fingerprint to compare, removal by another client |
| O7: the packaging questions | Answered per platform by A8 in step 1 and checked in step 3 |

### What this design is least sure of

- The channel after the protocol review: the review's findings are taken in, or accepted by D120 to D122, but the revised linking and restore have not been reviewed again; they should be, before A1 and A3 build them.
- Whether every browser on the list passes K1; one that fails cannot be linked.

- The budget for home C and for larger households is projected, not measured.
- How well Expo's web export takes a strict content security policy, and what accessibility React Native Web gives without work.
- The per-platform installers: every row of section 9's table marked ‡ is from memory and must be tried.
- Windows: whether Bun's `bun:ffi` and workers are sound enough there for a serial port (W1), whether its `unix` listener reaches Windows' Unix-domain sockets (W2), and whether a hosted runner accepts a virtual COM-port driver. Until W1 and W2 report, the recommendations in section 9 are informed guesses.

**From the review, what was not taken as proposed, and why:**

- *`seq` only on `first`.* Kept on every change: inside a session Noise already refuses replays, as the review says, but a change whose reply was lost needs `seq` and the stored replies to be done exactly once; the replay defence for `first` is one use of it.
- *Counting link failures per source and committing them at once.* A 128-bit token cannot be named without its secret, so it needs no limit. A typed code's token id travels in clear (D120), so it keeps a limit of 5 tries and can be used up by anyone on the home network, which D120's trust accepts; failures are recorded as routine, under the warning cap (HD 5), not each committed at once.
- *The browser checking message 2 against the hub key in the page it was served.* A page served from a forged certificate would skip the check; the identity is taken instead from the link URL or QR code the maker's device made.
- *A challenge with a fresh hub nonce to resynchronise devices after a restore.* A key change does the same with one message the firmware must handle anyway once, and makes every recorded packet fail outright; moving counter bases does not work (section 9).

**Accepted by the product owner, and built around:** a typed code can be worked out by someone on the home network who pretends to be the hub (D120); a code links whoever uses it first, with no approval (D121); a restore from a file older than the newest brings back the people and permissions of that time, after saying so (D122).
