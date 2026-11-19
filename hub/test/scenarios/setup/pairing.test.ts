/**
 * Adding a device from a phone over Bluetooth, on the whole core (docs/m3-design.md section 5,
 * D133; H1): the phone's session of channel version 2 relays the board's Identity in
 * `pair.prepare`, hands the Provision the hub answers to the board, and relays its result in
 * `pair.finish`; the board, a siren keyed with what the Provision carried, then reports on its own
 * link and the hub hears it. The Bluetooth side is the phone's and the board's: here the board is
 * the frozen setup messages, as USB pairing has them.
 *
 * Also the crash tests the design asks for: a `pair.prepare` committed whose reply was lost,
 * retried with the same `seq` after a restart, gets the same address and key; one retried with a
 * new `seq` gets them too, as a USB retry does.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  decodeSetupMessage,
  encodeSetupMessage,
  type PairingData,
  ProvisionResultCode,
  Role,
  SetupType,
  toHex,
} from "@hsn/protocol";
import { APP_OPS_V2, PAIR_PREPARE_REFUSALS } from "@hsn/protocol/app";
import { linkId } from "../../../src/core/model/ids.ts";
import { DeviceState } from "../../../src/core/model/rows.ts";
import { ANNA_PHONE, CONSOLE_CLIENT, entropy } from "../../unit/people/support/hub.ts";
import { CHIP_A, CHIP_B, identityFrame } from "../../unit/setup/support/driver.ts";
import { expectNoKeyLeaks, noteEffects, noteKey } from "../../unit/setup/support/leak-guard.ts";
import {
  Disk,
  errorOf,
  eventsOn,
  okBody,
  PhoneHub,
  replyTo,
} from "../../unit/app/support/phone-hub.ts";
import { Siren } from "../sensors/whole/support.ts";

afterAll(() => {
  expectNoKeyLeaks();
});

/** A board's Identity setup message as hex, as the phone relays it. */
function identityHex(role: number, chip: Uint8Array, development = false): string {
  return toHex(identityFrame({ role, chipId: chip, development }));
}

function resultHex(result: number): string {
  return toHex(encodeSetupMessage({ type: SetupType.ProvisionResult, result }));
}

/** The Provision a `pair.prepare` reply carries, decoded as the board decodes it. */
function provisionOf(body: Record<string, unknown>): PairingData {
  const bytes = new Uint8Array(Buffer.from(String(body.provision), "base64url"));
  const decoded = decodeSetupMessage(bytes);
  if (!decoded.ok || decoded.value.type !== SetupType.Provision)
    return expect.unreachable("not a Provision");
  noteKey(decoded.value.pairing.key);
  return decoded.value.pairing;
}

/** Entropy for the step that draws an address and a key: the address first, then the key. */
const ADDRESS = [0x01, 0x00, 0x00, 0x7e];
const KEY = Array.from({ length: 16 }, (_, i) => 0xa0 + i);

function prepared(hub: PhoneHub, conn: ReturnType<PhoneHub["connect"]>, name = "porch") {
  const asked = hub.request(
    conn,
    ANNA_PHONE,
    { op: "pair.prepare", body: { identity: identityHex(Role.Siren, CHIP_A), name } },
    { bytes: entropy(ADDRESS, KEY) },
  );
  noteEffects(asked.effects);
  return asked;
}

