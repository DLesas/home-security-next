/** Every vector file, by name, as the exact text written to disk. */
import { counterVectorFile } from "./counters.ts";
import type { JsonObject } from "./json.ts";
import { messageVectorFiles } from "./packets.ts";
import { timeOnAirVectorFile } from "./radio.ts";
import { rejectedVectorFile } from "./rejected.ts";
import { unitVectorFile } from "./units.ts";
import { usbVectorFiles } from "./usb.ts";

/**
 * The device protocol's vector files, by an explicit list: the generator writes and deletes only
 * these, and the device vector tests and the verifier read only these. The app's vectors
 * (`app-*.json`, `@hsn/protocol/app`'s `APP_VECTOR_FILES`) share the folder and have their own
 * generator and tests in `src/app/vectors/` (m2-design.md section 11, "Step 1's questions").
 */
export const DEVICE_VECTOR_FILES = [
  "button.json",
  "cobs.json",
  "counters.json",
  "cover-changed.json",
  "disarmed-notice.json",
  "door-changed.json",
  "forwarded-packet.json",
  "gateway-settings.json",
  "gateway-status.json",
  "heartbeat.json",
  "hello.json",
  "interference.json",
  "log-entries.json",
  "pairing-data.json",
  "rejected-packets.json",
  "reply.json",
  "setup-messages.json",
  "siren-command.json",
  "siren-report.json",
  "siren-settings.json",
  "started.json",
  "time-on-air.json",
  "transmit-request.json",
  "transmit-result.json",
  "units.json",
  "welcome.json",
] as const;

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
