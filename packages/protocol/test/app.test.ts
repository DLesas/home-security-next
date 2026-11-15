/**
 * The app channel's frozen types and schemas (docs/m2-design.md sections 5 and 6): every
 * operation and event has its schemas, the envelope's rules hold, the codes and addresses read
 * back what they wrote, and the vector formats take a sample of each.
 */
import { describe, expect, test } from "bun:test";
import {
  APP_EVENT_NAMES,
  APP_EVENTS,
  APP_OP_NAMES,
  APP_OPS,
  APP_VECTOR_FILES,
  appError,
  appReply,
  BACKUP_HEADER_LAYOUT,
  HUB_FEATURES,
  BACKUP_KNOWN_FLAGS,
  categoryBit,
  displayName,
  historyRow,
  linkHubPayload,
  NOTIFICATION_CATEGORIES,
  OPTIONAL_CATEGORIES,
  restoreHello,
  restoreKey,
  restoreOffer,
  restoreResult,
  weekdayBit,
  CHANGE_OPS,
  clientHello,
  formatConsoleAddress,
  formatIdentity,
  formatLinkAddress,
  formatLinkQr,
  formatTypedCode,
  hubHello,
  linkHello,
  linkPrologue,
  linkRequest,
  linkResult,
  parseConsoleFragment,
  parseEvent,
  parseIdentity,
  parseLinkFragment,
  parseLinkQr,
  parseRequest,
  parseTypedCode,
  secretLookup,
  secretPsk,
  sessionPrologue,
  typedLookup,
  typedPsk,
  vectorFile,
} from "../src/app/index.ts";
import { nodeSha256 } from "../src/crypto/sha256.ts";

/** Section 6's table, row by row: the operations and whether each is a change. */
const SECTION_6: readonly (readonly [string, boolean])[] = [
  ["snapshot", false],
  ["subscribe", false],
  ["hub.info", false],
  ["hub.status", false],
  ["mode.switch", true],
  ["arm", true],
  ["disarm", true],
  ["group.create", true],
  ["group.update", true],
  ["group.delete", true],
  ["mode.create", true],
  ["mode.update", true],
  ["mode.delete", true],
  ["schedule.create", true],
  ["schedule.update", true],
  ["schedule.delete", true],
  ["device.list", false],
  ["device.show", false],
  ["device.rename", true],
  ["device.remove", true],
  ["sensor.settings", true],
  ["siren.settings", true],
  ["siren.test", true],
  ["gateway.settings", true],
  ["usb.list", false],
  ["usb.add", true],
  ["usb.erase", true],
  ["site.show", false],
  ["site.set", true],
  ["site.wifi", true],
  ["site.survey", true],
  ["site.change", true],
  ["site.changeStatus", false],
  ["history.query", false],
  ["notifications.list", false],
  ["notifications.read", false],
  ["notifications.prefs", true],
  ["people.list", false],
  ["person.create", true],
  ["person.rename", true],
  ["person.remove", true],
  ["permissions.set", true],
  ["userManagement.set", true],
  ["clients.list", false],
  ["client.rename", true],
  ["client.remove", true],
  ["link.create", true],
  ["link.cancel", true],
  ["pong", false],
  ["backup.key", false],
  ["backup.status", false],
  ["backup.settings", true],
  ["backup.now", true],
  ["backup.export", true],
  ["restore.start", false],
  ["update.status", false],
  ["update.upload", true],
  ["update.approve", true],
  ["update.cancel", true],
  ["fileChunk", false],
];

