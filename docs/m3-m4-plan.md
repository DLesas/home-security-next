# M3, M4 and M5: the joint order of work

Three designs are built together: the phone app and Bluetooth pairing ([m3-design.md](m3-design.md)), firmware updates and the key change after a restore ([m3-updates-design.md](m3-updates-design.md)), and the relay and push ([m4-design.md](m4-design.md)). Each design says what it builds and who owns which folder. This document says in what order, and settles what the three share. Where it and a design disagree on order, ownership or numbering, this document wins.

The rules of M2 still hold ([m2-design.md](m2-design.md) section 11): one owner per folder; a frozen interface changes only through the step 0 owner; every owner runs `bun run check:own <owner>` and the whole check before handing in; nobody commits.

## Rules for every engineer

1. **Your folders only.** You change only the folders your brief names. A frozen interface (anything step 0 wrote: `packages/protocol/`, `packages/deployment/`, `hub/src/core/model/`, `hub/src/core/step.ts`, `hub/src/db/`, `hub/src/ports/`, `hub/src/control-protocol/`, `firmware/core/include/`) changes only through the reviewer: start a line of your report with `FROZEN-CHANGE:` and give the exact change and why. If another owner's file must change for yours to compile, make the smallest change that keeps its behaviour identical and list it.
2. **Git.** No git command that changes anything: no add, commit, stash, checkout, restore, reset, branch. Reading with git is fine. If you need a file as it was, read it with `git show HEAD:<path>`.
3. **Code.** No `any` in TypeScript. Errors are `neverthrow` results; no `throw` and no `try` outside a `safe/` folder (`hub/src/shell/safe/`, and the same-named folder of a new workspace). The hub's core and the relay's core do no input or output. The firmware core has no heap, no exceptions and no floating point. Follow the header comments and the style of the files around yours.
4. **Dependencies and downloads.** Add no dependency, and download or install nothing, unless your brief names it. A new workspace may use packages at versions already in `bun.lock`.
5. **Tests.** Everything you add has tests that would fail if it were wrong: the reviewer changes your code on purpose and expects a test to fail. Do not weaken, skip or delete an existing test. Test a rule at its edges, not only its middle.
6. **Secrets.** Never print, log or record a device key, a link secret, a push key, a session key or a private key. Test keys are published test keys or made for the test.
7. **Privacy.** Never put the owner's name, e-mail or the project's name in a request to an outside service.
8. **Formatting.** Format only files you changed. Scratch files go in your own folder under the reviewer's scratchpad (your brief gives the path), never in the repository.
9. **Scripts.** Do not run a script you did not write, other than the repository's own `package.json` scripts and build tools.
10. **Questions.** Where the design is silent or contradicts itself on something you must decide: if `docs/m3-m4-plan.md` or the designs' text supports one reading, take it and list the point in your report. If nothing settles it and it matters, start your final message with `SPEC-QUESTION:` and stop. If you cannot proceed at all, `BLOCKED:`.
11. **Checks.** Before you report: the type check, lint and format check, your own tests by exact path, and then the whole `bun run check` once (and `bun run check:firmware` if you changed anything under `firmware/`; it takes about 17 minutes). Other engineers are working in the same checkout, so a failure outside your folders may be theirs: report it with its output and do not fix it.
12. **Report.** What you built, file by file in a line each; every file you touched outside your folders and why; the points where you had to choose; what you did not finish or could not prove; the check results with counts. State doubts plainly: a doubt you list costs nothing, one you hide is found in review.

## What the three designs share

| Shared thing | Rule |
| --- | --- |
| The app channel | One version 2, holding all three designs' additions except per-hub names. It stays open to additions until the first release, since nothing is in use before then (D119) |
| Database migrations | One sequence. Step 0 writes one migration, the next after M2's, with every table and column the three designs add except names |
| The core's module order | Step 0 places `firmware` before `sensors`, and `relay` after `people`, and records the final order in [hub-design.md](hub-design.md) section 2 |
| The product's name, domain and identifiers | One place: `packages/deployment/src/deployment.ts`. The URL scheme is `hsn` and never follows the product name |
| Decision numbers | D125 to D131 relay; D132 and D133 phone; D134 to D141 updates; D142 protection of what the operator runs; D143 no secure boot, flash encryption considered when the custom board is made |
| Error codes | Step 0 places every new refusal in M2's error-code scheme, the `firmware.bluetooth` refusals included |
| Release manifests | Both schemas (hub release, firmware release) live in `packages/protocol` |

