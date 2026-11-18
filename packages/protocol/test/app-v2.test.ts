/**
 * Channel version 2, as the joint step 0 froze it (docs/m3-m4-plan.md): version 1 unchanged for a
 * version 1 session, every new row's rule, body and reply, the versions' gate, the errors' new
 * values, `r=` in link codes. Each case would fail if a field, a bound or a rule were wrong.
 */
import { describe, expect, test } from "bun:test";
import {
  APP_EVENT_NAMES,
  APP_EVENTS,
  APP_EVENTS_V2,
  APP_OP_NAMES,
  APP_OPS,
  APP_OPS_V2,
  appError,
  appErrorV2,
  BUSY_BECAUSE,
  bluetoothSessionObject,
  deviceObjectV2,
  FIRMWARE_BLUETOOTH_REFUSALS,
  FIRMWARE_FILE_REFUSALS,
  formatLinkQr,
  hubInfoV2,
  INVALID_REASONS,
  isAppErrorV1,
  isOpInVersion,
  NEW_OPS_V2,
  NOT_A_PHONE,
  NOT_FOUND_WHATS,
  OFFER_AND_ROLLOUT_REFUSALS,
  opSince,
  PAIR_PREPARE_REFUSALS,
  parseAppOp,
  parseAppOpIn,
  parseLinkQr,
  parseRequest,
  parseRequestIn,
  RELAY_SET_REFUSALS,
  relayStatusObject,
  replyErrorV2,
  ROLLOUT_PAUSE_REASONS,
  rolloutObject,
  snapshotObjectV2,
  UNRECORDED_BODY_FIELDS,
  UPDATE_REASONS,
  version1Error,
  versionText,
} from "../src/app/index.ts";
import * as app from "../src/app/index.ts";
import * as relay from "../src/relay/index.ts";

const KEY43 = "A".repeat(42) + "E";
const KEY_ID = "0123456789abcdef";
const APNS = "a".repeat(64);

function accepts(op: keyof typeof APP_OPS_V2, body: unknown): boolean {
  return APP_OPS_V2[op].body.safeParse(body).success;
}

describe("version 1 stays as it was", () => {
  test("its 60 operations and their schemas, and its events, are unchanged", () => {
    expect(APP_OP_NAMES).toHaveLength(60);
    expect(APP_EVENT_NAMES).toHaveLength(Object.keys(APP_EVENTS).length);
    for (const name of APP_OP_NAMES) expect(Object.hasOwn(APP_OPS_V2, name)).toBe(true);
    // Rows version 2 does not change are the very same objects.
    const changed = [
      "hub.info",
      "snapshot",
      "device.list",
      "device.show",
      "device.rename",
      "device.remove",
      "usb.add",
      "site.wifi",
      "backup.key",
    ];
    for (const name of APP_OP_NAMES)
      if (!changed.includes(name)) expect(APP_OPS_V2[name]).toBe(APP_OPS[name]);
  });

  test("version 1's parser refuses version 2's operations, as it refused unknown names", () => {
    expect(parseAppOp("push.test", {}).ok).toBe(false);
    expect(parseRequest({ t: "req", id: 1, seq: 1, op: "push.test", body: {} }).ok).toBe(false);
    expect(parseAppOp("hub.info", {}).ok).toBe(true);
  });

  test("version 1's errors keep their lists", () => {
    expect(INVALID_REASONS).toHaveLength(16);
    expect(BUSY_BECAUSE).toHaveLength(7);
    expect(NOT_FOUND_WHATS).toHaveLength(10);
    const armed = { code: "invalid", detail: { field: "device", reason: "armed" } };
    expect(appError.safeParse(armed).success).toBe(false);
    expect(appErrorV2.safeParse(armed).success).toBe(true);
  });
});

