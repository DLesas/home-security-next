/**
 * A handler returns its slice unchanged for a message that changes nothing (hub-design.md section
 * 2): for `people` and `app`, every input kind that has nothing to do for them leaves both slices
 * the very same objects, also right after a step that sent events. Without it the run loop's guard
 * against a wake never handled sees progress for ever (`hub/test/world/world.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import type { HubEvent } from "../../../src/core/model/events.ts";
import { connId, jobId, linkId, requestId, sendRef, tokenId } from "../../../src/core/model/ids.ts";
import { ANNA_LAPTOP, FACTS, household, Hub } from "../people/support/hub.ts";

const RESTORE_TOKEN = tokenId(2 ** 31 + 5);

/**
 * One input of each kind that has nothing to do for people or app, or why the kind is left out:
 * the record type makes a new input kind fail to compile here until it is placed.
 */
const INPUTS: Readonly<Record<HubEvent["kind"], HubEvent | string>> = {
  boot: "rebuilds both slices",
  linkOpened: { kind: "linkOpened", link: linkId(40), linkKind: "network", label: "10.0.0.9" },
  linkClosed: { kind: "linkClosed", link: linkId(41), reason: "remote" },
  frame: { kind: "frame", link: linkId(42), bytes: new Uint8Array([1, 2, 3]) },
  sendFailed: { kind: "sendFailed", link: linkId(42), ref: sendRef(7), error: "closed" },
  commit: { kind: "commit", outcome: { kind: "recovered" } },
  command: {
    kind: "command",
    conn: connId(0),
    request: requestId(900),
    actor: "root",
    command: { kind: "status" },
  },
  inputRejected: {
    kind: "inputRejected",
    rejection: { source: "control", reason: "notJson", bytes: 3, issues: [] },
  },
  tick: { kind: "tick" },
  // Step 1, wave 2: a refused handshake (A3 records it as `client_refused`, a record only) and a
  // shell warning, which is `audit`'s.
  clientRefused: "counts the hour's refusals per address (app)",
  shellWarning: {
    kind: "shellWarning",
    code: "data_folder_was_open",
    message: "the data folder was open",
    detail: null,
  },
  clientConnected: "adds a session and a client's last seen",
  clientRequest: {
    kind: "clientRequest",
    conn: connId(999),
    client: ANNA_LAPTOP,
    request: { id: 1, seq: undefined, op: { op: "pong", body: {} } },
  },
  clientClosed: { kind: "clientClosed", conn: connId(998), reason: "remote" },
  linkCompleted: {
    kind: "linkCompleted",
    conn: connId(997),
    token: RESTORE_TOKEN,
    staticKey: new Uint8Array(32),
    listener: "lan",
    link: { name: "x", kind: "web" },
  },
  linkFailed: { kind: "linkFailed", token: RESTORE_TOKEN, reason: "badPsk", address: "10.0.0.9" },
  hubFacts: { kind: "hubFacts", ...FACTS },
  timeZone: { kind: "timeZone", zone: "Europe/London" },
  fileReady: {
    kind: "fileReady",
    job: jobId(1),
    outcome: { kind: "failed", reason: "io", message: "-" },
  },
  restoreOpened: { kind: "restoreOpened", conn: connId(996), token: RESTORE_TOKEN },
  restoreKey: {
    kind: "restoreKey",
    conn: connId(996),
    token: RESTORE_TOKEN,
    key: new Uint8Array(32),
    epoch: 1,
  },
};

function quiet(): Hub {
  const hub = new Hub();
  hub.boot(household());
  const conn = hub.connect(ANNA_LAPTOP);
  hub.request(conn, ANNA_LAPTOP, { op: "subscribe", body: { topics: ["arming"] } });
  return hub;
}

describe("people and app leave their slices as they were for inputs that change nothing", () => {
  test.each(
    Object.entries(INPUTS).filter(
      (entry): entry is [string, HubEvent] => typeof entry[1] !== "string",
    ),
  )("%s", (_kind, event) => {
    const hub = quiet();
    const before = hub.state;
    hub.input(event);
    expect(hub.state.people).toBe(before.people);
    expect(hub.state.app).toBe(before.app);
  });

  test("also on the step after one that sent events: three ticks change neither", () => {
    const hub = quiet();
    hub.command({ kind: "arm", sensors: ["front"], continue: false });
    const before = hub.state;
    for (let i = 0; i < 3; i++) hub.input({ kind: "tick" });
    expect(hub.state.people).toBe(before.people);
    expect(hub.state.app).toBe(before.app);
  });
});
