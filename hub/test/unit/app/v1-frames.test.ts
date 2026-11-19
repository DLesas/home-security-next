/**
 * A version 1 session receives byte for byte what it received before channel version 2 was wired
 * into `app` (docs/m3-m4-plan.md, H1): the household scenario of `support/v1-scenario.ts` was run
 * on the code as it stood before, and every frame each version 1 session was sent, as the wire
 * carries it, kept in `fixtures/v1-frames.json`, alone and with a version 2 session of Anna's phone
 * open beside the version 1 ones (a session the code before treated as it treats any). Here both
 * are run again and compared frame by frame.
 *
 * The fixture was first recorded before version 2 existed. Use
 * `HSN_RECORD_V1_FRAMES=1 bun test hub/test/unit/app/v1-frames.test.ts` only for a deliberate
 * change to version 1's behaviour, and review every changed frame.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connId } from "../../../src/core/model/ids.ts";
import { ANNA_PHONE, type Hub } from "../people/support/hub.ts";
import { type RecordedStep, runV1Scenario } from "./support/v1-scenario.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "v1-frames.json");

interface Recording {
  readonly alone: readonly RecordedStep[];
  readonly beside: readonly RecordedStep[];
}

/** A version 2 session of Anna's phone, open and subscribed before the scenario's requests. */
function besideV2(hub: Hub): void {
  hub.input({
    kind: "clientConnected",
    conn: connId(5_000),
    client: ANNA_PHONE,
    listener: "lan",
    proto: 2,
    app: "2.0.0",
  });
  hub.request(connId(5_000), ANNA_PHONE, {
    op: "subscribe",
    body: { topics: ["arming", "devices", "notifications", "people", "hub", "config"] },
  });
}

function recorded(): Recording {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as Recording;
}

if (process.env.HSN_RECORD_V1_FRAMES === "1") {
  const recording: Recording = {
    alone: runV1Scenario(),
    beside: runV1Scenario({ extra: besideV2 }),
  };
  writeFileSync(FIXTURE, `${JSON.stringify(recording, null, 1)}\n`);
}

describe("version 1 sessions receive what they received before version 2", () => {
  test("the recording exists and holds frames of every kind", () => {
    expect(existsSync(FIXTURE)).toBe(true);
    const frames = recorded().alone.flatMap((s) =>
      s.frames.map((f) => JSON.parse(f.json) as unknown),
    );
    const kinds = new Set(
      frames.map((f) => {
        const m = f as { readonly t: string; readonly ev?: string; readonly ok?: boolean };
        return m.t === "evt" ? `evt:${m.ev ?? ""}` : `res:${String(m.ok)}`;
      }),
    );
    for (const kind of [
      "res:true",
      "res:false",
      "evt:device",
      "evt:notification",
      "evt:hub",
      "evt:arming",
      "evt:people",
      "evt:backupKeyChanged",
    ])
      expect(kinds).toContain(kind);
  });

  test("step by step, frame by frame, byte for byte", () => {
    const now = runV1Scenario();
    const before = recorded().alone;
    expect(now.map((s) => s.step)).toEqual(before.map((s) => s.step));
    for (const [i, step] of now.entries()) expect(step).toEqual(before[i] ?? expect.unreachable());
  });

  test("the same with a version 2 session of the phone open beside them", () => {
    expect(runV1Scenario({ extra: besideV2 })).toEqual(recorded().beside);
  });
});
