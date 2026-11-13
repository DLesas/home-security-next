/**
 * The only place the core calls a `@hsn/protocol` function that can throw (hub-design.md
 * section 10, "Where library exceptions are wrapped"). Each wrapper returns a neverthrow
 * `Result` whose error is a `HubError` of kind "codec"; lint forbids the wrapped names anywhere
 * else in the core. The package's own `Result` becomes a `HubError` through `fromProtocol`.
 *
 * SPEC-QUESTION: section 10 names five such functions (`timeOnAirMs`, `dataRateMask`,
 * `tenPpmUnitsFromPpm`, `resumeSendCounter`, `checkReplayWindow`); the package has more that
 * throw `RangeError` on bad arguments, and the rule "the only place" covers them too, so they
 * are wrapped here as well.
 */
import { err, ok, Result } from "neverthrow";
import {
  batteryCode,
  checkReplayWindow,
  checkStrictlyHigher,
  counterBinding,
  dataRateMask,
  encodeMessage,
  encodePairingData,
  encodeSetupMessage,
  fifteenSecondUnitsFromSeconds,
  fromHex,
  type ProtocolError,
  restoreSendCounter,
  resumeSendCounter,
  sessionBinding,
  tenPpmUnitsFromPpm,
  tenthsFromMilliseconds,
  timeOnAirMs,
  welcomeBinding,
  type Result as ProtocolResult,
} from "@hsn/protocol";
import type { HubError } from "../model/errors.ts";

const ORIGIN = "core/util/protocol-safe";

/** A thrown `RangeError` (or anything else thrown) as a `HubError`. */
function thrown(error: unknown): HubError {
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "codec", origin: ORIGIN, message };
}

/** The protocol package's own result as a neverthrow result (section 10). */
export function fromProtocol<T>(result: ProtocolResult<T>): Result<T, HubError> {
  return result.ok ? ok(result.value) : err(protocolError(result.error));
}

/** A protocol error as a `HubError`, keeping its code. */
export function protocolError(error: ProtocolError): HubError {
  const detail =
    error.code === "unknownType"
      ? { code: error.code, messageType: error.messageType }
      : { code: error.code };
  return { kind: "codec", origin: ORIGIN, message: `protocol error: ${error.code}`, detail };
}

export const safeTimeOnAirMs = Result.fromThrowable(timeOnAirMs, thrown);
export const safeDataRateMask = Result.fromThrowable(dataRateMask, thrown);
export const safeTenPpmUnitsFromPpm = Result.fromThrowable(tenPpmUnitsFromPpm, thrown);
export const safeResumeSendCounter = Result.fromThrowable(resumeSendCounter, thrown);
export const safeRestoreSendCounter = Result.fromThrowable(restoreSendCounter, thrown);
export const safeCheckReplayWindow = Result.fromThrowable(checkReplayWindow, thrown);
export const safeCheckStrictlyHigher = Result.fromThrowable(checkStrictlyHigher, thrown);
export const safeCounterBinding = Result.fromThrowable(counterBinding, thrown);
export const safeWelcomeBinding = Result.fromThrowable(welcomeBinding, thrown);
export const safeSessionBinding = Result.fromThrowable(sessionBinding, thrown);
export const safeEncodeMessage = Result.fromThrowable(encodeMessage, thrown);
export const safeEncodeSetupMessage = Result.fromThrowable(encodeSetupMessage, thrown);
export const safeEncodePairingData = Result.fromThrowable(encodePairingData, thrown);
export const safeFifteenSecondUnitsFromSeconds = Result.fromThrowable(
  fifteenSecondUnitsFromSeconds,
  thrown,
);
export const safeTenthsFromMilliseconds = Result.fromThrowable(tenthsFromMilliseconds, thrown);
export const safeBatteryCode = Result.fromThrowable(batteryCode, thrown);
export const safeFromHex = Result.fromThrowable(fromHex, thrown);
