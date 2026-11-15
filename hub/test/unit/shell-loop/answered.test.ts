/**
 * No request is left unanswered at the loop's level either (m2-design.md sections 4 to 7): the real
 * `HubLoop` with the real core and every module, a writer that commits what it is given, and an app
 * side that records what the loop hands it. Each operation of `APP_OPS` the channel hands the core,
 * from the console's session, must end in exactly one answer on that connection: an `appSend`
 * reply with the request's `id`, within its turn or a later one the design states (a file job's
 * `fileReady`), or the shell's own answer the loop hands on (`historyRead`, answered with a page;
 * `hubStatusRead`, answered by the channel from the writer). An effect the loop drops, or reports
 * as not built, is a failure here, not silence.
 */
import { describe, expect, test } from "bun:test";
import { nodeSha256 } from "@hsn/protocol";
import { APP_OP_NAMES, APP_OPS, type AppOpName, parseAppOp } from "@hsn/protocol/app";
import { ok, type Result } from "neverthrow";
import type { HubError } from "../../../src/core/model/errors.ts";
import type { CommitOutcome, HubEvent } from "../../../src/core/model/events.ts";
import { type ConnId, connId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { mono } from "../../../src/core/model/time.ts";
import { OP_OWNERS } from "../../../src/core/model/ops.ts";
import { makeCore, MODULES } from "../../../src/core/step.ts";
import type { CommitInfo, StagedEffect, StorageError } from "../../../src/ports/writer.ts";
import { UNBUILT_CALENDAR } from "../../../src/shell/calendar/unbuilt.ts";
import { historyReply } from "../../../src/shell/history-page.ts";
import {
  type ChannelEffect,
  HubLoop,
  type LoopPorts,
  type LoopWriter,
} from "../../../src/shell/loop.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";
import { BODIES } from "../m2/support/bodies.ts";
import {
  ANNA,
  CONSOLE_CLIENT,
  FACTS,
  household,
  role,
  WALL_AT_START,
} from "../people/support/hub.ts";

/** A writer that commits whatever it is given at once. */
class CommittingWriter implements LoopWriter {
  #staged: StagedEffect[] = [];
  commits = 0;
  stage(items: readonly StagedEffect[]): void {
    this.#staged.push(...items);
  }
  setCadence(): void {
    // No countdown runs here.
  }
  durable(): number | undefined {
    return Number.MAX_SAFE_INTEGER;
  }
  due(): undefined {
    return undefined;
  }
  flushIfDue(): Result<(CommitInfo & { readonly committed: boolean }) | undefined, StorageError> {
    return this.#staged.length === 0 ? ok(undefined) : this.flush();
  }
  flush(): Result<CommitInfo & { readonly committed: boolean }, StorageError> {
    const items = this.#staged.length;
    this.#staged = [];
    this.commits += 1;
    return ok({ items, durationMs: 0, committed: true });
  }
  takeOutcome(): CommitOutcome | undefined {
    return undefined;
  }
  maintain(): Result<void, StorageError> {
    return ok(undefined);
  }
}

const CONN: ConnId = connId(100);

/** The loop on the real core, booted with the household, the console's session open. */
function loopWith(answers: string[], reports: HubError[]): HubLoop {
  const performed = (effect: ChannelEffect): void => {
    if (effect.kind === "appSend" && effect.conn === CONN && "t" in effect.message) {
      const message = effect.message;
      if (message.t === "res")
        answers.push(`${String(message.id)}:${message.ok ? "ok" : message.error.code}`);
    }
    // The shell's own answers, as the app side gives them (`app-wiring.ts`, the channel).
    if (effect.kind === "historyRead" && effect.conn === CONN) {
      const reply = historyReply({ rows: () => ok([]), staged: () => [] }, effect);
      answers.push(
        `${String(effect.id)}:${"ok" in reply.message && reply.message.ok ? "ok" : "page failed"}`,
      );
    }
    if (effect.kind === "hubStatusRead" && effect.conn === CONN)
      answers.push(`${String(effect.id)}:ok`);
  };
  let at = 1_000_000;
  const ports: LoopPorts = {
    clock: {
      now: () => ({ mono: mono((at += 1000)), wall: WALL_AT_START + at / 1000, wallTrusted: true }),
    },
    random: { bytes: (length) => ok(new Uint8Array(length).fill(0x5a)) },
    links: { listen: () => undefined, send: () => ok(undefined), close: () => ok(undefined) },
    control: { respond: () => undefined, publish: () => undefined },
    writer: new CommittingWriter(),
    advertiser: { advertise: () => ok(undefined), stop: () => ok(undefined) },
    wakeAt: () => undefined,
    soon: () => undefined,
    report: (error) => reports.push(error),
    fatal: (error) => reports.push(error),
    channel: { perform: performed },
    // A file job ends as a job that failed: it is answered all the same (section 9).
    files: {
      perform: () => ({
        kind: "ready",
        outcome: { kind: "failed", reason: "io", message: "the test's job failed" },
      }),
    },
  };
  const loop = new HubLoop(
    makeCore(MODULES),
    {
      cipher: VectorCipher.fromVectors(),
      rules: DEFAULT_RULES,
      calendar: UNBUILT_CALENDAR,
      sha256: nodeSha256,
    },
    ports,
  );
  const boot = household({ userManagement: true, roles: [role(ANNA, true, true)] });
  const events: HubEvent[] = [
    {
      kind: "boot",
      snapshot: boot,
      boot: { id: 1 as never, previousExit: "clean", cause: undefined },
    },
    { kind: "hubFacts", ...FACTS },
    { kind: "timeZone", zone: "Europe/London" },
    {
      kind: "clientConnected",
      conn: CONN,
      client: CONSOLE_CLIENT,
      listener: "console",
      proto: 1,
      app: "1.0.0",
    },
  ];
  for (const event of events) loop.enqueue(event);
  drain(loop);
  return loop;
}

function drain(loop: HubLoop): void {
  for (let turns = 0; turns < 20 && (loop.waiting > 0 || loop.openJobs > 0); turns++) loop.turn();
}

const NAMES = APP_OP_NAMES.filter(
  (n): n is Exclude<AppOpName, "fileChunk"> => OP_OWNERS[n] !== "shell",
);

describe("every request the channel hands the core is answered once, at the loop's level", () => {
  test.each([...NAMES])("%s", (name) => {
    const answers: string[] = [];
    const reports: HubError[] = [];
    const loop = loopWith(answers, reports);
    answers.length = 0;
    const parsed = parseAppOp(name, BODIES[name]);
    expect([name, parsed.ok]).toEqual([name, true]);
    if (!parsed.ok) return;
    const id = 41;
    loop.enqueue({
      kind: "clientRequest",
      conn: CONN,
      client: CONSOLE_CLIENT,
      request: { id, seq: APP_OPS[name].change ? 1 : undefined, op: parsed.value },
    });
    drain(loop);
    const mine = answers.filter((a) => a.startsWith(`${String(id)}:`));
    expect([name, mine.length]).toEqual([name, 1]);
    expect([name, mine[0]]).not.toEqual([name, `${String(id)}:notBuilt`]);
    // Nothing the loop was handed is reported as dropped or not built.
    expect([name, reports.map((r) => r.message)]).toEqual([name, []]);
  });
});
