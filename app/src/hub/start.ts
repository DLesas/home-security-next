/**
 * Starting the hub client, per platform (m3-design.md section 2): the root layout imports
 * `startClient` and `claimArrivedCode` from here. `start.web.ts` is the browser's (the page's own
 * origin, a code in the address fragment, IndexedDB, one session for all tabs); `start.native.ts`
 * is the phone's (addresses from the stored record, codes from links opened in the app; P2, wave
 * 1). Metro loads one of them in place of this file; tsc and Bun's tests read this one, which
 * binds the web build's (`platform/split.ts`).
 */
import type { Split } from "../platform/split";
import type { ClientStart } from "./start-types";
import type * as phone from "./start.native";
import * as web from "./start.web";

export type { ArrivedCode, ClientStart, StartedClient } from "./start-types";

/** Both platforms' files export `ClientStart`. */
export type Platforms = Split<ClientStart, typeof web, typeof phone>;

export const { startClient, claimArrivedCode, onArrivedCode }: ClientStart = web;
