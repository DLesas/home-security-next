# `hub/src/core/firmware/`: owner U7

The `firmware` core module (docs/m3-updates-design.md section 4; module 15, after `alarm` and `site`, whose views it reads, and before `sensors`, which reads its view when it builds a reply). Pure: time and entropy come in the input.

| File | Holds |
| --- | --- |
| `state.ts` | The slice: images, rollouts, each device's update (its row and what is kept in memory beside it), the relay's offers, file jobs, grants |
| `handle.ts` | The handler: which message goes where; revokes and gives back every grant as a countdown or alarm begins and ends |
| `decide.ts` | What the hub wants of one device now: presence, holds, turns, limits, the go-ahead's conditions |
| `deliver.ts` | The Update offer for the module that owns the key, the grant, the transition an offer makes |
| `devices.ts` | A device's update query, status and Started; the shell's progress; the device timers |
| `rollout.ts` | Stages: pilots, soak, rest, done; pause, resume, cancel |
| `ops.ts` | `firmware.*` and `rollout.*`, with their permission and refusals; `firmware.bluetooth` |
| `store.ts` | The store's index, uploads, fetches of offered releases, removal, download |
| `boot.ts` | Rebuilding the module from migration 3's tables after a restart |
| `entries.ts` | Changing one device's row, its decision, and its `deviceUpdate` body |
| `records.ts`, `codes.ts` | Rows, decisions (with each one's `value` and `detail`), hub events; stored codes and names |
| `view.ts` | `offerWaiting`, `deviceUpdateOf`, `devicesInstalling` for the other modules (`deviceUpdate` events go to `app` as `deviceUpdateEvent` messages) |

**Frozen for this module** (changed only through the step 0 owner): `hub/src/core/model/`, `hub/src/core/step.ts`, `hub/src/db/` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports, and `packages/protocol/`.

Check with `bun run check:own U7`, and the module's tests: `bun test hub/test/unit/firmware hub/test/scenarios/firmware`.