describe("a siren added from a phone, through to its first report", () => {
  test("prepare writes the rows now and answers the Provision; finish pairs it; it is heard", () => {
    const hub = new PhoneHub().boot();
    const phone = hub.connect(ANNA_PHONE);
    hub.request(phone, ANNA_PHONE, { op: "subscribe", body: { topics: ["devices"] } });

    const asked = prepared(hub, phone);
    const reply = replyTo(asked.effects, phone);
    expect(APP_OPS_V2["pair.prepare"].reply.safeParse(okBody(reply)).success).toBe(true);
    const body = okBody(reply);
    const device = Number(body.device);
    const pairing = provisionOf(body);
    expect(pairing.address).toBe(0x7e000001);
    expect([...pairing.key]).toEqual(KEY);
    expect(toHex(pairing.wifiName)).toBe(toHex(new TextEncoder().encode("home")));
    expect(pairing.siteChannel).toBe(1);

    // Written now, in the step that answers: the row, its key and its resume point (HD 4).
    const now = asked.effects.flatMap((e) =>
      e.kind === "write" && e.durability === "now" ? [e.op.table] : [],
    );
    for (const table of ["devices", "device_keys", "send_counters", "siren_config"] as const)
      expect(now).toContain(table);
    expect(hub.device(device)?.state).toBe(DeviceState.Provisioning);
    expect(hub.device(device)?.name).toBe("porch");
    // Recorded as USB's is, on the phone's link label, the key and the password zeroed.
    const sent = asked.effects.flatMap((e) =>
      e.kind === "record" && e.record.kind === "hubEvent" && e.record.row.code === "usb_sent"
        ? [JSON.parse(e.record.row.detail ?? "{}") as Record<string, unknown>]
        : [],
    );
    expect(sent.map((s) => s.link)).toEqual([`bluetooth:${ANNA_PHONE}`]);
    expect(String(sent[0]?.bytes)).not.toContain(toHex(new Uint8Array(KEY)));

    const finished = hub.request(phone, ANNA_PHONE, {
      op: "pair.finish",
      body: { device, result: resultHex(ProvisionResultCode.Accepted) },
    });
    const finish = okBody(replyTo(finished.effects, phone));
    expect(APP_OPS_V2["pair.finish"].reply.safeParse(finish).success).toBe(true);
    expect(finish.device).toMatchObject({ id: device, state: "paired", update: null });
    expect(hub.device(device)?.state).toBe(DeviceState.Paired);

    // The board restarts as a siren and reports on its own Wi-Fi link: contacted.
    const siren = new Siren(
      hub.device(device)?.id ?? expect.unreachable(),
      pairing.address,
      "porch",
      pairing.key,
    );
    const link = linkId(77);
    hub.input({ kind: "linkOpened", link, linkKind: "network", label: "10.0.0.77" });
    const heard = hub.input({ kind: "frame", link, bytes: siren.report() });
    expect(hub.device(device)?.state).toBe(DeviceState.Contacted);
    const told = eventsOn(heard, phone).filter((e) => e.ev === "device");
    expect(told.map((e) => (e.body as { device: { state: string } }).device.state)).toEqual([
      "contacted",
    ]);
  });

  test("a refused Provision deletes the rows and answers no device", () => {
    const hub = new PhoneHub().boot();
    const phone = hub.connect(ANNA_PHONE);
    const device = Number(okBody(replyTo(prepared(hub, phone).effects, phone)).device);
    for (const result of [ProvisionResultCode.Refused]) {
      const finished = hub.request(phone, ANNA_PHONE, {
        op: "pair.finish",
        body: { device, result: resultHex(result) },
      });
      expect(okBody(replyTo(finished.effects, phone))).toEqual({ device: null });
    }
    expect(hub.device(device)).toBeUndefined();
    expect(hub.disk.rows.keys.has(device as never)).toBe(false);
  });

  test("a result that is not valid, too", () => {
    const hub = new PhoneHub().boot();
    const phone = hub.connect(ANNA_PHONE);
    const device = Number(okBody(replyTo(prepared(hub, phone).effects, phone)).device);
    const finished = hub.request(phone, ANNA_PHONE, {
      op: "pair.finish",
      body: { device, result: resultHex(ProvisionResultCode.NotValid) },
    });
    expect(okBody(replyTo(finished.effects, phone))).toEqual({ device: null });
    expect(hub.device(device)).toBeUndefined();
  });
});

describe("crash tests: a prepare committed and its reply lost", () => {
  test("retried with the same seq after a restart: the kept reply, the same address and key", () => {
    const disk = new Disk();
    const hub = new PhoneHub(disk).boot();
    const phone = hub.connect(ANNA_PHONE);
    const first = prepared(hub, phone);
    const lost = provisionOf(okBody(replyTo(first.effects, phone)));
    // The reply never reached the phone; the hub stops after the commit.
    const again = hub.restart();
    const conn = again.connect(ANNA_PHONE);
    again.setSeq(ANNA_PHONE, hub.seqOf(ANNA_PHONE));
    const retry = again.request(
      conn,
      ANNA_PHONE,
      { op: "pair.prepare", body: { identity: identityHex(Role.Siren, CHIP_A), name: "porch" } },
      { seq: first.seq ?? 0, bytes: entropy([9, 9, 9, 9], [8, 8, 8, 8]) },
    );
    const reply = replyTo(retry.effects, conn);
    expect(reply.repeat).toBe(true);
    const got = provisionOf(okBody(reply));
    expect(got.address).toBe(lost.address);
    expect(toHex(got.key)).toBe(toHex(lost.key));
    // Nothing done again.
    expect(retry.effects.filter((e) => e.kind === "write")).toEqual([]);
  });

  test("retried with a new seq after a restart: the same address and key, from the committed key", () => {
    const hub = new PhoneHub().boot();
    const phone = hub.connect(ANNA_PHONE);
    const lost = provisionOf(okBody(replyTo(prepared(hub, phone).effects, phone)));
    const again = hub.restart();
    const conn = again.connect(ANNA_PHONE);
    again.setSeq(ANNA_PHONE, hub.seqOf(ANNA_PHONE));
    const retry = again.request(
      conn,
      ANNA_PHONE,
      { op: "pair.prepare", body: { identity: identityHex(Role.Siren, CHIP_A), name: "porch" } },
      { bytes: entropy([9, 9, 9, 9], [8, 8, 8, 8]) },
    );
    noteEffects(retry.effects);
    const got = provisionOf(okBody(replyTo(retry.effects, conn)));
    expect(got.address).toBe(lost.address);
    expect(toHex(got.key)).toBe(toHex(lost.key));
    expect(
      [...again.state.registry.devices.values()].filter(
        (r) => r.state === DeviceState.Provisioning,
      ),
    ).toHaveLength(1);
  });
});