## Step 0: frozen first

Three engineers, on folders that do not overlap, reviewed before anyone else starts. The wire formats are fixed by the designs, so the three can work at once; the C++ side is checked against the TypeScript side's vectors at the end.

| Step | Folders | What is frozen |
| --- | --- | --- |
| 0a, protocol and hub | `packages/deployment/`, `packages/protocol/` (all of it), `hub/src/core/model/`, `hub/src/core/step.ts`, `hub/src/db/`, `hub/src/ports/`, `hub/src/control-protocol/`, the new modules' folders as stubs (`hub/src/core/firmware/`, `hub/src/core/relay/`), `relay/` as an empty workspace with its internal interfaces | Each design's "part of the joint step 0" for protocol, hub model, app operations and the relay's internal interfaces: m4-design section 12, m3-updates-design section 10 items 1, 3 and 4, m3-design section 10 items 3 and 4. The two checks m4-design asks for (the Noise text on reusing a static key, with its section number; XN in the published vectors) |
| 0b, firmware | `firmware/core/include/`, the stubs in `firmware/core/src/` its interfaces need, `firmware/platform/host/` only where a new interface needs a fake to compile | m3-updates-design section 10 item 2, and the C++ codec's descriptors for the new messages and frames, passing 0a's vectors |
| 0c, app | `app/app.config.ts`, `app/src/platform/` (types and the split into `.native.ts` and `.web.ts`), the lint rule for web globals in `eslint.config.js`, `.gitignore` for `ios/` and `android/` | m3-design section 10 items 1, 2 and 6. Then, as the same engineer, the phone design's wave 0: the development builds start on the iOS simulator and the Android emulator and reach the real hub, reported in `docs/spikes/P0-phone-build.md` |

Beside step 0, on folders nobody else touches:

- **The documents.** The edits the three designs propose to `architecture.md`, `stack.md`, `protocol.md`, `firmware-design.md`, `hub-design.md`, `m2-design.md`, `app-design.md`, `build-plan.md` and `requirements/software.md` are applied once, with the numbers above.
- **Spike S5** (push on the simulators), in `spikes/s5-push/`: whether the iOS extension can raise a push to critical by itself, which decides between the relay design's uniform envelope and its envelope B.
- **The check of `node:http2` under Bun** against a stand-in for Apple's service, which decides whether the push role runs on Bun.

## Step 1: in parallel, after step 0 is reviewed

Owners are those the designs name, with these changes:

- **U8 and K1 are one owner** (called U8): the update parts and the key change touch the same four hub folders (`intake`, `sensors`, `sirens`, `gateways`).
- **The `backup.key` fix** is A8's, in `hub/src/core/upkeep/`.
- **The relay `Connect` and push registration** are P2's; the screens for relay status, offered updates and the test alert are P5's.
- **The board's Bluetooth** (`firmware/platform/esp-idf/bluetooth/`) has one owner, F1, for both the pairing service and the update service.

They start in three streams, so that no more than about six engineers are at work at once and each hand-in can be reviewed properly:

