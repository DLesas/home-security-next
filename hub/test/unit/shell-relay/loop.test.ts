/**
 * The loop's part in the relay client (docs/m4-design.md section 4; hub-design.md section 4): the
 * relay effects (`relayConnect`, `relayRoster`, `pushSend`, `pushKey`) given to the relay client
 * in effect order after the turn's commit, held while a "now" commit fails exactly as the channel's
 * are (a push, a roster or a push key never leaves before the rows behind it); and a job that says
 * it is waiting (a release fetch waiting for its next piece) asks for no turn, so the hub's one
 * thread is not kept busy by a download that waits on the network.
 */
import { nodeSha256 } from "@hsn/protocol";
import { relayAlertContent } from "@hsn/protocol/app";
import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";
import type { Effect, FileWork } from "../../../src/core/model/effects.ts";
import type { HubError } from "../../../src/core/model/errors.ts";
import type { CommitOutcome, HubEvent, Input } from "../../../src/core/model/events.ts";
import { clientId, jobId, outboxId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import { mono, type Now } from "../../../src/core/model/time.ts";
import type { Core } from "../../../src/core/step.ts";
import type { CommitInfo, StagedEffect, StorageError } from "../../../src/ports/writer.ts";
import {
  HubLoop,
  type JobPieces,
  type LoopPorts,
  type LoopWriter,
  type RelayLoopEffect,
} from "../../../src/shell/loop.ts";
import { UNBUILT_CALENDAR } from "../../../src/shell/calendar/unbuilt.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";

const STATE = { clock: { boot: { id: 4 } } } as unknown as HubState;

class Writer implements LoopWriter {
  failing = false;
  staged: StagedEffect[] = [];
  #outcome: CommitOutcome | undefined;
  #failed = false;
  stage(items: readonly StagedEffect[]): void {
    this.staged.push(...items);
  }
  setCadence(): void {
    return;
  }
  durable(): number | undefined {
    return undefined;
  }
  due(): undefined {
    return undefined;
  }
  flushIfDue(): Result<(CommitInfo & { readonly committed: boolean }) | undefined, StorageError> {
    return this.staged.length === 0 ? ok(undefined) : this.flush();
  }
  flush(): Result<CommitInfo & { readonly committed: boolean }, StorageError> {
    if (this.failing) {
      if (!this.#failed) this.#outcome = { kind: "failed", message: "disk full" };
      this.#failed = true;
      return err({ kind: "storage", origin: "test", message: "disk full" });
    }
    const items = this.staged.length;
    this.staged = [];
    if (this.#failed) this.#outcome = { kind: "recovered" };
    this.#failed = false;
    return ok({ items, durationMs: 1, committed: true });
  }
  takeOutcome(): CommitOutcome | undefined {
    const outcome = this.#outcome;
    this.#outcome = undefined;
    return outcome;
  }
  maintain(): Result<void, StorageError> {
    return ok(undefined);
  }
}

function rig(
  script: (event: HubEvent) => readonly Effect[],
  extra: Partial<LoopPorts> = {},
  withRelay = true,
): {
  loop: HubLoop;
  writer: Writer;
  performed: RelayLoopEffect[];
  reported: HubError[];
  soons: { n: number };
} {
  const writer = new Writer();
  const performed: RelayLoopEffect[] = [];
  const reported: HubError[] = [];
  const soons = { n: 0 };
  const core: Core = {
    emptyState: () => STATE,
    nextDeadline: () => undefined,
    step: (state: HubState, input: Input) =>
      ok({ state, effects: script(input.event), wake: undefined }),
  };
  const ports: LoopPorts = {
    clock: { now: (): Now => ({ mono: mono(0), wall: 1_800_000_000_000, wallTrusted: true }) },
    random: { bytes: (length) => ok(new Uint8Array(length)) },
    links: {
      listen: () => undefined,
      send: () => ok(undefined),
      close: () => ok(undefined),
    },
    control: { respond: () => undefined, publish: () => undefined },
    writer,
    advertiser: { advertise: () => ok(undefined), stop: () => ok(undefined) },
    wakeAt: () => undefined,
    soon: () => {
      soons.n += 1;
    },
    report: (error) => reported.push(error),
    fatal: () => undefined,
    ...(withRelay
      ? { relay: { perform: (effect: RelayLoopEffect) => performed.push(effect) } }
      : {}),
    ...extra,
  };
  const loop = new HubLoop(
    core,
    {
      cipher: VectorCipher.fromVectors(),
      rules: DEFAULT_RULES,
      calendar: UNBUILT_CALENDAR,
      sha256: nodeSha256,
    },
    ports,
  );
  return { loop, writer, performed, reported, soons };
}

const KEY_ROW: Effect = {
  kind: "write",
  durability: "now",
  op: { table: "push_keys", op: "upsert", row: { clientId: clientId(5), key: new Uint8Array(32) } },
};

const RELAY_EFFECTS: readonly RelayLoopEffect[] = [
  { kind: "pushKey", client: clientId(5), keyId: new Uint8Array(8), key: new Uint8Array(32) },
  { kind: "relayConnect", url: "ws://127.0.0.1:8480" },
  {
    kind: "relayRoster",
    rev: 1,
    targets: [
      {
        client: clientId(5),
        keyId: new Uint8Array(8),
        platform: "fcm",
        environment: "production",
        token: "t",
        unreachable: relayAlertContent("unreachable", "a".repeat(26), false),
        back: relayAlertContent("back", "a".repeat(26), false),
      },
    ],
  },
  {
    kind: "pushSend",
    id: outboxId(3),
    client: clientId(5),
    content: relayAlertContent("back", "a".repeat(26), false),
  },
];

describe("the relay effects", () => {
  test("given to the relay client in effect order, after the turn's commit", () => {
    const r = rig((event) => (event.kind === "tick" ? [KEY_ROW, ...RELAY_EFFECTS] : []));
    r.loop.enqueue({ kind: "tick" });
    r.loop.turn();
    expect(r.performed).toEqual([...RELAY_EFFECTS]);
    expect(r.writer.staged).toEqual([]);
  });

  test("held while the turn's now commit fails, then given, in order, once a commit succeeds", () => {
    const r = rig((event) => (event.kind === "tick" ? [KEY_ROW, ...RELAY_EFFECTS] : []));
    r.writer.failing = true;
    r.loop.enqueue({ kind: "tick" });
    r.loop.turn();
    r.loop.turn();
    expect(r.performed).toEqual([]);
    r.writer.failing = false;
    r.loop.enqueue({
      kind: "inputRejected",
      rejection: { source: "frame", link: 1 as never, reason: "badFrame" },
    });
    r.loop.turn();
    r.loop.turn();
    expect(r.performed).toEqual([...RELAY_EFFECTS]);
  });

  test("without a relay client they are ignored, and nothing is reported", () => {
    const r = rig((event) => (event.kind === "tick" ? RELAY_EFFECTS : []), {}, false);
    r.loop.enqueue({ kind: "tick" });
    r.loop.turn();
    expect(r.reported).toEqual([]);
  });
});

describe("a job that waits asks for no turn", () => {
  test("no turn on its account while waiting; one each turn once it has work", () => {
    let waiting = true;
    let pieces = 0;
    const job: JobPieces = {
      next: () => {
        pieces += 1;
        return { done: false };
      },
      abort: () => undefined,
      waiting: () => waiting,
    };
    const work: FileWork = {
      kind: "fetchRelease",
      release: "hub",
      file: "hsn-hub-9.0.0-darwin-arm64.hsnr",
      bytes: 10,
      sha256: new Uint8Array(32),
    };
    const r = rig(
      (event) => (event.kind === "tick" ? [{ kind: "fileJob", job: jobId(1), work }] : []),
      { files: { perform: () => ({ kind: "pieces", pieces: job }) } },
    );
    r.loop.enqueue({ kind: "tick" });
    const before = r.soons.n;
    r.loop.turn();
    expect(r.loop.openJobs).toBe(1);
    expect(r.soons.n).toBe(before);
    r.loop.turn();
    expect(r.soons.n).toBe(before);
    waiting = false;
    r.loop.turn();
    expect(r.soons.n).toBe(before + 1);
    // Each turn still takes one piece, waiting or not.
    expect(pieces).toBe(3);
  });

  test("a job that never says (staging) keeps asking, as before", () => {
    const job: JobPieces = { next: () => ({ done: false }), abort: () => undefined };
    const r = rig(
      (event) =>
        event.kind === "tick"
          ? [{ kind: "fileJob", job: jobId(1), work: { kind: "switchRestore" } }]
          : [],
      { files: { perform: () => ({ kind: "pieces", pieces: job }) } },
    );
    r.loop.enqueue({ kind: "tick" });
    r.loop.turn();
    r.loop.turn();
    expect(r.soons.n).toBeGreaterThanOrEqual(3);
  });
});