describe("pair.prepare's refusals (m3-design section 5)", () => {
  function ask(identity: string, name = "porch", hub = new PhoneHub().boot()) {
    const phone = hub.connect(ANNA_PHONE);
    return {
      hub,
      error: errorOf(
        replyTo(
          hub.request(phone, ANNA_PHONE, { op: "pair.prepare", body: { identity, name } }).effects,
          phone,
        ),
      ),
    };
  }

  test("a board paired to another hub", () => {
    const other = toHex(
      identityFrame({
        role: Role.Siren,
        chipId: CHIP_B,
        development: false,
        hubIdentity: new Uint8Array(8).fill(7),
      }),
    );
    expect(ask(other).error).toEqual(PAIR_PREPARE_REFUSALS.pairedElsewhere);
  });

  test("a development build paired elsewhere is taken, as over USB (HD 9)", () => {
    const dev = toHex(
      identityFrame({
        role: Role.Siren,
        chipId: CHIP_B,
        development: true,
        hubIdentity: new Uint8Array(8).fill(7),
      }),
    );
    expect(ask(dev).error).toBeUndefined();
  });

  test("a board already ours and in use", () => {
    const hub = new PhoneHub().boot();
    // The hall siren (device 21) has chip 0x15…, paired to this hub.
    const hall = hub.device(21) ?? expect.unreachable();
    const ours = toHex(
      identityFrame({
        role: Role.Siren,
        chipId: hall.chipId,
        development: false,
        hubIdentity: (hub.state.registry.hub ?? expect.unreachable()).identity,
      }),
    );
    expect(ask(ours, "porch", hub).error).toEqual(PAIR_PREPARE_REFUSALS.alreadyOurs);
  });

  test("not an Identity, or a role this hub does not know", () => {
    expect(
      ask(toHex(identityFrame({ role: 9, chipId: CHIP_B, development: false }))).error,
    ).toEqual(PAIR_PREPARE_REFUSALS.badIdentity);
    // An Identity cut short: the type byte right, the body not.
    expect(ask(`f102${"00".repeat(20)}`).error).toEqual(PAIR_PREPARE_REFUSALS.badIdentity);
  });

  test("a name taken, or not a name", () => {
    expect(ask(identityHex(Role.Siren, CHIP_B), "front").error).toEqual({
      code: "invalid",
      detail: { field: "name", reason: "taken" },
    });
    expect(ask(identityHex(Role.Siren, CHIP_B), "#3-x").error).toEqual({
      code: "invalid",
      detail: { field: "name", reason: "format" },
    });
  });

  test("no Wi-Fi: a siren and a gateway are refused, a sensor is not", () => {
    const noWifi = new Disk();
    noWifi.rows.site = {
      ...(noWifi.rows.site ?? expect.unreachable()),
      wifiName: new Uint8Array(),
    };
    const run = (role: number, chip: Uint8Array) =>
      ask(identityHex(role, chip), "x1", new PhoneHub(noWifi).boot()).error;
    expect(run(Role.Siren, CHIP_B)).toEqual(PAIR_PREPARE_REFUSALS.noWifi);
    expect(run(Role.Gateway, CHIP_B)).toEqual(PAIR_PREPARE_REFUSALS.noWifi);
    expect(run(Role.Sensor, CHIP_B)).toBeUndefined();
  });

  test("busy while the same board waits in a USB exchange", () => {
    const hub = new PhoneHub().boot();
    const usb = linkId(5);
    hub.input({ kind: "linkOpened", link: usb, linkKind: "usb", label: "/dev/ttyACM0" });
    hub.input({
      kind: "frame",
      link: usb,
      bytes: identityFrame({ role: Role.Gateway, chipId: CHIP_B, development: false }),
    });
    // An unpaired gateway on USB is added at once (D100): its Provision waits for an answer.
    expect(ask(identityHex(Role.Gateway, CHIP_B), "gw2", hub).error).toEqual(
      PAIR_PREPARE_REFUSALS.provisioning,
    );
  });

  test("manage system only; the console may", () => {
    const hub = new PhoneHub().boot();
    const consoleConn = hub.connect(CONSOLE_CLIENT, 2, "console");
    const reply = replyTo(
      hub.request(consoleConn, CONSOLE_CLIENT, {
        op: "pair.prepare",
        body: { identity: identityHex(Role.Sensor, CHIP_B), name: "x2" },
      }).effects,
      consoleConn,
    );
    expect(errorOf(reply)).toBeUndefined();
  });
});
