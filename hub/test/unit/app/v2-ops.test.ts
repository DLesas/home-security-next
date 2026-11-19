/**
 * Channel version 2's operations as `app` checks and routes them (docs/m3-m4-plan.md; H1): each to
 * its owner, the refusals each version may be sent, `site.wifi` from any client with manage
 * system and its password never recorded, presence and its offers at their edges, the addresses
 * apps are given, and the replies by version (`replyOf`).
 */
import { describe, expect, test } from "bun:test";
import { type AppErrorV2, NOT_A_PHONE, RELAY_SET_REFUSALS } from "@hsn/protocol/app";
import type { Effect } from "../../../src/core/model/effects.ts";
import { appAddresses, isLinkLocalIpv6, shortestIpv6 } from "../../../src/core/app/versions.ts";
import { peopleDetail } from "../../../src/core/app/presence.ts";
import { decodeReply, encodeReply, replyOf } from "../../../src/core/people/replies.ts";
import { ArmState, ClientKind } from "../../../src/core/model/rows.ts";
import { clientId, deviceId, personId } from "../../../src/core/model/ids.ts";
import {
  ANNA,
  ANNA_LAPTOP,
  ANNA_PHONE,
  BEN,
  BEN_LAPTOP,
  client,
  CONSOLE_CLIENT,
  role,
} from "../people/support/hub.ts";
import { Disk, errorOf, okBody, PhoneHub, replyTo } from "./support/phone-hub.ts";

const UNAUTHORIZED_MS: AppErrorV2 = {
  code: "unauthorized",
  detail: { permission: "manageSystem" },
};

/** User management on: Anna has manage system, Ben nothing; Ben has a phone too (client 10). */
function managedDisk(): Disk {
  const disk = new Disk();
  disk.people.userManagement = true;
  disk.people.roles.set(ANNA, role(ANNA, true, true));
  disk.people.roles.set(BEN, role(BEN, false, false));
  disk.people.clients.set(clientId(10), client(10, 2, { kind: ClientKind.Phone }));
  return disk;
}
const BEN_PHONE = clientId(10);

function ask(
  hub: PhoneHub,
  who: Parameters<PhoneHub["connect"]>[0],
  op: Parameters<PhoneHub["request"]>[2],
  proto: 1 | 2 = 2,
) {
  const conn = hub.connect(who, proto, who === CONSOLE_CLIENT ? "console" : "lan");
  const asked = hub.request(conn, who, op);
  return { reply: replyTo(asked.effects, conn), effects: asked.effects };
}

