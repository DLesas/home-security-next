/** Exercises phone Resume and web Updates against the real hub's app listener. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createElement } from "react";
import {
  Direction,
  MaxPacketLength,
  MessageType,
  NO_BINDING,
  Role,
  sealPacket,
  toHex,
} from "@hsn/protocol";
import {
  APP_OPS_V2,
  type AppOpBodyV2,
  type AppOpNameV2,
  type AppOpReplyV2,
} from "@hsn/protocol/app";
import { Session } from "../../hub/cli/client";
import { socketPath } from "../../hub/cli/paths";
import { mono } from "../../hub/src/core/model/time";
import { DEVICE_PATH } from "../../hub/src/shell/links/websocket";
import { GATEWAY, HOME_KEYS, SENSOR, seedHome } from "../../hub/test/relay/home";
import { waitFor } from "../../hub/test/relay/processes";
import { rolledBack } from "../../hub/test/unit/firmware/support";
import { espImage, sha256 } from "../../hub/test/unit/shell-firmware/support";
import { SeededBytes } from "../../hub/test/world/entropy";
import { ScriptedGateway } from "../../hub/test/world/scripted-gateway";
import { type MakeSocket, NO_FINDER, readCode, type SocketLike } from "../src/hub/finder";
import { startPhoneClient } from "../src/hub/phone-client";
import { PHONE_PROTO } from "../src/hub/restore";
import { createWebHubClient } from "../src/hub/start.web";
import { realTimers } from "../src/hub/wire";
import { memoryRecordStore } from "../src/platform/client-key";
import * as phoneKeys from "../src/platform/keys.native";
import { memorySecureItems } from "../src/platform/vault";
import { rolloutView } from "../src/state/rollout";
import { clientScreen, screenAct } from "./support/client-screen";
import { connectFrom, type RealHub, startRealHub, stopAllHubs } from "./support/real-hub";
import { screenWorld, textOf } from "./support/screens";

const VERSION = "1.1.0";
const cleanups: (() => void)[] = [];
let screen: ReturnType<typeof clientScreen> | undefined;

afterEach(async () => {
  await screen?.close();
  screen = undefined;
  for (const clean of cleanups.splice(0).reverse()) clean();
  await stopAllHubs();
});

/** Reaches the test hub the same way as the separately tested version 2 phone client. */
const makeSocket: MakeSocket = (url, origin) => {
  const options = { headers: { Origin: origin }, tls: { rejectUnauthorized: false } };
  return new WebSocket(url, options as unknown as string[]) as unknown as SocketLike;
};

/** Opens a control session for setup, keeping uploads on a single connection. */
async function openControl(hub: RealHub): Promise<Session> {
  const opened = await Session.open(socketPath(hub.dataDir));
  if (opened.isErr()) return expect.unreachable("hub control connection did not open");
  const control = opened.value;
  cleanups.push(() => {
    control.close();
  });
  return control;
}

/** Sends a test setup operation over the local control socket and parses its success body. */
async function controlOp<Op extends AppOpNameV2>(
  control: Session,
  op: Op,
  body: AppOpBodyV2<Op>,
): Promise<AppOpReplyV2<Op>> {
  const answer = await control.request("test", { kind: "op", op, body }, 5000);
  if (answer.isErr() || !answer.value.reply.ok || answer.value.reply.result.kind !== "op")
    return expect.unreachable(`setup operation failed: ${op}`);
  const checked = APP_OPS_V2[op].reply.safeParse(answer.value.reply.result.body);
  if (!checked.success) return expect.unreachable(`setup operation failed: ${op}`);
  return checked.data as AppOpReplyV2<Op>;
}

/** Makes a real link for a new test resident without recording the code. */
async function residentLink(control: Session, name: string) {
  const invite = await controlOp(control, "link.create", {
    kind: { newPerson: { name } },
    form: "qr",
  });
  if (invite.qr === undefined) return expect.unreachable("hub returned no link code");
  const code = readCode(invite.qr);
  if (!code.ok || code.value.kind !== "link")
    return expect.unreachable("hub returned an invalid link code");
  return code.value.secret;
}

