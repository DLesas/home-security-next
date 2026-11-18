/**
 * USB setup (hub-design.md section 9, "Adding a device over USB"; protocol.md §9 and §10; D100,
 * D103, D115, PR2, PR5, PR7): Identify, what an Identity means, the automatic add of a gateway,
 * Set role, provisioning with its address and key from the entropy, everything written now in
 * the step that sends Provision, the result, the retry with the same address and key, Erase for
 * development builds only, the key zeroed in every record, and the setup vectors byte for byte.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  decodeSetupMessage,
  encodePairingData,
  encodeSetupMessage,
  ProvisionResultCode,
  SetupType,
  toHex,
} from "@hsn/protocol";
import { deviceId, connId } from "../../../src/core/model/ids.ts";
import { DeviceState } from "../../../src/core/model/rows.ts";
import { MAX_ADDRESS_DRAWS } from "../../../src/core/setup/provision.ts";
import { PAIRING_RESUME_POINT } from "../../../src/core/setup/handle.ts";
import {
  CHIP_A,
  CHIP_B,
  deviceNamed,
  devicesOf,
  Driver,
  entropy,
  errorCode,
  hubEvents,
  HUB_IDENTITY,
  identityFrame,
  KEY_ONE,
  le32,
  nowWrites,
  onlyReply,
  OTHER_HUB_IDENTITY,
  replies,
  resultFrame,
  Role,
  SECOND,
  sends,
  siteRow,
  snapshot,
  writes,
  unconfirmedSensor,
} from "./support/driver.ts";
import { expectNoKeyLeaks, guardCounts, noteKey } from "./support/leak-guard.ts";
import { pairingCases, setupBytesNamed, setupCases } from "./support/vectors.ts";

afterAll(() => {
  expect(guardCounts().keys).toBeGreaterThan(0);
  expectNoKeyLeaks();
});

const PORT = "/dev/cu.usbmodem1";
const ADDRESS = 0x11223344;

/** A booted hub with a board on USB that has sent its Identity. */
function withBoard(
  board: Parameters<typeof identityFrame>[0],
  from = snapshot(),
): { readonly hub: Driver; readonly link: ReturnType<Driver["openUsb"]>["link"] } {
  const hub = new Driver();
  hub.boot(from);
  const { link } = hub.openUsb(PORT);
  hub.frame(link, identityFrame(board));
  return { hub, link };
}

const devSensor = { role: Role.Sensor, chipId: CHIP_B, development: true } as const;

function addSensor(hub: Driver, name = "front", bytes?: Uint8Array) {
  return hub.command({ kind: "usbAdd", port: PORT, name }, bytes);
}

/** The Provision message a step sent, decoded. */
function provisionIn(effects: Parameters<typeof sends>[0]) {
  const frames = sends(effects).map((s) => decodeSetupMessage(s.bytes));
  for (const frame of frames) {
    if (frame.ok && frame.value.type === SetupType.Provision) return frame.value.pairing;
  }
  return undefined;
}

