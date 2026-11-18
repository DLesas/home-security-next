/** Build and verify Win32 serial settings without relying on C bit-field packing in Bun. */
const DCB_SIZE = 28;
const DCB_FLAGS = 8;
const DCB_BYTES = 18;
const DCB_PARITY = 19;
const DCB_STOP = 20;
const BINARY = 1;
const MAXDWORD = 0xffff_ffff;
const TIMEOUT_MS = 500;

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
export function setByteClean(dcb: Uint8Array): void {
  const view = new DataView(dcb.buffer, dcb.byteOffset, dcb.byteLength);
  // fBinary alone leaves parity checks, translation, flow control, DTR and RTS off.
  view.setUint32(DCB_FLAGS, BINARY, true);
  view.setUint8(DCB_BYTES, 8);
  view.setUint8(DCB_PARITY, 0);
  view.setUint8(DCB_STOP, 0);
}

/** Detects a driver changing a setting when it takes the DCB. */
export function isByteClean(dcb: Uint8Array): boolean {
  const view = new DataView(dcb.buffer, dcb.byteOffset, dcb.byteLength);
  return (
    view.getUint32(DCB_FLAGS, true) === BINARY &&
    view.getUint8(DCB_BYTES) === 8 &&
    view.getUint8(DCB_PARITY) === 0 &&
    view.getUint8(DCB_STOP) === 0
  );
}

/** Five DWORDs in the order specified by COMMTIMEOUTS. */
export function serialTimeouts(): Uint32Array<ArrayBuffer> {
  // First available bytes, or 500 ms; also bound the write before servicing a close.
  return Uint32Array.of(MAXDWORD, MAXDWORD, TIMEOUT_MS, 0, TIMEOUT_MS);
}
