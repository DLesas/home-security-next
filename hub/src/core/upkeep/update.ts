/**
 * Hub updates in the core (m2-design.md section 9, "Hub updates"; D54, HB23): staged from a file
 * (D119: no download in M2), approved by *manage system*, switched only when no countdown, alarm,
 * site move, provisioning or restore runs, and judged healthy or rolled back at the next start.
 *
 * - `update.upload {job}`: the shell checks the release and unpacks it beside the running version
 *   (`stageUpdate`); the answer waits for it. `update_staged`, written now with the staged row.
 * - From M4 (m4-design section 6): the relay's offer (`releaseOffered`), kept for `update.offers`
 *   and recorded once a run per version (`update_offered`); `update.fetch {version}` fetches the
 *   offered file through the relay (`fetchRelease`), answered `{job}` at once, and the shell
 *   stages it under that job as an upload is staged, ending `update_staged` or `update_refused`.
 * - The switch also waits while a device installs firmware or is on trial with it
 *   (`firmwareInstall`, m3-updates-design section 4).
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
import {
  type AppOpBody,
  type AppOpBodyV2,
  OFFER_AND_ROLLOUT_REFUSALS,
  type ReleaseOffer,
} from "@hsn/protocol/app";
import { alarmSummary, countdownOrAlarmRunning } from "../alarm/view.ts";
import type { FileOutcome } from "../model/events.ts";
import type { Context } from "../model/handler.ts";
import type { AnswerTo, Actor } from "../model/messages.ts";
import type { HubState } from "../model/state.ts";
import { UpdateResult, type UpdateStateRow } from "../model/rows.ts";
import { devicesInstalling } from "../firmware/view.ts";
import { usbBoards } from "../setup/view.ts";
import { latestMove } from "../site/view.ts";
import { actorText, upkeepDecision, upkeepHubEvent, writeUpdateState } from "./records.ts";
import { safeFromHex } from "../util/protocol-safe.ts";
import { busy, fileRefusal, invalid, type Steps, UNAVAILABLE, uploadOf } from "./out.ts";
import { type HubReleaseOffer, NO_UPDATE, type UpkeepSlice } from "./state.ts";

/**
 * What holds a switch back (D54, HB23), as `update.approve`'s `switchWhen` names it
 * (`after:<hold>`), and the shell's words for it (`shell/update/notes.ts`). `firmwareInstall`: a
 * device is installing a firmware image or on trial with one (m3-updates-design section 4,
 * `devicesInstalling`), so the hub does not restart under a device whose trial it judges.
 */
export type SwitchBlock =
  "countdown" | "alarm" | "siteMove" | "provisioning" | "restore" | "firmwareInstall";

/** What would hold the switch back now, or undefined when it may go. */
export function switchBlock(view: HubState, slice: UpkeepSlice): SwitchBlock | undefined {
  if (countdownOrAlarmRunning(view))
    return alarmSummary(view) === undefined ? "countdown" : "alarm";
  const move = latestMove(view);
  if (move?.stage === "announcing" || move?.stage === "switched") return "siteMove";
  if (usbBoards(view).some((board) => board.exchange?.kind === "provision")) return "provisioning";
  if (slice.restore !== undefined) return "restore";
  if (devicesInstalling(view)) return "firmwareInstall";
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
  steps.set({ ...steps.slice, staging: { source: "upload", job, upload, answerTo } });
  steps.push({ kind: "fileJob", job, work: { kind: "stageUpdate", upload } });
}

