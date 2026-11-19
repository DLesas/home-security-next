import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { UpstreamAnswer } from "../../src/releases/upstream.ts";
import { SYSTEM_CLOCK } from "../../src/push/clock.ts";
import { PushLink } from "../../src/push/push-link.ts";
import { PushService, ServiceDispatch } from "../../src/push/push-service.ts";
import { listen } from "../../src/push/server.ts";
import { cleanup, memoryLog, relayKey, tempFolder } from "./helpers.ts";
import { settle, until } from "../helpers.ts";

const stops: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

test("closing the releases route answers an outstanding catalogue check", async () => {
  const folder = tempFolder();
  stops.push(() => {
    cleanup(folder);
  });
  const socketPath = join(folder, "push.sock");
  const forwarded = Promise.withResolvers<() => void>();
  const service = new PushService({
    dispatch: new ServiceDispatch(undefined, undefined),
    version: "0.1.0",
    clock: SYSTEM_CLOCK,
    log: memoryLog(),
    openReleases: (_peer, _answer, gone) => ({
      forward() {
        forwarded.resolve(gone);
        return Promise.resolve(true);
      },
      close() {
        // The test drives the route's disconnect through the captured callback.
      },
    }),
  });
  const listeners = listen(service, { socketPath })._unsafeUnwrap();
  stops.push(() => listeners.stop());
  const link = new PushLink({
    url: `ws+unix://${socketPath}:/v1/relay`,
    staticKey: relayKey(),
    version: "0.1.0",
    clock: SYSTEM_CLOCK,
    log: memoryLog(),
  });
  stops.push(() => {
    link.stop();
  });
  const answers: UpstreamAnswer[] = [];
  link.attachReleases({
    answer: (answer) => answers.push(answer),
    linkDown() {
      // This observer keeps only the catalogue replies.
    },
    fill: () => Promise.resolve(0),
  });
  link.start();
  await until(() => link.up, "the relay link to join");
  expect(
    link.releaseChannel.send({ t: "release.check", platform: "linux-x64", running: "0.0.0" }),
  ).toBe(true);
  const closeRoute = await forwarded.promise;
  await settle();
  closeRoute();

  await until(() => answers.length > 0, "an answer to the forwarded release.check", 1000);
  expect(answers).toEqual([{ kind: "offer", releases: [] }]);
  expect(link.up).toBe(true);
});
