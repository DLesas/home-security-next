/**
 * The key-leak guard (hub-design.md sections 2 and 9; the task's rule "never print, log or record
 * a device key or the hub's private key"). Every test file that creates keys or produces records
 * or output registers them here; `expectNoKeyLeaks` then searches every record and every line of
 * output produced so far, in this file and every earlier one of the run, for every key: as raw
 * bytes inside any byte field, and as lowercase hex, uppercase hex and base64 inside any text.
 *
 * The one place a device key may appear is where the design puts it: the written-now
 * `device_keys` row and the Provision message itself. Those are never given to `noteOutput`.
 */
import { expect } from "bun:test";
import type { Effect } from "../../../../src/core/model/effects.ts";

interface Collected {
  readonly keys: Uint8Array[];
  readonly texts: string[];
  readonly blobs: Uint8Array[];
}

const GLOBAL = Symbol.for("hsn.test.e5.leakGuard");

function collected(): Collected {
  const holder = globalThis as unknown as Record<symbol, Collected | undefined>;
  holder[GLOBAL] ??= { keys: [], texts: [], blobs: [] };
  return holder[GLOBAL];
}

/** A key a test made or the core drew. */
export function noteKey(key: Uint8Array): void {
  if (key.length > 0) collected().keys.push(key.slice());
}

/** Text or bytes the hub produced: a record, a reply, a line of output. */
export function noteOutput(output: string | Uint8Array): void {
  if (typeof output === "string") collected().texts.push(output);
  else collected().blobs.push(output.slice());
}

/** Every byte array inside a value, and the value as JSON with bytes as hex. */
function walk(value: unknown, blobs: Uint8Array[]): unknown {
  if (value instanceof Uint8Array) {
    blobs.push(value);
    return Buffer.from(value).toString("hex");
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, blobs));
  if (value instanceof Map) return [...value.entries()].map((entry) => walk(entry, blobs));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, blobs)]));
  }
  return value;
}

/** Any value the hub produced (a record, a reply, a hub event), searched as bytes and as text. */
export function noteValue(value: unknown): void {
  const blobs: Uint8Array[] = [];
  const json = JSON.stringify(walk(value, blobs));
  noteOutput(json);
  for (const blob of blobs) noteOutput(blob);
}

/**
 * The step's effects: device keys written are noted as keys; records and replies as output. A
 * `send` and a `write` are not output: the Provision message and `device_keys` carry the key.
 */
export function noteEffects(effects: readonly Effect[]): void {
  for (const effect of effects) {
    if (effect.kind === "write" && effect.op.table === "device_keys" && effect.op.op === "upsert") {
      noteKey(effect.op.row.key);
    } else if (effect.kind === "record" || effect.kind === "respond") {
      noteValue(effect);
    }
  }
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Fails if any noted key appears in any noted output. */
export function expectNoKeyLeaks(): void {
  const { keys, texts, blobs } = collected();
  const leaks: string[] = [];
  keys.forEach((key, k) => {
    const hex = Buffer.from(key).toString("hex");
    const forms = [hex, hex.toUpperCase(), Buffer.from(key).toString("base64")];
    texts.forEach((text, i) => {
      if (forms.some((form) => text.includes(form))) leaks.push(`output ${i} holds key ${k}`);
    });
    blobs.forEach((blob, i) => {
      if (contains(blob, key)) leaks.push(`bytes ${i} hold key ${k}`);
    });
  });
  expect(leaks).toEqual([]);
}

/** How much has been searched, so a test can check the guard saw something. */
export function guardCounts(): { readonly keys: number; readonly outputs: number } {
  const { keys, texts, blobs } = collected();
  return { keys: keys.length, outputs: texts.length + blobs.length };
}

export { contains as bytesContain };
