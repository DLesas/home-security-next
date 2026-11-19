/**
 * `firmware.bluetooth` as a change (docs/m3-updates-design.md section 5, step 1; m2-design.md
 * section 5, "`seq` gives every change exactly one effect"), through the whole core: the step that
 * grants a session writes its `commands` row, leaves nothing pending and keeps for its `seq` a reply
 * with neither the session key nor the nonce; the shell alone sends the phone's reply. Asked again
 * while the session lives (a retry of that `seq`, a new `seq`, the console, another client), the
 * answer is that session: the same nonce, the time left, nothing done again. A retry once the
 * session has ended is `unavailable`, and never starts one. On the control line (`hsn`) the same:
 * recorded in its step, nothing left waiting, and the shell's reply the only one. Found by review: before, a grant was
 * never answered as a change, and its retry waited for ever.
 */
import { describe, expect, test } from "bun:test";
import { FIRMWARE_BLUETOOTH_REFUSALS } from "@hsn/protocol/app";
import { bluetoothSessionKey } from "@hsn/protocol/update";
import { type DurableSnapshot, EMPTY_M3M4_SNAPSHOT } from "../../../src/core/model/events.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import { type ConnId, connId, deviceId } from "../../../src/core/model/ids.ts";
import type { DeviceUpdateRow, RolloutRow } from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { mono } from "../../../src/core/model/time.ts";
import {
  ANNA_PHONE,
  BEN_LAPTOP,
  CONSOLE_CLIENT,
  commandRows,
  decisionsOf,
  entropy,
  writesTo,
} from "../people/support/hub.ts";
import { Disk, errorOf, framesTo, PhoneHub, replyTo, seededKey } from "../app/support/phone-hub.ts";
import { imageRow } from "./support.ts";

/**
 * The household's disk with one stored image, and the firmware rows the steps write (the rollout,
 * each device's update), so a restart starts again from exactly what was committed.
 */
class FirmwareDisk extends Disk {
  readonly rollouts = new Map<number, RolloutRow>();
  readonly updates = new Map<number, DeviceUpdateRow>();

  override apply(effects: readonly Effect[]): void {
    super.apply(effects);
    for (const e of effects) {
      if (e.kind !== "write" || e.op.op !== "upsert") continue;
      if (e.op.table === "rollouts") this.rollouts.set(e.op.row.id, e.op.row);
      if (e.op.table === "device_updates") this.updates.set(e.op.row.deviceId, e.op.row);
    }
  }

  override snapshot(): DurableSnapshot {
    return {
      ...super.snapshot(),
      m3m4: {
        ...EMPTY_M3M4_SNAPSHOT,
        firmwareImages: [imageRow()],
        rollouts: [...this.rollouts.values()],
        deviceUpdates: [...this.updates.values()],
      },
    };
  }
}

/** The household's siren, with its seeded key and address (`people/support/hub.ts`). */
const SIREN = 21;
const SIREN_ADDRESS = 0x1000 + SIREN;
const LIFE_MS = DEFAULT_RULES.firmware.bluetoothSessionMs;
const ASK = { op: "firmware.bluetooth", body: { device: SIREN } } as const;
/** The household's front sensor (`people/support/hub.ts`). */
const FRONT_SENSOR = 11;
const ASK_FRONT = { op: "firmware.bluetooth", body: { device: FRONT_SENSOR } } as const;

/** Entropy whose first 8 bytes, the nonce, are these: distinct from every other byte the test sees. */
const FIRST_BYTES = entropy([0xc3, 0x1f, 0x88, 0x07, 0x6e, 0xd2, 0x41, 0x9b]);
const OTHER_BYTES = entropy([0x27, 0xb4, 0x90, 0x5d, 0x0e, 0xa1, 0x7c, 0x36]);

function sessionsIn(effects: readonly Effect[]) {
  return effects.flatMap((e) => (e.kind === "bluetoothSession" ? [e] : []));
}

type Session = Extract<Effect, { readonly kind: "bluetoothSession" }>;

/** A session reply no step gave, so a missing one fails the comparisons after the check. */
const NO_SESSION: Session = {
  kind: "bluetoothSession",
  to: { kind: "app", conn: connId(0), id: 0 },
  device: deviceId(0),
  address: 0,
  nonce: new Uint8Array(0),
  reply: {
    device: 0,
    address: 0,
    imageId: "",
    version: "",
    fileBytes: 0,
    sha256: "",
    windowS: 0,
    expiresInMs: -1,
    needsWake: false,
  },
};

/** The one session reply in these effects. */
function sessionIn(effects: readonly Effect[]): Session {
  const all = sessionsIn(effects);
  expect(all).toHaveLength(1);
  return all[0] ?? NO_SESSION;
}