describe("operations (section 6)", () => {
  test("every row of section 6 is an operation, with its change flag, and nothing else is", () => {
    expect([...APP_OP_NAMES].map(String).toSorted()).toEqual(SECTION_6.map(([n]) => n).toSorted());
    for (const [name, change] of SECTION_6) {
      expect([name, APP_OPS[name as keyof typeof APP_OPS].change]).toEqual([name, change]);
    }
    expect(CHANGE_OPS.length).toBe(SECTION_6.filter(([, c]) => c).length);
  });

  test("the console-only operations are those section 6 marks C", () => {
    const consoleOnly = APP_OP_NAMES.filter((n) => APP_OPS[n].console)
      .map(String)
      .toSorted();
    expect(consoleOnly).toEqual(
      [
        "restore.start",
        "site.wifi",
        "update.upload",
        "usb.add",
        "usb.erase",
        "usb.list",
      ].toSorted(),
    );
  });

  test("a change carries seq and a read does not; unknown fields and operations are refused", () => {
    const arm = { t: "req", id: 1, seq: 7, op: "arm", body: { target: { group: 2 } } };
    expect(parseRequest(arm).ok).toBe(true);
    expect(parseRequest({ ...arm, seq: undefined }).ok).toBe(false);
    expect(parseRequest({ t: "req", id: 2, op: "hub.info", body: {} }).ok).toBe(true);
    expect(parseRequest({ t: "req", id: 2, seq: 3, op: "hub.info", body: {} }).ok).toBe(false);
    expect(parseRequest({ ...arm, body: { target: { group: 2 }, extra: 1 } }).ok).toBe(false);
    expect(parseRequest({ ...arm, op: "explode" }).ok).toBe(false);
    expect(parseRequest({ ...arm, id: 0 }).ok).toBe(false);
    expect(parseRequest({ ...arm, id: 2 ** 32 }).ok).toBe(false);
  });

  test("a sample body of each operation that has one parses", () => {
    const samples: Partial<Record<(typeof APP_OP_NAMES)[number], unknown>> = {
      "mode.switch": { mode: 1, confirm: { openDoors: true, lowBattery: false } },
      disarm: { target: "mine" },
      "group.create": { name: "Ground floor", sensors: [3, 4], sirens: "all" },
      "schedule.create": {
        name: "Night",
        action: "switchMode",
        target: { mode: 1 },
        at: "22:00",
        days: "everyDay",
        enabled: true,
      },
      "permissions.set": {
        person: 2,
        devices: [{ device: 3, manage: true, view: true }],
        manageUsers: false,
        manageSystem: false,
        ifRevision: 4,
      },
      "link.create": { kind: { newPerson: { name: "Ben" } }, form: "code", invite: true },
      "site.change": "cancel",
      "history.query": { devices: [3], kinds: ["decision"], limit: 500 },
      fileChunk: { job: 1, n: 0, data: "AAEC", end: { chunks: 1, sha256: "0".repeat(64) } },
      "client.remove": { client: 7, also: [8, 9] },
      "device.rename": { device: 3, name: "hall" },
      "device.remove": { device: 3 },
      "restore.start": { job: 1 },
    };
    for (const [name, body] of Object.entries(samples)) {
      const parsed = APP_OPS[name as keyof typeof APP_OPS].body.safeParse(body);
      expect([name, parsed.success]).toEqual([name, true]);
    }
    expect(APP_OPS["history.query"].body.safeParse({ limit: 501 }).success).toBe(false);
    // Devices have no revision (section 4), and `also` names no client twice (section 7).
    expect(APP_OPS["device.remove"].body.safeParse({ device: 3, ifRevision: 0 }).success).toBe(
      false,
    );
    expect(APP_OPS["client.remove"].body.safeParse({ client: 7 }).success).toBe(false);
    expect(APP_OPS["client.remove"].body.safeParse({ client: 7, also: [8, 8] }).success).toBe(
      false,
    );
    expect(
      APP_OPS["restore.start"].reply.safeParse({
        identity: "a".repeat(26),
        madeMs: 1,
        lastChangeMs: 1,
        qr: "hsn://restore/1?…",
      }).success,
    ).toBe(true);
    expect(
      APP_OPS["schedule.create"].body.safeParse({
        ...(samples["schedule.create"] as object),
        at: "24:00",
      }).success,
    ).toBe(false);
  });

  test("each error's detail as section 5 gives it: conflict carries its object, busy an upload", () => {
    const error = (e: unknown) => appError.safeParse(e).success;
    const group = { id: 1, name: "Ground", sensors: [3], sirens: "all", revision: 4 };
    expect(error({ code: "conflict", detail: { revision: 4, object: group } })).toBe(true);
    expect(error({ code: "conflict", detail: { revision: 4 } })).toBe(false);
    expect(error({ code: "notFound", detail: { what: "group", id: 9 } })).toBe(true);
    expect(error({ code: "notFound", detail: { what: "thing", id: 9 } })).toBe(false);
    expect(
      error({ code: "invalid", detail: { field: "groups.0", reason: "inUse", refs: [2] } }),
    ).toBe(true);
    expect(error({ code: "invalid", detail: { field: "name", reason: "odd" } })).toBe(false);
    expect(error({ code: "busy", detail: { because: "upload" } })).toBe(true);
    expect(error({ code: "protoUnsupported", detail: { speaks: [1, 1] } })).toBe(true);
  });

  test("replies: ok with any body, errors only by their codes; notBuilt is a code of its own", () => {
    expect(appReply.safeParse({ t: "res", id: 1, ok: true, body: {}, repeat: true }).success).toBe(
      true,
    );
    expect(
      appReply.safeParse({
        t: "res",
        id: 1,
        ok: false,
        error: { code: "needsConfirmation", detail: { openDoors: [3], lowBattery: [] } },
      }).success,
    ).toBe(true);
    expect(
      appReply.safeParse({
        t: "res",
        id: 1,
        ok: false,
        error: { code: "notBuilt", detail: { op: "arm" } },
      }).success,
    ).toBe(true);
    expect(
      appReply.safeParse({ t: "res", id: 1, ok: false, error: { code: "nope", detail: {} } })
        .success,
    ).toBe(false);
  });
});

