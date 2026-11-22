/**
 * The Expo 58 native check. The Face ID purpose string is already in app.config.ts. The device
 * credential fallback uses iOS device-owner authentication or Android's DEVICE_CREDENTIAL.
 */
import {
  authenticateAsync,
  AuthenticationType,
  getEnrolledLevelAsync,
  type LocalAuthenticationError,
  SecurityLevel,
  supportedAuthenticationTypesAsync,
} from "expo-local-authentication";
import {
  type Biometry,
  type CheckFault,
  type LockAbility,
  NO_ABILITY,
  type PersonCheck,
} from "./app-lock-types";

const kinds: Readonly<Record<AuthenticationType, Biometry>> = {
  [AuthenticationType.FACIAL_RECOGNITION]: "face",
  [AuthenticationType.FINGERPRINT]: "fingerprint",
  [AuthenticationType.IRIS]: "iris",
};

/** Uses enrollment to distinguish biometric devices from passcode-only devices. */
function abilityOf(level: SecurityLevel, supported: readonly AuthenticationType[]): LockAbility {
  if (level === SecurityLevel.NONE)
    return { ...NO_ABILITY, kinds: supported.map((type) => kinds[type]) };
  if (level === SecurityLevel.SECRET)
    return { level: "passcode", kinds: supported.map((type) => kinds[type]) };
  return { level: "biometric", kinds: supported.map((type) => kinds[type]) };
}

/** Maps the native errors without exposing the library's diagnostic messages. */
function checkFaultOf(error: LocalAuthenticationError): CheckFault {
  switch (error) {
    case "user_cancel":
    case "system_cancel":
    case "app_cancel":
    case "user_fallback":
      return "cancelled";
    case "lockout":
      return "lockedOut";
    case "not_enrolled":
    case "passcode_not_set":
    case "not_available":
      return "unavailable";
    default:
      return "failed";
  }
}

export const personCheck = {
  /** Reads enrolled security and supported biometrics from Expo without an authentication prompt. */
  ability: () =>
    Promise.all([getEnrolledLevelAsync(), supportedAuthenticationTypesAsync()]).then(
      ([level, types]) => ({ ok: true as const, value: abilityOf(level, types) }),
      () => ({ ok: false as const, fault: "failed" as const }),
    ),
  /** Asks Expo for one check and accepts either biometric authentication or the device passcode. */
  check: (words) =>
    authenticateAsync({
      promptMessage: words.prompt,
      cancelLabel: words.cancel,
      disableDeviceFallback: false,
    }).then(
      (result) =>
        result.success
          ? { ok: true as const, value: undefined }
          : { ok: false as const, fault: checkFaultOf(result.error) },
      () => ({ ok: false as const, fault: "failed" as const }),
    ),
} satisfies PersonCheck;