/** The control line's replies the core sends (`respond`), not the shell's. */
function responds(effects: readonly Effect[]) {
  return effects.filter((e) => e.kind === "respond");
}

/** The replies (`res`) sent on `conn` by `app`, not by the shell. */
function appReplies(effects: readonly Effect[], conn: ConnId) {
  return framesTo(effects, conn).filter((m) => "t" in m && m.t === "res");
}

/** Every way a secret's bytes could be written out in text, and the bytes themselves. */
function spellings(secret: Uint8Array): readonly Buffer[] {
  const bytes = Buffer.from(secret);
  return [
    bytes,
    Buffer.from(bytes.toString("hex")),
    Buffer.from(bytes.toString("hex").toUpperCase()),
    Buffer.from(bytes.toString("base64")),
    Buffer.from(bytes.toString("base64url")),
    Buffer.from([...bytes].join(",")),
  ];
}

/** Whether the serialised `bytes` hold the secret in any spelling. */
function holds(bytes: Uint8Array | string, secret: Uint8Array): boolean {
  const haystack = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  return spellings(secret).some((spelling) => haystack.includes(spelling));
}

/** The session key the shell derives for the siren from `nonce` (`shell/firmware/session.ts`). */
function keyOf(nonce: Uint8Array): Uint8Array {
  const key = bluetoothSessionKey(seededKey(SIREN), nonce, SIREN_ADDRESS);
  expect(key.ok).toBe(true);
  return key.ok ? key.value : new Uint8Array(32);
}

/** A hub whose rollout plans the siren, and Anna's phone granted a session for it. */
function granted() {
  const hub = new PhoneHub(new FirmwareDisk()).boot();
  const conn = hub.connect(ANNA_PHONE);
  hub.request(conn, ANNA_PHONE, { op: "rollout.start", body: { image: 1, devices: [SIREN] } });
  const asked = hub.request(conn, ANNA_PHONE, ASK, { bytes: FIRST_BYTES });
  const session = sessionIn(asked.effects);
  return { hub, conn, asked, session, seq: asked.seq ?? 0 };
}

/** The firmware module's session expiry timer for the siren, if set. */
function expiryAt(hub: PhoneHub) {
  return hub.state.firmware.timers.find((t) => t.key.kind === "sessionExpiry")?.at;
}

describe("the step that grants a session answers it as a change", () => {
  test("its commands row is written, nothing is left pending, and the shell alone sends the reply", () => {
    const { hub, conn, asked, session } = granted();
    expect(commandRows(asked.effects).map((c) => [c.row.kind, c.row.outcome])).toEqual([
      ["firmware.bluetooth", "ok"],
    ]);
    expect(hub.state.app.pending.size).toBe(0);
    expect(hub.state.app.waiting.size).toBe(0);
    expect(hub.state.people.replies.get(ANNA_PHONE)?.get(asked.seq ?? 0)?.kind).toBe("sent");
    // `app` sends nothing on the connection: the reply with the key is the shell's.
    expect(appReplies(asked.effects, conn)).toEqual([]);
    expect(session.to).toEqual({ kind: "app", conn, id: asked.id });
    expect(session.reply.expiresInMs).toBe(LIFE_MS);
  });

  test("the reply kept for its seq and its commands row hold neither the key nor the nonce", () => {
    const { hub, asked, session } = granted();
    const key = keyOf(session.nonce);
    const kept = writesTo(asked.effects, "client_replies").flatMap((op) =>
      op.op === "upsert" && op.table === "client_replies" ? [op.row.reply] : [],
    );
    expect(kept).toHaveLength(1);
    const command = JSON.stringify(commandRows(asked.effects));
    const inMemory = JSON.stringify(hub.state.people.replies.get(ANNA_PHONE)?.get(asked.seq ?? 0));
    for (const serialised of [...kept, command, inMemory]) {
      expect(holds(serialised, session.nonce)).toBe(false);
      expect(holds(serialised, key)).toBe(false);
    }
    // The search would have found them: the shell's reply carries the key, the effect the nonce.
    expect(holds(JSON.stringify({ sessionKey: Buffer.from(key).toString("base64url") }), key)).toBe(
      true,
    );
    expect(holds(Buffer.from(session.nonce).toString("hex"), session.nonce)).toBe(true);
    // What is kept: which device the session is for and when it ends, nothing more.
    expect(JSON.parse(new TextDecoder().decode(kept[0]))).toMatchObject({
      ok: true,
      body: { session: "granted", device: SIREN, expiresAtMs: hub.wall() + LIFE_MS },
    });
  });

  test("a refused one is kept and recorded as before", () => {
    const hub = new PhoneHub(new FirmwareDisk()).boot();
    const conn = hub.connect(ANNA_PHONE);
    const asked = hub.request(conn, ANNA_PHONE, ASK);
    expect(errorOf(replyTo(asked.effects, conn))).toEqual(FIRMWARE_BLUETOOTH_REFUSALS.noImage);
    expect(commandRows(asked.effects)).toHaveLength(1);
    expect(hub.state.app.pending.size).toBe(0);
  });
});