describe("Identify and Identity (§10)", () => {
  test("a new USB link is sent Identify, exactly the vector's bytes, with no counter", () => {
    const hub = new Driver();
    hub.boot();
    const { effects } = hub.openUsb(PORT);
    const [send] = sends(effects);
    expect(send?.bytes).toEqual(setupBytesNamed("identify"));
    expect(send?.counters).toEqual([]);
  });

  test("a network link is not sent Identify", () => {
    const hub = new Driver();
    hub.boot();
    const effects = hub.input({
      kind: "linkOpened",
      link: deviceId(9) as never,
      linkKind: "network",
      label: "10.0.0.2",
    });
    expect(sends(effects)).toEqual([]);
  });

  test("each vector Identity is kept, recorded routine, and shown by usb list with what it means", () => {
    for (const vector of setupCases().valid.filter((c) => c.setupType === SetupType.Identity)) {
      const hub = new Driver();
      hub.boot();
      const { link } = hub.openUsb(PORT);
      const effects = hub.frame(link, vector.bytes);
      const decoded = decodeSetupMessage(vector.bytes);
      if (!decoded.ok || decoded.value.type !== SetupType.Identity) continue;
      const identity = decoded.value;
      const recorded = hubEvents(effects).find((e) => e.row.code === "usb_identity");
      expect(recorded?.durability).toBe(
        identity.role === Role.Gateway && !identity.paired ? "routine" : "routine",
      );
      // Every field a field (section 6): the link, the board's identity, nothing to parse.
      const v = identity.firmwareVersion;
      expect(JSON.parse(recorded?.row.detail ?? "{}")).toEqual({
        link: PORT,
        role: ["sensor", "siren", "gateway"][identity.role - 1] ?? String(identity.role),
        chip: toHex(identity.chipId),
        firmware: v.major * 65_536 + v.minor * 256 + v.patch,
        paired: identity.paired
          ? (expect.stringMatching(/^(ours|elsewhere)$/) as unknown)
          : "unpaired",
        hubIdentity: identity.paired ? toHex(identity.hubIdentity) : null,
        development: identity.developmentBuild,
      });
      const reply = onlyReply(hub.command({ kind: "usbList" }).effects);
      expect(reply).toEqual({
        ok: true,
        result: {
          kind: "usbList",
          ports: [
            {
              port: PORT,
              identity: {
                role: identity.role,
                chipId: toHex(identity.chipId),
                firmware: `${identity.firmwareVersion.major}.${identity.firmwareVersion.minor}.${identity.firmwareVersion.patch}`,
                paired: identity.paired,
                ours: identity.paired && toHex(identity.hubIdentity) === toHex(HUB_IDENTITY),
                hubIdentity: identity.paired ? toHex(identity.hubIdentity) : null,
                development: identity.developmentBuild,
              },
            },
          ],
        },
      });
    }
  });

  test("the hub identity bytes of an unpaired Identity are ignored (§10)", () => {
    const hub = new Driver();
    hub.boot();
    const { link } = hub.openUsb(PORT);
    const bytes = identityFrame({ role: Role.Sensor, chipId: CHIP_B, development: false });
    bytes.set(HUB_IDENTITY, 2 + 1 + 6 + 3 + 1); // garbage where "paired" is 0
    hub.frame(link, bytes);
    const reply = onlyReply(hub.command({ kind: "usbList" }).effects);
    expect(
      reply.ok && reply.result.kind === "usbList" ? reply.result.ports[0]?.identity : undefined,
    ).toMatchObject({
      paired: false,
      ours: false,
      hubIdentity: null,
    });
  });

  test("an Identity that does not decode is counted as a rejection, with its reason", () => {
    for (const vector of setupCases().invalid.filter((c) => c.bytes[0] === 0xf1)) {
      const hub = new Driver();
      hub.boot();
      const { link } = hub.openUsb(PORT);
      const effects = hub.frame(link, vector.bytes);
      const rejects = effects.flatMap((e) =>
        e.kind === "record" && e.record.kind === "reject" ? [e.record.row] : [],
      );
      expect(rejects.map((r) => r.reason)).toEqual([vector.error as never]);
      expect(rejects[0]?.sample).toEqual(vector.bytes.slice(0, 16));
      expect(sends(effects)).toEqual([]);
    }
  });

  test("setup messages that travel from the hub only are refused when a board sends them", () => {
    for (const name of ["identify", "erase", "set role 1", "provision"]) {
      const hub = new Driver();
      hub.boot();
      const { link } = hub.openUsb(PORT);
      const effects = hub.frame(link, setupBytesNamed(name));
      const reasons = effects.flatMap((e) =>
        e.kind === "record" && e.record.kind === "reject" ? [e.record.row.reason] : [],
      );
      expect(reasons).toEqual(["wrongDirection"]);
    }
  });

  test("a setup frame from a link that is not a USB board is refused as on the wrong path", () => {
    const hub = new Driver();
    hub.boot();
    const effects = hub.frame(deviceId(7) as never, identityFrame(devSensor));
    const reasons = effects.flatMap((e) =>
      e.kind === "record" && e.record.kind === "reject" ? [e.record.row.reason] : [],
    );
    expect(reasons).toEqual(["wrongPath"]);
  });
});

