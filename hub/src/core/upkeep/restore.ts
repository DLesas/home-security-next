/**
 * Restore (m2-design.md section 9, "Restore"; section 5, "Restore's messages"; D53, D78, D122):
 * on a hub with no devices, from a backup file uploaded on the console, unlocked by a phone that
 * holds the file's backup key.
 *
 * 1. `restore.start {job}`: no devices and no restore under way; the shell reads the header
 *    (`readRestore`). Nothing durable changes: it is a read (section 6).
 * 2. With the header: a restore token, 128 bits from the input's entropy, its lookup and
 *    pre-shared key as linking's (section 5), given to the shell by `linkSecret` with purpose
 *    `restore` and never stored. The reply says the file's identity, when it was made and how old
 *    its people and permissions are, always (D122), and the QR code only: the new hub's own
 *    identity, the secret, its addresses, the apps' port and its certificate. 10 minutes ‡.
 * 3. `restoreOpened`: message 4, `RestoreOffer`, on the phone's connection, which proves the hub
 *    knows the pre-shared key. `restoreKey`: the phone's key goes once into `applyRestore`, never
 *    into the slice; an epoch other than the file's is `wrongKey`, and the token stays usable.
 * 4. `restoreReady`: `RestoreResult {ok: true}`, the token withdrawn, then `switchRestore`. A
 *    wrong key is `RestoreResult {ok: false, reason: "wrongKey"}`, the token usable until it
 *    expires.
 * 5. At the restored hub's start, the restore mark (`backup_state.restored_from_ms`) is recorded as
 *    `restored` and cleared, in one commit (`handle.ts`, boot).
 */
import {
  type AppOpBody,
  formatIdentity,
  formatLinkQr,
  LINKING,
  type RestoreResult,
  secretLookup,
  secretPsk,
  appIdentityBytes,
} from "@hsn/protocol/app";
import { hubFacts } from "../app/view.ts";
import type { FileOutcome } from "../model/events.ts";
import type { Context } from "../model/handler.ts";
import { type ConnId, type TokenId, tokenId } from "../model/ids.ts";
import type { AnswerTo } from "../model/messages.ts";
import { DeviceState } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import { appStaticPublic } from "../people/view.ts";
import { registeredDevices } from "../registry/view.ts";
import { busy, fileRefusal, invalid, type Steps, UNAVAILABLE, uploadOf } from "./out.ts";
import { dropStaging } from "./update.ts";
import type { RestoreHeader } from "./state.ts";

/** Whether the hub has a device: a restore is only for a hub with none yet (section 9). */
export function hasDevices(view: HubState): boolean {
  return registeredDevices(view).some((row) => row.state !== DeviceState.Removed);
}

function result(steps: Steps, conn: ConnId, body: RestoreResult): void {
  steps.push({ kind: "appSend", conn, message: { kind: "handshake", body } });
}

function withdraw(steps: Steps, token: TokenId): void {
  steps.push({
    kind: "linkSecret",
    token,
    purpose: "restore",
    askName: false,
    lookup: null,
    psk: null,
  });
}

/** `restore.start` (section 6): a read; the answer comes with the header. */
export function restoreStart(
  steps: Steps,
  ctx: Context,
  answerTo: AnswerTo,
  body: AppOpBody<"restore.start">,
): void {
  const slice = steps.slice;
  if (slice.restore !== undefined) {
    steps.refuse(answerTo, busy("restore"));
    return;
  }
  if (slice.switchJob !== undefined || slice.update.switchingMs !== null) {
    steps.refuse(answerTo, busy("updateSwitch"));
    return;
  }
  if (hasDevices(ctx.view)) {
    steps.refuse(answerTo, invalid("", "noDevicesRequired"));
    return;
  }
  // A restore replaces everything, an update staged half-way included.
  dropStaging(steps);
  const upload = uploadOf(answerTo, body.job);
  if (upload === undefined) {
    steps.refuse(answerTo, UNAVAILABLE);
    return;
  }
  const job = steps.job();
  steps.set({ ...steps.slice, restore: { stage: "reading", job, upload, answerTo } });
  steps.push({ kind: "fileJob", job, work: { kind: "readRestore", upload } });
}

/** The restore token's QR code (section 9), naming the new hub's own app key. */
function restoreQr(ctx: Context, secret: Uint8Array): string | undefined {
  const facts = hubFacts(ctx.view);
  const key = appStaticPublic(ctx.view);
  if (facts === undefined || key === undefined) return undefined;
  return formatLinkQr(
    {
      identity: formatIdentity(appIdentityBytes(ctx.deps.sha256, key)),
      secret,
      addresses: facts.addresses,
      port: facts.appsPort,
      fingerprint: facts.certificateSha256,
    },
    "restore",
  );
}