describe("the versions' gate", () => {
  test("names each operation's first version", () => {
    expect(opSince("hub.info")).toBe(1);
    expect(opSince("push.register")).toBe(2);
    expect(isOpInVersion("push.register", 1)).toBe(false);
    expect(isOpInVersion("push.register", 2)).toBe(true);
    expect(isOpInVersion("hub.info", 1)).toBe(true);
    expect(isOpInVersion("nothing", 2)).toBe(false);
  });

  test("tells an operation the version does not name from one no version names", () => {
    expect(parseAppOpIn(1, "push.test", {})).toEqual({
      ok: false,
      notInVersion: true,
      issues: ["op: not an operation of version 1"],
    });
    const unknown = parseAppOpIn(2, "push.tset", {});
    expect(unknown.ok || unknown.notInVersion).toBe(false);
    expect(parseAppOpIn(2, "push.test", {}).ok).toBe(true);
    expect(parseAppOpIn(2, "push.test", { extra: 1 }).ok).toBe(false);
  });

  test("checks seq against the version's rule", () => {
    expect(parseRequestIn(2, { t: "req", id: 1, seq: 4, op: "push.test", body: {} }).ok).toBe(true);
    expect(parseRequestIn(2, { t: "req", id: 1, op: "push.test", body: {} }).ok).toBe(false);
    expect(parseRequestIn(2, { t: "req", id: 1, op: "relay.status", body: {} }).ok).toBe(true);
    expect(parseRequestIn(2, { t: "req", id: 1, seq: 4, op: "relay.status", body: {} }).ok).toBe(
      false,
    );
    const v1 = parseRequestIn(1, { t: "req", id: 1, seq: 4, op: "push.test", body: {} });
    expect(v1.ok ? "ok" : v1.notInVersion).toBe(true);
  });
});

