/**
 * The firmware store's index (docs/m3-updates-design.md section 4, "Where images are kept", D140)
 * and where a release comes from: a file on the console (`firmware.upload`, `hsn firmware add`)
 * or, from M4, a release the relay offered (`firmware.offers`, `firmware.fetch`). The bytes stay in
 * the shell; the core keeps each image's row, decides what is staged, kept and removed, and never
 * removes an image by itself.
 *
 * - **At most `maxImages` ‡ and `storeMaxBytes` ‡.** A fifth image, or one that would pass the
 *   bytes, is refused `storeFull` until a person removes one: checked before an upload is staged
 *   (the count, and the store already full of bytes), and again when it is staged (with its size).
 * - **The same image twice** (its image id among the stored ones) is the stored one: no new row.
 * - **An image a rollout uses** is not removed (`invalid {field: "image", reason: "inUse"}`).
 * - **Offered releases** replace each other with each `release.offer`; each version is recorded
 *   once a run (`firmware_release_offered`); one over `fileMaxBytes` ‡ is refused before any byte
 *   is fetched. No `notNewer`: an older image may be fetched to undo a bad release.
 * - **Never in backups**: the rows are not among a backup's tables (upkeep's), and the files are
 *   the shell's.
 */
import type { AppErrorV2, FirmwareImageObject } from "@hsn/protocol/app";
import { FIRMWARE_FILE_REFUSALS, OFFER_AND_ROLLOUT_REFUSALS } from "@hsn/protocol/app";
import type { FileOutcome, FirmwareStoreProblem } from "../model/events.ts";
import { M3M4_HUB_EVENTS } from "../model/decisions.ts";
import { UpdateReason } from "@hsn/protocol";
import { ORIGIN } from "./out.ts";
import { pause } from "./rollout.ts";
import type { Context } from "../model/handler.ts";
import { type ImageId, imageId, type JobId, jobOwner, type Seq } from "../model/ids.ts";
import type { Actor, AnswerTo } from "../model/messages.ts";
import { type FirmwareImageRow, ImageKind } from "../model/rows.ts";
import { safeFromHex } from "../util/protocol-safe.ts";
import { hex, parseVersion, rolesOf, versionText } from "./codes.ts";
import { openRollout } from "./decide.ts";
import type { Steps } from "./out.ts";
import { actorText, fileRefused, firmwareDecision, writeImage } from "./records.ts";
import type { FirmwareJob, FirmwareOffer } from "./state.ts";

const UNAVAILABLE: AppErrorV2 = { code: "unavailable", detail: {} };

/** The images in the store now, oldest first. */
export function liveImages(steps: Steps): readonly FirmwareImageRow[] {
  return [...steps.slice.images.values()]
    .filter((row) => row.removedMs === null)
    .toSorted((a, b) => a.id - b.id);
}

export function liveImage(steps: Steps, id: number): FirmwareImageRow | undefined {
  const row = steps.slice.images.get(imageId(id));
  return row?.removedMs === null ? row : undefined;
}

/** An image as `firmware.list` and `firmware.upload` show it. */
export function imageObject(row: FirmwareImageRow): FirmwareImageObject {
  return {
    id: row.id,
    imageId: hex(row.imageId),
    version: versionText(row.version),
    kind: row.kind === ImageKind.OwnBuild ? "ownBuild" : "official",
    roles: rolesOf(row.roles),
    bytes: row.bytes,
    addedMs: row.addedMs,
  };
}

function addJob(steps: Steps, job: JobId, work: FirmwareJob): void {
  const jobs = new Map(steps.slice.jobs);
  jobs.set(job, work);
  steps.set({ ...steps.slice, jobs });
}

function dropJob(steps: Steps, job: JobId): void {
  const jobs = new Map(steps.slice.jobs);
  jobs.delete(job);
  steps.set({ ...steps.slice, jobs });
}

/** The store cannot take one more image of `bytes` (0: the size is not known yet). */
function storeFull(steps: Steps, ctx: Context, bytes: number): boolean {
  const live = liveImages(steps);
  const used = live.reduce((sum, row) => sum + row.bytes, 0);
  const rules = ctx.deps.rules.firmware;
  return (
    live.length >= rules.maxImages ||
    used + bytes > rules.storeMaxBytes ||
    used >= rules.storeMaxBytes
  );
}

