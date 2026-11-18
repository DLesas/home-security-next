/**
 * What Apple's and Google's answers mean (docs/m4-design.md section 5, "To Apple and Google",
 * the Outcomes row). Pure: an answer in, an outcome out.
 *
 * The design's outcomes are four, and the relay link carries four (`PushOutcome`):
 *
 * | Here | On the link | Means |
 * | --- | --- | --- |
 * | `delivered` | `accepted` | The service took it |
 * | `tokenInvalid` | `badToken` | The phone's token is gone: the hub marks the target invalid and the phone registers again |
 * | `retryLater` | `limited` (the service's rate limit) or `failed` | Nothing wrong with the item: the hub's outbox tries again (section 4) |
 * | `dropped` | `failed` | The service refused the item itself, and sending it again will not change that: logged as an error for the operator; the hub's outbox drops it after 7 days |
 *
 * Only the answers the design names are `tokenInvalid`: APNs 410, or 400 `BadDeviceToken`; FCM
 * 404 `UNREGISTERED`, or 400 `INVALID_ARGUMENT` on the token. A token for another app (APNs
 * `DeviceTokenNotForTopic`, FCM `SENDER_ID_MISMATCH`) is `dropped`, not `tokenInvalid`: one wrong
 * topic or project in the push role's settings would otherwise mark every phone's target invalid.
 * Every fact about the services here is from memory ‡ (README of tools/push-standins).
 */
import type { PushOutcome } from "@hsn/protocol/relay";

export type RetryWhy = "rateLimited" | "unavailable" | "timeout" | "connection" | "credentials";
export type DropWhy =
  "badRequest" | "payloadTooLarge" | "topic" | "wrongApp" | "notFound" | "notConfigured" | "other";

export type ServiceOutcome =
  | { readonly kind: "delivered" }
  | { readonly kind: "tokenInvalid" }
  | { readonly kind: "retryLater"; readonly why: RetryWhy }
  | { readonly kind: "dropped"; readonly why: DropWhy };

export const DELIVERED: ServiceOutcome = { kind: "delivered" };
export const TOKEN_INVALID: ServiceOutcome = { kind: "tokenInvalid" };
export const retryLater = (why: RetryWhy): ServiceOutcome => ({ kind: "retryLater", why });
export const dropped = (why: DropWhy): ServiceOutcome => ({ kind: "dropped", why });

/** The outcome the relay link carries. */
export function toPushOutcome(outcome: ServiceOutcome): PushOutcome {
  switch (outcome.kind) {
    case "delivered":
      return "accepted";
    case "tokenInvalid":
      return "badToken";
    case "retryLater":
      return outcome.why === "rateLimited" ? "limited" : "failed";
    case "dropped":
      return "failed";
  }
}

const APNS_TOPIC_REASONS: readonly string[] = ["BadTopic", "MissingTopic", "TopicDisallowed"];

/** APNs: a status and the body's `reason` ‡. */
export function apnsOutcome(status: number, reason: string | undefined): ServiceOutcome {
  if (status === 200) return DELIVERED;
  if (status === 410) return TOKEN_INVALID;
  if (status === 400 && reason === "BadDeviceToken") return TOKEN_INVALID;
  if (status === 429) return retryLater("rateLimited");
  if (status === 403) return retryLater("credentials");
  if (status >= 500) return retryLater("unavailable");
  if (status === 413) return dropped("payloadTooLarge");
  if (status === 400 && reason === "DeviceTokenNotForTopic") return dropped("wrongApp");
  if (status === 400 && reason !== undefined && APNS_TOPIC_REASONS.includes(reason)) {
    return dropped("topic");
  }
  if (status === 404 || status === 405) return dropped("notFound");
  if (status === 400) return dropped("badRequest");
  return dropped("other");
}

/** The parts of a Google API error the mapping reads ‡. */
export interface GoogleErrorParts {
  /** `error.details[]`'s FCM `errorCode`, when there is one. */
  readonly fcmCode: string | undefined;
  /** `error.details[]`'s `google.rpc.BadRequest` field violations: the fields named. */
  readonly badFields: readonly string[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a Google API error body (`{error: {code, status, message, details}}`) ‡. */
export function googleErrorParts(body: unknown): GoogleErrorParts {
  const error = isRecord(body) ? body.error : undefined;
  const details = isRecord(error) && Array.isArray(error.details) ? error.details : [];
  let fcmCode: string | undefined;
  const badFields: string[] = [];
  for (const detail of details) {
    if (!isRecord(detail)) continue;
    const type = detail["@type"];
    if (typeof type !== "string") continue;
    if (type.endsWith("google.firebase.fcm.v1.FcmError")) {
      const code = detail.errorCode;
      if (typeof code === "string") fcmCode = code;
    }
    const violations = detail.fieldViolations;
    if (type.endsWith("google.rpc.BadRequest") && Array.isArray(violations)) {
      for (const violation of violations) {
        if (isRecord(violation) && typeof violation.field === "string") {
          badFields.push(violation.field);
        }
      }
    }
  }
  return { fcmCode, badFields };
}

/** FCM HTTP v1: a status and the error's parts ‡. */
export function fcmOutcome(status: number, parts: GoogleErrorParts): ServiceOutcome {
  if (status === 200) return DELIVERED;
  if (status === 404 && parts.fcmCode === "UNREGISTERED") return TOKEN_INVALID;
  if (status === 400 && parts.badFields.includes("message.token")) return TOKEN_INVALID;
  if (status === 429) return retryLater("rateLimited");
  if (status === 401) return retryLater("credentials");
  if (status === 403) {
    return parts.fcmCode === "SENDER_ID_MISMATCH" ? dropped("wrongApp") : retryLater("credentials");
  }
  if (status >= 500) return retryLater("unavailable");
  if (status === 404) return dropped("notFound");
  if (status === 400) return dropped("badRequest");
  return dropped("other");
}

/** `Retry-After` in milliseconds: seconds, or an HTTP date ‡. Undefined when absent or unreadable. */
export function retryAfterMs(header: string | null | undefined, nowMs: number): number | undefined {
  if (header === null || header === undefined) return undefined;
  if (/^\d+$/u.test(header.trim())) return Number(header.trim()) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}
