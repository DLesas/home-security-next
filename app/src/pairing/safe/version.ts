import { pairVersion, type PairVersion } from "@hsn/protocol/pairing";

/** Checks the clear-text version before a person chooses which board to authenticate. */
export function readVersion(bytes: Uint8Array): PairVersion | undefined {
  try {
    const result = pairVersion.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    );
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