describe("the automatic add of a gateway (D100, PR7)", () => {
  for (const development of [false, true]) {
    test(`an unpaired ${development ? "development" : "release"} gateway is added at once as gateway-<chip>`, () => {
      const hub = new Driver();
      hub.boot();
      const { link } = hub.openUsb(PORT);
      const effects = hub.frame(
        link,
        identityFrame({ role: Role.Gateway, chipId: CHIP_A, development }),
      );
      const row = deviceNamed(hub.state, `gateway-${toHex(CHIP_A)}`);
      expect(row?.state).toBe(DeviceState.Provisioning);
      expect(row?.role).toBe(Role.Gateway);
      const ops = nowWrites(effects);
      expect(ops.map((op) => op.table).toSorted()).toEqual([
        "device_keys",
        "devices",
        "send_counters",
      ]);
      expect(provisionIn(effects)?.address).toBe(ADDRESS);
      const added = hubEvents(effects).find(
        (e) => e.row.code === "usb_sent" && e.row.message.startsWith("Provision"),
      );
      expect(added?.durability).toBe("now");
      expect(replies(effects)).toEqual([]);
    });
  }

  const leftAlone = [
    [
      "a gateway paired to another hub",
      { role: Role.Gateway, chipId: CHIP_A, development: false, hubIdentity: OTHER_HUB_IDENTITY },
    ],
    [
      "a gateway already paired to this hub",
      { role: Role.Gateway, chipId: CHIP_A, development: false, hubIdentity: HUB_IDENTITY },
    ],
    ["an unpaired sensor", { role: Role.Sensor, chipId: CHIP_A, development: false }],
    ["an unpaired siren", { role: Role.Siren, chipId: CHIP_A, development: true }],
    ["a board with no role", { role: 0, chipId: CHIP_A, development: true }],
    ["a board of an unlisted role", { role: 9, chipId: CHIP_A, development: true }],
  ] as const;
  for (const [what, board] of leftAlone) {
    test(`${what} is left alone`, () => {
      const { hub } = withBoard(board);
      expect(sends(hub.all).filter((s) => s.bytes[1] !== SetupType.Identify)).toEqual([]);
      expect(devicesOf(hub.state)).toEqual([]);
    });
  }

  test("an automatic add that cannot go ahead is a warning, not an answer", () => {
    const { hub } = withBoard(
      { role: Role.Gateway, chipId: CHIP_A, development: false },
      snapshot({ hubKeys: undefined }),
    );
    const warning = hubEvents(hub.all).find((e) => e.row.code === "automatic_add_failed");
    expect(warning?.durability).toBe("now");
    expect(devicesOf(hub.state)).toEqual([]);
  });

  test("a gateway's automatic add is retried from its next Identity with the same address and key", () => {
    const { hub, link } = withBoard({ role: Role.Gateway, chipId: CHIP_A, development: false });
    const first = provisionIn(hub.all);
    hub.advance(5_000);
    const again = hub.frame(
      link,
      identityFrame({ role: Role.Gateway, chipId: CHIP_A, development: false }),
      entropy(le32(0x55667788), new Uint8Array(16).fill(0x99)),
    );
    expect(provisionIn(again)).toEqual(first);
    expect(writes(again).filter((op) => op.table === "devices")).toEqual([]);
  });
});