/** Links the production web client as an ordinary person on the LAN listener. */
async function linkWeb(hub: RealHub, control: Session, resident: string) {
  const client = createWebHubClient({
    connect: connectFrom(hub.lanOrigin ?? expect.unreachable("no LAN listener")),
    records: memoryRecordStore(),
    timers: realTimers,
    app: "0.1.0",
  });
  cleanups.push(() => {
    client.stop();
  });
  client.start();
  await client.link(await residentLink(control, resident), "qr", {
    name: "Test browser",
    kind: "web",
  });
  expect(await waitFor(() => client.live.getState().session !== null, 5000)).toBe(true);
  expect(client.live.getState().hub?.proto).toBe(2);
  return client;
}

/** Stages the hub's own image fixture just as the firmware CLI uploads a build. */
async function stage(control: Session) {
  const image = espImage({ version: VERSION, size: 20_000 });
  const job = 7;
  const chunk = await control.request(
    "test",
    {
      kind: "fileChunk",
      job,
      n: 0,
      data: Buffer.from(image).toString("base64url"),
      end: { chunks: 1, sha256: toHex(sha256(image)) },
    },
    5000,
  );
  expect(chunk.isOk() && chunk.value.reply.ok).toBe(true);
  return controlOp(control, "firmware.upload", {
    job,
    own: { version: VERSION },
    confirmOwn: true,
  });
}

/** Looks up the fixture's public device addresses, then forwards a real authenticated rollback. */
async function reportRollback(hub: RealHub) {
  const db = new Database(join(hub.dataDir, "hub.db"), { readonly: true });
  const address = db.query<{ address: number }, [number]>(
    "SELECT address FROM devices WHERE id = ?",
  );
  const gatewayAddress = address.get(GATEWAY)?.address;
  const sensorAddress = address.get(SENSOR)?.address;
  db.close(true);
  const [gatewayKey, sensorKey] = HOME_KEYS;
  if (
    gatewayAddress === undefined ||
    sensorAddress === undefined ||
    gatewayKey === undefined ||
    sensorKey === undefined
  )
    return expect.unreachable("the test home was not seeded");

  const random = new SeededBytes(5);
  const gateway = new ScriptedGateway({
    key: gatewayKey,
    address: gatewayAddress,
    nextRandom: () => random.bytes(8),
  });
  const socket = new WebSocket(`ws://127.0.0.1:${hub.devicePort}${DEVICE_PATH}`);
  cleanups.push(() => {
    socket.close();
  });
  socket.binaryType = "arraybuffer";
  const start = performance.now();
  /** Timestamps packets on the same monotonic time base as the test gateway. */
  const now = () => mono(Math.round((performance.now() - start) * 1000));
  socket.onopen = () => {
    const hello = gateway.hello();
    if (hello !== undefined) socket.send(hello);
  };
  socket.onmessage = (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    for (const frame of gateway.receive(new Uint8Array(event.data), now())) socket.send(frame);
  };
  expect(await waitFor(() => gateway.settings !== undefined, 5000)).toBe(true);
  const packet = sealPacket(
    {
      type: MessageType.Started,
      role: Role.Sensor,
      firmwareVersion: { major: 1, minor: 0, patch: 0 },
      resetCause: 3,
      lastFatalError: 0,
      settingsVersion: 1,
    },
    {
      key: sensorKey,
      direction: Direction.ToHub,
      address: sensorAddress,
      counter: 1,
      binding: NO_BINDING,
      maxLength: MaxPacketLength.Radio,
      startedImage: rolledBack(0x010100),
    },
  );
  const forwarded = gateway.forward(packet, {
    endedAt: now(),
    rssiDbm: -92,
    snrQuarterDb: 24,
    dataRate: 5,
    siteChannel: 1,
  });
  if (forwarded === undefined) return expect.unreachable("gateway could not forward the rollback");
  socket.send(forwarded);
}

