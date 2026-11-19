/**
 * What reached the stand-ins for Apple and Google, as a phone would receive it: per device token,
 * each push's time of arrival and its sealed `h`, opened with the phone's key by the protocol
 * package's opener (the phone's extension, in Swift and Kotlin, cannot run here). Also the
 * stand-ins and their keys made for a run, and the release a run serves.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PushContent } from "@hsn/protocol/app";
import { HUB_VERSION } from "../../src/shell/hub-facts.ts";
import { makeRelease, platformOf } from "../../src/shell/update/release.ts";
import type { StandIns } from "../../../relay/test/push/helpers.ts";
import type { AwayPhone } from "./phone.ts";

export { apnsToken, fcmToken, standIns, type StandIns } from "../../../relay/test/push/helpers.ts";

/** One push as a phone gets it. */
export interface Arrived {
  readonly atMs: number;
  readonly platform: "apns" | "fcm";
  readonly h: string;
  /** The APNs request's headers, for the topic and the envelope. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string;
}

function hOfApns(body: string): string | undefined {
  const parsed = JSON.parse(body) as { readonly h?: unknown };
  return typeof parsed.h === "string" ? parsed.h : undefined;
}

function hOfFcm(json: unknown): string | undefined {
  const message = (json as { readonly message?: { readonly data?: { readonly h?: unknown } } })
    .message;
  return typeof message?.data?.h === "string" ? message.data.h : undefined;
}

/** Every push to `token`, in order of arrival, from both stand-ins. */
export function arrivedFor(s: StandIns, token: string): readonly Arrived[] {
  const apns = s.apns.received
    .filter(
      (r) => r.deviceToken === token && r.answered?.kind === "status" && r.answered.status === 200,
    )
    .flatMap((r): Arrived[] => {
      const h = hOfApns(r.body);
      return h === undefined
        ? []
        : [{ atMs: r.atMs, platform: "apns", h, headers: r.headers, body: r.body }];
    });
  const fcm = s.fcm.received
    .filter((r) => r.token === token && r.answered === 200)
    .flatMap((r): Arrived[] => {
      const h = hOfFcm(r.json);
      return h === undefined ? [] : [{ atMs: r.atMs, platform: "fcm", h, body: r.body }];
    });
  return [...apns, ...fcm].toSorted((a, b) => a.atMs - b.atMs);
}

/** A push opened by the phone that registered the key it was sealed with. */
export interface Opened extends Arrived {
  readonly content: PushContent;
}

/** The pushes to a phone's token that its key opens, in order. */
export function openedFor(s: StandIns, token: string, phone: AwayPhone): readonly Opened[] {
  return arrivedFor(s, token).flatMap((arrived): Opened[] => {
    const content = phone.openPush(arrived.h);
    return content === undefined ? [] : [{ ...arrived, content }];
  });
}

/** The tests' publisher seed (`TEST_PUBLISHER_KEY` is its public half). */
const TEST_SEED = new Uint8Array(32).fill(7);
/** A version above any the hub runs. */
export const RELEASE_VERSION = "99.0.0";

/**
 * A hub release for this computer, newer than the running hub, signed with the tests' key, written
 * into `folder` under the name the releases role indexes (`hsn-hub-<version>-<platform>.hsnr`).
 * Its payload is `bytes` long, so a fetch can take many pieces. Returns its path and size.
 */
export function writeTestRelease(
  folder: string,
  bytes = 64,
  version = RELEASE_VERSION,
): { readonly path: string; readonly size: number; readonly platform: string } {
  const data = new Uint8Array(bytes);
  const head = new TextEncoder().encode("#!/bin/sh\necho test release\n");
  data.set(head.subarray(0, Math.min(bytes, head.length)));
  for (let i = head.length; i < bytes; i++) data[i] = (i * 31) & 0xff;
  const hash = createHash("sha256").update(data).digest("hex");
  const platform = platformOf(process.platform, process.arch) ?? "darwin-arm64";
  const file = makeRelease(
    {
      version,
      platform,
      madeMs: 0,
      payloadBytes: data.length,
      payloadSha256: hash,
      files: [{ path: "bin/hsn-hub", bytes: data.length, sha256: hash, executable: true }],
    },
    data,
    TEST_SEED,
  )._unsafeUnwrap();
  const path = join(folder, `hsn-hub-${version}-${platform}.hsnr`);
  writeFileSync(path, file);
  return { path, size: file.length, platform };
}

export { HUB_VERSION };
