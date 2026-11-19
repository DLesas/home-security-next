/** The app's pairing functions over genuine security 2 and the running hub's channel. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { APP_OPS_V2, PAIR_PREPARE_REFUSALS, parseConsoleFragment } from "@hsn/protocol/app";
import { fromHex } from "@hsn/protocol/messages";
import { formatBoardQr, makePairingCode, readBoardQr } from "@hsn/protocol/pairing";
import { redirectSystemPath } from "../src/app/+native-intent";
import { claimPairingCode } from "../src/pairing/code-arrival";
import { createHubClient } from "../src/hub/client";
import { type MakeSocket, NO_FINDER, readCode, type SocketLike } from "../src/hub/finder";
import { startPhoneClient, type PhoneClient } from "../src/hub/phone-client";
import { realTimers } from "../src/hub/wire";
import { addBoard, findPairingBoards, pairingFlow } from "../src/pairing/pair-device";
import { phoneRequest, refusal } from "../src/pairing/hub";
import { memoryRecordStore } from "../src/platform/client-key";
import * as phoneKeys from "../src/platform/keys.native";
import { memorySecureItems } from "../src/platform/vault";
import { BleAir } from "../../tools/ble-bench/src/air/air";
import { ScriptedCentral } from "../../tools/ble-bench/src/air/central";
import {
  type BoardOptions,
  placeBoard,
  ScriptedBoard,
} from "../../tools/ble-bench/src/boards/board";
import { ManualClock } from "../../tools/ble-bench/src/clock";
import { Role } from "../../tools/ble-bench/src/test-keys";
import { settled } from "../../tools/ble-bench/test/support/raw-phone";
import { falseIdentity, provisionReply } from "./support/pairing-board";
import { seedPairingSite } from "./support/pairing-site";
import { connectFrom, startRealHub, stopAllHubs } from "./support/real-hub";

let phone: PhoneClient;
let group: number;
let stopPhone: () => void = () => undefined;

const socket: MakeSocket = (url, origin) =>
  new WebSocket(url, {
    headers: { Origin: origin },
    tls: { rejectUnauthorized: false },
  } as unknown as string[]) as unknown as SocketLike;

/** Waits for a versioned snapshot or a later subscribed event. */
async function until(check: () => boolean): Promise<boolean> {
  for (let i = 0; i < 150; i++) {
    if (check()) return true;
    await Bun.sleep(30);
  }
  return check();
}

/** Starts an actual hub and links an app phone to its version 2 socket. */
async function realPhone() {
  const hub = await startRealHub(seedPairingSite);
  const console0 = createHubClient({
    connect: connectFrom(hub.consoleOrigin),
    records: memoryRecordStore(),
    timers: realTimers,
    app: "0.1.0",
  });
  console0.start();
  const url = await hub.consoleCode();
  const secret = parseConsoleFragment(url.slice(url.indexOf("#") + 1));
  expect(secret !== undefined).toBe(true);
  if (secret === undefined) return;
  await console0.link({ kind: "secret", secret, identity: undefined }, "console", {
    name: "Console",
    kind: "web",
  });
  expect(await until(() => console0.live.getState().rev !== null)).toBe(true);
  const code = await console0.request("link.create", {
    kind: { newPerson: { name: "Pat" } },
    form: "qr",
  });
  const read = code.ok && code.body.qr !== undefined ? readCode(code.body.qr) : undefined;
  expect(read?.ok && read.value.kind === "link").toBe(true);
  if (!read?.ok || read.value.kind !== "link") return;
  phone = startPhoneClient({
    items: memorySecureItems(),
    makeSocket: socket,
    finder: NO_FINDER,
    timers: realTimers,
    app: "0.1.0",
    proto: [2, 2],
    keys: phoneKeys,
  });
  phone.client.start();
  stopPhone = () => {
    phone.client.stop();
  };
  await phone.client.link(read.value.secret, "qr", { name: "Test phone", kind: "phone" });
  expect(await until(() => phone.client.live.getState().rev !== null)).toBe(true);
  expect((await phone.client.request("subscribe", { topics: ["devices", "config"] })).ok).toBe(
    true,
  );
  expect(
    (await phoneRequest(phone, "site.wifi", { name: "Bench network", password: "bench-password" }))
      .ok,
  ).toBe(true);
  const added = await phone.client.request("group.create", {
    name: "Downstairs",
    sensors: [],
    sirens: "all",
  });
  expect(added.ok).toBe(true);
  if (added.ok) group = added.body.id;
  console0.stop();
}

