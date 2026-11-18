/**
 * The release index (docs/m4-design.md section 6): what the `releases` role knows of the signed
 * files in its folder (`hsn-hub-<version>-<platform>.hsnr`, `hsn-firmware-<version>.hsnf`), read
 * at start and every `RELEASES_RULES.refreshMs` (`../core/rules.ts`) with the two manifest schemas of `@hsn/protocol/release`. It
 * checks no signature: it is not trusted to. A self-hosted relay fills its folder over its relay
 * link (`release.check`, `release.get`). Frozen by the joint step 0; B2 implements it.
 */
import type { ResultAsync } from "neverthrow";
import type { ReleaseCheck, ReleaseOffer } from "@hsn/protocol/relay";

/**
 * One file in the index: an offer as the hub link carries it (kind, version, platform or target
 * and roles, file name, length and SHA-256), and where the file is.
 */
export type ReleaseIndexEntry = ReleaseOffer & {
  /** Where in the folder the file is. */
  readonly path: string;
};

/** Why a piece could not be read. */
export type ReleaseReadError =
  /** No such file in the index. */
  | { readonly kind: "notFound" }
  /** `offset` and `length` reach past the file. */
  | { readonly kind: "range" }
  /** The file could not be read (it went, or the disk failed). */
  | { readonly kind: "unavailable" };

export interface ReleaseIndex {
  /** Every file indexed, newest first within each kind and platform or target. */
  entries(): readonly ReleaseIndexEntry[];
  /**
   * What `release.offer` answers a `release.check` with: the newest hub release above `running`
   * for that platform, and the newest firmware above `firmware` (or the newest, when the hub
   * holds none); at most one of each kind.
   */
  offer(check: ReleaseCheck): readonly ReleaseOffer[];
  /** Bytes `offset` to `offset + length` of an indexed file, exactly `length` of them. */
  read(file: string, offset: number, length: number): ResultAsync<Uint8Array, ReleaseReadError>;
  /** Reads the folder again; files gone leave the index, new ones join it. */
  refresh(): ResultAsync<void, ReleaseReadError>;
}
