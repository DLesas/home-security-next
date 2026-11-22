/** The Expo adapter, exercised with the native package's exports replaced under Bun. */
import { expect, mock, test } from "bun:test";
import type {
  LocalAuthenticationOptions,
  LocalAuthenticationResult,
} from "expo-local-authentication";
import { NO_ABILITY } from "../src/platform/app-lock-types";

const SecurityLevel = { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 };
const AuthenticationType = { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 };
const calls: LocalAuthenticationOptions[] = [];
const native = {
  level: SecurityLevel.NONE,
  types: [] as number[],
  answer: { success: true } as LocalAuthenticationResult,
  rejected: false,
};
await mock.module("expo-local-authentication", () => ({
  SecurityLevel,
  AuthenticationType,
  getEnrolledLevelAsync: () =>
    native.rejected ? Promise.reject(new Error("unavailable")) : Promise.resolve(native.level),
  supportedAuthenticationTypesAsync: () => Promise.resolve(native.types),
  authenticateAsync: (options: LocalAuthenticationOptions) => {
    calls.push(options);
    return native.rejected
      ? Promise.reject(new Error("unavailable"))
      : Promise.resolve(native.answer);
  },
}));
const { personCheck } = await import("../src/platform/app-lock.native");
const words = { prompt: "Unlock the app", cancel: "Cancel" };

test("enrollment distinguishes no credentials, passcode and biometrics without prompting", async () => {
  expect(await personCheck.ability()).toEqual({ ok: true, value: NO_ABILITY });
  native.level = SecurityLevel.SECRET;
  native.types = [AuthenticationType.FACIAL_RECOGNITION];
  expect(await personCheck.ability()).toEqual({
    ok: true,
    value: { level: "passcode", kinds: ["face"] },
  });
  native.level = SecurityLevel.BIOMETRIC_STRONG;
  native.types = [AuthenticationType.FINGERPRINT];
  expect(await personCheck.ability()).toEqual({
    ok: true,
    value: { level: "biometric", kinds: ["fingerprint"] },
  });
  expect(calls).toEqual([]);
});

test("the device passcode is allowed and native failures are returned as faults", async () => {
  expect(await personCheck.check(words)).toEqual({ ok: true, value: undefined });
  expect(calls).toEqual([
    { promptMessage: "Unlock the app", cancelLabel: "Cancel", disableDeviceFallback: false },
  ]);
  native.answer = { success: false, error: "user_cancel" };
  expect(await personCheck.check(words)).toEqual({ ok: false, fault: "cancelled" });
  native.answer = { success: false, error: "lockout" };
  expect(await personCheck.check(words)).toEqual({ ok: false, fault: "lockedOut" });
  native.answer = { success: false, error: "not_available" };
  expect(await personCheck.check(words)).toEqual({ ok: false, fault: "unavailable" });
  native.answer = { success: false, error: "authentication_failed" };
  expect(await personCheck.check(words)).toEqual({ ok: false, fault: "failed" });
  native.rejected = true;
  expect(await personCheck.ability()).toEqual({ ok: false, fault: "failed" });
  expect(await personCheck.check(words)).toEqual({ ok: false, fault: "failed" });
});
