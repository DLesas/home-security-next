/**
 * No operation is unbuilt or unanswered (m2-design.md sections 5, 6 and 11), on the real core
 * with every module: each operation of `APP_OPS` sent on a session by the hub computer's console
 * (permitted everything, the console-only operations included), and each control operation sent
 * as `hsn` sends it, with a valid body. Each must get exactly one answer that is not `notBuilt`:
 * a reply in the step, the shell's effect for the two the shell answers (`historyRead`,
 * `hubStatusRead`), or, for a file job, the reply its `fileReady` gives (here a failed job's). A
 * core fault is no answer.
 *
 * `NOT_YET` names the exceptions, each with its owner and reason. It is empty at the end of M2;
 * an operation is added to it only with the coordinator's agreement, never to make this pass.
 */
import { describe, expect, test } from "bun:test";
import { APP_OP_NAMES, type AppOp, type AppOpName, parseAppOp } from "@hsn/protocol/app";
import { CONTROL_OPS, controlCommand, typedCommand } from "../../../src/control-protocol/index.ts";
import type { ControlCommand } from "../../../src/core/model/control.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { HubEvent } from "../../../src/core/model/events.ts";
import { type ConnId, connId, requestId } from "../../../src/core/model/ids.ts";
import { OP_OWNERS } from "../../../src/core/model/ops.ts";
import { MODULES } from "../../../src/core/step.ts";
import { BODIES } from "./support/bodies.ts";
import { ANNA, CONSOLE_CLIENT, household, Hub, repliesTo, role } from "../people/support/hub.ts";

/** The exceptions: operation, owner, and why it is not answered yet. Empty when M2 is done. */
const NOT_YET: Readonly<
  Partial<Record<AppOpName, { readonly owner: string; readonly why: string }>>
> = {};

function booted(): Hub {
  const hub = new Hub(MODULES);
  hub.boot(household({ userManagement: true, roles: [role(ANNA, true, true)] }));
  return hub;
}

/** A file job's end, as the shell gives it: here a job that failed, which still answers. */
function ended(hub: Hub, effects: readonly Effect[]): readonly Effect[] {
  return effects.flatMap((e) =>
    e.kind === "fileJob"
      ? step(hub, {
          kind: "fileReady",
          job: e.job,
          outcome: { kind: "failed", reason: "io", message: "the test's job failed" },
        })
      : [],
  );
}

/** One step; a core fault is recorded as no effects (and so as no answer). */
function step(hub: Hub, event: HubEvent): readonly Effect[] {
  const result = hub.try(event);
  return result.isOk() ? result.value.effects : [`fault: ${result.error.message}` as never];
}

/** Each answer the request got on `conn`: a reply's code, the shell's effect, or a fault. */
function answers(effects: readonly Effect[], conn: ConnId, id: number): readonly string[] {
  const replies = repliesTo(
    effects.filter((e) => typeof e === "object"),
    conn,
  )
    .filter((r) => r.id === id)
    .map((r) => (r.ok ? "ok" : r.error.code));
  const shell = effects.flatMap((e) =>
    typeof e === "object" &&
    (e.kind === "historyRead" || e.kind === "hubStatusRead") &&
    e.conn === conn &&
    e.id === id
      ? [e.kind]
      : [],
  );
  const faults = effects.flatMap((e) => (typeof e === "string" ? [e] : []));
  return [...replies, ...shell, ...faults];
}

const APP_NAMES = APP_OP_NAMES.filter(
  (n): n is Exclude<AppOpName, "fileChunk"> => OP_OWNERS[n] !== "shell",
);

describe("every operation is built and answered once (sections 5, 6 and 11)", () => {
  test("the exceptions name only operations that exist, each with an owner and a reason", () => {
    for (const [name, why] of Object.entries(NOT_YET)) {
      expect(APP_OP_NAMES as readonly string[]).toContain(name);
      expect(why.owner.length * why.why.length).toBeGreaterThan(0);
    }
  });

  test.each([...APP_NAMES])("%s on a session", (name) => {
    const hub = booted();
    const conn = hub.connect(CONSOLE_CLIENT, "console");
    const parsed = parseAppOp(name, BODIES[name]);
    expect([name, parsed.ok ? "ok" : parsed.issues]).toEqual([name, "ok"]);
    const op: AppOp = parsed.ok ? parsed.value : { op: "pong", body: {} };
    const { id, effects } = hub.request(conn, CONSOLE_CLIENT, op);
    const got = answers([...effects, ...ended(hub, effects)], conn, id);
    const exception = NOT_YET[name];
    if (exception !== undefined) {
      console.log(
        `not yet: ${name} (${exception.owner}): ${exception.why}; answered ${got.join(", ")}`,
      );
      return;
    }
    expect([name, got.length]).toEqual([name, 1]);
    expect([name, got[0]]).not.toEqual([name, "notBuilt"]);
  });

  test.each([...CONTROL_OPS])("%s from hsn", (name) => {
    const hub = booted();
    const parsed = controlCommand.safeParse({ kind: "op", op: name, body: BODIES[name] });
    expect([name, parsed.success]).toEqual([name, true]);
    const typed = parsed.success ? typedCommand(parsed.data) : undefined;
    expect([name, typed !== undefined]).toEqual([name, true]);
    const command: ControlCommand = typed ?? { kind: "status" };
    const effects = step(hub, {
      kind: "command",
      request: requestId(9),
      actor: "dimitri",
      command,
      conn: connId(4),
    });
    const all = [...effects, ...ended(hub, effects)];
    const replies = all.flatMap((e) =>
      typeof e === "string"
        ? [e]
        : e.kind === "respond"
          ? [e.reply.ok ? "ok" : e.reply.error.code]
          : [],
    );
    const exception = NOT_YET[name];
    if (exception !== undefined) return;
    expect([name, replies.length]).toEqual([name, 1]);
    expect([name, replies[0]]).not.toEqual([name, "notBuilt"]);
  });
});