/** Builds real-handshake peripherals for discovery without relying on a simulator. */
function world(...options: BoardOptions[]) {
  const clock = new ManualClock();
  const air = new BleAir(clock, { advertIntervalMs: 15 });
  const central = new ScriptedCentral(air);
  const boards = options.map((option) => placeBoard(air, new ScriptedBoard(clock, option)));
  return {
    clock,
    air,
    central,
    boards,
    flow: pairingFlow(central, clock),
    signal: new AbortController().signal,
  };
}

/** Pumps the simulated radio while the hub process handles real socket traffic. */
async function withRealHub<T>(clock: ManualClock, pending: Promise<T>): Promise<T | undefined> {
  let result: T | undefined;
  void pending.then((value) => {
    result = value;
  });
  for (let i = 0; i < 1000 && result === undefined; i++) {
    await clock.advance(2);
    await Bun.sleep(2);
  }
  return result;
}

beforeAll(realPhone, 25_000);
afterAll(async () => {
  stopPhone();
  await stopAllHubs();
});

for (const [role, suffix, name] of [
  [Role.Sensor, "01", "Back-door"],
  [Role.Siren, "02", "Hall-siren"],
  [Role.Gateway, "03", "Garage-gateway"],
] as const) {
  test(`the phone adds a ${name} through security 2 and the real hub`, async () => {
    const { boards, central, clock, flow, signal } = world({
      role,
      chipId: fromHex(`1122334455${suffix}`),
    });
    const board = boards[0];
    expect(board !== undefined).toBe(true);
    if (board === undefined) return;
    const found = await settled(clock, findPairingBoards(central, clock, signal, role));
    expect(found?.ok).toBe(true);
    const candidate = found?.ok ? found.value[0] : undefined;
    expect(candidate?.version.role).toBe(role);
    if (candidate === undefined) return;
    const opened = await settled(clock, flow.open(candidate, board.code, signal));
    expect(opened?.ok).toBe(true);
    if (!opened?.ok) return;
    const done = await withRealHub(
      clock,
      addBoard(phone, opened.value, name, role === Role.Sensor ? [group] : [], signal),
    );
    expect(done?.kind).toBe("added");
    if (done?.kind !== "added") return;
    expect(done.groupsFailed).toBe(false);
    expect(done.device.name).toBe(name);
    expect(
      board.pairing?.wifiName.every(
        (byte, i) => byte === new TextEncoder().encode("Bench network")[i],
      ),
    ).toBe(true);
    expect(
      await until(() => phone.client.live.getState().devices[done.device.id]?.name === name),
    ).toBe(true);
    if (role === Role.Sensor)
      expect(
        await until(
          () =>
            phone.client.live.getState().groups[group]?.sensors.includes(done.device.id) === true,
        ),
      ).toBe(true);
  });
}

test("QR detection verifies the full chip when two boards have the same advertised suffix", async () => {
  const { boards, central, clock, signal } = world(
    { role: Role.Siren, id: "wrong", chipId: fromHex("112233444f2a") },
    { role: Role.Sensor, id: "correct", chipId: fromHex("889900114f2a") },
  );
  const qr = readBoardQr(boards[1]?.qr ?? "");
  expect(qr !== undefined).toBe(true);
  const found = await settled(clock, findPairingBoards(central, clock, signal, undefined, qr));
  expect(found?.ok ? found.value.map((x) => x.advert.id) : []).toEqual(["correct"]);
  expect(boards.map((board) => board.connections)).toEqual([1, 1]);
});

test("the fifth refused proof stops the window until a hold reopens it with the same code", async () => {
  const { boards, central, clock, signal, flow } = world({
    role: Role.Siren,
    chipId: fromHex("112233445566"),
  });
  const found = await settled(clock, findPairingBoards(central, clock, signal));
  const candidate = found?.ok ? found.value[0] : undefined;
  const wrong = makePairingCode(1n);
  const board = boards[0];
  expect(candidate !== undefined && board !== undefined && wrong !== undefined).toBe(true);
  if (candidate === undefined || board === undefined || wrong === undefined) return;
  const alternate = wrong === board.code ? (makePairingCode(2n) ?? wrong) : wrong;
  for (let attempt = 1; attempt <= 5; attempt++) {
    expect(await settled(clock, flow.open(candidate, alternate, signal))).toEqual({
      ok: false,
      fault: attempt === 5 ? "tooManyTries" : "wrongCode",
    });
    expect(flow.remaining(candidate.version.chip)).toBe(5 - attempt);
  }
  expect(await settled(clock, flow.open(candidate, board.code, signal))).toEqual({
    ok: false,
    fault: "tooManyTries",
  });
  expect(board.wrongCodes).toBe(5);
  const displayed = board.qr;
  board.pressButton();
  expect(board.window).toBe("pairing");
  expect(board.qr).toBe(displayed);
  flow.reopened(candidate.version.chip);
  expect((await settled(clock, flow.open(candidate, board.code, signal)))?.ok).toBe(true);
});