/** The connection an answer goes back on, for an upload or a stream. */
function connOf(answerTo: AnswerTo) {
  return answerTo.kind === "schedule" ? undefined : answerTo.conn;
}

/** `firmware.upload`: an uploaded `.hsnf`, or an owner's own build once the console confirmed it. */
export function upload(
  steps: Steps,
  ctx: Context,
  answerTo: AnswerTo,
  actor: Actor,
  record: Seq,
  body: {
    readonly job: number;
    readonly own?: { readonly version: string } | undefined;
    readonly confirmOwn?: true | undefined;
  },
): void {
  if (body.own !== undefined && body.confirmOwn !== true) {
    steps.refuse(answerTo, FIRMWARE_FILE_REFUSALS.notConfirmed);
    return;
  }
  if (storeFull(steps, ctx, 0)) {
    steps.refuse(answerTo, FIRMWARE_FILE_REFUSALS.storeFull);
    steps.pushResult(fileRefused(ctx, "storeFull", "the store holds its most images", undefined));
    return;
  }
  const conn = connOf(answerTo);
  if (conn === undefined) {
    steps.refuse(answerTo, UNAVAILABLE);
    return;
  }
  const job = steps.job();
  addJob(steps, job, {
    kind: "upload",
    answerTo,
    actor: actorText(actor),
    record,
    upload: body.job,
  });
  steps.push({
    kind: "fileJob",
    job,
    work: {
      kind: "stageFirmware",
      upload: { conn, job: body.job },
      own: body.own === undefined ? null : { version: body.own.version },
    },
  });
}

/** `firmware.fetch {version}`: an offered release, fetched through the relay and staged. */
export function fetch(
  steps: Steps,
  ctx: Context,
  answerTo: AnswerTo,
  actor: Actor,
  record: Seq,
  version: string,
): void {
  const offer = steps.slice.offers.find((o) => o.version === version);
  if (offer === undefined) {
    steps.refuse(answerTo, OFFER_AND_ROLLOUT_REFUSALS.notOffered);
    return;
  }
  if (offer.bytes > ctx.deps.rules.firmware.fileMaxBytes) {
    steps.refuse(answerTo, OFFER_AND_ROLLOUT_REFUSALS.offerTooLarge);
    return;
  }
  const sha256 = safeFromHex(offer.sha256);
  if (sha256.isErr()) {
    steps.refuse(answerTo, UNAVAILABLE);
    return;
  }
  const job = steps.job();
  addJob(steps, job, { kind: "fetch", actor: actorText(actor), record, version });
  steps.push({
    kind: "fileJob",
    job,
    work: {
      kind: "fetchRelease",
      release: "firmware",
      file: offer.file,
      bytes: offer.bytes,
      sha256: sha256.value,
    },
  });
  steps.answer(answerTo, { job });
}

/** `firmware.remove {image}`: not while a rollout not ended uses it. */
export function remove(
  steps: Steps,
  ctx: Context,
  answerTo: AnswerTo,
  actor: Actor,
  record: Seq,
  id: number,
): void {
  const row = liveImage(steps, id);
  if (row === undefined) {
    steps.refuse(answerTo, { code: "notFound", detail: { what: "image", id } });
    return;
  }
  const rollout = openRollout(steps.slice);
  if (rollout?.row.image === row.id) {
    steps.refuse(answerTo, {
      code: "invalid",
      detail: { field: "image", reason: "inUse", refs: [rollout.row.id] },
    });
    return;
  }
  const removed: FirmwareImageRow = { ...row, removedMs: ctx.now.wall };
  const images = new Map(steps.slice.images);
  images.set(row.id, removed);
  steps.set({ ...steps.slice, images });
  steps.push(writeImage(removed));
  steps.pushResult(
    firmwareDecision(ctx, "firmware_removed", {
      value: row.id,
      detail: actorText(actor),
      cause: record,
    }),
  );
  const job = steps.job();
  addJob(steps, job, { kind: "remove", image: row.id });
  steps.push({
    kind: "fileJob",
    job,
    work: { kind: "removeFirmware", image: row.id, file: row.file },
  });
  steps.answer(answerTo, {});
}

