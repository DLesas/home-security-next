/**
 * Hub updates in the core (m2-design.md section 9, "Hub updates"; D54, HB23): staged from a file
 * (D119: no download in M2), approved by *manage system*, switched only when no countdown, alarm,
 * site move, provisioning or restore runs, and judged healthy or rolled back at the next start.
 *
 * - `update.upload {job}`: the shell checks the release and unpacks it beside the running version
 *   (`stageUpdate`); the answer waits for it. `update_staged`, written now with the staged row.
 * - `update.approve`: the approval, written now; the switch follows at once when nothing holds it
 *   back, otherwise it waits.
 * - **The switch** is decided in the step whose message finds an approved update and nothing
 *   running (`switchIfClear`, after every message upkeep handles): `update_switching` and
 *   `switching_ms` written now, then `switchUpdate`. A later message of that same step could still
 *   start a countdown: the shell checks `switchBlockedBy` (view.ts) again after the commit and, if
 *   anything runs, answers the job `failed`; the switch then waits again, until the way is clear.
 *   A switch the shell refused while nothing holds it back (it was not started by the launcher, the
 *   version is not installed, the note could not be written) would only be refused again: the
 *   approval is withdrawn with `update_refused`, as for too little room, and a person approves
 *   again. (A timer at now, which this replaced, ran the switch one turn later; after such a
 *   refusal it was armed again at once, so the hub switched and was refused turn after turn.)
 * - **At the next start** (the first `hubFacts`, which names the running version): the version
 *   switched to is running, so `update_healthy`; otherwise the launcher put the old one back
 *   (section 9, step 5), so `update_rolled_back`. Either way the switch is over, written now. The
 *   shell tells the launcher once `update_healthy` is committed (section 9, step 4).
 */
import type { AppOpBody } from "@hsn/protocol/app";
import { alarmSummary, countdownOrAlarmRunning } from "../alarm/view.ts";
import type { FileOutcome } from "../model/events.ts";
import type { Context } from "../model/handler.ts";
import type { AnswerTo, Actor } from "../model/messages.ts";
import type { HubState } from "../model/state.ts";
import { UpdateResult, type UpdateStateRow } from "../model/rows.ts";
import { usbBoards } from "../setup/view.ts";
import { latestMove } from "../site/view.ts";
import { actorText, upkeepDecision, upkeepHubEvent, writeUpdateState } from "./records.ts";
import { busy, fileRefusal, invalid, type Steps, UNAVAILABLE, uploadOf } from "./out.ts";
import { NO_UPDATE, type UpkeepSlice } from "./state.ts";

/** What holds a switch back (D54, HB23), as `busy`'s `because` names it. */
export type SwitchBlock = "countdown" | "alarm" | "siteMove" | "provisioning" | "restore";

/** What would hold the switch back now, or undefined when it may go. */
export function switchBlock(view: HubState, slice: UpkeepSlice): SwitchBlock | undefined {
  if (countdownOrAlarmRunning(view))
    return alarmSummary(view) === undefined ? "countdown" : "alarm";
  const move = latestMove(view);
  if (move?.stage === "announcing" || move?.stage === "switched") return "siteMove";
  if (usbBoards(view).some((board) => board.exchange?.kind === "provision")) return "provisioning";
  if (slice.restore !== undefined) return "restore";
  return undefined;
}

const RESULT_NAMES = {
  [UpdateResult.None]: "none",
  [UpdateResult.Healthy]: "healthy",
  [UpdateResult.RolledBack]: "rolledBack",
} as const;

/** Nothing staged, the previous version and the last update's outcome kept (they outlive it). */
function kept(row: UpdateStateRow): UpdateStateRow {
  return {
    ...NO_UPDATE,
    previousVersion: row.previousVersion,
    lastResult: row.lastResult,
    lastResultMs: row.lastResultMs,
  };
}

function setUpdate(steps: Steps, row: UpdateStateRow): void {
  steps.set({ ...steps.slice, update: row });
  steps.push(writeUpdateState(row));
}

