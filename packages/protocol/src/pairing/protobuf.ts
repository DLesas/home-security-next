/**
 * The protobuf messages of protocomm security 2, by hand (ESP-IDF v6.1.1's
 * `components/protocomm/proto/session.proto`, `sec2.proto`, `constants.proto`): only what a
 * pairing exchange uses, written as ESP-IDF's protobuf-c writes it and read strictly.
 *
 *   SessionData    { sec_ver = 2: varint (2 = SecScheme2); sec2 = 12: Sec2Payload }
 *   Sec2Payload    { msg = 1: varint (0 Command0, 1 Response0, 2 Command1, 3 Response1);
 *                    oneof { sc0 = 20; sr0 = 21; sc1 = 22; sr1 = 23 } }
 *   S2SessionCmd0  { client_username = 1: bytes; client_pubkey = 2: bytes }
 *   S2SessionResp0 { status = 1: varint; device_pubkey = 2: bytes; device_salt = 3: bytes }
 *   S2SessionCmd1  { client_proof = 1: bytes }
 *   S2SessionResp1 { status = 1: varint; device_proof = 2: bytes; device_nonce = 3: bytes }
 *
 * Writing: fields in number order; proto3, so a zero varint or empty bytes is left out, and the
 * oneof's message is always written. Reading is stricter than protobuf's rules, since the board
 * writes only these: a field number not listed here, a field given twice, a wire type other than
 * the field's, a varint over 32 bits or of more than 5 bytes, a payload that does not match `msg`,
 * or bytes left over, is not a message (undefined). A missing field reads as zero or empty, as in
 * proto3.
 */

/** The security 2 messages, as the phone and the board exchange them on `prov-session`. */
export type Sec2Message =
  | {
      readonly msg: "command0";
      readonly username: Uint8Array;
      readonly publicKey: Uint8Array;
    }
  | {
      readonly msg: "response0";
      readonly status: number;
      readonly publicKey: Uint8Array;
      readonly salt: Uint8Array;
    }
  | { readonly msg: "command1"; readonly proof: Uint8Array }
  | {
      readonly msg: "response1";
      readonly status: number;
      readonly proof: Uint8Array;
      readonly nonce: Uint8Array;
    };

const SEC_SCHEME_2 = 2;
const MSG = { command0: 0, response0: 1, command1: 2, response1: 3 } as const;
const PAYLOAD_FIELD = { command0: 20, response0: 21, command1: 22, response1: 23 } as const;
const VARINT = 0;
const LEN = 2;

// ----- Writing -----

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function varintField(field: number, value: number): number[] {
  return value === 0 ? [] : [...varint((field << 3) | VARINT), ...varint(value)];
}

function bytesField(field: number, value: Uint8Array, always = false): number[] {
  if (value.length === 0 && !always) return [];
  return [...varint((field << 3) | LEN), ...varint(value.length), ...value];
}

function payloadBody(m: Sec2Message): Uint8Array {
  switch (m.msg) {
    case "command0":
      return Uint8Array.from([...bytesField(1, m.username), ...bytesField(2, m.publicKey)]);
    case "response0":
      return Uint8Array.from([
        ...varintField(1, m.status),
        ...bytesField(2, m.publicKey),
        ...bytesField(3, m.salt),
      ]);
    case "command1":
      return Uint8Array.from(bytesField(1, m.proof));
    case "response1":
      return Uint8Array.from([
        ...varintField(1, m.status),
        ...bytesField(2, m.proof),
        ...bytesField(3, m.nonce),
      ]);
  }
}

/** A `SessionData` holding a security 2 message, byte for byte as protobuf-c packs it. */
export function encodeSessionData(m: Sec2Message): Uint8Array {
  const payload = Uint8Array.from([
    ...varintField(1, MSG[m.msg]),
    ...bytesField(PAYLOAD_FIELD[m.msg], payloadBody(m), true),
  ]);
  return Uint8Array.from([...varintField(2, SEC_SCHEME_2), ...bytesField(12, payload, true)]);
}