describe("provisioning (section 9, PR2, PR5, HB17)", () => {
  test("the address and key come from the input's entropy, and every row is written now in the step that sends Provision", () => {
    const { hub } = withBoard(devSensor);
    const { effects } = addSensor(hub);
    const pairing = provisionIn(effects);
    expect(pairing?.address).toBe(ADDRESS);
    expect(pairing?.key).toEqual(KEY_ONE);
    const ops = nowWrites(effects);
    const row = ops.find((op) => op.table === "devices" && op.op === "upsert");
    expect(row?.op === "upsert" ? row.row : undefined).toMatchObject({
      address: ADDRESS,
      role: Role.Sensor,
      name: "front",
      chipId: CHIP_B,
      firmware: 0x010203,
      development: true,
      state: DeviceState.Provisioning,
    });
    expect(ops).toContainEqual({
      table: "device_keys",
      op: "upsert",
      row: { deviceId: deviceId(1), key: KEY_ONE, nextKey: null, rekey: 0 },
    });
    expect(ops).toContainEqual({
      table: "send_counters",
      op: "upsert",
      row: { deviceId: deviceId(1), resumePoint: PAIRING_RESUME_POINT },
    });
    // Nothing routine stands in for a row the Provision depends on.
    expect(writes(effects).length).toBe(ops.length);
    expect(replies(effects)).toEqual([]);
  });

  test("every canonical pairing vector is produced byte for byte, and opens back to its fields", () => {
    for (const vector of pairingCases().filter((c) => c.canonical)) {
      const site = siteRow({
        channel: vector.siteChannel,
        rateMask: vector.rateMask,
        wifiName: vector.wifiName,
        wifiPassword: vector.wifiPassword,
      });
      const from = snapshot({
        hubKeys: { signingPublic: vector.signingKey, identity: vector.hubIdentity },
        site,
      });
      const { hub } = withBoard(devSensor, from);
      noteKey(vector.key);
      const { effects } = addSensor(hub, "front", entropy(le32(vector.address), vector.key));
      const provision = sends(effects).find((s) => s.bytes[1] === SetupType.Provision);
      expect(provision === undefined ? "" : toHex(provision.bytes)).toBe(
        `f103${toHex(vector.bytes)}`,
      );
      const opened = provision === undefined ? undefined : decodeSetupMessage(provision.bytes);
      expect(
        opened?.ok === true && opened.value.type === SetupType.Provision
          ? opened.value.pairing
          : undefined,
      ).toEqual({
        address: vector.address,
        key: vector.key,
        hubIdentity: vector.hubIdentity,
        firmwareSigningKey: vector.signingKey,
        siteChannel: vector.siteChannel,
        allowedDataRateMask: vector.rateMask,
        wifiName: vector.wifiName,
        wifiPassword: vector.wifiPassword,
      });
    }
  });

  test("the setup-messages provision case is the frame sent for its pairing", () => {
    const vector = pairingCases().find((c) => c.name === "sensor pairing");
    if (vector === undefined) return;
    const { hub } = withBoard(
      devSensor,
      snapshot({ site: siteRow({ rateMask: vector.rateMask }) }),
    );
    const { effects } = addSensor(hub, "front", entropy(le32(vector.address), vector.key));
    expect(sends(effects).find((s) => s.bytes[1] === SetupType.Provision)?.bytes).toEqual(
      setupBytesNamed("provision"),
    );
  });

  test("the Provision is recorded with its key and Wi-Fi password zeroed, and nothing else changed", () => {
    const { hub } = withBoard(devSensor);
    const { effects } = addSensor(hub);
    const pairing = provisionIn(effects);
    const recorded = hubEvents(effects).find(
      (e) => e.row.code === "usb_sent" && e.row.message.startsWith("Provision"),
    );
    if (pairing === undefined) return;
    const zeroed = encodeSetupMessage({
      type: SetupType.Provision,
      pairing: {
        ...pairing,
        key: new Uint8Array(16),
        wifiPassword: new Uint8Array(pairing.wifiPassword.length),
      },
    });
    // The record's fields: the link, the message, its bytes as sent with the secrets zeroed.
    const fields = JSON.parse(recorded?.row.detail ?? "{}") as Record<string, unknown>;
    expect(fields).toEqual({
      link: "/dev/cu.usbmodem1",
      message: "Provision",
      bytes: toHex(zeroed),
      address: pairing.address,
    });
    expect(recorded?.row.detail?.includes(toHex(KEY_ONE))).toBe(false);
  });

  test("accepted: paired, written now, and the CLI's answer comes in the same step", () => {
    const { hub, link } = withBoard(devSensor);
    addSensor(hub);
    const effects = hub.frame(link, resultFrame(ProvisionResultCode.Accepted));
    expect(deviceNamed(hub.state, "front")?.state).toBe(DeviceState.Paired);
    expect(nowWrites(effects).filter((op) => op.table === "devices")).toHaveLength(1);
    expect(onlyReply(effects)).toEqual({
      ok: true,
      result: {
        kind: "usbAdd",
        device: deviceNamed(hub.state, "front")?.id ?? 0,
        name: "front",
        role: "sensor",
        address: ADDRESS,
        chip: toHex(deviceNamed(hub.state, "front")?.chipId ?? new Uint8Array()),
      },
    });
    expect(hub.state.setup.retryKeys.size).toBe(0);
  });

  for (const [result, name] of [
    [ProvisionResultCode.Refused, "refused"],
    [ProvisionResultCode.NotValid, "not valid"],
  ] as const) {
    test(`${name}: the rows are deleted, now, and the CLI is told why`, () => {
      const { hub, link } = withBoard(devSensor);
      addSensor(hub);
      const effects = hub.frame(link, resultFrame(result));
      expect(deviceNamed(hub.state, "front")).toBeUndefined();
      expect(
        nowWrites(effects)
          .map((op) => `${op.table} ${op.op}`)
          .toSorted(),
      ).toEqual(["device_keys delete", "devices delete", "send_counters delete"]);
      expect(errorCode(onlyReply(effects))).toBe("boardRefused");
      expect(hub.state.setup.retryKeys.size).toBe(0);
    });
  }

  test("a refusal from a board that says it is paired to this hub keeps the rows: it may hold the key (PR2)", () => {
    const { hub, link } = withBoard(devSensor);
    addSensor(hub);
    hub.advance(5_000);
    // The board took the pairing, but its answer was lost: it now says it is ours.
    hub.frame(link, identityFrame({ ...devSensor, hubIdentity: HUB_IDENTITY }));
    addSensor(hub);
    const effects = hub.frame(link, resultFrame(ProvisionResultCode.Refused));
    expect(errorCode(onlyReply(effects))).toBe("boardRefused");
    expect(deviceNamed(hub.state, "front")?.state).toBe(DeviceState.Provisioning);
    expect(writes(effects)).toEqual([]);
    expect(hub.state.setup.retryKeys.size).toBe(1);
  });

  test("an unlisted result keeps the device provisioning: the board may have stored the key", () => {
    const { hub, link } = withBoard(devSensor);
    addSensor(hub);
    const effects = hub.frame(
      link,
      setupBytesNamed("provision result with unlisted value 3, which passes through"),
    );
    expect(deviceNamed(hub.state, "front")?.state).toBe(DeviceState.Provisioning);
    expect(writes(effects)).toEqual([]);
    expect(errorCode(onlyReply(effects))).toBe("noAnswer");
  });

  test("no answer in 5 s: the CLI is told to retry at exactly 5 s, and the device stays provisioning", () => {
    const { hub } = withBoard(devSensor);
    addSensor(hub);
    expect(replies(hub.advance(4_999))).toEqual([]);
    const effects = hub.advance(1);
    expect(errorCode(onlyReply(effects))).toBe("noAnswer");
    expect(deviceNamed(hub.state, "front")?.state).toBe(DeviceState.Provisioning);
    expect(writes(effects)).toEqual([]);
  });

  test("a retry sends the same address and key, writes nothing new, and draws no entropy", () => {
    const { hub, link } = withBoard(devSensor);
    const first = provisionIn(addSensor(hub).effects);
    hub.advance(5_000);
    const retry = addSensor(hub, "front", entropy(le32(0x55667788), new Uint8Array(16).fill(0x77)));
    expect(provisionIn(retry.effects)).toEqual(first);
    expect(writes(retry.effects)).toEqual([]);
    const accepted = hub.frame(link, resultFrame(ProvisionResultCode.Accepted));
    expect(errorCode(onlyReply(accepted))).toBe("ok");
  });

  test("a retry must name the device it continues", () => {
    const { hub } = withBoard(devSensor);
    addSensor(hub);
    hub.advance(5_000);
    expect(errorCode(onlyReply(addSensor(hub, "back").effects))).toBe("nameTaken");
  });

  test("a late result after the timeout still pairs, without a second answer", () => {
    const { hub, link } = withBoard(devSensor);
    addSensor(hub);
    hub.advance(5_000);
    const effects = hub.frame(link, resultFrame(ProvisionResultCode.Accepted));
    expect(deviceNamed(hub.state, "front")?.state).toBe(DeviceState.Paired);
    expect(replies(effects)).toEqual([]);
  });

  test("the link closing before the answer tells the CLI; the device stays provisioning", () => {
    const { hub, link } = withBoard(devSensor);
    addSensor(hub);
    const effects = hub.input({ kind: "linkClosed", link, reason: "remote" });
    expect(errorCode(onlyReply(effects))).toBe("noAnswer");
    expect(deviceNamed(hub.state, "front")?.state).toBe(DeviceState.Provisioning);
    expect(hub.state.setup.timers).toEqual([]);
  });

  test("a Provision result with no Provision waiting is a warning and changes nothing", () => {
    const { hub, link } = withBoard(devSensor);
    const effects = hub.frame(link, resultFrame(ProvisionResultCode.Accepted));
    expect(hubEvents(effects).map((e) => e.row.code)).toEqual(["usb_unexpected"]);
    expect(writes(effects)).toEqual([]);
  });

  test("a second add on a board in an exchange is refused until it ends", () => {
    const { hub } = withBoard(devSensor);
    addSensor(hub);
    expect(errorCode(onlyReply(addSensor(hub).effects))).toBe("failed");
  });
});