test("discovery detects a radio turned off while looking and a board with no pairing window", async () => {
  const { central, clock, signal } = world();
  expect(await settled(clock, findPairingBoards(central, clock, signal))).toEqual({
    ok: false,
    fault: "notFound",
  });
  const found = findPairingBoards(central, clock, signal);
  clock.after(250, () => {
    central.bluetooth = "off";
  });
  expect(await settled(clock, found)).toEqual({ ok: false, fault: "off" });
});

test("a board that disappears and another phone occupying the board have different failures", async () => {
  const { air, central, clock, flow, signal, boards } = world({
    role: Role.Sensor,
    chipId: fromHex("010203040506"),
  });
  const board = boards[0];
  const found = await settled(clock, findPairingBoards(central, clock, signal));
  const candidate = found?.ok ? found.value[0] : undefined;
  expect(candidate !== undefined && board !== undefined).toBe(true);
  if (candidate === undefined || board === undefined) return;
  const connected = await settled(clock, new ScriptedCentral(air).connect(board.id, 185));
  expect(connected?.ok).toBe(true);
  expect(await settled(clock, flow.open(candidate, board.code, signal))).toEqual({
    ok: false,
    fault: "timeout",
  });
  if (connected?.ok) connected.value.close();
  air.faults = { dropAfter: (crossing) => crossing.kind === "write" };
  expect(await settled(clock, flow.open(candidate, board.code, signal))).toEqual({
    ok: false,
    fault: "lost",
  });
});

test("a board lost on the name page leaves no provisioning row", async () => {
  const { boards, central, clock, flow, signal } = world({
    role: Role.Sensor,
    chipId: fromHex("112233446633"),
  });
  const [board] = boards;
  const found = await settled(clock, findPairingBoards(central, clock, signal));
  const candidate = found?.ok ? found.value[0] : undefined;
  expect(board !== undefined && candidate !== undefined).toBe(true);
  if (board === undefined || candidate === undefined) return;
  const opened = await settled(clock, flow.open(candidate, board.code, signal));
  expect(opened?.ok).toBe(true);
  if (!opened?.ok) return;
  board.powerOff();
  await clock.advance(1);
  expect(await addBoard(phone, opened.value, "Vanished-sensor", [], signal)).toEqual({
    kind: "refused",
    reason: "vanished",
  });
  const devices = await phoneRequest(phone, "device.list", {});
  expect(devices.ok && devices.value.devices.some(({ name }) => name === "Vanished-sensor")).toBe(
    false,
  );
});

test("a board refusing provision is finished at the hub without keeping its row", async () => {
  const { boards, central, clock, flow, signal } = world({
    role: Role.Siren,
    chipId: fromHex("112233446611"),
    storageFails: true,
  });
  const found = await settled(clock, findPairingBoards(central, clock, signal));
  const candidate = found?.ok ? found.value[0] : undefined;
  const board = boards[0];
  expect(candidate !== undefined && board !== undefined).toBe(true);
  if (candidate === undefined || board === undefined) return;
  const opened = await settled(clock, flow.open(candidate, board.code, signal));
  expect(opened?.ok).toBe(true);
  if (!opened?.ok) return;
  expect(
    await withRealHub(clock, addBoard(phone, opened.value, "Refused-siren", [], signal)),
  ).toEqual({ kind: "refused", reason: "boardWifi" });
  const list = await phoneRequest(phone, "device.list", {});
  expect(list.ok && list.value.devices.some((device) => device.name === "Refused-siren")).toBe(
    false,
  );
});

test("lost after prepare leaves a provisioning row for retry", async () => {
  const { boards, central, clock, flow, signal } = world({
    role: Role.Sensor,
    chipId: fromHex("112233446622"),
    restartBeforeResult: true,
  });
  const found = await settled(clock, findPairingBoards(central, clock, signal));
  const candidate = found?.ok ? found.value[0] : undefined;
  const board = boards[0];
  expect(candidate !== undefined && board !== undefined).toBe(true);
  if (candidate === undefined || board === undefined) return;
  const opened = await settled(clock, flow.open(candidate, board.code, signal));
  expect(opened?.ok).toBe(true);
  if (!opened?.ok) return;
  expect(
    await withRealHub(clock, addBoard(phone, opened.value, "Retry-sensor", [], signal)),
  ).toEqual({ kind: "refused", reason: "unfinished" });
  const list = await phoneRequest(phone, "device.list", {});
  expect(
    list.ok && list.value.devices.find((device) => device.name === "Retry-sensor")?.state,
  ).toBe("provisioning");
});