describe("events (section 6)", () => {
  test("every event of the table, each with its schema", () => {
    expect([...APP_EVENT_NAMES].map(String).toSorted()).toEqual(
      [
        "arming",
        "countdown",
        "alarm",
        "door",
        "reading",
        "health",
        "device",
        "notification",
        "record",
        "config",
        "people",
        "site",
        "hub",
        "session",
        "ping",
        "forget",
        "backupKeyChanged",
        "fileChunk",
        "fileFailed",
      ].toSorted(),
    );
    expect(APP_EVENTS.fileFailed.safeParse({ job: 3, reason: "stopping" }).success).toBe(true);
    expect(APP_EVENTS.fileFailed.safeParse({ job: 3, reason: "lost" }).success).toBe(false);
    expect(
      parseEvent({ t: "evt", rev: 4, ev: "door", body: { sensor: 3, open: true, atMs: 1 } }).ok,
    ).toBe(true);
    expect(parseEvent({ t: "evt", rev: 4, ev: "door", body: { sensor: 3 } }).ok).toBe(false);
    expect(APP_EVENTS.ping.safeParse({}).success).toBe(true);
  });
});

describe("handshake payloads (section 5)", () => {
  test("ClientHello with first, HubHello, LinkHello by lookup and by typed id, LinkRequest, LinkResult", () => {
    expect(
      clientHello.safeParse({
        proto: [1, 1],
        app: "1.0.0",
        first: { t: "req", id: 1, seq: 9, op: "disarm", body: { target: "mine" } },
      }).success,
    ).toBe(true);
    expect(clientHello.safeParse({ proto: [2, 1], app: "1.0.0" }).success).toBe(false);
    expect(
      hubHello.safeParse({
        proto: 1,
        hub: "2.0.0",
        boot: 3,
        rev: 0,
        client: { id: 7, person: 2, kind: "web" },
        features: [],
      }).success,
    ).toBe(true);
    // Version 1 defines no feature; a later name has the rule's shape.
    expect(HUB_FEATURES).toEqual([]);
    const hello = {
      proto: 1,
      hub: "2.0.0",
      boot: 3,
      rev: 0,
      client: { id: 7, person: 2, kind: "web" },
    };
    expect(hubHello.safeParse({ ...hello, features: ["fastSnapshot"] }).success).toBe(true);
    expect(hubHello.safeParse({ ...hello, features: ["Fast-Snapshot"] }).success).toBe(false);
    expect(linkHello.safeParse({ proto: [1, 2], find: "0a1b2c3d" }).success).toBe(true);
    expect(linkHello.safeParse({ proto: [1, 1], find: "7XQ0" }).success).toBe(true);
    expect(linkHello.safeParse({ proto: [1, 1], find: "7XQI" }).success).toBe(false);
    expect(linkHello.safeParse({ proto: 1, find: "7XQ0" }).success).toBe(false);
    expect(linkHubPayload.safeParse({ hub: "2.0.0", proto: 1, askName: true }).success).toBe(true);
    expect(linkHubPayload.safeParse({ hub: "2.0.0", proto: 1 }).success).toBe(false);
    expect(linkRequest.safeParse({ name: "Ben's laptop", kind: "web" }).success).toBe(true);
    expect(linkResult.safeParse({ client: 7, person: 2 }).success).toBe(true);
  });

  test("restore's six messages: LinkHello, {hub, proto}, RestoreHello, RestoreOffer, RestoreKey, RestoreResult", () => {
    expect(restoreHello.safeParse({ app: "3.0.0" }).success).toBe(true);
    expect(restoreHello.safeParse({ app: "3.0.0", key: "x" }).success).toBe(false);
    const offer = { identity: "a".repeat(26), epoch: 2, madeMs: 10, lastChangeMs: 5 };
    expect(restoreOffer.safeParse(offer).success).toBe(true);
    expect(restoreOffer.safeParse({ ...offer, identity: "A".repeat(26) }).success).toBe(false);
    expect(restoreKey.safeParse({ key: "A".repeat(43), epoch: 2 }).success).toBe(true);
    expect(restoreResult.safeParse({ ok: true }).success).toBe(true);
    expect(restoreResult.safeParse({ ok: false, reason: "wrongKey" }).success).toBe(true);
    expect(restoreResult.safeParse({ ok: false, reason: "lost" }).success).toBe(false);
  });

  test("prologues: the label, a zero byte, and for a session the identity", () => {
    const identity = new Uint8Array(16).fill(0xab);
    const session = sessionPrologue(identity);
    expect(new TextDecoder().decode(session.slice(0, 13))).toBe("hsn-session/1");
    expect(session[13]).toBe(0);
    expect(session.slice(14)).toEqual(identity);
    expect(linkPrologue("restore")).toEqual(new TextEncoder().encode("hsn-restore/1\0"));
  });
});