/** An update is approved and not yet switching. */
export function waitingToSwitch(slice: UpkeepSlice): boolean {
  return (
    slice.update.stagedVersion !== null &&
    slice.update.approvedBy !== null &&
    slice.update.switchingMs === null &&
    slice.switchJob === undefined
  );
}

export function updateUpload(
  steps: Steps,
  answerTo: AnswerTo,
  body: AppOpBody<"update.upload">,
): void {
  const slice = steps.slice;
  if (slice.staging !== undefined) {
    steps.refuse(answerTo, busy("upload"));
    return;
  }
  if (slice.switchJob !== undefined || slice.update.switchingMs !== null) {
    steps.refuse(answerTo, busy("updateSwitch"));
    return;
  }
  if (slice.restore !== undefined) {
    steps.refuse(answerTo, busy("restore"));
    return;
  }
  const upload = uploadOf(answerTo, body.job);
  if (upload === undefined) {
    steps.refuse(answerTo, UNAVAILABLE);
    return;
  }
  const job = steps.job();
  steps.set({ ...steps.slice, staging: { job, upload, answerTo } });
  steps.push({ kind: "fileJob", job, work: { kind: "stageUpdate", upload } });
}

/** The release checked and unpacked, or refused (`stageUpdate`). */
export function staged(steps: Steps, ctx: Context, outcome: FileOutcome): void {
  const staging = steps.slice.staging;
  if (staging === undefined) return;
  steps.set({ ...steps.slice, staging: undefined });
  if (outcome.kind !== "updateStaged") {
    const reason = outcome.kind === "failed" ? outcome.reason : "io";
    const message = outcome.kind === "failed" ? outcome.message : `unexpected ${outcome.kind}`;
    // Section 9, "What each bad file gets": `invalid {field: "job", reason}` and `update_refused`.
    const refusal = fileRefusal(outcome, staging.upload, {
      badFile: "badFile",
      badSignature: "badSignature",
      wrongSystem: "wrongSystem",
      notNewer: "notNewer",
      full: "full",
    });
    // A missing upload is no release at all: `notFound {upload}` and no `update_refused`.
    if (reason !== "noUpload") {
      steps.pushResult(
        upkeepHubEvent(ctx, "update_refused", `release refused: ${message}`, { reason, message }),
      );
    }
    steps.refuse(staging.answerTo, refusal);
    return;
  }
  setUpdate(steps, {
    ...kept(steps.slice.update),
    stagedVersion: outcome.version,
    stagedMs: ctx.now.wall,
  });
  steps.pushResult(upkeepDecision(ctx, "update_staged", { detail: outcome.version }));
  steps.answer(staging.answerTo, { version: outcome.version });
}

/** `update.approve`: when it will switch (D54). */
export function updateApprove(steps: Steps, ctx: Context, answerTo: AnswerTo, actor: Actor): void {
  const row = steps.slice.update;
  if (row.stagedVersion === null) {
    steps.refuse(answerTo, invalid("", "unknownReference"));
    return;
  }
  if (row.switchingMs !== null || steps.slice.switchJob !== undefined) {
    steps.refuse(answerTo, busy("updateSwitch"));
    return;
  }
  setUpdate(steps, { ...row, approvedBy: actorText(actor), approvedMs: ctx.now.wall });
  const block = switchBlock(ctx.view, steps.slice);
  steps.answer(answerTo, { switchWhen: block === undefined ? "now" : `after:${block}` });
  switchIfClear(steps, ctx);
}

/**
 * A staging under way dropped (a cancel, a restore): its upload answered `unavailable`; the
 * shell's next piece finds it unwanted (`view.ts`'s `stagingJob`) and removes what it wrote. An
 * outcome that still comes for it is ignored.
 */
export function dropStaging(steps: Steps): void {
  const staging = steps.slice.staging;
  if (staging === undefined) return;
  steps.set({ ...steps.slice, staging: undefined });
  steps.refuse(staging.answerTo, UNAVAILABLE);
}

