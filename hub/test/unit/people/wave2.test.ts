/**
 * Step 1, wave 2 rows of people (m2-design.md section 11): `askName` for the hub's message 2, and
 * which phone holds which backup key epoch.
 */
import { describe, expect, test } from "bun:test";
import { connId, tokenId } from "../../../src/core/model/ids.ts";
import { MODULES } from "../../../src/core/step.ts";
import {
  ANNA_LAPTOP,
  ANNA_PHONE,
  codeOf,
  entropy,
  household,
  Hub,
  linkSecrets,
  linkResults,
  nowWrites,
  onlyReply,
  rowWritten,
  testModules,
} from "./support/hub.ts";

function booted(modules = testModules()): Hub {
  const hub = new Hub(modules);
  hub.boot(household());
  return hub;
}

function askNameOf(hub: Hub, kind: unknown): unknown {
  const conn = hub.connect(ANNA_LAPTOP);
  const { effects } = hub.request(conn, ANNA_LAPTOP, {
    op: "link.create",
    body: { kind: kind as never, form: "code" },
  });
  const secret = linkSecrets(effects)[0];
  return secret !== undefined && "askName" in secret ? secret.askName : undefined;
}

describe("askName (section 5): the hub's message 2 asks the new person's name", () => {
  test("a new-person code made without a name asks; with one, or for one's own device, not", () => {
    expect(askNameOf(booted(), { newPerson: {} })).toBe(true);
    expect(askNameOf(booted(), { newPerson: { name: "Cleo" } })).toBe(false);
    expect(askNameOf(booted(), "ownDevice")).toBe(false);
  });

  test("the console's token never asks", () => {
    const hub = booted();
    const effects = hub.command({ kind: "consoleToken" });
    const secret = linkSecrets(effects)[0];
    expect(secret !== undefined && "askName" in secret ? secret.askName : undefined).toBe(false);
  });
});

describe("a phone's backup key epoch (sections 3 and 9)", () => {
  const withUpkeep = () => booted(testModules({ upkeep: MODULES.upkeep }));

  test("fetched with backup.key: the phone's row holds the epoch, written now; asked again, refused", () => {
    const hub = withUpkeep();
    const epoch = hub.state.upkeep.key?.epoch;
    const phone = hub.connect(ANNA_PHONE);
    const { effects } = hub.request(phone, ANNA_PHONE, { op: "backup.key", body: {} });
    expect(onlyReply(effects, phone)).toMatchObject({ ok: true, body: { epoch } });
    expect(
      rowWritten(
        effects.filter((e) => e.kind === "write" && e.durability === "now"),
        "clients",
        {
          id: ANNA_PHONE,
          backupKeyEpoch: epoch,
        },
      ),
    ).toBeDefined();
    expect(hub.state.people.clients.get(ANNA_PHONE)?.backupKeyEpoch).toBe(epoch);
    const again = hub.request(phone, ANNA_PHONE, { op: "backup.key", body: {} });
    expect(codeOf(onlyReply(again.effects, phone))).toBe("unauthorized");
    expect(nowWrites(again.effects).filter((op) => op.table === "clients")).toEqual([]);
  });

  test("a browser is refused the key, and no epoch is written", () => {
    const hub = withUpkeep();
    const laptop = hub.connect(ANNA_LAPTOP);
    const { effects } = hub.request(laptop, ANNA_LAPTOP, { op: "backup.key", body: {} });
    expect(codeOf(onlyReply(effects, laptop))).toBe("unauthorized");
    expect(hub.state.people.clients.get(ANNA_LAPTOP)?.backupKeyEpoch).toBeNull();
  });

  test("a browser linked is never given the key, and holds no epoch", () => {
    const hub = withUpkeep();
    const conn = hub.connect(ANNA_LAPTOP);
    hub.request(
      conn,
      ANNA_LAPTOP,
      { op: "link.create", body: { kind: "ownDevice", form: "code" } },
      { bytes: entropy([1, 2, 3], [1, 2, 3, 4, 5]) },
    );
    const effects = hub.input({
      kind: "linkCompleted",
      conn: connId(81),
      token: tokenId(1),
      staticKey: new Uint8Array(32).fill(0x72),
      listener: "lan",
      link: { name: "Anna's tablet", kind: "web" },
    });
    expect(linkResults(effects)[0]?.result).toEqual({ client: 10, person: 1 });
    expect(hub.state.people.clients.get(10 as never)?.backupKeyEpoch).toBeNull();
  });

  test("a phone linked is given the key in LinkResult, and its row holds the epoch", () => {
    const hub = withUpkeep();
    const conn = hub.connect(ANNA_LAPTOP);
    hub.request(
      conn,
      ANNA_LAPTOP,
      { op: "link.create", body: { kind: "ownDevice", form: "code" } },
      { bytes: entropy([1, 2, 3], [1, 2, 3, 4, 5]) },
    );
    const effects = hub.input({
      kind: "linkCompleted",
      conn: connId(80),
      token: tokenId(1),
      staticKey: new Uint8Array(32).fill(0x71),
      listener: "lan",
      link: { name: "Anna's new phone", kind: "phone" },
    });
    const key = hub.state.upkeep.key;
    expect(linkResults(effects)[0]?.result.backupKey?.epoch).toBe(key?.epoch);
    expect(linkResults(effects)[0]?.result.backupKey?.key).toBe(
      Buffer.from(key?.key ?? new Uint8Array()).toString("base64url"),
    );
    expect(hub.state.people.clients.get(10 as never)?.backupKeyEpoch).toBe(key?.epoch);
  });
});