describe("version 2's rows", () => {
  test("23 new operations, each with the designs' rule", () => {
    const rules = Object.fromEntries(
      NEW_OPS_V2.map((op) => [
        op,
        [APP_OPS_V2[op].change, APP_OPS_V2[op].scope, APP_OPS_V2[op].console],
      ]),
    );
    expect(rules).toEqual({
      "backup.keyHeld": [true, "own", false],
      "pair.prepare": [true, "MS", false],
      "pair.finish": [true, "MS", false],
      "presence.set": [true, "own", false],
      "push.register": [true, "own", false],
      "push.unregister": [true, "own", false],
      "push.test": [true, "own", false],
      "relay.status": [false, "MS", false],
      "relay.set": [true, "MS", false],
      "update.offers": [false, "MS", false],
      "update.fetch": [true, "MS", false],
      "firmware.list": [false, "MS", false],
      "firmware.offers": [false, "MS", false],
      "firmware.fetch": [true, "MS", false],
      "firmware.upload": [true, "MS", true],
      "firmware.remove": [true, "MS", false],
      "firmware.download": [false, "MS", false],
      "firmware.bluetooth": [true, "MS", false],
      "rollout.start": [true, "MS", false],
      "rollout.pause": [true, "MS", false],
      "rollout.resume": [true, "MS", false],
      "rollout.cancel": [true, "MS", false],
      "rollout.status": [false, "MS", false],
    });
  });

  test("site.wifi is manage system from any client; backup.key any phone, a read", () => {
    expect(APP_OPS["site.wifi"].console).toBe(true);
    expect(APP_OPS_V2["site.wifi"].console).toBe(false);
    expect(APP_OPS_V2["site.wifi"].change).toBe(true);
    expect(APP_OPS_V2["backup.key"].change).toBe(false);
  });

  test("push.register: the token's bounds per platform, the key id and the key", () => {
    const body = {
      platform: "apns",
      environment: "production",
      token: APNS,
      keyId: KEY_ID,
      key: KEY43,
    };
    expect(accepts("push.register", body)).toBe(true);
    expect(accepts("push.register", { ...body, token: "a".repeat(63) })).toBe(false);
    expect(accepts("push.register", { ...body, token: "a".repeat(200) })).toBe(true);
    expect(accepts("push.register", { ...body, token: "a".repeat(201) })).toBe(false);
    expect(accepts("push.register", { ...body, token: "A".repeat(64) })).toBe(false);
    expect(accepts("push.register", { ...body, platform: "fcm", token: "x".repeat(4096) })).toBe(
      true,
    );
    expect(accepts("push.register", { ...body, platform: "fcm", token: "x".repeat(4097) })).toBe(
      false,
    );
    expect(accepts("push.register", { ...body, platform: "fcm", token: "a b" })).toBe(false);
    expect(accepts("push.register", { ...body, platform: "web" })).toBe(false);
    expect(accepts("push.register", { ...body, environment: "staging" })).toBe(false);
    expect(accepts("push.register", { ...body, keyId: KEY_ID.slice(1) })).toBe(false);
    expect(accepts("push.register", { ...body, keyId: KEY_ID.toUpperCase() })).toBe(false);
    expect(accepts("push.register", { ...body, key: "A".repeat(43) })).toBe(true);
    expect(accepts("push.register", { ...body, key: "A".repeat(42) + "B" })).toBe(false);
    expect(accepts("push.register", { ...body, key: "A".repeat(44) })).toBe(false);
    expect(accepts("push.register", { ...body, extra: true })).toBe(false);
  });

  test("pair.prepare and pair.finish take setup messages of their type, as hex", () => {
    const identity = "f102" + "00".repeat(20);
    expect(accepts("pair.prepare", { identity, name: "door-1" })).toBe(true);
    expect(accepts("pair.prepare", { identity: identity.slice(2), name: "door-1" })).toBe(false);
    expect(accepts("pair.prepare", { identity: "f103" + "00".repeat(20), name: "door-1" })).toBe(
      false,
    );
    expect(accepts("pair.prepare", { identity: "f102" + "00".repeat(19), name: "door-1" })).toBe(
      false,
    );
    expect(accepts("pair.prepare", { identity, name: "front door" })).toBe(false);
    expect(accepts("pair.finish", { device: 3, result: "f10400" })).toBe(true);
    expect(accepts("pair.finish", { device: 3, result: "f104" })).toBe(false);
    expect(accepts("pair.finish", { device: 3, result: "f10200" })).toBe(false);
    expect(accepts("pair.finish", { device: 3, result: "F10400" })).toBe(false);
  });

  test("relay.set takes a ws:// or wss:// URL or null", () => {
    expect(accepts("relay.set", { url: null })).toBe(true);
    expect(accepts("relay.set", { url: "wss://relay.example.com" })).toBe(true);
    expect(accepts("relay.set", { url: "ws://192.168.1.20:8480" })).toBe(true);
    expect(accepts("relay.set", { url: "https://relay.example.com" })).toBe(false);
    expect(accepts("relay.set", { url: "wss://relay.example.com/?a=1" })).toBe(false);
    expect(accepts("relay.set", {})).toBe(false);
  });

  test("versions are MAJOR.MINOR.PATCH, each 0 to 255", () => {
    expect(versionText.safeParse("1.2.3").success).toBe(true);
    expect(versionText.safeParse("255.255.255").success).toBe(true);
    expect(versionText.safeParse("256.0.0").success).toBe(false);
    expect(versionText.safeParse("1.02.3").success).toBe(false);
    expect(versionText.safeParse("1.2").success).toBe(false);
    expect(accepts("update.fetch", { version: "1.4.0" })).toBe(true);
    expect(accepts("firmware.fetch", { version: "v1.4.0" })).toBe(false);
  });

  test("firmware.upload's own build and its confirmation", () => {
    expect(accepts("firmware.upload", { job: 1 })).toBe(true);
    expect(
      accepts("firmware.upload", { job: 1, own: { version: "1.4.0" }, confirmOwn: true }),
    ).toBe(true);
    expect(accepts("firmware.upload", { job: 1, confirmOwn: false })).toBe(false);
    expect(accepts("firmware.upload", { job: 1, own: {} })).toBe(false);
  });

  test("rollouts: devices once each, force only with a device", () => {
    expect(accepts("rollout.start", { image: 1 })).toBe(true);
    expect(accepts("rollout.start", { image: 1, devices: "all", pilots: [3] })).toBe(true);
    expect(accepts("rollout.start", { image: 1, devices: [3, 3] })).toBe(false);
    expect(accepts("rollout.start", { image: 1, devices: [] })).toBe(false);
    expect(accepts("rollout.start", { image: 1, pilots: [4, 4] })).toBe(false);
    expect(accepts("rollout.resume", { rollout: 1 })).toBe(true);
    expect(accepts("rollout.resume", { rollout: 1, device: 5, force: true })).toBe(true);
    expect(accepts("rollout.resume", { rollout: 1, force: true })).toBe(false);
    expect(accepts("rollout.resume", { rollout: 1, device: 5, force: false })).toBe(false);
  });
});