/** `update.cancel`: a staging, the staged version and its approval dropped, unless the switch began. */
export function updateCancel(steps: Steps, answerTo: AnswerTo): void {
  const row = steps.slice.update;
  if (row.switchingMs !== null || steps.slice.switchJob !== undefined) {
    steps.refuse(answerTo, busy("updateSwitch"));
    return;
  }
  dropStaging(steps);
  setUpdate(steps, kept(row));
  steps.answer(answerTo, {});
}

export function updateStatus(steps: Steps, answerTo: AnswerTo): void {
  const slice = steps.slice;
  steps.answer(answerTo, {
    staged: slice.update.stagedVersion,
    approvedBy: slice.update.approvedBy,
    switching: slice.update.switchingMs !== null,
    lastResult: RESULT_NAMES[slice.update.lastResult],
    // Step 0 owner, wave 2: `update.status` gains `lastResultMs` (frozen), from the row's own.
    lastResultMs: slice.update.lastResultMs,
  });
}

/**
 * After every message: an approved update whose way is clear switches now, in this step (see the
 * file's comment). Nothing is polled and no timer is set: upkeep sees every message and runs after
 * every module that can hold the switch back, so the message that clears the way (the approval, a
 * countdown's or alarm's end, a move done, a board answered, a restore over) reaches it in the
 * step that cleared it.
 */
export function switchIfClear(steps: Steps, ctx: Context): void {
  const slice = steps.slice;
  const version = slice.update.stagedVersion;
  if (!waitingToSwitch(slice) || version === null) return;
  if (switchBlock(ctx.view, slice) !== undefined) return;
  setUpdate(steps, {
    ...slice.update,
    switchingMs: ctx.now.wall,
    previousVersion: slice.version ?? slice.update.previousVersion,
  });
  steps.pushResult(upkeepDecision(ctx, "update_switching", { detail: version }));
  const job = steps.job();
  steps.set({ ...steps.slice, switchJob: job });
  steps.push({ kind: "fileJob", job, work: { kind: "switchUpdate", version } });
}

/**
 * The shell did not switch. Something started in the same turn, and still runs: wait again, until
 * the way is clear (`switchIfClear`). No room for the database's copy before the migration
 * (`full`, section 9, step 4), or a refusal while nothing holds the switch back, which a retry
 * would only meet again (see the file's comment): the approval is dropped, with `update_refused`,
 * and nothing stopped.
 */
export function switchFailed(steps: Steps, ctx: Context, outcome: FileOutcome): void {
  steps.set({ ...steps.slice, switchJob: undefined });
  const full = outcome.kind === "failed" && outcome.reason === "full";
  if (!full && switchBlock(ctx.view, steps.slice) !== undefined) {
    setUpdate(steps, { ...steps.slice.update, switchingMs: null });
    return;
  }
  const reason = outcome.kind === "failed" ? outcome.reason : "io";
  const message = outcome.kind === "failed" ? outcome.message : `unexpected ${outcome.kind}`;
  setUpdate(steps, {
    ...steps.slice.update,
    switchingMs: null,
    approvedBy: null,
    approvedMs: null,
  });
  steps.pushResult(
    upkeepHubEvent(ctx, "update_refused", `switch refused: ${message}`, { reason, message }),
  );
}

/** The first `hubFacts` after a switch: healthy, or rolled back by the launcher (section 9). */
export function afterSwitch(steps: Steps, ctx: Context, version: string): void {
  const row = steps.slice.update;
  if (row.switchingMs === null || steps.slice.switchJob !== undefined) return;
  const target = row.stagedVersion;
  if (target !== null && version === target) {
    setUpdate(steps, {
      ...NO_UPDATE,
      previousVersion: row.previousVersion,
      lastResult: UpdateResult.Healthy,
      lastResultMs: ctx.now.wall,
    });
    steps.pushResult(upkeepDecision(ctx, "update_healthy", { detail: version }));
    return;
  }
  setUpdate(steps, {
    ...NO_UPDATE,
    lastResult: UpdateResult.RolledBack,
    lastResultMs: ctx.now.wall,
  });
  steps.pushResult(upkeepDecision(ctx, "update_rolled_back", { detail: target ?? "" }));
}