describe("routing version 2's operations to their owners", () => {
  test("relay.set's own refusal reaches a version 2 session as it is", () => {
    const hub = new PhoneHub().boot();
    const { reply } = ask(hub, ANNA_PHONE, { op: "relay.set", body: { url: "ws://8.8.8.8:7000" } });
    expect(errorOf(reply)).toEqual(RELAY_SET_REFUSALS.notLocal);
  });

  test("update.offers and update.fetch go to upkeep, after app's check of manage system", () => {
    const hub = new PhoneHub(managedDisk()).boot();
    expect(okBody(ask(hub, ANNA_PHONE, { op: "update.offers", body: {} }).reply)).toEqual({
      offer: null,
    });
    expect(errorOf(ask(hub, BEN_LAPTOP, { op: "update.offers", body: {} }).reply)).toEqual(
      UNAUTHORIZED_MS,
    );
    expect(
      errorOf(ask(hub, BEN_LAPTOP, { op: "update.fetch", body: { version: "9.9.9" } }).reply),
    ).toEqual(UNAUTHORIZED_MS);
    // Anna may: upkeep answers (no such offer).
    const fetched = errorOf(
      ask(hub, ANNA_PHONE, { op: "update.fetch", body: { version: "9.9.9" } }).reply,
    );
    expect(fetched).not.toEqual(UNAUTHORIZED_MS);
    expect(fetched).not.toEqual({ code: "notBuilt", detail: { op: "update.fetch" } });
  });

  test("backup.keyHeld goes to upkeep: the phone's own; a stale epoch is refused there", () => {
    const hub = new PhoneHub().boot();
    const epoch = hub.state.upkeep.key?.epoch ?? expect.unreachable();
    expect(
      errorOf(ask(hub, ANNA_PHONE, { op: "backup.keyHeld", body: { epoch: epoch + 1 } }).reply),
    ).toEqual({ code: "invalid", detail: { field: "epoch", reason: "range" } });
    expect(okBody(ask(hub, ANNA_PHONE, { op: "backup.keyHeld", body: { epoch } }).reply)).toEqual(
      {},
    );
    expect(errorOf(ask(hub, ANNA_LAPTOP, { op: "backup.keyHeld", body: { epoch } }).reply)).toEqual(
      NOT_A_PHONE,
    );
  });

  test("pair.* need manage system", () => {
    const hub = new PhoneHub(managedDisk()).boot();
    expect(
      errorOf(
        ask(hub, BEN_PHONE, {
          op: "pair.prepare",
          body: { identity: `f102${"00".repeat(20)}`, name: "x" },
        }).reply,
      ),
    ).toEqual(UNAUTHORIZED_MS);
    expect(
      errorOf(
        ask(hub, BEN_PHONE, { op: "pair.finish", body: { device: 11, result: "f10400" } }).reply,
      ),
    ).toEqual(UNAUTHORIZED_MS);
  });

  test("a version 2 operation on a version 1 session is protoUnsupported (the shell refuses it first)", () => {
    const hub = new PhoneHub().boot();
    const { reply } = ask(hub, ANNA_PHONE, { op: "presence.set", body: { away: true } }, 1);
    expect(errorOf(reply)).toEqual({ code: "protoUnsupported", detail: { speaks: [1, 2] } });
    expect(hub.state.app.presence.size).toBe(0);
  });
});

describe("site.wifi (m3-design section 5)", () => {
  function secretIn(effects: readonly Effect[], secret: string): boolean {
    return JSON.stringify(effects, (_k, v: unknown) =>
      v instanceof Uint8Array ? new TextDecoder().decode(v) : v,
    ).includes(secret);
  }

  test("version 2: manage system from any client; the password is in no record and no event", () => {
    const hub = new PhoneHub(managedDisk()).boot();
    const secret = "sesame-open-42";
    const { reply, effects } = ask(hub, ANNA_PHONE, {
      op: "site.wifi",
      body: { name: "home-5g", password: secret },
    });
    expect(okBody(reply)).toMatchObject({ wifiName: "home-5g" });
    const commands = effects.flatMap((e) =>
      e.kind === "record" && e.record.kind === "command" ? [e.record.row] : [],
    );
    expect(commands.map((c) => [c.kind, c.args])).toEqual([
      ["site.wifi", JSON.stringify({ name: "home-5g", password: "***" })],
    ]);
    // Neither a record, nor a reply or event, nor anything but the site row holds the password.
    const notTheRow = effects.filter((e) => !(e.kind === "write" && e.op.table === "site"));
    expect(secretIn(notTheRow, secret)).toBe(false);
    expect(new TextDecoder().decode(hub.state.site.row.wifiPassword)).toBe(secret);
  });

  test("version 2 without manage system: unauthorized", () => {
    const hub = new PhoneHub(managedDisk()).boot();
    expect(
      errorOf(ask(hub, BEN_PHONE, { op: "site.wifi", body: { name: "a", password: "b" } }).reply),
    ).toEqual(UNAUTHORIZED_MS);
  });

  test("version 1 keeps version 1's rule: the console only", () => {
    const hub = new PhoneHub().boot();
    expect(
      errorOf(
        ask(hub, ANNA_LAPTOP, { op: "site.wifi", body: { name: "a", password: "b" } }, 1).reply,
      ),
    ).toEqual({ code: "consoleOnly", detail: {} });
    expect(
      errorOf(
        ask(hub, CONSOLE_CLIENT, { op: "site.wifi", body: { name: "a", password: "b" } }, 1).reply,
      ),
    ).toBeUndefined();
  });
});