describe("the address draw (section 9, §3)", () => {
  const cases = [
    ["0", 0],
    ["0xFFFFFFFF", 0xffffffff],
  ] as const;
  for (const [what, bad] of cases) {
    test(`a draw of ${what} takes the next 4 bytes, and the key follows the draw that was kept`, () => {
      const { hub } = withBoard(devSensor);
      const pairing = provisionIn(
        addSensor(hub, "front", entropy(le32(bad), le32(ADDRESS), KEY_ONE)).effects,
      );
      expect(pairing?.address).toBe(ADDRESS);
      expect(pairing?.key).toEqual(KEY_ONE);
    });
  }

  test("a draw that collides with an address in use, even a removed device's, takes the next", () => {
    const removed = {
      id: deviceId(4),
      address: ADDRESS,
      role: Role.Sensor,
      name: "#4-old",
      chipId: CHIP_A,
      firmware: 0,
      development: true,
      state: DeviceState.Removed,
      addedMs: 0,
      removedMs: 1,
    };
    const { hub } = withBoard(devSensor, snapshot({ devices: [removed] }));
    const pairing = provisionIn(
      addSensor(hub, "front", entropy(le32(ADDRESS), le32(0x0a0b0c0d), KEY_ONE)).effects,
    );
    expect(pairing?.address).toBe(0x0a0b0c0d);
    expect(deviceNamed(hub.state, "front")?.id).toBe(deviceId(5));
  });

  test(`${MAX_ADDRESS_DRAWS} unusable draws are a fault, and nothing is written or sent`, () => {
    const { hub } = withBoard(devSensor);
    const before = hub.state;
    const result = hub.try(
      {
        kind: "command",
        conn: connId(0),
        request: 1 as never,
        actor: "tester",
        command: { kind: "usbAdd", port: PORT, name: "front" },
      },
      entropy(le32(0), le32(0xffffffff), le32(0), le32(ADDRESS)),
    );
    expect(result.isErr()).toBe(true);
    expect(hub.state).toBe(before);
  });

  test("a step's add takes at most 28 bytes of the input's 32 (section 2)", () => {
    const { hub } = withBoard(devSensor);
    const bytes = entropy(le32(0), le32(0), le32(ADDRESS), KEY_ONE);
    expect(provisionIn(addSensor(hub, "front", bytes).effects)?.address).toBe(ADDRESS);
    expect(MAX_ADDRESS_DRAWS * 4 + 16).toBe(28);
  });
});

