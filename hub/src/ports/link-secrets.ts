/**
 * Link and restore tokens the shell may accept (m2-design.md section 5, "Linking" and "Token
 * numbers"): each token's pre-shared key and purpose, given by the core's `linkSecret` effect when
 * it is made and withdrawn (null) when it is used, cancelled or expires. The shell finds a token by
 * the lookup `LinkHello` carries and runs XXpsk3 with its key under the prologue its purpose names;
 * the core never sees a key again after making it (section 2).
 */
import type { TokenId } from "../core/model/ids.ts";

/** What a handshake's token is for: linking a client, or a restore (section 9). */
export type TokenPurpose = "link" | "restore";

/** A token the shell may accept. */
export interface AcceptedToken {
  readonly token: TokenId;
  readonly purpose: TokenPurpose;
  /** Linking a new person whose name was not given: message 2 asks for one; false for a restore. */
  readonly askName: boolean;
  readonly psk: Uint8Array;
}

export interface LinkSecrets {
  /** The token `LinkHello.find` names, with its key, or undefined: the socket closes. */
  find(lookup: string): AcceptedToken | undefined;
  /** A `linkSecret` effect: accept the token from now (`psk`), or no longer (null). */
  apply(
    token: TokenId,
    purpose: TokenPurpose,
    askName: boolean,
    lookup: string,
    psk: Uint8Array | null,
  ): void;
}
