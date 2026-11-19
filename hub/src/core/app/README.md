# `hub/src/core/app/`: owner A3

M2, step 1 (docs/m2-design.md section 11). App sessions, subscriptions, the live revision; request routing to the owners (`OP_OWNERS`, `opRequest`, `opAnswer`), permission checks, `seq` with stored replies; snapshot, events checked when made, `forget`.

`history.query` is yours too: you check the person and compute what they may see, then give the shell a `historyRead` effect with the query and that `HistoryFilter` (section 6). M1a's modules are reached with their own request messages, numbered from `APP_REQUEST_BASE` (2⁴⁰, section 2); `fileChunk` is the shell's.

Your slice and handler are yours; the messages they exchange are frozen.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A3` (the checks of `bun run check`, failing only for your folders).

## Channel version 2 (H1, docs/m3-m4-plan.md)

A session agrees version 1 or 2 (`Session.proto`); `app` makes every reply and event in the session's version, and a version 1 session gets exactly what it got before (`hub/test/unit/app/v1-frames.test.ts` replays frames recorded before version 2 was wired in).

| File | What |
| --- | --- |
| `versions.ts` | Objects by version: `hub.info`, device objects with `update`, notifications with `happenedAtMs`, the snapshot with `push` and `backupKeyEpoch`; the addresses apps are given (no link-local, IPv4 first, IPv6 shortest), which link codes use too (`hubFacts` view) |
| `v2-live.ts` | Events only version 2 names: `hub {relay}`, `hub {updateOffered}`, `deviceUpdate` |
| `presence.ts` | `presence.set` and the hub's rule for its two offers (`presence_offer_away`, `presence_offer_disarm`) |
| `updates.ts` | U8's device update and `deviceUpdate` frames |

Version 2's operations go to their owners as `v2OpRequest` (`firmware`, `relay`, `upkeep`, `setup`); `presence.set` is `app`'s own. Replies are made by version (`people/replies.ts`, `replyOf`), and kept so for a retry.