describe("presence (m3-design section 6)", () => {
  function offers(effects: readonly Effect[]) {
    return effects.flatMap((e) =>
      e.kind === "record" &&
      e.record.kind === "decision" &&
      e.record.row.kind.startsWith("presence_")
        ? [
            {
              kind: e.record.row.kind,
              detail: [...(e.record.row.detail ?? [])],
              value: e.record.row.value,
            },
          ]
        : [],
    );
  }
  const say = (hub: PhoneHub, phone: Parameters<PhoneHub["connect"]>[0], away: boolean) =>
    ask(hub, phone, { op: "presence.set", body: { away } });

  function arm(hub: PhoneHub): void {
    hub.command({ kind: "arm", sensors: ["front"], continue: true });
    expect(hub.state.alarm.sensors.get(deviceId(11))?.arm).not.toBe(ArmState.Disarmed);
  }

  test("only a phone's own report; a browser, the console are refused", () => {
    const hub = new PhoneHub().boot();
    expect(errorOf(say(hub, ANNA_LAPTOP, true).reply)).toEqual(NOT_A_PHONE);
    expect(errorOf(say(hub, CONSOLE_CLIENT, true).reply)).toEqual(NOT_A_PHONE);
    expect(okBody(say(hub, ANNA_PHONE, true).reply)).toEqual({});
  });

  test("Away is offered when the last opted-in person leaves, not before, and once", () => {
    const hub = new PhoneHub(managedDisk()).boot();
    expect(offers(say(hub, ANNA_PHONE, false).effects)).toEqual([]);
    expect(offers(say(hub, BEN_PHONE, true).effects)).toEqual([]);
    const last = offers(say(hub, ANNA_PHONE, true).effects);
    expect(last).toEqual([
      { kind: "presence_offer_away", detail: [...peopleDetail([ANNA, BEN])], value: null },
    ]);
    // The same report again offers nothing more.
    expect(offers(say(hub, ANNA_PHONE, true).effects)).toEqual([]);
  });

  test("no Away offer while anything is armed", () => {
    const hub = new PhoneHub(managedDisk()).boot();
    arm(hub);
    expect(offers(say(hub, ANNA_PHONE, true).effects)).toEqual([]);
  });

  test("Disarm is offered to the person who arrives while armed, and only then", () => {
    const hub = new PhoneHub(managedDisk()).boot();
    say(hub, ANNA_PHONE, true);
    say(hub, BEN_PHONE, true);
    arm(hub);
    expect(offers(say(hub, BEN_PHONE, false).effects)).toEqual([
      { kind: "presence_offer_disarm", detail: [...peopleDetail([BEN])], value: BEN },
    ]);
    // Arriving again (already home) offers nothing.
    expect(offers(say(hub, BEN_PHONE, false).effects)).toEqual([]);
  });

  test("an arrival not known to have left (after a restart) still offers Disarm while armed", () => {
    const hub = new PhoneHub(managedDisk()).boot();
    arm(hub);
    expect(offers(say(hub, ANNA_PHONE, false).effects).map((o) => o.kind)).toEqual([
      "presence_offer_disarm",
    ]);
  });

  test("no Disarm offer when disarmed, nor for a person whose other phone is home", () => {
    const hub = new PhoneHub(managedDisk()).boot();
    expect(offers(say(hub, ANNA_PHONE, false).effects)).toEqual([]);
    const second = clientId(11);
    const disk = managedDisk();
    disk.people.clients.set(second, client(11, 1, { kind: ClientKind.Phone }));
    const two = new PhoneHub(disk).boot();
    ask(two, ANNA_PHONE, { op: "presence.set", body: { away: false } });
    arm(two);
    expect(offers(say(two, second, false).effects)).toEqual([]);
  });

  test("a removed phone is forgotten: its person no longer counts", () => {
    const hub = new PhoneHub(managedDisk()).boot();
    say(hub, BEN_PHONE, false);
    hub.input({ kind: "clientRemoved", client: BEN_PHONE } as never);
    expect(hub.state.app.presence.has(BEN_PHONE)).toBe(false);
    expect(offers(say(hub, ANNA_PHONE, true).effects).map((o) => o.kind)).toEqual([
      "presence_offer_away",
    ]);
  });

  test("the detail lists people in number order, u32 little-endian", () => {
    expect([...peopleDetail([personId(258), personId(1)])]).toEqual([1, 0, 0, 0, 2, 1, 0, 0]);
  });
});