/** `MAJOR.MINOR.PATCH` as three numbers, or undefined for anything else (section 9, "The file"). */
function versionParts(version: string): readonly [number, number, number] | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether `a` is a newer version than `b`, compared as numbers, major first. */
export function newerVersion(a: string, b: string): boolean {
  const x = versionParts(a);
  const y = versionParts(b);
  if (x === undefined || y === undefined) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/**
 * The relay's `release.offer` (m4-design section 6): its hub entry replaces the last offer, the
 * newest if it named several; one not above the running version (once `hubFacts` named it) is
 * no offer, since the relay offers only releases above it. Each version is recorded once a run as
 * `update_offered` (info, routine; notified in `updates` by notify, D75): the relay offers again
 * each time the link opens and every 24 hours, and a restart may tell it once more.
 */
export function onReleaseOffered(
  steps: Steps,
  ctx: Context,
  releases: readonly ReleaseOffer[],
): void {
  const running = steps.slice.version;
  let offer: HubReleaseOffer | undefined;
  for (const release of releases) {
    if (release.kind !== "hub" || versionParts(release.version) === undefined) continue;
    if (running !== undefined && !newerVersion(release.version, running)) continue;
    if (offer === undefined || newerVersion(release.version, offer.version)) offer = release;
  }
  steps.set({ ...steps.slice, offer });
  if (offer === undefined || steps.slice.offeredVersions.has(offer.version)) return;
  steps.set({
    ...steps.slice,
    offeredVersions: new Set([...steps.slice.offeredVersions, offer.version]),
  });
  steps.pushResult(upkeepDecision(ctx, "update_offered", { detail: offer.version }, "routine"));
}

/** `update.offers`: the hub release the relay offers now, or null. */
export function updateOffers(steps: Steps, answerTo: AnswerTo): void {
  const offer = steps.slice.offer;
  steps.answer(answerTo, {
    offer:
      offer === undefined
        ? null
        : { version: offer.version, bytes: offer.bytes, platform: offer.platform },
  });
}

/**
 * `update.fetch {version}` (m4-design section 6; *manage system*, which `app` checked): only the
 * version offered, and only when nothing else is staging, switching or restoring, as
 * `update.upload`. Answered `{job}` at once; the shell fetches the file through the relay and
 * stages it under this same job (`stagingJob`), and the end is `update_staged` or
 * `update_refused`, as for an upload.
 */
export function updateFetch(
  steps: Steps,
  answerTo: AnswerTo,
  body: AppOpBodyV2<"update.fetch">,
): void {
  const slice = steps.slice;
  const offer = slice.offer;
  if (offer?.version !== body.version) {
    steps.refuse(answerTo, OFFER_AND_ROLLOUT_REFUSALS.notOffered);
    return;
  }
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
  const sha256 = safeFromHex(offer.sha256);
  if (sha256.isErr() || sha256.value.length !== 32) {
    steps.refuse(answerTo, UNAVAILABLE);
    return;
  }
  const job = steps.job();
  steps.set({ ...steps.slice, staging: { source: "fetch", job, version: offer.version } });
  steps.answer(answerTo, { job });
  steps.push({
    kind: "fileJob",
    job,
    work: {
      kind: "fetchRelease",
      release: "hub",
      file: offer.file,
      bytes: offer.bytes,
      sha256: sha256.value,
    },
  });
}

/** The release checked and unpacked, or refused (`stageUpdate`, after an upload or a fetch). */
export function staged(steps: Steps, ctx: Context, outcome: FileOutcome): void {
  const staging = steps.slice.staging;
  if (staging === undefined) return;
  steps.set({ ...steps.slice, staging: undefined });
  if (outcome.kind !== "updateStaged") {
    const reason = outcome.kind === "failed" ? outcome.reason : "io";
    const message = outcome.kind === "failed" ? outcome.message : `unexpected ${outcome.kind}`;
    if (staging.source === "fetch") {
      // Answered `{job}` already: the end is the record, `update_refused` with the fetch's own
      // reasons (`tooLarge`, `unreachable`, `badFile`, `io`) or M2's staging refusals.
      steps.pushResult(
        upkeepHubEvent(ctx, "update_refused", `fetched release refused: ${message}`, {
          reason,
          message,
          version: staging.version,
        }),
      );
      return;
    }
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
  if (staging.source === "upload") steps.answer(staging.answerTo, { version: outcome.version });
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
 * A staging under way dropped (a cancel, a restore): an upload's answered `unavailable` (a
 * fetch's was answered `{job}` already); the shell's next piece finds it unwanted (`view.ts`'s
 * `stagingJob`) and removes what it wrote. An outcome that still comes for it is ignored.
 */
export function dropStaging(steps: Steps): void {
  const staging = steps.slice.staging;
  if (staging === undefined) return;
  steps.set({ ...steps.slice, staging: undefined });
  if (staging.source === "upload") steps.refuse(staging.answerTo, UNAVAILABLE);
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
