/**
 * The relay and B3's push service together (docs/m4-design.md sections 3 and 5): the relay's own
 * key proved on its relay link (`PushLink`, the operated relay's `PushSender`) to the push service
 * on its local socket; a hub's pushes and the relay's own alert reach the push service's dispatch
 * naming the hub the relay authenticated, with the target and `h` as the roster gave them.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { RelayPushItem } from "@hsn/protocol/relay";
import { SYSTEM_CLOCK } from "../src/push/clock.ts";
import { jsonLineLog } from "../src/push/log.ts";
import type { ServiceOutcome } from "../src/push/outcomes.ts";
import { PushLink } from "../src/push/push-link.ts";
import { type PushDispatch, PushService } from "../src/push/push-service.ts";
import { listen, type PushListeners } from "../src/push/server.ts";
import { loadOrMakeRelayKey } from "../src/shell/relay-key.ts";
import {
  cleanup,
  ManualClock,
  must,
  sealedH,
  StandInHub,
  startRelay,
  target,
  tempFolder,
  type TestRelay,
  until,
} from "./helpers.ts";

class Dispatch implements PushDispatch {
  readonly sent: RelayPushItem[] = [];
  send(item: RelayPushItem): Promise<ServiceOutcome> {
    this.sent.push(item);
    return Promise.resolve({ kind: "delivered" });
  }
}

let folder: string;
let t: TestRelay;
let link: PushLink;
let listeners: PushListeners;
let dispatch: Dispatch;
let service: PushService;

beforeEach(() => {
  folder = tempFolder();
  const pushLog = jsonLineLog(
    () => undefined,
    () => 0,
  );
  dispatch = new Dispatch();
  service = new PushService({ dispatch, version: "0.1.0", clock: SYSTEM_CLOCK, log: pushLog });
  const socketPath = join(folder, "p.sock");
  listeners = must(listen(service, { socketPath }));
  link = new PushLink({
    url: `ws+unix://${socketPath}:/v1/relay`,
    staticKey: must(loadOrMakeRelayKey(folder)),
    version: "0.1.0",
    clock: SYSTEM_CLOCK,
    log: pushLog,
  });
  link.start();
});

afterEach(async () => {
  link.stop();
  await t.stop();
  await listeners.stop();
  cleanup(folder);
});

test("a hub's pushes and the relay's alert reach the push service, naming the hub", async () => {
  const clock = new ManualClock(Date.UTC(2026, 10, 18, 12));
  t = startRelay(folder, { clock, sender: link });
  await until(() => link.up, "the relay link to join", 5000);
  const hub = await StandInHub.connect(t.url);
  await hub.next("joined");
  hub.send({ t: "roster", rev: 1, targets: [target(1)] });
  await hub.next("rosterAck");
  const h = sealedH(target(1).key, "w");
  hub.send({ t: "push", items: [{ id: 7, key: target(1).key, h }] });
  expect((await hub.next("pushResult")).results).toEqual([{ id: 7, outcome: "accepted" }]);
  expect(dispatch.sent.map((i) => ({ hub: i.hub, token: i.token, h: i.h }))).toEqual([
    { hub: hub.identity, token: target(1).token, h },
  ]);
  hub.client.close();
  await until(() => t.relay.counts.joined === 0, "the link to close");
  clock.advance(180_000);
  await until(() => dispatch.sent.length === 2, "the alert");
  expect(dispatch.sent[1]?.h).toBe(target(1).unreachable);
  expect(dispatch.sent[1]?.hub).toBe(hub.identity);
  expect(service.linkCount).toBe(1);
});
