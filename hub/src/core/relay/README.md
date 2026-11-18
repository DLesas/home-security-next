# `hub/src/core/relay/`: owner B5

The joint step 0 of M3 and M4 ([docs/m3-m4-plan.md](../../../../docs/m3-m4-plan.md)), step 1. Relay settings, push targets (tokens, never keys), the push outbox, the link's state as the shell reports it, and what each push says (docs/m4-design.md section 4); the operations `push.*` and `relay.*` (`OP_OWNERS`).

Your slice and handler are yours; the module's place (7th, right after `people`, whose `clientRemoved` it acts on; its decisions reach `notify` in a later turn of the step's queue), its timer keys (`unreachable`, `linkRecord`, `pushRetry`, `outboxExpiry`, `rosterRefresh`), `relay_settings`, `push_targets`, `push_outbox` (migration 3; `push_keys` is the `PushKeys` port's), `HubRules.relay`, the `relayConnect`, `relayRoster`, `pushSend` and `pushKey` effects, the `relayLink`, `pushResults` and `releaseOffered` events, the `PushKeys` port, and its decisions (`push_registered`, `push_unregistered`, `push_target_invalid`) and hub events (`relay_link`, `relay_unreachable`, `relay_reachable`, `relay_identity_in_use`, `push_dropped`) are frozen.

**Frozen for you** (changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/`. Ask for a change there; do not make it.

Check your work with `bun run check:own B5` (the checks of `bun run check`, failing only for your folders). Its tests are in `hub/test/unit/relay-core/`.

## The files

| File | What |
| --- | --- |
| `handle.ts` | The handler: which messages it acts on, and the timers |
| `state.ts` | The slice: settings, link, outage, the hour's tally, targets, outbox, test pushes, roster, causes |
| `settings.ts` | The relay in use (the default is none while the domain is a placeholder), `relay.set`'s rule, `relay.status` |
| `targets.ts` | Registering, unregistering, invalid targets, the roster |
| `outbox.ts` | Raising, sending, results and retries, the burst when the link returns, rows too old |
| `content.ts` | What each push says to each recipient: `actions`, `names`, `detail`, `armed`, the size rule |
| `link.ts` | The link's state, `relay_link`, `relay_unreachable`, `relay_reachable`, `relay_identity_in_use` |
| `ops.ts` | `push.register`, `push.unregister`, `push.test`, `relay.status`, `relay.set` |
| `boot.ts` | The slice rebuilt from migration 3's tables at a start |
| `records.ts` | Rows, decisions and hub events, with their classes |
| `codec.ts` | The content's size |
| `view.ts` | For other modules: `relayInUse` (`hub.info`), `relayForLinkCode` (`r=`), `pushTargetState` (the snapshot's `push`), `relayStatus` |

## For the modules and the shell around it

- **The shell (B6).** Give the boot input `defaultRelayUrl`. `relayConnect` comes at boot only when a relay is in use (none: the client starts off), and at each change of the relay in use (`null`: close it). Report `relayLink` with the URL the core asked for: an event for another URL is ignored. `relayRoster` comes only while the link is up, with `rev` counting from 1 in each run; it is the whole set each time. `pushSend` ids are outbox row ids, or a test push's id (never stored); give every result back by id, `accepted` and `badToken` even when the link has dropped since. The roster's two alerts carry `armed` as it was when the roster was made; the core sends a new roster whenever whether any sensor is armed changes. The announcement of a restart before a switch is the shell's alone (section 4): the core has no part in it.
- **`app`.** `hub.info`'s `relay` is `relayInUse(view)`; a link code's `r=` is `relayForLinkCode(view)`; the snapshot's `push` is `pushTargetState(view, client)`. The `commands` row of `push.register` must drop `key`, as `site.wifi`'s drops the password (M2 section 4).
- **`notify` (A6).** `relay_unreachable` must be raised for *manage system* and the console in `hub`; relay never pushes it. The presence offers' notification kinds are a guess until H1 defines them: `content.ts`'s `PRESENCE_OFFER_KINDS`, the one place to correct.
