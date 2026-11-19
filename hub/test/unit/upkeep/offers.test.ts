/**
 * Hub releases through the relay, upkeep's side (docs/m4-design.md section 6): the relay's offer
 * kept for `update.offers` and recorded once a run per version (`update_offered`, info, routine);
 * `update.fetch {version}` only for the version offered and only when nothing else stages, switches
 * or restores, answered `{job}` at once with a `fetchRelease` naming the offer's file, length and
 * 32-byte SHA-256, the staging under that same job (`stagingJob`), and its end `update_staged` or
 * `update_refused`; and the switch held while a device installs firmware or is on trial
 * (`firmwareInstall`, m3-updates-design section 4).
 */
import { describe, expect, test } from "bun:test";
import { type AppOp, type AppOpV2, isVersion1Op, type ReleaseOffer } from "@hsn/protocol/app";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { FileOutcome, FileFailure } from "../../../src/core/model/events.ts";
import { clientId, connId, deviceId, jobId, type JobId, seq } from "../../../src/core/model/ids.ts";
import type { AnswerTo } from "../../../src/core/model/messages.ts";
import {
  BACKUP_STATE_DEFAULTS,
  DeviceUpdateState,
  type DeviceUpdateRow,
} from "../../../src/core/model/rows.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import type { DeviceEntry } from "../../../src/core/firmware/state.ts";
import { hubReleaseOffer, stagingJob, switchBlockedBy } from "../../../src/core/upkeep/view.ts";
import { newerVersion } from "../../../src/core/upkeep/update.ts";
import { MODULES } from "../../../src/core/step.ts";
import { CONSOLE_CLIENT, household, Hub, onlyReply, testModules } from "../people/support/hub.ts";
import { type Ran, Runner, snapshot } from "./support.ts";

const SHA = "ab".repeat(32);
const COMPUTER = { kind: "computer", name: "root" } as const;
const CONSOLE: AnswerTo = { kind: "app", conn: connId(3), client: clientId(1), id: 7, seq: 9 };

function hub(version: string, file = `hsn-hub-${version}-darwin-arm64.hsnr`, bytes = 1000) {
  return {
    kind: "hub",
    version,
    platform: "darwin-arm64",
    file,
    bytes,
    sha256: SHA,
  } as const satisfies ReleaseOffer;
}

const FIRMWARE = {
  kind: "firmware",
  version: "3.0.0",
  target: "esp32s3-olimex-poe",
  roles: [1],
  file: "hsn-firmware-3.0.0.hsnf",
  bytes: 4000,
  sha256: SHA,
} as unknown as ReleaseOffer;

function booted(running: string | null = "1.0.0"): Runner {
  const runner = new Runner();
  runner.boot(
    snapshot({
      backupState: BACKUP_STATE_DEFAULTS,
      backupKey: { key: new Uint8Array(32), epoch: 1 },
    }),
  );
  if (running !== null)
    runner.send({
      kind: "hubFacts",
      version: running,
      addresses: [],
      appsPort: 8444,
      consolePort: 8445,
      certificateSha256: new Uint8Array(32),
    });
  return runner;
}

function offered(runner: Runner, ...releases: ReleaseOffer[]): Ran {
  return runner.send({ kind: "releaseOffered", releases });
}

/**
 * An operation as `app` sends it to upkeep (H1, docs/m3-m4-plan.md step 2): a version 1 row as an
 * `opRequest`, a row only version 2 names (`update.offers`, `update.fetch`) as a `v2OpRequest`.
 */
function op(runner: Runner, o: AppOpV2, answerTo: AnswerTo = CONSOLE): Ran {
  return runner.send(
    isVersion1Op(o.op)
      ? {
          kind: "opRequest",
          owner: "upkeep",
          op: o as AppOp,
          actor: COMPUTER,
          answerTo,
          record: seq(0),
        }
      : { kind: "v2OpRequest", owner: "upkeep", op: o, actor: COMPUTER, answerTo, record: seq(0) },
  );
}

function answer(ran: Ran): unknown {
  const found = ran.messages.find((m) => m.kind === "opAnswer");
  return found?.kind === "opAnswer" ? found.outcome : undefined;
}