describe("linking's formats (section 5)", () => {
  test("an identity is 26 base32 characters and reads back", () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => i * 17);
    const text = formatIdentity(bytes);
    expect(text).toMatch(/^[a-z2-7]{26}$/u);
    expect(parseIdentity(text)).toEqual(bytes);
    expect(parseIdentity(`${text.slice(0, 25)}1`)).toBeUndefined();
  });

  test("a typed code: XXXX-XXXX-XXXX, its check character catches a typo, look-alikes forgiven", () => {
    const code = { tokenId: 0xabcde, secret: 0x7_1234_5678n };
    const text = formatTypedCode(code) ?? "";
    expect(text).toMatch(/^[0-9A-Z*~$=]{4}-[0-9A-Z*~$=]{4}-[0-9A-Z*~$=]{4}$/u);
    expect(parseTypedCode(text)).toEqual(code);
    expect(parseTypedCode(text.toLowerCase().replaceAll("-", " "))).toEqual(code);
    const typo = `${text.slice(0, 5)}${text[5] === "0" ? "1" : "0"}${text.slice(6)}`;
    expect(parseTypedCode(typo)).toBeUndefined();
    expect(typedLookup(code.tokenId)).toBe(text.slice(0, 4));
    expect(formatTypedCode({ tokenId: 2 ** 20, secret: 0n })).toBeUndefined();
    expect(typedPsk(nodeSha256, code.secret)).toHaveLength(32);
  });

  test("a 128-bit secret's lookup is 8 hex digits and its psk 32 bytes, both apart from the secret", () => {
    const secret = new Uint8Array(16).fill(7);
    expect(secretLookup(nodeSha256, secret)).toMatch(/^[0-9a-f]{8}$/u);
    expect(secretPsk(nodeSha256, secret)).toHaveLength(32);
  });

  test("the QR code, the link address and the console's address read back", () => {
    const qr = {
      identity: formatIdentity(new Uint8Array(16).fill(1)),
      secret: new Uint8Array(16).fill(2),
      addresses: ["192.168.1.20", "hub.local"],
      port: 8444,
      fingerprint: new Uint8Array(32).fill(3),
    };
    expect(parseLinkQr(formatLinkQr(qr))).toEqual(qr);
    const restore = formatLinkQr(qr, "restore");
    expect(restore.startsWith("hsn://restore/1?")).toBe(true);
    expect(parseLinkQr(restore, "restore")).toEqual(qr);
    expect(parseLinkQr(restore)).toBeUndefined();
    const address = formatLinkAddress("192.168.1.20", 8444, qr.identity, qr.secret);
    expect(parseLinkFragment(address.slice(address.indexOf("#") + 1))).toEqual({
      identity: qr.identity,
      secret: qr.secret,
    });
    const console = formatConsoleAddress(8445, qr.secret);
    expect(console.startsWith("http://127.0.0.1:8445/#console=")).toBe(true);
    expect(parseConsoleFragment(console.slice(console.indexOf("#") + 1))).toEqual(qr.secret);
  });
});