describe("version 2's objects", () => {
  const hub = {
    hub: "0.2.0",
    proto: 2,
    identity: "a".repeat(26),
    fingerprint: "f",
    timeZone: "Europe/London",
    clockTrusted: true,
    boot: 1,
  };
  test("hub.info adds the home addresses, the apps' port and the relay", () => {
    const v2 = { ...hub, addresses: ["192.168.1.20", "fd00::1"], appsPort: 8444, relay: null };
    expect(hubInfoV2.safeParse(v2).success).toBe(true);
    expect(hubInfoV2.safeParse(hub).success).toBe(false);
    expect(hubInfoV2.safeParse({ ...v2, appsPort: 0 }).success).toBe(false);
    expect(hubInfoV2.safeParse({ ...v2, appsPort: 65_536 }).success).toBe(false);
    expect(hubInfoV2.safeParse({ ...v2, addresses: ["hub.local"] }).success).toBe(false);
    expect(hubInfoV2.safeParse({ ...v2, relay: { url: "wss://r.example.com" } }).success).toBe(
      true,
    );
    expect(APP_OPS["hub.info"].reply.safeParse(v2).success).toBe(false);
  });

  test("a device carries its update: state, hold and method", () => {
    const device = {
      id: 3,
      name: "door-1",
      role: "sensor",
      state: "contacted",
      firmware: "1.2.3",
      batteryPercent: 80,
      signal: null,
      temperatureC: null,
      lastSeenMs: null,
      heardBy: null,
      health: { silent: false, batteryLow: false, tamperOpen: false, poorLink: false },
    };
    expect(deviceObjectV2.safeParse({ ...device, update: null }).success).toBe(true);
    expect(
      deviceObjectV2.safeParse({
        ...device,
        update: { state: "fetching", held: null, method: "bluetooth" },
      }).success,
    ).toBe(true);
    expect(
      deviceObjectV2.safeParse({
        ...device,
        update: { state: "fetching", held: "no", method: "ownLink" },
      }).success,
    ).toBe(false);
    expect(deviceObjectV2.safeParse(device).success).toBe(false);
  });

  test("the snapshot carries the phone's push target and backup epoch, null for others", () => {
    const shape = snapshotObjectV2.unwrap().shape;
    expect(shape.push.safeParse(null).success).toBe(true);
    expect(shape.push.safeParse({ registered: true, valid: false }).success).toBe(true);
    expect(shape.backupKeyEpoch.safeParse(-1).success).toBe(false);
    expect(shape.backupKeyEpoch.safeParse(null).success).toBe(true);
  });

  test("relay.status names its state from up, down and off", () => {
    const status = { url: null, isDefault: true, state: "off", sinceMs: null, roles: [] };
    expect(relayStatusObject.safeParse(status).success).toBe(true);
    expect(relayStatusObject.safeParse({ ...status, state: "unknown" }).success).toBe(false);
    expect(relayStatusObject.safeParse({ ...status, roles: ["names", "dns"] }).success).toBe(false);
  });

  test("firmware.bluetooth's reply: address u32, 8-byte image id, a 32-byte key, a window", () => {
    const reply = {
      device: 3,
      address: 0xffff_ffff,
      imageId: "0011223344556677",
      version: "1.3.0",
      fileBytes: 1_500_128,
      sha256: "ab".repeat(32),
      sessionKey: KEY43,
      windowS: 120,
      expiresInMs: 900_000,
      needsWake: true,
    };
    expect(bluetoothSessionObject.safeParse(reply).success).toBe(true);
    expect(bluetoothSessionObject.safeParse({ ...reply, address: 2 ** 32 }).success).toBe(false);
    expect(bluetoothSessionObject.safeParse({ ...reply, imageId: "00112233" }).success).toBe(false);
    expect(bluetoothSessionObject.safeParse({ ...reply, fileBytes: 128 }).success).toBe(false);
    expect(bluetoothSessionObject.safeParse({ ...reply, windowS: 2560 }).success).toBe(false);
    expect(bluetoothSessionObject.safeParse({ ...reply, sessionKey: "short" }).success).toBe(false);
  });
});

describe("version 2's events", () => {
  test("deviceUpdate, and the hub event's two new whats", () => {
    const update = {
      device: 3,
      image: 1,
      state: "fetching",
      held: null,
      method: "joinWifi",
      bytes: 65_536,
      of: 1_500_128,
    };
    expect(APP_EVENTS_V2.deviceUpdate.safeParse(update).success).toBe(true);
    expect(APP_EVENTS_V2.deviceUpdate.safeParse({ ...update, reason: "radioBusy" }).success).toBe(
      true,
    );
    expect(APP_EVENTS_V2.deviceUpdate.safeParse({ ...update, reason: "late" }).success).toBe(false);
    expect(APP_EVENTS_V2.deviceUpdate.safeParse({ ...update, bytes: -1 }).success).toBe(false);
    const relay = { what: "relay", detail: {} };
    expect(APP_EVENTS_V2.hub.safeParse(relay).success).toBe(true);
    expect(APP_EVENTS_V2.hub.safeParse({ what: "updateOffered", detail: {} }).success).toBe(true);
    expect(APP_EVENTS.hub.safeParse(relay).success).toBe(false);
    expect(Object.hasOwn(APP_EVENTS, "deviceUpdate")).toBe(false);
  });
});

