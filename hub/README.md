# @hsn/hub

The hub: a pure core (`step`) with its thirteen modules, the shell that drives it (the loop of section 4, SQLite storage, USB and WebSocket links, the control socket, mDNS), the `hsn` command, the database schema and the control protocol. The design is [docs/hub-design.md](../docs/hub-design.md). Steps 0 to 2 of its section 12 are built: every module, wired together in `src/shell/main.ts`, tested on its own and as a whole home.

## Running the hub and `hsn`

The hub keeps everything in one data folder: `--data <folder>`, or `$HSN_DATA_DIR`. Keep its path short: the control socket inside it must stay under 104 bytes.

```
bun hub/src/shell/main.ts --data /tmp/hsn [--port 8443] [--serial /dev/ttyACM0]… [--no-usb-watch]
```

At start it migrates the database, makes the hub's keys the first time, opens the devices' WebSocket on `/device` at the port (8443 ‡ by default), watches for USB serial ports (and opens each `--serial` path), opens the control socket `control.sock` in the data folder and advertises itself by mDNS. On macOS give a `--serial` port by its `/dev/cu.*` name: opening the `/dev/tty.*` one waits for a modem's carrier, and the hub opens listed ports by their `cu.` names itself. SIGINT or SIGTERM stops it cleanly; exit 78 means it could not start, 70 an uncaught error (written to `fatal.log`).

`hsn` talks to it through the control socket (section 9), with the same data folder:

```
HSN_DATA_DIR=/tmp/hsn bun hub/cli/hsn.ts status
HSN_DATA_DIR=/tmp/hsn bun hub/cli/hsn.ts log --follow
```

(`hub/package.json` names it as the `hsn` command.) Not yet: the Windows control pipe and the bench's lockstep mode.

### Against the firmware's bench, in real time

`hsn_bench` (`firmware/tools/bench/README.md`) puts each simulated board's links on pseudo-terminals and writes a manifest. The hub opens the USB ones with `--serial <path>`; `tools/bench-bridge` joins each network one (a siren's Wi-Fi) to the hub's `/device`:

```
bun tools/bench-bridge/src/main.ts --manifest bench-manifest.json --hub ws://127.0.0.1:8443/device
```

`bun run m1a` at the root runs M1a's "done when" (section 11) against a built bench (`$HSN_BENCH`, or `firmware/build/host-debug/tools/bench/hsn_bench`), in about a minute.

## Tests

`bun run check` at the repository's root runs everything. On its own, from `hub/`:

| What | Where | Run |
| --- | --- | --- |
| Units: each module, the shell's adapters, the loop and the process | `test/unit/` | `bun test test/unit` |
| Scenarios: homes A and B of section 5 on the whole hub (`test/world/home.ts`: every module, the loop, the real SQLite store, scripted gateways, sensors, sirens and boards) | `test/scenarios/` | `bun test test/scenarios` |
| The write budget: section 5's day of each home, measured on the real writer | `test/budget/` | `bun test test/budget` (prints the figures) |
| Crash tests: power lost at each point of section 4's table and at 500 ‡ seeded points of a day, the seven conditions checked after each restart | `test/crash/crash.test.ts` | `bun test test/crash/crash.test.ts` |
| M1a in real time: the real hub against the bench's sensor, siren and gateway (skipped unless `HSN_M1A=1` and the bench is built) | `test/bench/m1a.test.ts` | `bun run m1a` at the root |
| The bench bridge, against a stand-in hub and the real one | `tools/bench-bridge/test/` | `bun test tools/bench-bridge` |
| A real hub process killed with `kill -9`, 8 times by default | `test/crash/kill.test.ts` | `HSN_KILL9_RUNS=100 bun test test/crash/kill.test.ts` (the nightly run) |

Every harness loop is bounded: a run that stops making progress fails with a message rather than hanging.

## Who owns what (hub-design.md section 12, step 1)

Each engineer changes only the folders below, and asks the step 0 owner before changing a frozen interface: anything in `src/core/model/`, `src/core/step.ts`, `src/ports/`, `src/db/`, `src/control-protocol/`, `test/world/world.ts`, or the lint rules.

| Engineer | Owns |
| --- | --- |
| E1 | `src/core/gateways/`, `src/core/links/`, `src/shell/links/` |
| E2 | `src/core/intake/`, `src/core/sensors/`, `src/core/slots/`, `src/core/site/`, the scripted sensor in `test/world/` |
| E3 | `src/core/alarm/`, `src/core/sirens/`, the scripted siren in `test/world/` |
| E4 | `src/shell/storage/`, `src/shell/safe/`, `src/core/audit/`, `src/core/clock/`, `test/budget/`, `test/crash/` |
| E5 | `src/core/registry/`, `src/core/setup/`, `src/core/control/`, `src/shell/control/`, `cli/`, `src/shell/advertise/` |
| E6 (firmware) | `firmware/platform/host/` additions, `tools/bench-bridge/` |

A module's folder has four files: `state.ts` (its slice and timers), `handle.ts` (its handler), `view.ts` (the selectors other modules may read) and `deadlines.ts`. Other modules read a slice only through its `view.ts`; lint enforces this, and the layer rules of section 1.

## Checking your own work: `bun run check:own`

Five engineers work in one checkout at once, so `bun run check` fails for everyone while one of them is mid-edit. Each owner checks their own folders instead, with paths from the repository's root:

```
bun run check:own hub/src/core/alarm hub/src/core/sirens
```

It runs:

- **the type check** on the whole project, as it must, but reports only the errors inside the named folders; the others are counted, as in `not yours: 3 errors in hub/src/core/gateways`;
- **ESLint** and **Prettier** on the named folders only;
- **the tests** under the named folders, and the lint probes (`test/unit/lint-probes.test.ts`), whose layer rules every owner relies on.

It exits non-zero only for a failure in the named folders. Tests of a module that live elsewhere (for example a scenario in `test/scenarios/`) are run by naming that folder too. Before merging, `bun run check` must pass for the whole repository.

## Layout

- `src/core/model/`: the frozen types: ids, time, inputs, internal messages, effects, store operations, audit records, decision kinds, errors, rules, timers, state, handler and context.
- `src/core/step.ts`: `step`, `nextDeadline`, `emptyState` and the dispatcher; `src/core/<module>/`: the thirteen modules; `src/core/util/`: the entropy cursor and `protocol-safe.ts`, the only place the core calls a protocol function that can throw.
- `src/ports/`: the interfaces the shell implements.
- `src/db/schema.ts` and `drizzle/`: the tables and their migrations (`bun run db:generate` here).
- `src/control-protocol/`: the control socket's commands and replies, the bench's lockstep messages and manifest, as Zod schemas.
- `src/shell/`: `main.ts` (the process), `loop.ts` (section 4's turn), `storage/`, `links/`, `control/`, `advertise/`, `cipher/`, `clock/`, and `safe/`, the only place besides `main.ts` with `try` and `throw`.
- `cli/`: the `hsn` command.
- `test/world/`: `home.ts`, a whole home on the whole hub; `world.ts`, the lighter harness on the real `step` with a recording writer; the scripted gateway, sensor and siren; the vector cipher. `test/unit/`; `test/scenarios/`; `test/budget/`; `test/crash/`; `test/lint-probes/`, one file per lint restriction, ignored by the ordinary lint and checked by its own test.
