/**
 * Adding boards over USB, end to end in the scenario world (hub-design.md sections 4, 9 and 11):
 * the real dispatcher with E5's modules, the world's loop (stage, commit if anything is "now",
 * then send), and boards that answer as the firmware does. Each crash point of section 4's table
 * that provisioning can meet is played: the hub restarts from exactly the committed rows, the
 * board keeps what it had, and the retry is checked against the crash test's invariant 7: every
 * key a board was given is in the database, and the hub never forgets a key a board holds (PR2).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { toHex, type PairingData } from "@hsn/protocol";
import type { ControlCommand, ControlReply } from "../../../src/core/model/control.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import { requestId } from "../../../src/core/model/ids.ts";
import { DeviceState, MoveStage } from "../../../src/core/model/rows.ts";
import type { StoreOp } from "../../../src/core/model/store.ts";
import { World } from "../../world/world.ts";
import { ScriptedBoard } from "../../unit/setup/support/board.ts";
import { setupCore } from "../../unit/setup/support/core.ts";
import {
  CHIP_A,
  CHIP_B,
  CommittedRows,
  deviceNamed,
  OTHER_HUB_IDENTITY,
  Role,
  siteRow,
  snapshot,
  unconfirmedSensor,
} from "../../unit/setup/support/driver.ts";
import { expectNoKeyLeaks, guardCounts, noteEffects } from "../../unit/setup/support/leak-guard.ts";

const PORT = "/dev/ttyACM0";
let nextRequest = 1;

afterAll(() => {
  expect(guardCounts().keys).toBeGreaterThan(0);
  expectNoKeyLeaks();
});

/** A run of the hub: a world on the given committed rows, with E5's modules. */
function run(rows: CommittedRows, seed: number, bootId = 1): World {
  const world = new World({ core: setupCore(), seed });
  world.boot(rows.snapshot(), bootId).match(
    () => undefined,
    () => undefined,
  );
  return world;
}

/** The rows a run committed, on top of what it booted from. */
function committed(
  world: World,
  base: CommittedRows = new CommittedRows(),
  upTo = world.writer.commits.length,
): CommittedRows {
  const rows = new CommittedRows();
  for (const [id, row] of base.devices) rows.devices.set(id, row);
  for (const [id, key] of base.keys) rows.keys.set(id, key);
  for (const [id, point] of base.resumePoints) rows.resumePoints.set(id, point);
  rows.site = base.site;
  for (const commit of world.writer.commits.slice(0, upTo)) {
    rows.apply(commit.items.flatMap((item): StoreOp[] => (item.kind === "write" ? [item.op] : [])));
  }
  return rows;
}

function command(world: World, cmd: ControlCommand): ControlReply | undefined {
  const request = requestId(nextRequest++);
  const before = world.replies.length;
  world.input({ kind: "command", request, actor: "installer", command: cmd }).match(
    () => undefined,
    () => undefined,
  );
  noteEffects(world.effects);
  return world.replies.slice(before).find((r) => r.request === request)?.reply;
}

function code(reply: ControlReply | undefined): string {
  return reply === undefined ? "none" : reply.ok ? "ok" : reply.error.code;
}

function add(
  world: World,
  name = "front",
  role?: "sensor" | "siren" | "gateway",
): ControlReply | undefined {
  return command(
    world,
    role === undefined
      ? { kind: "usbAdd", port: PORT, name }
      : { kind: "usbAdd", port: PORT, name, role },
  );
}

/** Invariant 7 of section 11: the key the board holds, if any, is the committed key of its device. */
function expectBoardKeyCommitted(board: ScriptedBoard, rows: CommittedRows): void {
  const pairing = board.pairing;
  if (pairing === undefined) return;
  const holders = [...rows.devices.values()].filter((row) => row.address === pairing.address);
  expect(holders).toHaveLength(1);
  const holder = holders[0];
  expect(
    holder === undefined ? undefined : toHex(rows.keys.get(holder.id) ?? new Uint8Array()),
  ).toBe(toHex(pairing.key));
}

function devSensor(): ScriptedBoard {
  return new ScriptedBoard({ role: Role.Sensor, chipId: CHIP_B, development: true });
}

