import {
  type RolloutObject,
  ROLLOUT_PAUSE_REASONS,
  UPDATE_REASONS,
  version1Error,
} from "@hsn/protocol/app";
import type { RolloutFailure } from "../state/rollout";
import { appErrorWords, deviceName, LOCAL_FAULT_KEYS, type Translate } from "../state/words";
import { fromHexSafe } from "./packets";

type Devices = Parameters<typeof deviceName>[1];
type Pause = RolloutObject["paused"];
const PAUSE_REASONS = [...UPDATE_REASONS, ...ROLLOUT_PAUSE_REASONS];

/** Uses the same explanation on Updates and in History. */
export function pauseWords(t: Translate, devices: Devices, pause: Pause): string {
  if (pause === null) return t("rollout.pausedByPerson");
  if (pause.device === null && pause.reason === "hashMismatch") return t("rollout.damagedCopy");
  const reason = t(`rollout.reason.${pause.reason}`);
  return pause.device === null
    ? reason
    : t("rollout.pauseDevice", { device: deviceName(t, devices, pause.device), reason });
}

/** Reads the history record's little-endian device ID followed by its one-byte reason. */
export function recordedPause(t: Translate, devices: Devices, detail: string | null): string {
  if (detail === null) return pauseWords(t, devices, null);
  const bytes = fromHexSafe(detail);
  if (bytes?.byteLength !== 5) return t("rollout.stage.paused");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const reason = PAUSE_REASONS[view.getUint8(4) - 1];
  if (reason === undefined) return t("rollout.stage.paused");
  return pauseWords(t, devices, { reason, device: view.getUint32(0, true) || null });
}

/** Describes rollout-specific refusals, using the app's common wording for channel failures. */
export function rolloutFailureWords(
  t: Translate,
  language: string,
  devices: Devices,
  failure: RolloutFailure,
): string {
  if ("local" in failure) return t(LOCAL_FAULT_KEYS[failure.local]);
  const { error } = failure;
  if (error.code === "notFound") {
    if (error.detail.what === "rollout") return t("rollout.errors.rolloutMissing");
    if (error.detail.what === "image") return t("rollout.errors.imageMissing");
  }
  if (error.code === "invalid") {
    const { field, reason } = error.detail;
    if (field === "rollout" && reason === "range") return t("rollout.errors.ended");
    if (field === "devices" && reason === "range") return t("rollout.errors.noDevices");
    if (field === "device" && reason === "unknownReference") return t("rollout.errors.device");
    if (field === "force" && reason === "range") return t("rollout.errors.force");
    if (field === "version" && reason === "unknownReference") return t("rollout.errors.noOffer");
    if (field === "version" && reason === "tooLarge") return t("rollout.errors.tooLarge");
  }
  return appErrorWords(t, language, devices, error.code === "busy" ? error : version1Error(error));
}