/** `firmware.download {image}`: the header and the image streamed as `fileChunk` events. */
export function download(steps: Steps, answerTo: AnswerTo, id: number): void {
  const row = liveImage(steps, id);
  if (row === undefined) {
    steps.refuse(answerTo, { code: "notFound", detail: { what: "image", id } });
    return;
  }
  const conn = connOf(answerTo);
  if (conn === undefined) {
    steps.refuse(answerTo, UNAVAILABLE);
    return;
  }
  const job = steps.job();
  addJob(steps, job, { kind: "download" });
  steps.push({
    kind: "fileJob",
    job,
    work: { kind: "sendFirmware", conn, header: row.header, file: row.file },
  });
  steps.answer(answerTo, { job });
}

/** `firmware.offers`. */
export function offersReply(steps: Steps): { offers: readonly unknown[] } {
  return {
    offers: steps.slice.offers.map((o) => ({
      version: o.version,
      bytes: o.bytes,
      roles: [...o.roles],
    })),
  };
}

/** The relay's `release.offer`: its firmware entries replace the last; a new version is recorded. */
export function onReleaseOffered(
  steps: Steps,
  ctx: Context,
  releases: readonly { readonly kind: string }[],
): void {
  const firmware = releases.filter((r): r is FirmwareOffer => r.kind === "firmware");
  const offeredVersions = new Set(steps.slice.offeredVersions);
  for (const offer of firmware) {
    if (offeredVersions.has(offer.version)) continue;
    offeredVersions.add(offer.version);
    const value = parseVersion(offer.version);
    steps.pushResult(
      firmwareDecision(ctx, "firmware_release_offered", value === undefined ? {} : { value }),
    );
  }
  const same =
    firmware.length === steps.slice.offers.length &&
    firmware.every((o, i) => o === steps.slice.offers[i]);
  if (same && offeredVersions.size === steps.slice.offeredVersions.size) return;
  steps.set({ ...steps.slice, offers: firmware, offeredVersions });
}

/** The five reasons a firmware file is refused with, as the hub event names them. */
const FILE_REFUSALS = new Set(["badFile", "badSignature", "wrongTarget", "tooLarge", "storeFull"]);

/** A file job came to its outcome. */
export function onFileReady(steps: Steps, ctx: Context, job: JobId, outcome: FileOutcome): void {
  if (jobOwner(job) !== "firmware") return;
  const work = steps.slice.jobs.get(job);
  if (work === undefined) return;
  dropJob(steps, job);
  switch (work.kind) {
    case "remove":
    case "download":
      return;
    case "upload":
    case "fetch":
      staged(steps, ctx, work, outcome);
      return;
  }
}

function staged(
  steps: Steps,
  ctx: Context,
  work: Extract<FirmwareJob, { kind: "upload" | "fetch" }>,
  outcome: FileOutcome,
): void {
  const version = work.kind === "fetch" ? work.version : undefined;
  if (outcome.kind !== "firmwareStaged") {
    if (outcome.kind === "failed" && FILE_REFUSALS.has(outcome.reason)) {
      steps.pushResult(fileRefused(ctx, outcome.reason, outcome.message, version));
    }
    if (work.kind === "upload") steps.refuse(work.answerTo, refusalOf(outcome, work.upload));
    return;
  }
  const image = outcome.image;
  const same = liveImages(steps).find(
    (row) =>
      row.imageId.length === image.imageId.length &&
      row.imageId.every((b, i) => b === image.imageId[i]),
  );
  if (same !== undefined) {
    if (work.kind === "upload") steps.answer(work.answerTo, imageObject(same));
    return;
  }
  // The image of the open rollout, dropped as damaged and added again: its own row comes back, so
  // the rollout that names it can be resumed.
  const rollout = openRollout(steps.slice);
  const dropped = rollout === undefined ? undefined : steps.slice.images.get(rollout.row.image);
  const revived =
    dropped !== undefined &&
    dropped.removedMs !== null &&
    dropped.imageId.length === image.imageId.length &&
    dropped.imageId.every((b, i) => b === image.imageId[i]);
  if (storeFull(steps, ctx, image.bytes)) {
    steps.pushResult(
      fileRefused(ctx, "storeFull", "the store holds its most images or bytes", version),
    );
    if (work.kind === "upload") steps.refuse(work.answerTo, FIRMWARE_FILE_REFUSALS.storeFull);
    // The staged file is no image of the store's: the shell takes it out again (no row).
    const removeJob = steps.job();
    addJob(steps, removeJob, { kind: "remove", image: NO_IMAGE });
    steps.push({
      kind: "fileJob",
      job: removeJob,
      work: { kind: "removeFirmware", image: NO_IMAGE, file: image.file },
    });
    return;
  }
  const row: FirmwareImageRow = {
    ...image,
    id: revived ? dropped.id : imageId(steps.slice.nextImage),
    addedMs: ctx.now.wall,
    addedBy: work.actor,
    removedMs: null,
  };
  const images = new Map(steps.slice.images);
  images.set(row.id, row);
  steps.set({
    ...steps.slice,
    images,
    nextImage: revived ? steps.slice.nextImage : steps.slice.nextImage + 1,
  });
  steps.push(writeImage(row));
  steps.pushResult(
    firmwareDecision(ctx, "firmware_added", {
      value: row.id,
      detail: work.actor,
      cause: work.record,
    }),
  );
  if (work.kind === "upload") steps.answer(work.answerTo, imageObject(row));
}