function decisions(ran: Ran) {
  return ran.messages.flatMap((m) =>
    m.kind === "auditRecord" && m.record.kind === "decision"
      ? [
          {
            kind: m.record.row.kind,
            detail: new TextDecoder().decode(m.record.row.detail ?? new Uint8Array()),
            durability: m.durability,
          },
        ]
      : [],
  );
}

function hubEvents(ran: Ran) {
  return ran.messages.flatMap((m) =>
    m.kind === "auditRecord" && m.record.kind === "hubEvent"
      ? [{ code: m.record.row.code, detail: JSON.parse(m.record.row.detail ?? "null") as unknown }]
      : [],
  );
}

function fileJob(ran: Ran): Extract<Effect, { readonly kind: "fileJob" }> | undefined {
  return ran.effects.find(
    (e): e is Extract<Effect, { readonly kind: "fileJob" }> => e.kind === "fileJob",
  );
}

function ready(runner: Runner, job: JobId, outcome: FileOutcome): Ran {
  return runner.send({ kind: "fileReady", job, outcome });
}

describe("the relay's offer (update.offers, update_offered)", () => {
  test("nothing offered: {offer: null}", () => {
    expect(answer(op(booted(), { op: "update.offers", body: {} }))).toEqual({
      ok: true,
      body: { offer: null },
    });
  });

  test("a hub release beside a firmware one: kept, recorded once as info (routine), the version as detail", () => {
    const runner = booted();
    const ran = offered(runner, hub("1.2.0"), FIRMWARE);
    expect(decisions(ran)).toEqual([
      { kind: "update_offered", detail: "1.2.0", durability: "routine" },
    ]);
    expect(answer(op(runner, { op: "update.offers", body: {} }))).toEqual({
      ok: true,
      body: { offer: { version: "1.2.0", bytes: 1000, platform: "darwin-arm64" } },
    });
    expect(hubReleaseOffer(runner.view)).toEqual({
      version: "1.2.0",
      bytes: 1000,
      platform: "darwin-arm64",
    });
    // Offered again (the link reopened, a day passed): no second record.
    expect(decisions(offered(runner, hub("1.2.0")))).toEqual([]);
    // A newer one: recorded; and the first, offered again later, is not.
    expect(decisions(offered(runner, hub("1.3.0"))).map((d) => d.detail)).toEqual(["1.3.0"]);
    expect(decisions(offered(runner, hub("1.2.0")))).toEqual([]);
  });

  test("only a release above the running version is an offer: equal is none, one patch above is", () => {
    const runner = booted("1.4.2");
    expect(decisions(offered(runner, hub("1.4.2")))).toEqual([]);
    expect(runner.slice.offer).toBeUndefined();
    expect(decisions(offered(runner, hub("1.4.1")))).toEqual([]);
    expect(decisions(offered(runner, hub("1.4.3"))).map((d) => d.detail)).toEqual(["1.4.3"]);
    expect(runner.slice.offer?.version).toBe("1.4.3");
  });

  test("before the running version is known, any well-formed one; a malformed version never", () => {
    const runner = booted(null);
    expect(decisions(offered(runner, hub("0.0.1"))).map((d) => d.detail)).toEqual(["0.0.1"]);
    expect(decisions(offered(runner, hub("01.0.0")))).toEqual([]);
    expect(runner.slice.offer).toBeUndefined();
  });

  test("several hub entries: the newest; an offer with none clears the last", () => {
    const runner = booted();
    offered(runner, hub("1.10.0"), hub("1.9.9"), hub("1.2.0"));
    expect(runner.slice.offer?.version).toBe("1.10.0");
    offered(runner, FIRMWARE);
    expect(runner.slice.offer).toBeUndefined();
    expect(answer(op(runner, { op: "update.offers", body: {} }))).toEqual({
      ok: true,
      body: { offer: null },
    });
  });

  test("versions compare as numbers, major first", () => {
    expect(newerVersion("1.10.0", "1.9.0")).toBe(true);
    expect(newerVersion("2.0.0", "1.99.99")).toBe(true);
    expect(newerVersion("1.0.1", "1.0.0")).toBe(true);
    expect(newerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(newerVersion("1.0.0", "1.0.1")).toBe(false);
    expect(newerVersion("1.0.0-rc1", "0.0.1")).toBe(false);
  });
});

describe("update.fetch {version}", () => {
  function withOffer(): Runner {
    const runner = booted();
    offered(runner, hub("1.2.0", "hsn-hub-1.2.0-darwin-arm64.hsnr", 123_456));
    return runner;
  }

  test("a version not offered: invalid {version, unknownReference}; nothing fetched", () => {
    const runner = withOffer();
    for (const version of ["1.2.1", "1.1.9"]) {
      const ran = op(runner, { op: "update.fetch", body: { version } });
      expect(answer(ran)).toEqual({
        ok: false,
        error: { code: "invalid", detail: { field: "version", reason: "unknownReference" } },
      });
      expect(fileJob(ran)).toBeUndefined();
    }
    expect(
      fileJob(op(booted(), { op: "update.fetch", body: { version: "1.2.0" } })),
    ).toBeUndefined();
  });

  test("the offered one: {job} at once, then fetchRelease with the offer's file, length and 32-byte SHA-256; staging under that job", () => {
    const runner = withOffer();
    const ran = op(runner, { op: "update.fetch", body: { version: "1.2.0" } });
    const job = fileJob(ran);
    expect(answer(ran)).toEqual({ ok: true, body: { job: job?.job } });
    // The answer first: the shell runs the job after the turn's answers.
    const kinds = ran.out.map((o) => o.kind);
    expect(kinds.indexOf("opAnswer")).toBeLessThan(kinds.indexOf("fileJob"));
    expect(job?.work).toEqual({
      kind: "fetchRelease",
      release: "hub",
      file: "hsn-hub-1.2.0-darwin-arm64.hsnr",
      bytes: 123_456,
      sha256: new Uint8Array(32).fill(0xab),
    });
    expect(stagingJob(runner.view)).toBe(job?.job);
    // Nothing is recorded or written until it ends.
    expect(decisions(ran)).toEqual([]);
    expect(ran.effects.filter((e) => e.kind === "write")).toEqual([]);
  });

  test("ends staged: update_staged, the staged row written now, no second answer", () => {
    const runner = withOffer();
    const job = fileJob(op(runner, { op: "update.fetch", body: { version: "1.2.0" } }))?.job;
    const done = ready(runner, job ?? jobId(0), { kind: "updateStaged", version: "1.2.0" });
    expect(decisions(done).map((d) => [d.kind, d.detail, d.durability])).toEqual([
      ["update_staged", "1.2.0", "now"],
    ]);
    expect(answer(done)).toBeUndefined();
    expect(
      done.effects.find((e) => e.kind === "write" && e.op.table === "update_state"),
    ).toMatchObject({ durability: "now", op: { row: { stagedVersion: "1.2.0" } } });
    expect(stagingJob(runner.view)).toBeUndefined();
    // Approved like an uploaded one.
    expect(answer(op(runner, { op: "update.approve", body: {} }))).toEqual({
      ok: true,
      body: { switchWhen: "now" },
    });
  });

  const FAILURES: readonly FileFailure[] = [
    "tooLarge",
    "unreachable",
    "badFile",
    "io",
    "badSignature",
    "wrongSystem",
    "notNewer",
    "full",
  ];

  test.each(FAILURES.map((reason) => [reason]))(
    "ends %s: update_refused with the reason and the version, nothing staged, no answer",
    (reason) => {
      const runner = withOffer();
      const job = fileJob(op(runner, { op: "update.fetch", body: { version: "1.2.0" } }))?.job;
      const done = ready(runner, job ?? jobId(0), { kind: "failed", reason, message: "m" });
      expect(hubEvents(done)).toEqual([
        { code: "update_refused", detail: { reason, message: "m", version: "1.2.0" } },
      ]);
      expect(decisions(done)).toEqual([]);
      expect(answer(done)).toBeUndefined();
      expect(runner.slice.update.stagedVersion).toBeNull();
      expect(stagingJob(runner.view)).toBeUndefined();
      // The way is clear for another try.
      expect(fileJob(op(runner, { op: "update.fetch", body: { version: "1.2.0" } }))).toBeDefined();
    },
  );

  test("busy: while a fetch or an upload stages, while switching, while restoring", () => {
    const runner = withOffer();
    op(runner, { op: "update.fetch", body: { version: "1.2.0" } });
    const busy = (because: string) => ({ ok: false, error: { code: "busy", detail: { because } } });
    expect(answer(op(runner, { op: "update.fetch", body: { version: "1.2.0" } }))).toEqual(
      busy("upload"),
    );
    expect(answer(op(runner, { op: "update.upload", body: { job: 4 } }))).toEqual(busy("upload"));

    const uploading = withOffer();
    op(uploading, { op: "update.upload", body: { job: 4 } });
    expect(answer(op(uploading, { op: "update.fetch", body: { version: "1.2.0" } }))).toEqual(
      busy("upload"),
    );

    const switching = withOffer();
    switching.view = {
      ...switching.view,
      upkeep: {
        ...switching.view.upkeep,
        update: { ...switching.view.upkeep.update, switchingMs: 1 },
      },
    };
    expect(answer(op(switching, { op: "update.fetch", body: { version: "1.2.0" } }))).toEqual(
      busy("updateSwitch"),
    );
    const restoring = withOffer();
    restoring.view = {
      ...restoring.view,
      upkeep: { ...restoring.view.upkeep, restore: { stage: "switching", job: jobId(9) } },
    };
    expect(answer(op(restoring, { op: "update.fetch", body: { version: "1.2.0" } }))).toEqual(
      busy("restore"),
    );
  });

  test("a cancel while it fetches: no longer wanted, no answer owed, its later outcome ignored", () => {
    const runner = withOffer();
    const job = fileJob(op(runner, { op: "update.fetch", body: { version: "1.2.0" } }))?.job;
    const cancelled = op(runner, { op: "update.cancel", body: {} });
    expect(cancelled.messages.filter((m) => m.kind === "opAnswer")).toHaveLength(1);
    expect(answer(cancelled)).toEqual({ ok: true, body: {} });
    expect(stagingJob(runner.view)).toBeUndefined();
    const late = ready(runner, job ?? jobId(0), { kind: "updateStaged", version: "1.2.0" });
    expect(decisions(late)).toEqual([]);
    expect(runner.slice.update.stagedVersion).toBeNull();
  });

  test("an offer whose SHA-256 is not 32 bytes is never fetched: unavailable", () => {
    const runner = booted();
    offered(runner, { ...hub("1.2.0"), sha256: "ab".repeat(31) });
    const ran = op(runner, { op: "update.fetch", body: { version: "1.2.0" } });
    expect(answer(ran)).toEqual({ ok: false, error: { code: "unavailable", detail: {} } });
    expect(fileJob(ran)).toBeUndefined();
  });

  test("a v2OpRequest for another module is not upkeep's", () => {
    const runner = withOffer();
    const other = runner.send({
      kind: "v2OpRequest",
      owner: "relay",
      op: { op: "update.fetch", body: { version: "1.2.0" } },
      actor: COMPUTER,
      answerTo: CONSOLE,
      record: seq(0),
    });
    expect(answer(other)).toBeUndefined();
    expect(fileJob(other)).toBeUndefined();
  });
});

// ----- The switch waits while devices install firmware (U7) -----

function installing(
  state: DeviceUpdateState,
): ReadonlyMap<ReturnType<typeof deviceId>, DeviceEntry> {
  const row: DeviceUpdateRow = {
    deviceId: deviceId(3),
    rolloutId: null,
    state,
    method: 0,
    held: 0,
    bytes: 0,
    attempts: 0,
    sameVersion: false,
    lastReason: null,
    sinceMs: 0,
    bleNonce: null,
    bleExpiresMs: null,
    remindedMs: null,
  };
  return new Map([[deviceId(3), { row } as unknown as DeviceEntry]]);
}

function withFirmware(runner: Runner, state: DeviceUpdateState | undefined): void {
  const firmware: HubState["firmware"] = {
    ...runner.view.firmware,
    updates: state === undefined ? new Map() : installing(state),
  };
  runner.view = { ...runner.view, firmware };
}

describe("the switch waits while a device installs firmware (firmwareInstall)", () => {
  function stagedRunner(): Runner {
    const runner = booted();
    const job = fileJob(op(runner, { op: "update.upload", body: { job: 4 } }))?.job;
    ready(runner, job ?? jobId(0), { kind: "updateStaged", version: "1.1.0" });
    return runner;
  }

  test.each([
    ["installing", DeviceUpdateState.Installing],
    ["on trial", DeviceUpdateState.OnTrial],
  ] as const)(
    "a device %s: approved, after:firmwareInstall, no switch; once it ends, switched",
    (_n, state) => {
      const runner = stagedRunner();
      withFirmware(runner, state);
      expect(switchBlockedBy(runner.view)).toBe("firmwareInstall");
      const approve = op(runner, { op: "update.approve", body: {} });
      expect(answer(approve)).toEqual({ ok: true, body: { switchWhen: "after:firmwareInstall" } });
      expect(fileJob(approve)).toBeUndefined();
      // Still installing at the next message: still waiting.
      expect(fileJob(runner.send({ kind: "tick" }))).toBeUndefined();
      // Confirmed: the next message switches.
      withFirmware(runner, DeviceUpdateState.Confirmed);
      expect(switchBlockedBy(runner.view)).toBeUndefined();
      expect(fileJob(runner.send({ kind: "tick" }))?.work).toEqual({
        kind: "switchUpdate",
        version: "1.1.0",
      });
    },
  );

  test.each([
    ["verified (fetched, not yet installing)", DeviceUpdateState.Verified],
    ["fetching", DeviceUpdateState.Fetching],
    ["confirmed", DeviceUpdateState.Confirmed],
    ["rolled back", DeviceUpdateState.RolledBack],
  ] as const)("a device %s does not hold it", (_n, state) => {
    const runner = stagedRunner();
    withFirmware(runner, state);
    expect(switchBlockedBy(runner.view)).toBeUndefined();
    expect(fileJob(op(runner, { op: "update.approve", body: {} }))?.work.kind).toBe("switchUpdate");
  });

  test("a countdown is named before it: the earlier holds keep their order", () => {
    const runner = stagedRunner();
    withFirmware(runner, DeviceUpdateState.Installing);
    runner.view = {
      ...runner.view,
      upkeep: { ...runner.view.upkeep, restore: { stage: "switching", job: jobId(9) } },
    };
    expect(switchBlockedBy(runner.view)).toBe("restore");
  });
});

// ----- The whole core: a person's version 2 session, through `app` -----

describe("through app, on a version 2 session (H1's routing)", () => {
  test("the console asks update.offers and update.fetch: the offer, then {job} and the fetch", () => {
    const hub = new Hub(testModules({ upkeep: MODULES.upkeep }));
    hub.boot(household());
    hub.input({ kind: "releaseOffered", releases: [hub2("2.1.0"), FIRMWARE] });
    const console = connId(80);
    hub.input({
      kind: "clientConnected",
      conn: console,
      client: CONSOLE_CLIENT,
      listener: "console",
      proto: 2,
      app: "2.0.0",
    });
    const offers = hub.input({
      kind: "clientRequest",
      conn: console,
      client: CONSOLE_CLIENT,
      request: { id: 1, seq: undefined, op: { op: "update.offers", body: {} } },
    });
    expect(onlyReply(offers, console)).toMatchObject({
      ok: true,
      body: { offer: { version: "2.1.0", bytes: 1000, platform: "darwin-arm64" } },
    });
    const fetched = hub.input({
      kind: "clientRequest",
      conn: console,
      client: CONSOLE_CLIENT,
      request: { id: 2, seq: 1, op: { op: "update.fetch", body: { version: "2.1.0" } } },
    });
    const job = fetched.find(
      (e): e is Extract<Effect, { readonly kind: "fileJob" }> => e.kind === "fileJob",
    );
    expect(job?.work).toMatchObject({ kind: "fetchRelease", release: "hub", bytes: 1000 });
    expect(onlyReply(fetched, console)).toMatchObject({ ok: true, body: { job: job?.job } });
  });
});

/** A hub release above the people harness's running version (`FACTS`, 2.0.0). */
function hub2(version: string) {
  return hub(version);
}