describe("a board added over USB", () => {
  test("the rows are committed before the Provision message reaches the board", () => {
    const world = run(new CommittedRows(), 1);
    const board = devSensor();
    const seen: boolean[] = [];
    board.onProvision = (pairing: PairingData) => {
      seen.push(
        toHex(committed(world).keys.values().next().value ?? new Uint8Array()) ===
          toHex(pairing.key),
      );
    };
    world.openLink("usb", PORT, board);
    expect(code(add(world))).toBe("ok");
    expect(seen).toEqual([true]);
    const rows = committed(world);
    expectBoardKeyCommitted(board, rows);
    expect(deviceNamed(world.state, "front")?.state).toBe(DeviceState.Paired);
    expect([...rows.devices.values()][0]?.state).toBe(DeviceState.Paired);
    expect([...rows.resumePoints.values()]).toEqual([1024]);
  });

  test("a release gateway is added by itself when plugged in (D100), and holds the committed key", () => {
    const world = run(new CommittedRows(), 2);
    const board = new ScriptedBoard({ role: Role.Gateway, chipId: CHIP_A, development: false });
    world.openLink("usb", PORT, board);
    expect(deviceNamed(world.state, `gateway-${toHex(CHIP_A)}`)?.state).toBe(DeviceState.Paired);
    expectBoardKeyCommitted(board, committed(world));
    noteEffects(world.effects);
  });

  test("a release sensor refuses: nothing is kept on either side", () => {
    const world = run(new CommittedRows(), 3);
    const board = new ScriptedBoard({ role: Role.Sensor, chipId: CHIP_B, development: false });
    world.openLink("usb", PORT, board);
    expect(code(add(world))).toBe("boardRefused");
    const rows = committed(world);
    expect(rows.devices.size).toBe(0);
    expect(rows.keys.size).toBe(0);
    expect(board.pairing).toBeUndefined();
  });

  test("a release board paired to another hub is refused before anything is written", () => {
    const world = run(new CommittedRows(), 4);
    const other = {
      address: 9,
      key: new Uint8Array(16).fill(3),
      hubIdentity: OTHER_HUB_IDENTITY,
      firmwareSigningKey: new Uint8Array(64),
      siteChannel: 1,
      allowedDataRateMask: 32,
      wifiName: new Uint8Array(),
      wifiPassword: new Uint8Array(),
    };
    const board = new ScriptedBoard({
      role: Role.Gateway,
      chipId: CHIP_A,
      development: false,
      pairing: other,
    });
    world.openLink("usb", PORT, board);
    expect(code(add(world, "gw"))).toBe("boardRefused");
    expect(world.writer.commits).toEqual([]);
    expect(board.pairing).toBe(other);
  });

  test("Set role, then Provision, on a development board with no role (D103)", () => {
    const world = run(new CommittedRows(), 5);
    const board = new ScriptedBoard({ role: 0, chipId: CHIP_B, development: true });
    world.openLink("usb", PORT, board);
    expect(code(add(world, "hall", "siren"))).toBe("ok");
    expect(board.role).toBe(Role.Siren);
    expect(deviceNamed(world.state, "hall")?.role).toBe(Role.Siren);
    expectBoardKeyCommitted(board, committed(world));
  });

  test("a board that loses power after storing its pairing gets the same key again on the retry", () => {
    const world = run(new CommittedRows(), 6);
    const board = devSensor();
    world.openLink("usb", PORT, board);
    board.answers = false;
    expect(code(add(world))).toBe("none");
    expect(world.advanceByMs(5_000).isOk()).toBe(true);
    expect(
      world.replies.at(-1)?.reply.ok === false ? world.replies.at(-1)?.reply : undefined,
    ).toMatchObject({ error: { code: "noAnswer" } });
    board.answers = true;
    expect(code(add(world))).toBe("ok");
    expect(board.accepted.map((p) => toHex(p.key))).toEqual([
      toHex(board.accepted[0]?.key ?? new Uint8Array()),
      toHex(board.accepted[0]?.key ?? new Uint8Array()),
    ]);
    expect(board.accepted[0]?.address).toBe(board.accepted[1]?.address);
    expectBoardKeyCommitted(board, committed(world));
  });

  test("while a site move announces, the board is paired with the current settings (D115)", () => {
    const rows = new CommittedRows();
    rows.site = siteRow({
      channel: 0,
      rateMask: 1 << 5,
      moveId: 3,
      moveStage: MoveStage.Announcing,
      moveChannel: 2,
      moveRate: 2,
    });
    rows.devices.set(unconfirmedSensor().id, unconfirmedSensor());
    const world = run(rows, 7);
    const board = devSensor();
    world.openLink("usb", PORT, board);
    expect(code(add(world))).toBe("ok");
    expect([board.pairing?.siteChannel, board.pairing?.allowedDataRateMask]).toEqual([0, 1 << 5]);
  });
});