describe("version 2's refusals in M2's scheme", () => {
  test("every named refusal is a version 2 error", () => {
    for (const table of [
      FIRMWARE_BLUETOOTH_REFUSALS,
      PAIR_PREPARE_REFUSALS,
      FIRMWARE_FILE_REFUSALS,
      OFFER_AND_ROLLOUT_REFUSALS,
      RELAY_SET_REFUSALS,
    ])
      for (const [name, error] of Object.entries(table))
        expect([name, appErrorV2.safeParse(error).success]).toEqual([name, true]);
    expect(appErrorV2.safeParse(NOT_A_PHONE).success).toBe(true);
    expect(
      replyErrorV2.safeParse({
        t: "res",
        id: 1,
        ok: false,
        error: FIRMWARE_BLUETOOTH_REFUSALS.busy,
      }).success,
    ).toBe(true);
  });

  test("firmware.bluetooth's holds: waiting is busy, acting is invalid", () => {
    expect(FIRMWARE_BLUETOOTH_REFUSALS.armed).toEqual({
      code: "invalid",
      detail: { field: "device", reason: "armed" },
    });
    expect(FIRMWARE_BLUETOOTH_REFUSALS.battery.detail).toEqual({
      field: "device",
      reason: "lowBattery",
    });
    expect(FIRMWARE_BLUETOOTH_REFUSALS.keyChange).toEqual({
      code: "busy",
      detail: { because: "keyChange" },
    });
    expect(FIRMWARE_BLUETOOTH_REFUSALS.onTrial).toEqual({
      code: "busy",
      detail: { because: "onTrial" },
    });
    expect(FIRMWARE_BLUETOOTH_REFUSALS.busy).toEqual({
      code: "busy",
      detail: { because: "bluetoothSession" },
    });
    expect(Object.keys(FIRMWARE_BLUETOOTH_REFUSALS).toSorted()).toEqual(
      [
        "armed",
        "battery",
        "countdown",
        "alarm",
        "siteMove",
        "keyChange",
        "notPaired",
        "onTrial",
        "noImage",
        "busy",
      ].toSorted(),
    );
  });
});

describe("link codes gain r=", () => {
  const qr = {
    identity: "a".repeat(26),
    secret: new Uint8Array(16).fill(1),
    addresses: ["192.168.1.20"],
    port: 8444,
    fingerprint: new Uint8Array(32).fill(2),
  };
  test("only when given, percent-encoded, and read back", () => {
    expect(formatLinkQr(qr)).not.toContain("&r=");
    const withRelay = formatLinkQr({ ...qr, relay: "ws://192.168.1.20:8480" });
    expect(withRelay).toEndWith("&r=ws%3A%2F%2F192.168.1.20%3A8480");
    expect(withRelay.startsWith("hsn://link/1?")).toBe(true);
    expect(parseLinkQr(withRelay)).toEqual({ ...qr, relay: "ws://192.168.1.20:8480" });
    expect(parseLinkQr(formatLinkQr(qr))).toEqual(qr);
    expect(parseLinkQr(`${formatLinkQr(qr)}&r=`)).toEqual(qr);
  });
});