/**
 * The shell found an indexed image's file missing or not hashing to its row at start
 * (`firmwareStoreDamaged`): `firmware_store_damaged`, critical and written now; the image dropped
 * from the index (its row marked removed, now), so it can be added again. A rollout not ended that
 * uses it is paused with the reason `hashMismatch` (the store's copy is not the image signed), and
 * every grant of it taken back: nothing can be served until the image is added again, which brings
 * back its own row (above), and the rollout cannot be resumed before that.
 */
export function onStoreDamaged(
  steps: Steps,
  ctx: Context,
  id: ImageId,
  problem: FirmwareStoreProblem,
): void {
  const row = steps.slice.images.get(id);
  const spec = M3M4_HUB_EVENTS.firmware_store_damaged;
  steps.pushResult(
    ctx.records.take().map((seq) => ({
      kind: "auditRecord" as const,
      durability: spec.durability,
      record: {
        kind: "hubEvent" as const,
        row: {
          seq,
          atMs: ctx.now.wall,
          clockOk: ctx.now.wallTrusted,
          level: spec.level,
          origin: ORIGIN,
          code: "firmware_store_damaged",
          message:
            problem === "missing"
              ? "A stored firmware image's file is missing; add the image again."
              : "A stored firmware image's file is damaged; add the image again.",
          detail: JSON.stringify({
            image: id,
            problem,
            version: row === undefined ? null : versionText(row.version),
          }),
        },
      },
    })),
  );
  if (row?.removedMs !== null) return;
  const dropped: FirmwareImageRow = { ...row, removedMs: ctx.now.wall };
  const images = new Map(steps.slice.images);
  images.set(id, dropped);
  steps.set({ ...steps.slice, images });
  steps.push(writeImage(dropped));
  for (const [link, held] of steps.slice.grants) {
    if (held.image !== id) continue;
    const grants = new Map(steps.slice.grants);
    grants.delete(link);
    steps.set({ ...steps.slice, grants });
    if (!steps.slice.suspended) steps.push({ kind: "transferRevoke", link, reason: "notGranted" });
  }
  if (openRollout(steps.slice)?.row.image === id) {
    pause(steps, ctx, UpdateReason.HashMismatch, null, undefined);
  }
}

/** The image id a file job names when the file has no row: a staged file refused `storeFull`. */
export const NO_IMAGE: ImageId = imageId(0);

/** What `firmware.upload` is answered when its job did not stage the image. */
function refusalOf(outcome: FileOutcome, upload: number): AppErrorV2 {
  if (outcome.kind !== "failed") return UNAVAILABLE;
  switch (outcome.reason) {
    case "noUpload":
      return { code: "notFound", detail: { what: "upload", id: upload } };
    case "badFile":
    case "badSignature":
    case "wrongTarget":
    case "tooLarge":
    case "storeFull":
      return FIRMWARE_FILE_REFUSALS[outcome.reason];
    default:
      return UNAVAILABLE;
  }
}