// ----- Reading -----

type Value =
  | { readonly wire: typeof VARINT; readonly n: number }
  | { readonly wire: typeof LEN; readonly bytes: Uint8Array };

/** Reads a varint of at most 32 bits; undefined if cut short or too long. */
function readVarint(bytes: Uint8Array, at: number): { value: number; next: number } | undefined {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = bytes[at + i];
    if (byte === undefined) return undefined;
    if (i === 4 && byte > 0x0f) return undefined;
    value += (byte & 0x7f) * 2 ** (7 * i);
    if (byte < 0x80) return { value, next: at + i + 1 };
  }
  return undefined;
}

/** A message's fields by number, each once, each with its wire type checked against `wires`. */
function readFields(
  bytes: Uint8Array,
  wires: Readonly<Record<number, typeof VARINT | typeof LEN>>,
): Map<number, Value> | undefined {
  const fields = new Map<number, Value>();
  let at = 0;
  while (at < bytes.length) {
    const key = readVarint(bytes, at);
    if (key === undefined) return undefined;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    if (wires[field] !== wire || fields.has(field)) return undefined;
    const value = readVarint(bytes, key.next);
    if (value === undefined) return undefined;
    if (wire === VARINT) {
      fields.set(field, { wire: VARINT, n: value.value });
      at = value.next;
    } else {
      const end = value.next + value.value;
      if (end > bytes.length) return undefined;
      fields.set(field, { wire: LEN, bytes: bytes.slice(value.next, end) });
      at = end;
    }
  }
  return fields;
}

function num(fields: Map<number, Value>, field: number): number {
  const v = fields.get(field);
  return v?.wire === VARINT ? v.n : 0;
}

function bytesOf(fields: Map<number, Value>, field: number): Uint8Array {
  const v = fields.get(field);
  return v?.wire === LEN ? v.bytes : new Uint8Array(0);
}

const PAYLOAD_WIRES = { 1: VARINT, 20: LEN, 21: LEN, 22: LEN, 23: LEN } as const;
const BODY_WIRES = {
  command0: { 1: LEN, 2: LEN },
  response0: { 1: VARINT, 2: LEN, 3: LEN },
  command1: { 1: LEN },
  response1: { 1: VARINT, 2: LEN, 3: LEN },
} as const;
const BY_NUMBER = ["command0", "response0", "command1", "response1"] as const;

/** Reads a `SessionData` holding a security 2 message; undefined when it is not exactly one. */
export function decodeSessionData(bytes: Uint8Array): Sec2Message | undefined {
  const outer = readFields(bytes, { 2: VARINT, 12: LEN });
  if (outer === undefined || num(outer, 2) !== SEC_SCHEME_2 || !outer.has(12)) return undefined;
  const payload = readFields(bytesOf(outer, 12), PAYLOAD_WIRES);
  if (payload === undefined) return undefined;
  const kind = BY_NUMBER[num(payload, 1)];
  if (kind === undefined) return undefined;
  // Exactly one payload, the one `msg` names.
  const present = [20, 21, 22, 23].filter((f) => payload.has(f));
  if (present.length !== 1 || present[0] !== PAYLOAD_FIELD[kind]) return undefined;
  const body = readFields(bytesOf(payload, PAYLOAD_FIELD[kind]), BODY_WIRES[kind]);
  if (body === undefined) return undefined;
  switch (kind) {
    case "command0":
      return { msg: kind, username: bytesOf(body, 1), publicKey: bytesOf(body, 2) };
    case "response0":
      return {
        msg: kind,
        status: num(body, 1),
        publicKey: bytesOf(body, 2),
        salt: bytesOf(body, 3),
      };
    case "command1":
      return { msg: kind, proof: bytesOf(body, 1) };
    case "response1":
      return { msg: kind, status: num(body, 1), proof: bytesOf(body, 2), nonce: bytesOf(body, 3) };
  }
}
