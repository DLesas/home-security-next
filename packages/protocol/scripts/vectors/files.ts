/** Every vector file, by name, as the exact text written to disk. */
import { counterVectorFile } from "./counters.ts";
import type { JsonObject } from "./json.ts";
import { messageVectorFiles } from "./packets.ts";
import { timeOnAirVectorFile } from "./radio.ts";
import { rejectedVectorFile } from "./rejected.ts";
import { unitVectorFile } from "./units.ts";
import { usbVectorFiles } from "./usb.ts";

/** Changes when the file layout changes, so consumers can tell which README applies. */
export const VECTOR_SCHEMA_VERSION = 1;

export function vectorFiles(): Map<string, string> {
  const contents = new Map<string, JsonObject>([
    ...messageVectorFiles(),
    ["rejected-packets.json", rejectedVectorFile()],
    ["counters.json", counterVectorFile()],
    ...usbVectorFiles(),
    ["time-on-air.json", timeOnAirVectorFile()],
    ["units.json", unitVectorFile()],
  ]);
  return new Map(
    [...contents].map(([name, json]) => [
      name,
      JSON.stringify(
        { schemaVersion: VECTOR_SCHEMA_VERSION, protocolVersion: 1, ...json },
        null,
        2,
      ) + "\n",
    ]),
  );
}