describe("a paused rollout's reason", () => {
  const rollout = {
    id: 1,
    image: 2,
    version: "1.3.0",
    stage: "paused",
    devices: [3, 4],
    pilots: [3],
    approvedBy: "Anna (client 7)",
    approvedMs: 1_700_000_000_000,
    soakUntilMs: null,
    endedMs: null,
  };
  const paused = (reason: string) => ({ ...rollout, paused: { reason, device: 3 } });

  test("is a device's reason, or the rollout's own: a pilot failed, a device rolled back", () => {
    expect(ROLLOUT_PAUSE_REASONS).toEqual(["pilotFailed", "rolledBack"]);
    for (const reason of [...UPDATE_REASONS, ...ROLLOUT_PAUSE_REASONS])
      expect([reason, rolloutObject.safeParse(paused(reason)).success]).toEqual([reason, true]);
    expect(rolloutObject.safeParse({ ...rollout, paused: null }).success).toBe(true);
    for (const reason of ["none", "rolled_back", "rollback", "pilot", ""])
      expect([reason, rolloutObject.safeParse(paused(reason)).success]).toEqual([reason, false]);
  });

  test("the rollout's own follow the device's in stored code: 19 pilotFailed, 20 rolledBack", () => {
    // `rollouts.paused_reason`: 1 to 17 Update status's, 18 noContact, then these two.
    const names = [...UPDATE_REASONS, ...ROLLOUT_PAUSE_REASONS];
    expect(names.indexOf("noContact") + 1).toBe(18);
    expect(names.indexOf("pilotFailed") + 1).toBe(19);
    expect(names.indexOf("rolledBack") + 1).toBe(20);
  });
});

describe("version 2's errors on a version 1 session", () => {
  test("a version 1 error is sent as it is, the very same object", () => {
    const errors = [
      { code: "notFound", detail: { what: "device", id: 9 } },
      { code: "invalid", detail: { field: "name", reason: "taken" } },
      { code: "busy", detail: { because: "siteMove" } },
      { code: "unavailable", detail: {} },
      { code: "notBuilt", detail: { op: "rollout.status" } },
    ] as const;
    for (const error of errors) {
      expect(isAppErrorV1(error)).toBe(true);
      expect(version1Error(error)).toBe(error);
    }
  });

  test("a value only version 2 lists becomes protoUnsupported, which version 1 parses", () => {
    const v2Only = [
      FIRMWARE_BLUETOOTH_REFUSALS.armed,
      FIRMWARE_BLUETOOTH_REFUSALS.busy,
      FIRMWARE_FILE_REFUSALS.storeFull,
      OFFER_AND_ROLLOUT_REFUSALS.rolloutOpen,
      RELAY_SET_REFUSALS.notLocal,
      { code: "notFound", detail: { what: "rollout", id: 1 } },
    ] as const;
    for (const error of v2Only) {
      expect([error, isAppErrorV1(error)]).toEqual([error, false]);
      const sent = version1Error(error);
      expect(sent).toEqual({ code: "protoUnsupported", detail: { speaks: [1, 2] } });
      expect(appError.safeParse(sent).success).toBe(true);
    }
  });
});

describe("the relay's names the core takes from @hsn/protocol/app", () => {
  test("are the relay's own, the very same functions and schemas", () => {
    for (const name of [
      "parsePushKey",
      "parsePushKeyId",
      "relayAlertContent",
      "pushContent",
      "pushEnvironment",
      "pushOutcome",
      "pushPlatform",
      "releaseOffer",
    ] as const)
      expect([name, app[name] === relay[name]]).toEqual([name, true]);
  });

  test("parse a push key id and key as push.register carries them, and make the relay's alerts", () => {
    expect(app.parsePushKeyId(KEY_ID)).toEqual(
      Uint8Array.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]),
    );
    expect(app.parsePushKeyId("0123456789ABCDEF")).toBeUndefined();
    expect(app.parsePushKey(KEY43)?.length).toBe(32);
    expect(app.parsePushKey(KEY43.slice(1))).toBeUndefined();
    const alert = app.relayAlertContent("unreachable", "abcdefghijklmnopqrstuvwxyz", true);
    expect(app.pushContent.safeParse(alert).success).toBe(true);
    expect([alert.n.kind, alert.armed]).toEqual(["hub_unreachable", true]);
  });
});

describe("the body fields a commands row never keeps", () => {
  test("are site.wifi's password and push.register's key, each a field of its body", () => {
    expect(UNRECORDED_BODY_FIELDS).toEqual({
      "site.wifi": ["password"],
      "push.register": ["key"],
    });
    const register = {
      platform: "apns",
      token: APNS,
      environment: "production",
      keyId: KEY_ID,
      key: KEY43,
    };
    expect(accepts("push.register", register)).toBe(true);
    expect(accepts("push.register", { ...register, key: undefined })).toBe(false);
    expect(accepts("site.wifi", { name: "home" })).toBe(false);
    expect(accepts("site.wifi", { name: "home", password: "pw" })).toBe(true);
  });
});