describe("the addresses apps are given (m2-design.md section 5, `a=`)", () => {
  test("IPv4 first, IPv6 shortest, no link-local, no zone, nothing else, each once", () => {
    expect(
      appAddresses([
        "fe80::1",
        "FE80:0:0:0:1c2b:3cff:fe4d:5e6f",
        "febf::1",
        "fec0::1",
        "fd00:0:0:0:0:0:0:10",
        "fd00::10",
        "192.168.1.10",
        "fe80::1%en0",
        "not an address",
        "169.254.3.4",
        "192.168.1.10",
      ]),
    ).toEqual(["192.168.1.10", "169.254.3.4", "fec0::1", "fd00::10"]);
  });

  test("RFC 5952: the longest run of zeros, the first on a tie, never a single group", () => {
    expect(shortestIpv6("2001:db8:0:0:1:0:0:1")).toBe("2001:db8::1:0:0:1");
    expect(shortestIpv6("2001:db8:0:0:0:1:0:0")).toBe("2001:db8::1:0:0");
    expect(shortestIpv6("2001:db8:0:1:1:1:1:1")).toBe("2001:db8:0:1:1:1:1:1");
    expect(shortestIpv6("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    expect(shortestIpv6("0:0:0:0:0:0:0:0")).toBe("::");
    expect(shortestIpv6("1::2::3")).toBeUndefined();
    expect(shortestIpv6("1:2:3:4:5:6:7")).toBeUndefined();
    expect(shortestIpv6("1:2:3:4:5:6:7:8:9")).toBeUndefined();
  });

  test("link-local is fe80::/10 exactly", () => {
    expect(isLinkLocalIpv6("fe80::")).toBe(true);
    expect(isLinkLocalIpv6("febf:ffff::")).toBe(true);
    expect(isLinkLocalIpv6("fe7f::1")).toBe(false);
    expect(isLinkLocalIpv6("fec0::1")).toBe(false);
  });

  test("link codes list only those (a link.create's QR code)", () => {
    const hub = new PhoneHub().boot();
    hub.input({
      kind: "hubFacts",
      version: "2.0.0",
      addresses: ["fe80::1", "fd00::10", "192.168.1.10"],
      appsPort: 8444,
      consolePort: 8445,
      certificateSha256: new Uint8Array(32).fill(0xab),
    });
    const qr = String(
      okBody(
        ask(hub, ANNA_PHONE, { op: "link.create", body: { kind: "ownDevice", form: "qr" } }).reply,
      ).qr,
    );
    expect(new URLSearchParams(qr.split("?")[1]).get("a")).toBe("192.168.1.10,fd00::10");
  });
});

describe("replies by version (replyOf)", () => {
  const error: AppErrorV2 = { code: "invalid", detail: { field: "url", reason: "notLocal" } };

  test("a version 2 error as it is on version 2; protoUnsupported on version 1", () => {
    expect(replyOf(4, { ok: false, error }, 2)).toEqual({ t: "res", id: 4, ok: false, error });
    expect(replyOf(4, { ok: false, error }, 1)).toEqual({
      t: "res",
      id: 4,
      ok: false,
      error: { code: "protoUnsupported", detail: { speaks: [1, 2] } },
    });
    const v1: unknown = replyOf(4, { ok: false, error });
    expect(v1).toEqual(replyOf(4, { ok: false, error }, 1));
  });

  test("a version 1 error is the same in both", () => {
    const v1: AppErrorV2 = { code: "notFound", detail: { what: "device", id: 3 } };
    expect(replyOf(1, { ok: false, error: v1 }, 2)).toEqual(
      replyOf(1, { ok: false, error: v1 }, 1),
    );
  });

  test("a kept version 2 reply is read back at boot", () => {
    const kept = replyOf(9, { ok: false, error }, 2);
    expect(decodeReply(encodeReply(kept))).toEqual(kept);
  });
});
