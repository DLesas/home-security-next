/**
 * What linking derives from a secret (m2-design.md section 5, "Linking"), per platform:
 * `digest.web.ts` with Web Crypto's SHA-256; `digest.native.ts`, on a phone, with the protocol
 * package's own functions over `@noble/hashes`' SHA-256 (m3-design.md section 2; P2, wave 1).
 * Metro loads one of them in place of this file; tsc and Bun's tests read this one, which binds
 * the web build's (`platform/split.ts`).
 */
import type { Split } from "../platform/split";
import type { Digests } from "./digest-types";
import type * as phone from "./digest.native";
import * as web from "./digest.web";

export type { Digests } from "./digest-types";

/** Both platforms' files export `Digests`. */
export type Platforms = Split<Digests, typeof web, typeof phone>;

export const { sha256, pskOfSecret, lookupOfSecret, pskOfTypedSecret, identityOf, toHex }: Digests =
  web;