describe("who may be provisioned (section 9, §10)", () => {
  test("a release board paired to another hub is refused, and nothing is written", () => {
    const { hub } = withBoard({
      role: Role.Sensor,
      chipId: CHIP_B,
      development: false,
      hubIdentity: OTHER_HUB_IDENTITY,
    });
    const { effects } = addSensor(hub);
    expect(errorCode(onlyReply(effects))).toBe("boardRefused");
    expect(writes(effects)).toEqual([]);
    expect(sends(effects)).toEqual([]);
  });

  test("a development board paired to another hub is provisioned (PR5)", () => {
    const { hub } = withBoard({
      role: Role.Sensor,
      chipId: CHIP_B,
      development: true,
      hubIdentity: OTHER_HUB_IDENTITY,
    });
    expect(provisionIn(addSensor(hub).effects)?.address).toBe(ADDRESS);
  });

  test("a board already ours is refused, naming the device", () => {
    const paired = {
      id: deviceId(2),
      address: 5,
      role: Role.Sensor,
      name: "front",
      chipId: CHIP_B,
      firmware: 0,
      development: true,
      state: DeviceState.Contacted,
      addedMs: 0,
      removedMs: null,
    };
    const { hub } = withBoard(
      { ...devSensor, hubIdentity: HUB_IDENTITY },
      snapshot({ devices: [paired] }),
    );
    const reply = onlyReply(addSensor(hub, "other").effects);
    expect(errorCode(reply)).toBe("boardRefused");
    expect(reply.ok ? "" : reply.error.message).toContain("front");
  });

  test("a release sensor that refuses: the rows go and the CLI hears why", () => {
    const { hub, link } = withBoard({ role: Role.Sensor, chipId: CHIP_B, development: false });
    addSensor(hub);
    const effects = hub.frame(link, resultFrame(ProvisionResultCode.Refused));
    expect(errorCode(onlyReply(effects))).toBe("boardRefused");
    expect(devicesOf(hub.state)).toEqual([]);
  });

  test("a name that is taken or breaks the rule is refused before anything is drawn", () => {
    const named = {
      id: deviceId(2),
      address: 5,
      role: Role.Sensor,
      name: "front",
      chipId: CHIP_A,
      firmware: 0,
      development: true,
      state: DeviceState.Paired,
      addedMs: 0,
      removedMs: null,
    };
    const { hub } = withBoard(devSensor, snapshot({ devices: [named] }));
    expect(errorCode(onlyReply(addSensor(hub, "front").effects))).toBe("nameTaken");
    expect(errorCode(onlyReply(addSensor(hub, "#front").effects))).toBe("badRequest");
    expect(errorCode(onlyReply(addSensor(hub, "fr\u0007ont").effects))).toBe("badRequest");
  });

  test("an unknown port, or a board with no Identity yet, is refused; the latter is asked again", () => {
    const hub = new Driver();
    hub.boot();
    expect(errorCode(onlyReply(addSensor(hub).effects))).toBe("unknownPort");
    hub.openUsb(PORT);
    const { effects } = addSensor(hub);
    expect(errorCode(onlyReply(effects))).toBe("unknownPort");
    expect(sends(effects).map((s) => toHex(s.bytes))).toEqual(["f101"]);
  });

  test("with no signing key the hub cannot pair", () => {
    const { hub } = withBoard(devSensor, snapshot({ hubKeys: undefined }));
    expect(errorCode(onlyReply(addSensor(hub).effects))).toBe("failed");
  });
});