/** The header came (`readRestore`): the token, and the answer to `restore.start`. */
function headerRead(steps: Steps, ctx: Context, outcome: FileOutcome): void {
  const restore = steps.slice.restore;
  if (restore?.stage !== "reading") return;
  const answerTo = restore.answerTo;
  steps.set({ ...steps.slice, restore: undefined });
  if (outcome.kind !== "restoreRead") {
    steps.refuse(
      answerTo,
      fileRefusal(outcome, restore.upload, { badFile: "badFile", wrongKey: "badFile" }),
    );
    return;
  }
  if (hasDevices(ctx.view)) {
    steps.refuse(answerTo, invalid("", "noDevicesRequired"));
    return;
  }
  const secret = ctx.entropy.take(LINKING.secretBytes);
  if (secret.isErr()) {
    steps.fail(secret.error);
    return;
  }
  const qr = restoreQr(ctx, secret.value);
  if (qr === undefined) {
    steps.refuse(answerTo, UNAVAILABLE);
    return;
  }
  const token = tokenId(steps.slice.nextRestoreToken);
  const header: RestoreHeader = {
    identity: outcome.identity,
    epoch: outcome.epoch,
    madeMs: outcome.madeMs,
    lastChangeMs: outcome.lastChangeMs,
  };
  steps.set({
    ...steps.slice,
    nextRestoreToken: steps.slice.nextRestoreToken + 1,
    restore: { stage: "offered", token, upload: restore.upload, header, conn: undefined },
  });
  steps.push({
    kind: "linkSecret",
    token,
    purpose: "restore",
    askName: false,
    lookup: secretLookup(ctx.deps.sha256, secret.value),
    psk: secretPsk(ctx.deps.sha256, secret.value),
  });
  steps.timerAfter(ctx, "restoreExpiry", ctx.deps.rules.restore.tokenExpiryMs);
  steps.answer(answerTo, {
    identity: formatIdentity(outcome.identity),
    madeMs: outcome.madeMs,
    lastChangeMs: outcome.lastChangeMs,
    qr,
  });
}

/** Messages 1 to 3 done with a restore token: message 4, the offer (section 5). */
export function restoreOpened(steps: Steps, conn: ConnId, token: TokenId): void {
  const restore = steps.slice.restore;
  if (restore?.stage === "offered" && restore.token === token) {
    // A phone that tries again (its last connection dropped) takes the restore over.
    steps.set({ ...steps.slice, restore: { ...restore, conn } });
    steps.push({
      kind: "appSend",
      conn,
      message: {
        kind: "handshake",
        body: {
          identity: formatIdentity(restore.header.identity),
          epoch: restore.header.epoch,
          madeMs: restore.header.madeMs,
          lastChangeMs: restore.header.lastChangeMs,
        },
      },
    });
    return;
  }
  const working = restore?.stage === "applying" || restore?.stage === "switching";
  result(steps, conn, { ok: false, reason: working ? "busy" : "expired" });
}

/** Message 5, the phone's backup key: into `applyRestore` once, and nowhere else (section 2). */
export function restoreKey(
  steps: Steps,
  conn: ConnId,
  token: TokenId,
  key: Uint8Array,
  epoch: number,
): void {
  const restore = steps.slice.restore;
  if (restore?.stage !== "offered" || restore.token !== token || restore.conn !== conn) {
    const working = restore?.stage === "applying" || restore?.stage === "switching";
    result(steps, conn, { ok: false, reason: working ? "busy" : "expired" });
    return;
  }
  if (epoch !== restore.header.epoch) {
    result(steps, conn, { ok: false, reason: "wrongKey" });
    return;
  }
  const job = steps.job();
  steps.set({
    ...steps.slice,
    restore: {
      stage: "applying",
      job,
      token,
      upload: restore.upload,
      header: restore.header,
      conn,
    },
  });
  steps.push({ kind: "fileJob", job, work: { kind: "applyRestore", upload: restore.upload, key } });
}

/**
 * What the phone is told of a restore that failed (section 9): `wrongKey` when the file's first
 * chunk did not open with its key, `badFile` for a file damaged or incomplete (a later chunk, or
 * the database in it), `busy` for anything the hub could not do. The shell tells the first two
 * apart (`shell/backup/restore.ts`'s `openingFailure`).
 */
export function refusalReason(outcome: FileOutcome): "wrongKey" | "badFile" | "busy" {
  if (outcome.kind !== "failed") return "busy";
  if (outcome.reason === "wrongKey") return "wrongKey";
  return outcome.reason === "badFile" ? "badFile" : "busy";
}

/** The restored database prepared, or not (`applyRestore`). */
function applied(steps: Steps, outcome: FileOutcome): void {
  const restore = steps.slice.restore;
  if (restore?.stage !== "applying") return;
  if (outcome.kind === "restoreReady") {
    result(steps, restore.conn, { ok: true });
    withdraw(steps, restore.token);
    steps.clear("restoreExpiry");
    const job = steps.job();
    steps.set({ ...steps.slice, restore: { stage: "switching", job } });
    steps.push({ kind: "fileJob", job, work: { kind: "switchRestore" } });
    return;
  }
  // `wrongKey`, `badFile` or `busy` (`refusalReason`); the token stays usable until it expires.
  result(steps, restore.conn, { ok: false, reason: refusalReason(outcome) });
  steps.set({
    ...steps.slice,
    restore: {
      stage: "offered",
      token: restore.token,
      upload: restore.upload,
      header: restore.header,
      conn: undefined,
    },
  });
}

/** A file job of the restore's ended; whether it was the restore's. */
export function restoreJobDone(
  steps: Steps,
  ctx: Context,
  job: number,
  outcome: FileOutcome,
): boolean {
  const restore = steps.slice.restore;
  if (restore === undefined || !("job" in restore) || restore.job !== job) return false;
  if (restore.stage === "reading") headerRead(steps, ctx, outcome);
  else if (restore.stage === "applying") applied(steps, outcome);
  // The switch failed: the running hub stays as it was (section 9).
  else steps.set({ ...steps.slice, restore: undefined });
  return true;
}

/** The token expired (10 minutes ‡): withdrawn, and a phone mid-way told so. */
export function restoreExpired(steps: Steps): void {
  const restore = steps.slice.restore;
  if (restore?.stage !== "offered") return;
  withdraw(steps, restore.token);
  if (restore.conn !== undefined) result(steps, restore.conn, { ok: false, reason: "expired" });
  steps.set({ ...steps.slice, restore: undefined });
}