describe("a crash at each step of provisioning, then the retry (sections 4 and 9)", () => {
  /** Runs an add up to the crash; returns the committed rows the restart reads and the board. */
  function crashDuring(prepare: (board: ScriptedBoard) => void, keepCommitsOfAdd: boolean) {
    const world = run(new CommittedRows(), 11);
    const board = devSensor();
    world.openLink("usb", PORT, board);
    const before = world.writer.commits.length;
    prepare(board);
    add(world);
    const rows = committed(
      world,
      new CommittedRows(),
      keepCommitsOfAdd ? world.writer.commits.length : before,
    );
    board.deaf = false;
    board.answers = true;
    return { rows, board };
  }

  function restartAndRetry(rows: CommittedRows, board: ScriptedBoard) {
    const world = run(rows, 12, 2);
    world.openLink("usb", PORT, board);
    const reply = add(world);
    return { world, reply, after: committed(world, rows) };
  }

  test("after staging, before the commit: nothing was kept or sent; the retry is a new add", () => {
    const { rows, board } = crashDuring((b) => {
      b.deaf = true;
    }, false);
    expect(rows.devices.size).toBe(0);
    const { reply, after, world } = restartAndRetry(rows, board);
    expect(code(reply)).toBe("ok");
    expect(deviceNamed(world.state, "front")?.state).toBe(DeviceState.Paired);
    expectBoardKeyCommitted(board, after);
  });

  test("after the commit, before the send: a provisioning row and an untouched board; the retry pairs it under the same address", () => {
    const { rows, board } = crashDuring((b) => {
      b.deaf = true;
    }, true);
    const pending = [...rows.devices.values()][0];
    expect(pending?.state).toBe(DeviceState.Provisioning);
    expect(board.pairing).toBeUndefined();
    const { reply, after } = restartAndRetry(rows, board);
    expect(code(reply)).toBe("ok");
    expect(board.pairing?.address).toBe(pending?.address);
    expect([...after.devices.values()].map((r) => r.state)).toEqual([DeviceState.Paired]);
    expectBoardKeyCommitted(board, after);
  });

  test("after the send, before the answer: the board holds the key the hub committed; the retry sends the same", () => {
    const { rows, board } = crashDuring((b) => {
      b.answers = false;
    }, true);
    expect(board.pairing).toBeDefined();
    expectBoardKeyCommitted(board, rows);
    const address = board.pairing?.address;
    board.answers = true;
    // The snapshot gives the provisioning device's committed key, so the retry sends the same
    // address and key (section 9).
    const { reply, after } = restartAndRetry(rows, board);
    expect(code(reply)).toBe("ok");
    expect(board.pairing?.address).toBe(address);
    expectBoardKeyCommitted(board, after);
    expect([...after.devices.values()].map((r) => r.state)).toEqual([DeviceState.Paired]);
  });

  test("after the answer was committed: the device is paired, and an add of the same board is refused", () => {
    const { rows, board } = crashDuring(() => undefined, true);
    expect([...rows.devices.values()].map((r) => r.state)).toEqual([DeviceState.Paired]);
    const { reply, after } = restartAndRetry(rows, board);
    expect(code(reply)).toBe("boardRefused");
    expectBoardKeyCommitted(board, after);
  });

  test("a board whose storage fails refuses after erasing: the rows go, and it holds nothing", () => {
    const world = run(new CommittedRows(), 13);
    const board = devSensor();
    world.openLink("usb", PORT, board);
    board.storageFails = true;
    expect(code(add(world))).toBe("boardRefused");
    expect(committed(world).devices.size).toBe(0);
    expect(board.pairing).toBeUndefined();
  });
});

describe("Erase and a reset by the owner", () => {
  test("an erased development board shows unpaired at its next Identity: the device is reset, its key deleted", () => {
    const world = run(new CommittedRows(), 21);
    const board = devSensor();
    const link = world.openLink("usb", PORT, board);
    expect(code(add(world))).toBe("ok");
    expect(code(command(world, { kind: "usbErase", port: PORT }))).toBe("ok");
    expect(board.pairing).toBeUndefined();
    world.closeLink(link);
    world.openLink("usb", PORT, board);
    const rows = committed(world);
    expect([...rows.devices.values()].map((r) => [r.state, r.name])).toEqual([
      [DeviceState.ResetByOwner, "#1-front"],
    ]);
    expect(rows.keys.size).toBe(0);
  });
});

test("the scenario world saw keys and records, and no key reached a record or reply", () => {
  const world = run(new CommittedRows(), 31);
  world.openLink("usb", PORT, devSensor());
  add(world);
  const records: readonly Effect[] = world.effects.filter((e) => e.kind === "record");
  expect(records.length).toBeGreaterThan(0);
  noteEffects(world.effects);
  expectNoKeyLeaks();
  expect(snapshot().hubKeys).toBeDefined();
});
