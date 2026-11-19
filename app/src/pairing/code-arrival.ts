import { readBoardQr, type BoardQr } from "@hsn/protocol/pairing";

let next: BoardQr | undefined;

/** Holds one normalized deep-link code privately until the add-device page opens. */
export function receivePairingCode(text: string): boolean {
  const code = readBoardQr(text);
  if (code === undefined) return false;
  next = code;
  return true;
}

/** Hands the code to a single pairing screen without putting it in route parameters. */
export function claimPairingCode(): BoardQr | undefined {
  const code = next;
  next = undefined;
  return code;
}

/** Checks whether linking a phone left a board code ready for its add-device route. */
export function hasPairingCode(): boolean {
  return next !== undefined;
}
