/**
 * The four pairing vector files made from ESP-IDF's own code (`../esp-idf/make-vectors.sh`), read
 * with their formats, for the tests and the scripted boards. Reading a file that does not match
 * its format is a programmer's error here, as `fromHex` is.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  PAIRING_BOARD_VECTOR_FILES,
  pairingBoardScriptVectorFile,
  pairingCounterVectorFile,
} from "../board-vector-formats.ts";
import { pairingSecurity2VectorFile, pairingSrpVectorFile } from "../vector-formats.ts";

const DIRECTORY = join(import.meta.dir, "..", "..", "..", "vectors");
const read = (name: string): unknown => JSON.parse(readFileSync(join(DIRECTORY, name), "utf8"));

export const ESP_IDF_VECTOR_FILES = {
  srp: "pairing-srp.json",
  security2: "pairing-security2.json",
  ...PAIRING_BOARD_VECTOR_FILES,
} as const;

/** The same format, with `cases` typed as having a first case, as the formats require. */
const withFirst = <S extends z.ZodType>(item: S) => z.tuple([item], item);

export function espIdfVectors() {
  const srp = pairingSrpVectorFile.extend({
    cases: withFirst(pairingSrpVectorFile.shape.cases.element),
  });
  const security2 = pairingSecurity2VectorFile.extend({
    cases: withFirst(pairingSecurity2VectorFile.shape.cases.element),
  });
  const script = pairingBoardScriptVectorFile.extend({
    cases: withFirst(pairingBoardScriptVectorFile.shape.cases.element),
  });
  const counter = pairingCounterVectorFile.extend({
    cases: withFirst(pairingCounterVectorFile.shape.cases.element),
  });
  return {
    srp: srp.parse(read(ESP_IDF_VECTOR_FILES.srp)),
    security2: security2.parse(read(ESP_IDF_VECTOR_FILES.security2)),
    script: script.parse(read(ESP_IDF_VECTOR_FILES.script)),
    counter: counter.parse(read(ESP_IDF_VECTOR_FILES.counter)),
  };
}
