/**
 * The relay's log (docs/m4-design.md section 3, "What the relay stores"): counts and errors only,
 * no identity together with an IP address, and no content. A whole scenario runs with every kind
 * of event (joins, refusals, streams, rosters, pushes, alerts, releases, limits, a restart), the
 * log is captured, and searched for every identity, address, pseudonym, token, key id, sealed `h`
 * and carried byte the scenario used.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReleaseBudget } from "../src/core/release-budget.ts";
import { FolderReleaseIndex } from "../src/releases/folder-index.ts";
import { ReleaseService } from "../src/releases/service.ts";
import {
  Client,
  cleanup,
  hubKey,
  ManualClock,
  memoryLog,
  must,
  sealedH,
  StandInHub,
  startRelay,
  target,
  tempFolder,
  type TestRelay,
  until,
} from "./helpers.ts";

let folder: string;
let t: TestRelay;

beforeEach(() => {
  folder = tempFolder();
});

afterEach(async () => {
  await t.stop();
  cleanup(folder);
});

test("no identity, address, pseudonym or content reaches the log", async () => {
  const clock = new ManualClock(Date.UTC(2026, 10, 18, 12));
  const releasesFolder = join(folder, "releases");
  mkdirSync(releasesFolder);
  writeFileSync(join(releasesFolder, "hsn-firmware-1.0.0.hsnf"), "HSNF not a real one");
  const index = new FolderReleaseIndex(releasesFolder, memoryLog());
  must(await index.refresh());
  t = startRelay(folder, {
    clock,
    trustedProxies: ["127.0.0.1"],
    releases: new ReleaseService(index, new ReleaseBudget(), clock, memoryLog()),
  });
  // The relay's log and the releases role's are one in the program; here the relay's is searched,
  // and the releases role's events go to it too.
  const log = t.log;
  const service = new ReleaseService(index, new ReleaseBudget(), clock, log);
  const hubAddress = "198.51.100.23";
  const phoneAddress = "2001:db8:aa:bb::77";
  const secret = new TextEncoder().encode("SECRET-CONTENT-OF-A-NOISE-MESSAGE");

  // Hubs: one joins and works, one is refused for its address's new identities, one's key is bad.
  const key = hubKey();
  const hub = await StandInHub.connect(t.url, { key, address: hubAddress });
  await hub.next("joined");
  const roster = [target(1), target(2)];
  hub.send({ t: "roster", rev: 1, targets: roster });
  await hub.next("rosterAck");
  const h = sealedH(target(1).key, "Q");
  hub.send({ t: "push", items: [{ id: 1, key: target(1).key, h }] });
  await hub.next("pushResult");
  const others: string[] = [];
  for (let i = 0; i < 3; i++) {
    const other = await StandInHub.connect(t.url, { address: hubAddress });
    others.push(other.identity);
    other.client.close();
  }
  const bad = new Client(`${t.url}/v1/hub`, "203.0.113.5");
  await bad.open();
  bad.send(new Uint8Array(40));
  await bad.closed();

  // A phone's stream, with content both ways, then over a limit.
  const phone = new Client(`${t.url}/v1/phone/${key.identity}/session`, phoneAddress);
  await phone.open();
  const open = await hub.next("open");
  phone.send(secret);
  hub.sendStream(open.stream, secret);
  await until(() => phone.binaries.length === 1, "the hub's message");
  phone.send("text closes it");
  await phone.closed();
  const absent = new Client(`${t.url}/v1/phone/${hubKey().identity}/link`, phoneAddress);
  await absent.closed();

  // Releases: a refusal of each kind.
  hub.send({ t: "release.get", id: 1, file: "hsn-firmware-9.9.9.hsnf", offset: 0, length: 1 });
  await hub.next("release.error");
  await service.get(
    { kind: "hub", identity: key.identity, address: hubAddress },
    {
      id: 2,
      file: "hsn-firmware-9.9.9.hsnf",
      offset: 0,
      length: 1,
    },
  );

  // The hub goes away; its alert; a token refused; it returns.
  t.push.outcome = (item) => (item.token === target(2).token ? "badToken" : "accepted");
  hub.client.close();
  await until(() => t.relay.counts.joined === 0, "the link to close");
  clock.advance(200_000);
  await until(() => t.push.items.length === 3, "the alerts");
  const back = await StandInHub.connect(t.url, { key, address: hubAddress });
  await back.next("joined");
  t.relay.setRefused(new Set([key.identity]));
  await back.client.closed();

  const text = log.text();
  expect(text.length).toBeGreaterThan(0);
  const pseudonym = open.peer;
  const forbidden = [
    key.identity,
    ...others,
    hubAddress,
    phoneAddress,
    "2001:db8:aa:bb",
    "203.0.113.5",
    "127.0.0.1",
    pseudonym,
    pseudonym.slice("relay-".length),
    ...roster.flatMap((x) => [x.key, x.token, x.unreachable.slice(0, 40), x.back.slice(0, 40)]),
    h.slice(0, 40),
    "SECRET-CONTENT",
    Buffer.from(secret).toString("hex").slice(0, 16),
    Buffer.from(secret).toString("base64").slice(0, 16),
  ];
  for (const value of forbidden) expect(text.includes(value)).toBe(false);
  // Only the fields the log's types allow: words, numbers and booleans, never free text.
  for (const line of log.lines) {
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(typeof record.event).toBe("string");
    for (const [field, value] of Object.entries(record)) {
      if (field === "error" || field === "at") continue;
      expect(["string", "number", "boolean"]).toContain(typeof value);
      if (typeof value === "string") expect(value).toMatch(/^[a-zA-Z]+$/u);
    }
  }
});