test("each hub pairing refusal reaches the UI with its own reason", () => {
  for (const [reason, error] of Object.entries(PAIR_PREPARE_REFUSALS))
    expect(refusal({ ok: false, error })).toBe(reason);
  expect(APP_OPS_V2["pair.prepare"].body.safeParse({ identity: "", name: "a b" }).success).toBe(
    false,
  );
});

test("a system board link goes straight to pairing and passes its code only in memory", () => {
  const chipId = fromHex("54881234ab10");
  const code = makePairingCode(0n);
  expect(code).toBeDefined();
  if (code === undefined) return;
  const path = formatBoardQr({ chipId, code });
  expect(redirectSystemPath({ path, initial: false })).toBe("/device/add");
  expect(claimPairingCode()).toEqual({ chipId, code });
  expect(claimPairingCode()).toBeUndefined();
  expect(redirectSystemPath({ path: path.replace("ab10", "invalid"), initial: true })).toBe("/");
  expect(claimPairingCode()).toBeUndefined();
});

test("discovery returns only the chosen role", async () => {
  const { central, clock, signal } = world(
    { role: Role.Sensor, id: "sensor", chipId: fromHex("112233445501") },
    { role: Role.Siren, id: "siren", chipId: fromHex("112233445502") },
  );
  const found = await settled(clock, findPairingBoards(central, clock, signal, Role.Siren));
  expect(found?.ok ? found.value.map(({ advert }) => advert.id) : found?.fault).toEqual(["siren"]);
});

test("discovery refuses a board with an unsupported role", async () => {
  const { central, clock, signal } = world({
    role: 9 as BoardOptions["role"],
    id: "unsupported",
    chipId: fromHex("112233445501"),
  });
  const found = await settled(clock, findPairingBoards(central, clock, signal));
  expect(found?.ok ? "found" : found?.fault).toBe("protocol");
});

for (const [name, security, differentChip] of [
  ["the session chip must match the selected board", undefined, "222233445501"],
  ["Identify must return the session role", falseIdentity(2, Role.Sensor), undefined],
  ["Identify must return the session chip", falseIdentity(3, 0x22), undefined],
] as const) {
  test(name, async () => {
    const { boards, central, clock, flow, signal } = world({
      role: Role.Siren,
      chipId: fromHex("112233445501"),
      ...(security === undefined ? {} : { security }),
    });
    const [board] = boards;
    const found = await settled(clock, findPairingBoards(central, clock, signal));
    const candidate = found?.ok ? found.value[0] : undefined;
    expect(candidate !== undefined && board !== undefined).toBe(true);
    if (candidate === undefined || board === undefined) return;
    const opened = await settled(
      clock,
      flow.open(
        differentChip === undefined
          ? candidate
          : { ...candidate, version: { ...candidate.version, chip: differentChip } },
        board.code,
        signal,
      ),
    );
    if (opened?.ok) opened.value.session.close();
    expect(opened?.ok ? "opened" : opened?.fault).toBe("protocol");
  });
}

/** Opens a genuine board session before substituting only its Provision reply and hub. */
async function provisionWith(resultCode: number) {
  const { boards, central, clock, flow, signal } = world({
    role: Role.Siren,
    chipId: fromHex("112233445501"),
  });
  const [board] = boards;
  const found = await settled(clock, findPairingBoards(central, clock, signal));
  const candidate = found?.ok ? found.value[0] : undefined;
  expect(board !== undefined && candidate !== undefined).toBe(true);
  if (board === undefined || candidate === undefined) return;
  const opened = await settled(clock, flow.open(candidate, board.code, signal));
  expect(opened?.ok).toBe(true);
  if (!opened?.ok) return;
  const exchange = provisionReply(phone.client, opened.value, resultCode);
  const result = await addBoard(exchange.hub, exchange.board, "Hall-siren", [], signal);
  return { ...exchange, result };
}

test("provision bytes are wiped after exchange", async () => {
  const run = await provisionWith(0);
  expect(run?.result.kind).toBe("added");
  expect(run?.sentExpected()).toBe(true);
  expect(run?.wiped()).toBe(true);
});

test("a refusal stays refused when the hub keeps the device", async () => {
  const run = await provisionWith(1);
  expect(run?.commands).toEqual(["pair.prepare", "pair.finish"]);
  expect(run?.result).toEqual({ kind: "refused", reason: "boardWifi" });
});

test("an unknown provision result never reaches pair.finish", async () => {
  const run = await provisionWith(3);
  expect(run?.sentExpected()).toBe(true);
  expect(run?.commands).toEqual(["pair.prepare"]);
  expect(run?.result).toEqual({ kind: "refused", reason: "unfinished" });
});
