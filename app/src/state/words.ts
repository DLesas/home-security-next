/**
 * Every refusal and fault in words (the brief: "every error shown in words"; HB27): the hub's
 * errors with their details (section 5's table), the client's own faults, the connection's and
 * linking's. Each key is written out here, so `test/words.test.ts` checks every one has English.
 * Devices are named by their names when the store knows them.
 */
import type { AppError } from "@hsn/protocol/app";
import type { TFunction } from "i18next";
import type { LinkView } from "../hub/client";
import type { LocalFault } from "../hub/faults";
import type { ConnectionView, LiveState } from "./live";

/** i18next's `t`. */
export type Translate = TFunction;

/** A list of names, joined as the language joins them. */
export function listOf(items: readonly string[], language: string): string {
  return new Intl.ListFormat(language, { style: "long", type: "conjunction" }).format(items);
}

/** A device's name, or its number when the store does not know it (a device the person may not view). */
export function deviceName(t: Translate, state: Pick<LiveState, "devices">, id: number): string {
  return state.devices[id]?.name ?? t("common.deviceNumber", { id });
}

export function deviceNames(
  t: Translate,
  language: string,
  state: Pick<LiveState, "devices">,
  ids: readonly number[],
): string {
  return listOf(
    ids.map((id) => deviceName(t, state, id)),
    language,
  );
}

export const LOCAL_FAULT_KEYS: Readonly<Record<LocalFault, string>> = {
  offline: "errors.local.offline",
  lost: "errors.local.lost",
  badReply: "errors.local.badReply",
  storage: "errors.local.storage",
  removed: "errors.local.removed",
  notLinked: "errors.local.notLinked",
  tabClosed: "errors.local.tabClosed",
  unconfirmed: "errors.local.unconfirmed",
};

export const INVALID_KEYS = {
  format: "errors.invalid.format",
  range: "errors.invalid.range",
  taken: "errors.invalid.taken",
  unknownReference: "errors.invalid.unknownReference",
  fixed: "errors.invalid.fixed",
  inUse: "errors.invalid.inUse",
  lastManager: "errors.invalid.lastManager",
  tooOld: "errors.invalid.tooOld",
  noDevicesRequired: "errors.invalid.noDevicesRequired",
  noAnswer: "errors.invalid.noAnswer",
  noGateway: "errors.invalid.noGateway",
  badFile: "errors.invalid.badFile",
  badSignature: "errors.invalid.badSignature",
  wrongSystem: "errors.invalid.wrongSystem",
  notNewer: "errors.invalid.notNewer",
  full: "errors.invalid.full",
} as const satisfies Readonly<
  Record<Extract<AppError, { code: "invalid" }>["detail"]["reason"], string>
>;

export const BUSY_KEYS = {
  siteMove: "errors.busy.siteMove",
  updateSwitch: "errors.busy.updateSwitch",
  provisioning: "errors.busy.provisioning",
  countdown: "errors.busy.countdown",
  alarm: "errors.busy.alarm",
  restore: "errors.busy.restore",
  upload: "errors.busy.upload",
} as const satisfies Readonly<
  Record<Extract<AppError, { code: "busy" }>["detail"]["because"], string>
>;

export const NOT_FOUND_KEYS = {
  person: "errors.notFoundWhat.person",
  client: "errors.notFoundWhat.client",
  group: "errors.notFoundWhat.group",
  mode: "errors.notFoundWhat.mode",
  schedule: "errors.notFoundWhat.schedule",
  device: "errors.notFoundWhat.device",
  token: "errors.notFoundWhat.token",
  notification: "errors.notFoundWhat.notification",
  job: "errors.notFoundWhat.job",
  upload: "errors.notFoundWhat.upload",
} as const satisfies Readonly<
  Record<Extract<AppError, { code: "notFound" }>["detail"]["what"], string>
>;

export const PERMISSION_KEYS = {
  manageUsers: "errors.permission.manageUsers",
  manageSystem: "errors.permission.manageSystem",
} as const;

/** One of the hub's refusals, in words. */
export function appErrorWords(
  t: Translate,
  language: string,
  state: Pick<LiveState, "devices">,
  error: AppError,
): string {
  switch (error.code) {
    case "unauthorized": {
      const devices = error.detail.devices ?? [];
      if (devices.length > 0)
        return t("errors.unauthorizedDevices", {
          count: devices.length,
          devices: deviceNames(t, language, state, devices),
        });
      if (error.detail.permission !== undefined)
        return t("errors.unauthorizedPermission", {
          permission: t(PERMISSION_KEYS[error.detail.permission]),
        });
      return t("errors.unauthorized");
    }
    case "needsConfirmation":
      return t("errors.needsConfirmation");
    case "conflict":
      return t("errors.conflict");
    case "seqTooLow":
      return t("errors.seqTooLow");
    case "notFound":
      return t("errors.notFound", { what: t(NOT_FOUND_KEYS[error.detail.what]) });
    case "invalid":
      return t(INVALID_KEYS[error.detail.reason]);
    case "busy":
      return t(BUSY_KEYS[error.detail.because]);
    case "consoleOnly":
      return t("errors.consoleOnly");
    case "unavailable":
      return t("errors.unavailable");
    case "protoUnsupported":
      return t("errors.protoUnsupported");
    case "notBuilt":
      return t("errors.notBuilt");
  }
}

/** A request's outcome when it failed, in words. */
export function failureWords(
  t: Translate,
  language: string,
  state: Pick<LiveState, "devices">,
  outcome:
    | { readonly ok: false; readonly error: AppError }
    | { readonly ok: false; readonly local: LocalFault },
): string {
  return "local" in outcome
    ? t(LOCAL_FAULT_KEYS[outcome.local])
    : appErrorWords(t, language, state, outcome.error);
}

export const CONNECTION_FAILURE_KEYS: Readonly<Record<string, string>> = {
  unreachable: "connection.failure.unreachable",
  refused: "connection.failure.refused",
  notOurHub: "connection.failure.notOurHub",
  protocol: "connection.failure.protocol",
  timeout: "connection.failure.timeout",
  keyFailed: "connection.failure.keyFailed",
  closed: "connection.failure.closed",
};

/** Why the client is out of touch, and when it tries again. */
export function waitingWords(
  t: Translate,
  connection: Extract<ConnectionView, { kind: "waiting" }>,
): string {
  const why = t(CONNECTION_FAILURE_KEYS[connection.failure] ?? "connection.failure.protocol");
  return `${why} ${t("connection.retry", { count: Math.ceil(connection.retryInMs / 1000) })}`;
}

export const LINK_FAILURE_KEYS = {
  unreachable: "link.failure.unreachable",
  refused: "link.failure.refused",
  wrongHub: "link.failure.wrongHub",
  notAccepted: "link.failure.notAccepted",
  needsName: "link.failure.needsName",
  protocol: "link.failure.protocol",
  timeout: "link.failure.timeout",
  noWebCrypto: "link.failure.noWebCrypto",
  extractable: "link.failure.extractable",
  failed: "link.failure.failed",
  storage: "link.failure.storage",
  unreadable: "link.failure.unreadable",
  badCode: "link.failure.badCode",
} as const satisfies Readonly<Record<Extract<LinkView, { kind: "failed" }>["failure"], string>>;
