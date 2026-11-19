import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  cleanup,
  hubKey,
  sealedH,
  settle,
  StandInHub,
  startRelay,
  target,
  tempFolder,
  until,
} from "./helpers.ts";

let folder: string;
let relay: ReturnType<typeof startRelay>;

beforeEach(() => {
  folder = tempFolder();
  relay = startRelay(folder);
});

afterEach(async () => {
  await relay.stop();
  cleanup(folder);
});

test("an old token's delayed refusal preserves the phone's refreshed registration", async () => {
  const hub = await StandInHub.connect(relay.url);
  await hub.next("joined");
  const original = target(1);
  const refreshed = { ...original, token: target(2).token };
  hub.send({ t: "roster", rev: 1, targets: [original] });
  await hub.next("rosterAck");

  let reply = (): void => undefined;
  relay.push.hold = new Promise<void>((resolve) => {
    reply = resolve;
  });
  relay.push.outcome = (item) => (item.token === original.token ? "badToken" : "accepted");
  hub.send({ t: "push", items: [{ id: 1, key: original.key, h: sealedH(original.key) }] });
  await until(() => relay.push.sent.length === 1, "the original push");

  hub.send({ t: "roster", rev: 2, targets: [refreshed] });
  await hub.next("rosterAck");
  reply();
  await hub.next("pushResult");

  hub.send({ t: "push", items: [{ id: 2, key: refreshed.key, h: sealedH(refreshed.key) }] });
  expect((await hub.next("pushResult")).results[0]?.outcome).toBe("accepted");
});

test("a delayed unreachable refusal preserves a refreshed last target and its next alert", async () => {
  const key = hubKey();
  const hub = await StandInHub.connect(relay.url, { key });
  await hub.next("joined");
  const original = target(1);
  const refreshed = { ...original, token: target(2).token };
  hub.send({ t: "roster", rev: 1, targets: [original] });
  await hub.next("rosterAck");
  const held = Promise.withResolvers<undefined>();
  relay.push.hold = held.promise;
  relay.push.outcome = (item) => (item.token === original.token ? "badToken" : "accepted");
  hub.client.close();
  await until(() => relay.relay.counts.joined === 0, "the first link to close");
  relay.clock.advance(180_000);
  await until(() => relay.push.items.length === 1, "the unreachable alert");

  const back = await StandInHub.connect(relay.url, { key });
  await back.next("joined");
  back.send({ t: "roster", rev: 2, targets: [refreshed] });
  await back.next("rosterAck");
  held.resolve(undefined);
  await settle();
  expect(relay.store.targets(hub.identity)._unsafeUnwrap()[0]?.token === refreshed.token).toBe(
    true,
  );

  const before = relay.push.items.length;
  back.client.close();
  await until(() => relay.relay.counts.joined === 0, "the second link to close");
  relay.clock.advance(180_000);
  await until(() => relay.push.items.length === before + 1, "the next unreachable alert");
  expect(relay.push.items[before]?.token === refreshed.token).toBe(true);
});
