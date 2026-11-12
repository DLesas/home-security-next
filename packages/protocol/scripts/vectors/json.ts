/** How values appear in the vector files: bytes as lowercase hex, everything else as JSON. */
import { type ProtocolError, toHex } from "../../src/index.ts";

export type Json = string | number | boolean | null | readonly Json[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: Json;
}

/** Converts decoded protocol values: byte arrays become hex, objects and arrays are walked. */
export function toJson(value: unknown): Json {
  if (value instanceof Uint8Array) return toHex(value);
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, toJson(field)]));
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  throw new TypeError(`no JSON form for ${typeof value}`);
}

/** A message's body fields, without its type. */
export function fieldsJson(message: { readonly type: number }): Json {
  return toJson(Object.fromEntries(Object.entries(message).filter(([key]) => key !== "type")));
}

/** An error as the vectors record it: the code, plus the type byte for `unknownType`. */
export function errorJson(error: ProtocolError): JsonObject {
  return error.code === "unknownType"
    ? { error: error.code, messageType: error.messageType }
    : { error: error.code };
}