describe("a retry with the same seq", () => {
  test("after the reply was lost, while the session lives: the same session, the time left, nothing done again", () => {
    const { hub, seq, session } = granted();
    const at = expiryAt(hub);
    hub.advance(20_000);
    // The phone's link drops before the reply reaches it; the app sends the change again with
    // its `seq` on the next session (app/src/hub/channel.ts, `keepForRetry`).
    const other = hub.connect(ANNA_PHONE);
    const again = hub.request(other, ANNA_PHONE, ASK, { seq, bytes: OTHER_BYTES });
    const retried = sessionIn(again.effects);
    expect(retried.nonce).toEqual(session.nonce);
    expect(retried.to).toEqual({ kind: "app", conn: other, id: again.id });
    expect(retried.reply.expiresInMs).toBe(LIFE_MS - 20_000);
    expect({ ...retried.reply, expiresInMs: 0 }).toEqual({ ...session.reply, expiresInMs: 0 });
    // Nothing is done again: no row, no record, no kept reply changed, no timer, nothing pending.
    expect(again.effects.filter((e) => e.kind === "write" || e.kind === "record")).toEqual([]);
    expect(appReplies(again.effects, other)).toEqual([]);
    expect(expiryAt(hub)).toBe(at);
    expect(hub.state.app.pending.size).toBe(0);
  });

  test("once the session has ended: unavailable, and no session is started", () => {
    const { hub, seq } = granted();
    hub.advance(LIFE_MS);
    expect(hub.state.firmware.updates.get(deviceId(SIREN))?.row.bleNonce).toBeNull();
    const other = hub.connect(ANNA_PHONE);
    const again = hub.request(other, ANNA_PHONE, ASK, { seq, bytes: OTHER_BYTES });
    const reply = replyTo(again.effects, other);
    expect(errorOf(reply)).toEqual({ code: "unavailable", detail: {} });
    expect(sessionsIn(again.effects)).toEqual([]);
    expect(again.effects.filter((e) => e.kind === "write" || e.kind === "record")).toEqual([]);
    expect(expiryAt(hub)).toBeUndefined();
  });

  test("a millisecond before the end: the same session with 1 ms left; at the end: unavailable", () => {
    const before = granted();
    before.hub.advance(LIFE_MS - 1);
    const live = before.hub.connect(ANNA_PHONE);
    const kept = before.hub.request(live, ANNA_PHONE, ASK, { seq: before.seq });
    expect(sessionIn(kept.effects).reply.expiresInMs).toBe(1);

    const at = granted();
    at.hub.advance(LIFE_MS);
    const late = at.hub.connect(ANNA_PHONE);
    const over = at.hub.request(late, ANNA_PHONE, ASK, { seq: at.seq });
    expect(errorOf(replyTo(over.effects, late))).toMatchObject({ code: "unavailable" });
  });

  test("of a session that ended, after a new one was granted: unavailable, not the new one", () => {
    const { hub, conn, seq } = granted();
    hub.advance(LIFE_MS);
    const fresh = hub.request(conn, ANNA_PHONE, ASK, { bytes: OTHER_BYTES });
    expect(sessionsIn(fresh.effects)).toHaveLength(1);
    const other = hub.connect(ANNA_PHONE);
    const again = hub.request(other, ANNA_PHONE, ASK, { seq });
    expect(errorOf(replyTo(again.effects, other))).toMatchObject({ code: "unavailable" });
    expect(sessionsIn(again.effects)).toEqual([]);
  });

  test("after a restart, while the session lives: the same session; once it ended while off: unavailable", () => {
    const live = granted();
    const restarted = live.hub.restart();
    // The restart's boot arms the expiry for the time left (10 s passed while it was off).
    const conn = restarted.connect(ANNA_PHONE);
    const again = restarted.request(conn, ANNA_PHONE, ASK, { seq: live.seq });
    const retried = sessionIn(again.effects);
    expect(retried.nonce).toEqual(live.session.nonce);
    expect(retried.reply.expiresInMs).toBe(LIFE_MS - 10_000);

    const ended = granted();
    ended.hub.at = mono(ended.hub.at + LIFE_MS * 1000);
    const late = ended.hub.restart();
    const other = late.connect(ANNA_PHONE);
    const over = late.request(other, ANNA_PHONE, ASK, { seq: ended.seq });
    expect(errorOf(replyTo(over.effects, other))).toMatchObject({ code: "unavailable" });
    expect(sessionsIn(over.effects)).toEqual([]);
  });
});