describe("names, weekdays, categories, history rows and the backup header (sections 6, 7, 9)", () => {
  test("a name refuses control and bidirectional characters, white space at an end, and text not in NFC", () => {
    expect(displayName.safeParse("Ben's laptop").success).toBe(true);
    for (const bad of [
      "",
      " Ben",
      "Ben ",
      "   ",
      "a\u0007b",
      "a\u202Eb",
      "a\u2066b",
      "Cafe\u0301",
    ]) {
      expect([bad, displayName.safeParse(bad).success]).toEqual([bad, false]);
    }
    expect(displayName.safeParse("Caf\u00e9").success).toBe(true);
  });

  test("weekdays: Monday bit 0, 1 to 7 days without repeats", () => {
    expect(weekdayBit("mon")).toBe(1);
    expect(weekdayBit("sun")).toBe(64);
    const days = APP_OPS["schedule.create"].body;
    const entry = { name: "N", action: "arm", target: { group: 1 }, at: "07:00", enabled: true };
    expect(days.safeParse({ ...entry, days: ["fri", "mon"] }).success).toBe(true);
    expect(days.safeParse({ ...entry, days: ["mon", "mon"] }).success).toBe(false);
    expect(days.safeParse({ ...entry, days: [] }).success).toBe(false);
  });

  test("categories: the optional ones by bit, and hub among those always delivered", () => {
    expect(OPTIONAL_CATEGORIES[0]).toBe("sensorSilentWhileDisarmed");
    expect(categoryBit("updates")).toBe(1 << 5);
    expect(NOTIFICATION_CATEGORIES).toContain("hub");
    expect(OPTIONAL_CATEGORIES as readonly string[]).not.toContain("hub");
  });

  test("a history row's row is recordJson, of its own kind", () => {
    const row = {
      kind: "hubEvent",
      row: {
        kind: "hubEvent",
        row: {
          seq: 1,
          atMs: 2,
          clockOk: true,
          level: "info",
          origin: "app",
          code: "client_connected",
          message: "",
          detail: null,
        },
      },
    };
    expect(historyRow.safeParse(row).success).toBe(true);
    expect(historyRow.safeParse({ ...row, kind: "decision" }).success).toBe(false);
  });

  test("the backup header: 64 bytes, no flag known (bit 0 retired)", () => {
    const last = BACKUP_HEADER_LAYOUT[BACKUP_HEADER_LAYOUT.length - 1];
    expect(last === undefined ? 0 : last[1] + last[2]).toBe(64);
    expect(BACKUP_KNOWN_FLAGS).toBe(0);
  });
});

describe("vector formats (section 10)", () => {
  test("each vector file has a schema, and an empty file of each parses", () => {
    expect(Object.keys(APP_VECTOR_FILES).toSorted()).toEqual(
      [
        "app-backup.json",
        "app-link-secrets.json",
        "app-noise-failures.json",
        "app-noise.json",
        "app-release.json",
        "app-schemas.json",
        "app-typed-code.json",
      ].toSorted(),
    );
    for (const entry of Object.values(APP_VECTOR_FILES)) {
      expect(vectorFile(entry).safeParse({ description: "x", vectors: [] }).success).toBe(true);
    }
  });
});
