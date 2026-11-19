/** Build and verify Win32 serial settings without relying on C bit-field packing in Bun. */
const DCB_SIZE = 28;
const DCB_FLAGS = 8;
const DCB_BYTES = 18;
const DCB_PARITY = 19;
const DCB_STOP = 20;
const MAXDWORD = 0xffff_ffff;
export const SERIAL_TIMEOUT_MS = 500;

export interface SerialLines {
  readonly dtr: boolean;
  readonly rts: boolean;
}

// Unix asserts both on open. USB CDC may need DTR to answer Identify, and a board's
// auto-reset circuit may reset on a DTR/RTS transition. Only the board can settle this choice.
export const WINDOWS_SERIAL_LINES: SerialLines = { dtr: false, rts: false };

/** The named fields checked in the documented DCB bit order. */
function flagFields(lines: SerialLines) {
  return [
    ["fBinary", 0, 1, 1],
    ["fParity", 1, 1, 0],
    ["fOutxCtsFlow", 2, 1, 0],
    ["fOutxDsrFlow", 3, 1, 0],
    ["fDtrControl", 4, 3, Number(lines.dtr)],
    ["fDsrSensitivity", 6, 1, 0],
    ["fOutX", 8, 1, 0],
    ["fInX", 9, 1, 0],
    ["fErrorChar", 10, 1, 0],
    ["fNull", 11, 1, 0],
    ["fRtsControl", 12, 3, Number(lines.rts)],
    ["fAbortOnError", 14, 1, 0],
  ] as const;
}

const BYTE_FIELDS = [
  ["ByteSize", DCB_BYTES, 8],
  ["Parity", DCB_PARITY, 0],
  ["StopBits", DCB_STOP, 0],
] as const;

/** An exclusive Win32 device name, including two-digit COM numbers. */
export function devicePath(port: string): string | undefined {
  const name = port.replace(/^\\\\\.\\/u, "").toUpperCase();
  return /^COM[1-9]\d*$/u.test(name) ? `\\\\.\\${name}` : undefined;
}

/** Allocates the DCB and sets the first DWORD (DCBlength). */
export function newDcb(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(DCB_SIZE);
  new DataView(bytes.buffer).setUint32(0, DCB_SIZE, true);
  return bytes;
}

/** Sets 8N1 and binary mode, leaving the port's baud rate in place. */
export function setByteClean(dcb: Uint8Array, lines = WINDOWS_SERIAL_LINES): void {
  const view = new DataView(dcb.buffer, dcb.byteOffset, dcb.byteLength);
  const flags = flagFields(lines).reduce((bits, [, shift, , value]) => bits | (value << shift), 0);
  view.setUint32(DCB_FLAGS, flags, true);
  for (const [, offset, value] of BYTE_FIELDS) view.setUint8(offset, value);
}

/** Describes the first differing setting. Reserved bits and the inactive XOFF policy are ignored. */
export function byteCleanMismatch(
  dcb: Uint8Array,
  lines = WINDOWS_SERIAL_LINES,
): string | undefined {
  const view = new DataView(dcb.buffer, dcb.byteOffset, dcb.byteLength);
  const flags = view.getUint32(DCB_FLAGS, true);
  for (const [name, shift, mask, value] of flagFields(lines)) {
    const actual = (flags >>> shift) & mask;
    if (actual !== value) return `${name} reported ${actual}, expected ${value}`;
  }
  for (const [name, offset, value] of BYTE_FIELDS) {
    const actual = view.getUint8(offset);
    if (actual !== value) return `${name} reported ${actual}, expected ${value}`;
  }
  return undefined;
}

/** Five DWORDs in the order specified by COMMTIMEOUTS. */
export function serialTimeouts(): Uint32Array<ArrayBuffer> {
  // First available bytes or 500 ms. A write also has 500 ms to complete.
  return Uint32Array.of(MAXDWORD, MAXDWORD, SERIAL_TIMEOUT_MS, 0, SERIAL_TIMEOUT_MS);
}

/** On Windows x64: two ULONG_PTRs, the 8-byte offset union, and an unused HANDLE for Ex I/O. */
export function newOverlapped(): Uint8Array<SharedArrayBuffer> {
  return new Uint8Array(new SharedArrayBuffer(32));
}