describe("asked again with a new seq", () => {
  test("while the session lives: the same nonce, less time, a commands row, no second decision or timer", () => {
    const { hub, conn, session } = granted();
    const at = expiryAt(hub);
    hub.advance(60_000);
    const again = hub.request(conn, ANNA_PHONE, ASK, { bytes: OTHER_BYTES });
    const given = sessionIn(again.effects);
    expect(given.nonce).toEqual(session.nonce);
    expect(given.reply.expiresInMs).toBe(LIFE_MS - 60_000);
    expect(given.to).toEqual({ kind: "app", conn, id: again.id });
    expect(commandRows(again.effects).map((c) => c.row.outcome)).toEqual(["ok"]);
    expect(decisionsOf(again.effects).map((d) => d.row.kind)).toEqual([]);
    expect(writesTo(again.effects, "device_updates")).toEqual([]);
    expect(expiryAt(hub)).toBe(at);
    expect(hub.state.app.pending.size).toBe(0);
    expect(appReplies(again.effects, conn)).toEqual([]);
    // Its kept reply holds neither secret either.
    const kept = JSON.stringify(hub.state.people.replies.get(ANNA_PHONE)?.get(again.seq ?? 0));
    expect(holds(kept, session.nonce) || holds(kept, keyOf(session.nonce))).toBe(false);
  });

  test("after the session's expiry: a new session with a new nonce and the whole life", () => {
    const { hub, conn, session } = granted();
    hub.advance(LIFE_MS);
    const again = hub.request(conn, ANNA_PHONE, ASK, { bytes: OTHER_BYTES });
    const fresh = sessionIn(again.effects);
    expect(fresh.nonce).not.toEqual(session.nonce);
    expect(fresh.reply.expiresInMs).toBe(LIFE_MS);
    expect(decisionsOf(again.effects).map((d) => d.row.kind)).toContain("firmware_session_opened");
    expect(expiryAt(hub)).toBe(mono(hub.at + LIFE_MS * 1000));
  });

  test("from the console: the same session", () => {
    const { hub, session } = granted();
    const console = hub.connect(CONSOLE_CLIENT, 2, "console");
    const again = hub.request(console, CONSOLE_CLIENT, ASK, { bytes: OTHER_BYTES });
    const given = sessionIn(again.effects);
    expect(given.nonce).toEqual(session.nonce);
    expect(given.to).toEqual({ kind: "app", conn: console, id: again.id });
    expect(decisionsOf(again.effects)).toEqual([]);
    expect(commandRows(again.effects).map((c) => c.row.outcome)).toEqual(["ok"]);
    expect(hub.state.app.pending.size).toBe(0);
    expect(appReplies(again.effects, console)).toEqual([]);
  });

  test("from the control line (hsn): the same session, recorded, nothing pending, one reply", () => {
    const { hub, session } = granted();
    const again = hub.command({ kind: "op", operation: ASK }, OTHER_BYTES);
    const given = sessionIn(again);
    expect(given.nonce).toEqual(session.nonce);
    expect(given.to.kind).toBe("control");
    expect(responds(again)).toEqual([]);
    expect(commandRows(again).map((c) => c.row.outcome)).toEqual(["ok"]);
    expect(hub.state.control.pending.size).toBe(0);
    expect(decisionsOf(again).map((d) => d.row.kind)).toEqual([]);
  });

  test("from a second client: the same session", () => {
    const { hub, session } = granted();
    const laptop = hub.connect(BEN_LAPTOP);
    const again = hub.request(laptop, BEN_LAPTOP, ASK, { bytes: OTHER_BYTES });
    const given = sessionIn(again.effects);
    expect(given.nonce).toEqual(session.nonce);
    expect(given.to).toEqual({ kind: "app", conn: laptop, id: again.id });
    expect(commandRows(again.effects)).toHaveLength(1);
    expect(decisionsOf(again.effects)).toEqual([]);
  });
});

describe("the timer", () => {
  test("a grant's expiry is armed for the whole life, once", () => {
    const { hub } = granted();
    expect(hub.state.firmware.timers.filter((t) => t.key.kind === "sessionExpiry")).toHaveLength(1);
    expect(expiryAt(hub)).toBe(mono(hub.at + LIFE_MS * 1000));
  });
});

