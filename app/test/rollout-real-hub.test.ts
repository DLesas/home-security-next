/** A real hub starts a rollout, pauses on a device rollback, and accepts the app's Resume. */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
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
import { realTimers } from "../src/hub/wire";
import * as phoneKeys from "../src/platform/keys.native";
import { memorySecureItems } from "../src/platform/vault";
import { rolloutView } from "../src/state/rollout";
import { type RealHub, startRealHub, stopAllHubs } from "./support/real-hub";

const VERSION = "1.1.0";
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) clean();
  await stopAllHubs();
});

/** Reaches the test hub the same way as the separately tested version 2 phone client. */
const makeSocket: MakeSocket = (url, origin) => {
  const options = { headers: { Origin: origin }, tls: { rejectUnauthorized: false } };
  return new WebSocket(url, options as unknown as string[]) as unknown as SocketLike;
};

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
  const opened = await Session.open(socketPath(hub.dataDir));
  if (opened.isErr()) return expect.unreachable("hub control connection did not open");
  const control = opened.value;
  cleanups.push(() => {
    control.close();
  });
  const image = await stage(control);
  const invite = await controlOp(control, "link.create", {
    kind: { newPerson: { name: "Test resident" } },
    form: "qr",
  });
  if (invite.qr === undefined) return expect.unreachable("hub returned no link code");
  const code = readCode(invite.qr);
  if (!code.ok || code.value.kind !== "link")
    return expect.unreachable("hub returned an invalid link code");
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
  await phone.client.link(code.value.secret, "qr", { name: "Test phone", kind: "phone" });
  expect(await waitFor(() => phone.client.live.getState().rev !== null, 5000)).toBe(true);
  const view = rolloutView(phone.client, phone);
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
