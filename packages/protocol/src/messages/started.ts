/**
 * Started (0x05), section 6: sent once after every start-up. The hub always replies to a
 * sensor's Started, so the body needs no reply-wanted flag.
 */
import { u16, u8 } from "../codec/field.ts";
import { layout } from "../codec/layout.ts";
import { firmwareVersion } from "./common.ts";

/** Body of started: 8 bytes. */
export const startedLayout = layout([
  // A Role value; check with isEnumValue.
  ["role", u8],
  ["firmwareVersion", firmwareVersion],
  // As ESP-IDF reports it.
  ["resetCause", u8],
  // 0 for none (FW5).
  ["lastFatalError", u16],
  ["settingsVersion", u8],
]);