describe("a session granted on the control line (hsn, for the bench)", () => {
  /** A hub whose rollout plans the siren, started from the control line. */
  function planned() {
    const hub = new PhoneHub(new FirmwareDisk()).boot();
    hub.command({
      kind: "op",
      operation: { op: "rollout.start", body: { image: 1, devices: [SIREN] } },
    });
    return hub;
  }

  test("is recorded in its step, leaves nothing pending, and only the shell's reply goes back", () => {
    const hub = planned();
    const asked = hub.command({ kind: "op", operation: ASK }, FIRST_BYTES);
    const session = sessionIn(asked);
    // The one reply: the shell's, from this effect, to the request that asked.
    expect(session.to.kind).toBe("control");
    expect(responds(asked)).toEqual([]);
    const rows = commandRows(asked);
    expect(rows.map((c) => c.row.outcome)).toEqual(["ok"]);
    expect(hub.state.control.pending.size).toBe(0);
    // The row holds neither the key nor the nonce.
    const serialised = JSON.stringify(rows);
    expect(holds(serialised, session.nonce)).toBe(false);
    expect(holds(serialised, keyOf(session.nonce))).toBe(false);
    expect(decisionsOf(asked).map((d) => d.row.kind)).toContain("firmware_session_opened");
  });

  test("ten grants, each after the last one's life: ten rows, ten replies, nothing pending", () => {
    const hub = planned();
    const nonces = new Set<string>();
    for (let n = 0; n < 10; n++) {
      const asked = hub.command(
        { kind: "op", operation: ASK },
        entropy([n + 1, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]),
      );
      const session = sessionIn(asked);
      nonces.add(Buffer.from(session.nonce).toString("hex"));
      expect(responds(asked)).toEqual([]);
      expect(commandRows(asked)).toHaveLength(1);
      expect(hub.state.control.pending.size).toBe(0);
      hub.advance(LIFE_MS);
    }
    expect(nonces.size).toBe(10);
    expect(hub.state.control.pending.size).toBe(0);
  });

  test("a refusal is answered by control itself, once, as before", () => {
    const hub = new PhoneHub(new FirmwareDisk()).boot();
    const asked = hub.command({ kind: "op", operation: ASK });
    expect(responds(asked)).toHaveLength(1);
    expect(sessionsIn(asked)).toEqual([]);
    expect(commandRows(asked).map((c) => c.row.outcome)).toEqual(["opRefused"]);
    expect(hub.state.control.pending.size).toBe(0);
  });
});

describe("a retry whose seq was given a session for another device", () => {
  test("is not a live retry of the device it names, even when both sessions end at the same millisecond", () => {
    // Anna's `seq` N gave the siren a session; the front sensor is given one by Ben at the same
    // wall time, so both end at the same millisecond.
    const hub = new PhoneHub(new FirmwareDisk()).boot();
    const conn = hub.connect(ANNA_PHONE);
    hub.request(conn, ANNA_PHONE, {
      op: "rollout.start",
      body: { image: 1, devices: [SIREN, FRONT_SENSOR] },
    });
    const siren = hub.request(conn, ANNA_PHONE, ASK, { bytes: FIRST_BYTES });
    const laptop = hub.connect(BEN_LAPTOP);
    const front = hub.request(laptop, BEN_LAPTOP, ASK_FRONT, { bytes: OTHER_BYTES });
    expect(sessionsIn(front.effects)).toHaveLength(1);
    const expiries = [SIREN, FRONT_SENSOR].map(
      (d) => hub.state.firmware.updates.get(deviceId(d))?.row.bleExpiresMs,
    );
    expect(expiries[0]).toBe(expiries[1]);
    // `seq` N again, naming the sensor: no session (the sensor's is Ben's, never given to N).
    const other = hub.connect(ANNA_PHONE);
    const reused = hub.request(other, ANNA_PHONE, ASK_FRONT, { seq: siren.seq ?? 0 });
    expect(errorOf(replyTo(reused.effects, other))).toEqual({ code: "unavailable", detail: {} });
    expect(sessionsIn(reused.effects)).toEqual([]);
    // Nothing recorded or kept again, and nothing left waiting.
    expect(reused.effects.filter((e) => e.kind === "write" || e.kind === "record")).toEqual([]);
    expect(hub.state.app.pending.size).toBe(0);
    // `seq` N naming the siren is still its live retry.
    const right = hub.request(other, ANNA_PHONE, ASK, { seq: siren.seq ?? 0 });
    expect(sessionIn(right.effects).nonce).toEqual(sessionIn(siren.effects).nonce);
  });
});