describe("the site's part of the pairing (section 8, PR2, D115)", () => {
  test("a sensor or siren is not paired before the site has a channel; a gateway is, on 868.3", () => {
    const from = snapshot({ site: siteRow({ channel: null }) });
    const sensor = withBoard(devSensor, from).hub;
    const reply = onlyReply(addSensor(sensor).effects);
    expect(errorCode(reply)).toBe("failed");
    expect(reply.ok ? "" : reply.error.message).toContain("site survey");
    const gateway = withBoard(
      { role: Role.Gateway, chipId: CHIP_A, development: true, hubIdentity: OTHER_HUB_IDENTITY },
      from,
    ).hub;
    expect(
      provisionIn(gateway.command({ kind: "usbAdd", port: PORT, name: "gw" }).effects)?.siteChannel,
    ).toBe(1);
  });

  test("a siren needs the Wi-Fi details; a sensor and a gateway do not (PR2)", () => {
    const from = snapshot({
      site: siteRow({ wifiName: new Uint8Array(), wifiPassword: new Uint8Array() }),
    });
    const siren = withBoard({ role: Role.Siren, chipId: CHIP_B, development: true }, from).hub;
    expect(
      errorCode(onlyReply(siren.command({ kind: "usbAdd", port: PORT, name: "hall" }).effects)),
    ).toBe("failed");
    const sensor = withBoard(devSensor, from).hub;
    expect(provisionIn(addSensor(sensor).effects)?.wifiName).toEqual(new Uint8Array());
  });

  test("while a move announces, pairing gives the current channel and rates, not the target (D115)", () => {
    const site = siteRow({
      channel: 1,
      rateMask: 1 << 5,
      moveId: 1,
      moveStage: 1,
      moveChannel: 2,
      moveRate: 2,
    });
    const { hub } = withBoard(devSensor, snapshot({ site, devices: [unconfirmedSensor()] }));
    const pairing = provisionIn(addSensor(hub).effects);
    expect([pairing?.siteChannel, pairing?.allowedDataRateMask]).toEqual([1, 1 << 5]);
  });

  test("after the switch, pairing gives the new channel and rates (D115)", () => {
    const site = siteRow({
      channel: 2,
      rateMask: 1 << 2,
      moveId: 1,
      moveStage: 2,
      moveChannel: 2,
      moveRate: 2,
    });
    const { hub } = withBoard(devSensor, snapshot({ site }));
    const pairing = provisionIn(addSensor(hub).effects);
    expect([pairing?.siteChannel, pairing?.allowedDataRateMask]).toEqual([2, 1 << 2]);
  });
});