test("resuming in the app records rollout_resumed in the real hub", async () => {
  const hub = await startRealHub(seedHome);
  const control = await openControl(hub);
  const image = await stage(control);
  const phone = startPhoneClient({
    items: memorySecureItems(),
    makeSocket,
    finder: NO_FINDER,
    timers: realTimers,
    app: "0.1.0",
    proto: PHONE_PROTO,
    keys: phoneKeys,
  });
  cleanups.push(() => {
    phone.client.stop();
  });
  phone.client.start();
  await phone.client.link(await residentLink(control, "Test resident"), "qr", {
    name: "Test phone",
    kind: "phone",
  });
  expect(await waitFor(() => phone.client.live.getState().rev !== null, 5000)).toBe(true);
  const view = rolloutView(phone.client, phone.client.v2 ?? expect.unreachable());
  cleanups.push(view.watch());

  const started = await controlOp(control, "rollout.start", { image: image.id, devices: [SENSOR] });
  expect(started.stage).toBe("pilots");
  expect(await waitFor(() => view.store.getState().status?.rollout?.stage === "pilots", 5000)).toBe(
    true,
  );
  await reportRollback(hub);
  expect(await waitFor(() => view.store.getState().status?.rollout?.stage === "paused", 5000)).toBe(
    true,
  );
  expect(view.store.getState().status?.rollout?.paused).toEqual({
    reason: "rolledBack",
    device: SENSOR,
  });
  expect(view.store.getState().status?.devices[0]?.state).toBe("rolledBack");

  await view.run({ op: "rollout.resume", body: { rollout: started.id } });
  expect(view.store.getState().outcome).toEqual({ op: "rollout.resume", failure: undefined });
  expect(await waitFor(() => view.store.getState().status?.rollout?.stage === "pilots", 5000)).toBe(
    true,
  );
  const history = await phone.client.request("history.query", { kinds: ["decision"], limit: 100 });
  const recorded =
    history.ok &&
    history.body.rows.some(
      ({ row }) =>
        row.kind === "decision" &&
        row.row.kind === "rollout_resumed" &&
        row.row.value === started.id,
    );
  expect(recorded).toBe(true);
}, 40_000);

test("real web Updates shows an existing rollout only with manage system", async () => {
  const hub = await startRealHub(seedHome);
  const control = await openControl(hub);
  const image = await stage(control);
  // The rollout predates both clients' snapshots, so initial rendering has no live event to replay.
  await controlOp(control, "rollout.start", { image: image.id, devices: [SENSOR] });
  const manager = await linkWeb(hub, control, "Test manager");
  const guest = await linkWeb(hub, control, "Test guest");
  await controlOp(control, "userManagement.set", { on: true });
  const people = await controlOp(control, "people.list", {});
  const person = people.people.find(({ id }) => id === guest.live.getState().session?.person);
  if (person === undefined) return expect.unreachable("the guest was not linked as a person");
  await controlOp(control, "permissions.set", {
    person: person.id,
    ifRevision: person.revision,
    manageUsers: false,
    manageSystem: false,
    devices: [],
  });

  const { UpdatesScreen } = await import("../src/ui/updates");
  const shown = clientScreen();
  screen = shown;
  const guestForward = spyOn(guest.v2 ?? expect.unreachable(), "forward");
  await shown.render((await screenWorld({})).wrap(createElement(UpdatesScreen), guest));
  const statusCall = guestForward.mock.calls.findIndex(([op]) => op === "rollout.status");
  const result = guestForward.mock.results[statusCall];
  if (result?.type !== "return")
    return expect.unreachable("Updates did not ask for rollout status");
  await screenAct(async () => {
    expect(await result.value).toEqual({
      ok: false,
      error: { code: "unauthorized", detail: { permission: "manageSystem" } },
    });
    await Bun.sleep(10);
  });
  expect(textOf(shown.html())).not.toContain("Device update rollout");
  expect(textOf(shown.html())).not.toContain("Pause the rollout");
  guestForward.mockRestore();

  await shown.render((await screenWorld({})).wrap(createElement(UpdatesScreen), manager));
  expect(
    await waitFor(async () => {
      await screenAct(() => Bun.sleep(10));
      return textOf(shown.html()).includes("The first devices are updating.");
    }, 5000),
  ).toBe(true);
  expect(textOf(shown.html())).toContain("Device update rollout");
  expect(textOf(shown.html())).toContain(`Firmware ${VERSION}`);
  expect(shown.html()).toContain('aria-label="Pause the rollout"');
}, 40_000);
