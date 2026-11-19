/**
 * The local network permission, per platform (`local-network-types.ts` says why):
 * `local-network.web.ts` always has it; `local-network.native.ts` asks Android 17's and explains
 * iOS's. Metro loads one of them in place of this file; tsc and Bun's tests read this one, which
 * binds the web build's (`split.ts`).
 */
import type { LocalNetwork } from "./local-network-types";
import type { Split } from "./split";
import type * as phone from "./local-network.native";
import * as web from "./local-network.web";

export type { LocalNetwork } from "./local-network-types";

/** Both platforms' files export `LocalNetwork`. */
export type Platforms = Split<LocalNetwork, typeof web, typeof phone>;

export const { permission, ask }: LocalNetwork = web;