describe("Set role (§10, D103)", () => {
  test("a different role is set first, and the Identity that shows it leads to Provision", () => {
    const { hub, link } = withBoard({ role: 0, chipId: CHIP_B, development: false });
    const { effects } = hub.command({ kind: "usbAdd", port: PORT, name: "front", role: "sensor" });
    expect(sends(effects).map((s) => toHex(s.bytes))).toEqual([
      toHex(setupBytesNamed("set role 1")),
    ]);
    expect(writes(effects)).toEqual([]);
    const next = hub.frame(
      link,
      identityFrame({ role: Role.Sensor, chipId: CHIP_B, development: false }),
    );
    expect(provisionIn(next)?.address).toBe(ADDRESS);
    expect(deviceNamed(hub.state, "front")?.role).toBe(Role.Sensor);
  });

  test("a board that keeps its role is refused", () => {
    const { hub, link } = withBoard({ role: Role.Siren, chipId: CHIP_B, development: false });
    hub.command({ kind: "usbAdd", port: PORT, name: "front", role: "sensor" });
    const next = hub.frame(
      link,
      identityFrame({ role: Role.Siren, chipId: CHIP_B, development: false }),
    );
    expect(errorCode(onlyReply(next))).toBe("boardRefused");
    expect(devicesOf(hub.state)).toEqual([]);
  });

  test("the same role sends no Set role", () => {
    const { hub } = withBoard(devSensor);
    const { effects } = hub.command({ kind: "usbAdd", port: PORT, name: "front", role: "sensor" });
    expect(sends(effects).map((s) => s.bytes[1])).toEqual([SetupType.Provision]);
  });

  test("no Identity after Set role within 5 s: the CLI is told", () => {
    const { hub } = withBoard({ role: 0, chipId: CHIP_B, development: false });
    hub.command({ kind: "usbAdd", port: PORT, name: "front", role: "sensor" });
    expect(errorCode(onlyReply(hub.advance(5_000)))).toBe("noAnswer");
    expect(hub.state.setup.timers).toEqual([]);
  });
});

describe("Erase (§10): development builds only", () => {
  test("a development board is sent Erase and its Identity is forgotten", () => {
    const { hub } = withBoard(devSensor);
    const { effects } = hub.command({ kind: "usbErase", port: PORT });
    expect(sends(effects).map((s) => toHex(s.bytes))).toEqual([toHex(setupBytesNamed("erase"))]);
    expect(onlyReply(effects)).toEqual({ ok: true, result: { kind: "usbErase", port: PORT } });
    expect([...hub.state.setup.boards.values()][0]?.identity).toBeUndefined();
  });

  test("a release board is refused and sent nothing", () => {
    const { hub } = withBoard({ role: Role.Sensor, chipId: CHIP_B, development: false });
    const { effects } = hub.command({ kind: "usbErase", port: PORT });
    expect(errorCode(onlyReply(effects))).toBe("boardRefused");
    expect(sends(effects)).toEqual([]);
  });
});

describe("timers", () => {
  test("the setup slice holds exactly one timer per exchange waiting, at 5 s ‡", () => {
    const { hub } = withBoard(devSensor);
    addSensor(hub);
    expect(hub.state.setup.timers).toEqual([
      {
        at: (hub.at + 5 * SECOND) as never,
        key: {
          module: "setup",
          kind: "provisionAnswer",
          link: [...hub.state.setup.boards.keys()][0] as never,
        },
      },
    ]);
    hub.advance(5_000);
    expect(hub.state.setup.timers).toEqual([]);
  });
});

describe("pairing data from the hub's keys (§9)", () => {
  test("pairing data the core sends is exactly encodePairingData of its fields", () => {
    const { hub } = withBoard(devSensor);
    const pairing = provisionIn(addSensor(hub).effects);
    if (pairing === undefined) return;
    expect(pairing.hubIdentity).toEqual(HUB_IDENTITY);
    expect(
      sends(hub.all).some((s) => toHex(s.bytes) === `f103${toHex(encodePairingData(pairing))}`),
    ).toBe(true);
  });
});
