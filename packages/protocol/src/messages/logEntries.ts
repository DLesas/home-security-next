/** Log entries (0x30), section 6. Wi-Fi and USB only. */
import { lengthPrefixedText, listToEnd, u16, u32, u8 } from "../codec/field.ts";
import { layout, struct } from "../codec/layout.ts";

export const MAX_LOG_TEXT_BYTES = 64;

/** One entry: 8 bytes plus its text. */
export const logEntry = struct(
  layout([
    ["millisecondsSinceStart", u32],
    ["level", u8],
    ["code", u16],
    ["text", lengthPrefixedText(MAX_LOG_TEXT_BYTES)],
  ]),
);

/**
 * Body of log entries: one or more entries filling the body exactly; a partial entry at the end
 * makes it truncated (section 6). Text that is not valid UTF-8 decodes with replacement
 * characters (section 3).
 */
export const logEntriesLayout = layout([["entries", listToEnd(logEntry)]]);
