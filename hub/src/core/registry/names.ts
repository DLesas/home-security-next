/**
 * The rule for device names (hub-design.md section 9; section 6, `devices.name` is unique).
 *
 * SPEC-QUESTION: section 9 sets no rule for names. The control protocol's `deviceName` allows 1
 * to 64 characters with no white space; this rule adds two more: no control characters, since
 * names are printed on terminals, and no leading `#`, which marks a retired device. A device
 * that is removed or reset by its owner keeps its row and history but gives up its name, as
 * `#<id>-<name>`, so the name can be given again (the `devices.name` key is unique over every
 * row, retired ones included).
 */
import { toHex } from "@hsn/protocol";
import type { DeviceId } from "../model/ids.ts";

/** The longest name, in characters: the control protocol's `deviceName`. */
export const MAX_NAME_LENGTH = 64;

/** Marks a retired device's name; no name a person gives may start with it. */
export const RETIRED_NAME_PREFIX = "#";

/** What is wrong with a name. */
export type NameProblem = "empty" | "tooLong" | "whiteSpace" | "control" | "reserved";

const WHITE_SPACE = /\s/u;
/** The last C0 control character; DEL and the C1 controls follow. */
const LAST_C0 = 0x1f;
const DEL = 0x7f;
const LAST_C1 = 0x9f;

/** True for C0 and C1 control characters and DEL, which could steer a terminal. */
export function isControlCharacter(code: number): boolean {
  return code <= LAST_C0 || (code >= DEL && code <= LAST_C1);
}

function hasControl(text: string): boolean {
  for (const char of text) {
    if (isControlCharacter(char.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/** Why `name` may not be given to a device, or undefined when it may. Uniqueness is the registry's. */
export function nameProblem(name: string): NameProblem | undefined {
  if (name.length === 0) return "empty";
  if (name.length > MAX_NAME_LENGTH) return "tooLong";
  if (WHITE_SPACE.test(name)) return "whiteSpace";
  if (hasControl(name)) return "control";
  if (name.startsWith(RETIRED_NAME_PREFIX)) return "reserved";
  return undefined;
}

/** Each problem in words, for the CLI's answer. */
export const NAME_PROBLEM_TEXT: Readonly<Record<NameProblem, string>> = {
  empty: "a name needs at least one character",
  tooLong: `a name has at most ${MAX_NAME_LENGTH} characters`,
  whiteSpace: "a name may not contain spaces",
  control: "a name may not contain control characters",
  reserved: `a name may not start with "${RETIRED_NAME_PREFIX}", which marks removed devices`,
};

/**
 * The name a retired device keeps: `#<id>-<name>`, cut to `MAX_NAME_LENGTH` characters without
 * splitting a character. Unique, because no two rows share an id and no given name starts with
 * `#`.
 */
export function retiredName(id: DeviceId, name: string): string {
  const prefix = `${RETIRED_NAME_PREFIX}${id}-`;
  const kept = Array.from(name.startsWith(RETIRED_NAME_PREFIX) ? "" : name);
  let out = prefix;
  for (const char of kept) {
    if (out.length + char.length > MAX_NAME_LENGTH) break;
    out += char;
  }
  return out;
}

/** The name an automatically added gateway gets (D100, section 9): `gateway-<chip>`. */
export function gatewayName(chipId: Uint8Array): string {
  return `gateway-${toHex(chipId)}`;
}