| Stream | First | Then |
| --- | --- | --- |
| Relay | B1 (XN, frames, sealing, vectors), B2 (the relay), B3 (push and stand-ins) | B5 and B6 (the hub's relay client), A6, A8, then B7 (integration tests, `bun run m4`) |
| Updates | U1, U2, U3 (firmware core, host fakes, crypto), U7, U9 (hub module and shell) | U4, U5, U6 (the roles), U8 (hub folders, with the key change), K2, then U10 (budget, crash and lockstep tests) |
| Phone | P2 (keys, records, finding the hub, restore), P5 (the shared UI's platform split and the phone's pages), H1 (the hub's additions), P6 (scripted Bluetooth boards) | P1 (`hub-net`, if wave 0 shows it is needed), P3 and P4 (pairing), then M5's pieces as the relay stream delivers what they need |

## Step 2: integration

The step 0 owner with each owner, as each design's integration section lists; then the three "done when" runs on this Mac: `bun run m4` (a local relay, the real hub, stand-ins for Apple and Google), the rollout and key-change lockstep tests, and the phone design's wave 1 and wave 2 criteria on both simulators.

## Step 3: what waits for something outside this Mac

| Waits for | Work |
| --- | --- |
| ESP-IDF installed (approved 2026-11-18, v6.1.1 under `~/esp/esp-idf`) | M1b's platform layer written and compiled for the ESP32-S3 (`firmware/platform/esp-idf/`), after 0b; m3-updates-design step 3a; the pairing vectors from ESP-IDF's sources (P3.2) |
| Development boards (not yet arrived) | M1b proven on the bench; m3-updates-design steps 3b, 3d and 3e; the phone design's wave 2b |
| An Android phone (in hand) and boards | Spike S9 on Android: pairing and the transfer's speed |
| An iPhone | S9 and S10 on iOS; critical alerts |
| The Apple account's steps, a Firebase project | Real push (m4-design section 14) |
| A product name and a domain | The app identifiers, Apple's critical-alert request, the operated relay's address, and per-hub names, which are built last |
| A host for the relay | The operated relay, to the requirement in m4-design section 3, "Layer 2" |

## Rulings made after the first hand-ins (2026-11-19)

These settle points the designs left open or got wrong, found when the pieces were built. Where a design or `protocol.md` says otherwise, this section wins until that text is corrected.

**Bluetooth advertising (pairing and updates).** The design's advertisement (a 128-bit service UUID, service data with the role and chip id, and the name) needs 62 bytes and does not fit Bluetooth's legacy advertising, and ESP-IDF's protocomm transport cannot carry service data at all: it advertises the flags and the 128-bit service UUID, with the name in the scan response. So the advertisement carries no service data:

| State | Advertisement | Scan response |
| --- | --- | --- |
| Pairing window open | flags, protocomm's 128-bit service UUID | the name `hsn-pair-` and 4 lower-case hex digits, the last two bytes of the chip id |
| Update window open | flags, the update service's 128-bit UUID | the name `hsn-` and the device address as 8 lower-case hex digits |

A phone finds boards by the service UUID. It learns a board's role, chip id and firmware version after connecting, from protocomm's `proto-ver` answer, before any code is asked for. A scanned pairing QR carries the chip id, so the phone picks the board whose name ends in that chip id's last four hex digits; with two such boards in range it connects to each and checks the chip id. No manufacturer data is used, so no Bluetooth company identifier is needed. The frozen `Advert` type and `protocol.md` section 10 change to this.

**The smallest Bluetooth packet for an update.** An update session needs an agreed MTU of at least 185 bytes ‡ (what an iPhone gives; an Android phone is asked for 517). The first message the board sends cannot fit the smallest MTU (23), and a piece of the image with its framing needs 149. Below 185 the board refuses the session before any transfer, with a reason of its own that the hub and the app can word ("This phone cannot update this sensor over Bluetooth"), and no request the board makes may ask for more than the agreed size carries. Pairing is not affected: protocomm uses long reads and writes and works at the smallest MTU.

**A wrong pairing code.** The board never sends its proof for a wrong code: it refuses the write, which the phone sees as an ATT error. The phone treats that, and a board proof that does not verify, as a wrong code.

**A pairing code that can never pair.** ESP-IDF v6.1.1's `esp_srp_gen_salt_verifier` shortens a salt whose first byte is zero and computes the verifier over 15 bytes, so about one code in 256 could never pair. The board makes its salt again until its first byte is not zero.

**A gateway on USB after a hub restart.** The hub's Identify on the USB link is the sign of a new hub process: a gateway that believes it has a session on that link ends it and says hello again with a new random.

**Push registrations and backups.** A backup does not hold phones' push targets or push keys (the relay design said it would). After a restore each phone registers again at its next session.

**Late alarms.** A notification raised late (at a restart, or for a late door report) carries the time the event happened (D102): `happenedAtMs` on the notification in channel version 2, `endedAtMs` or `openedAtMs` in a push's detail.

## Decided by the product owner for this work

- The relay and the phone work start now, beside what is left of M2 (2026-11-18).
- Everything the operator runs is protected against outsiders on the internet (D142). The home side stays as D124 has it.
- No secure boot. Flash encryption is to be considered when the custom board is made, and is not needed now (D143).
- An outside review of the encryption code is still open: a paid service, possible at any time before public release.
