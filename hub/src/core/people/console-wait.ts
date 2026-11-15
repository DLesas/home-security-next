/**
 * `hsn open` waits for its console token (section 5, "The console"; section 11, "Step 1, wave 2":
 * "Knowing the page was read"): `consoleTokenWait {token}` from the hub computer's control socket,
 * the only way it comes (`app` never sends it), is answered `{used}` when the token is used or
 * expires, with no access time and no port read.
 *
 * - A live console token: answered when it is used (`true`) or void (`false`: expired, cancelled).
 * - Any other number: answered at once, `true` only for a console token used in this run, else
 *   `false`. So an unknown number, a link token's, and an expired console token's all answer the
 *   same, and asking reveals nothing of other tokens; a reply never holds a secret.
 * - The waits are memory: at a restart the control socket's requests have no one to answer.
 */
import type { Effect } from "../model/effects.ts";
import type { RequestId, TokenId } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { TokenKind } from "../model/rows.ts";
import { answerOk } from "../control/view.ts";
import type { PeopleSlice } from "./state.ts";

type Out = readonly (Internal | Effect)[];

function answered(request: RequestId, used: boolean): Internal {
  return answerOk(request, { kind: "consoleTokenWait", used });
}

/** A wait for `token`: kept while it is a live console token, else answered at once. */
export function consoleTokenWait(
  slice: PeopleSlice,
  request: RequestId,
  token: TokenId,
): { readonly slice: PeopleSlice; readonly out: Out } {
  if (slice.tokens.get(token)?.row.kind === TokenKind.Console) {
    const waits = new Map(slice.consoleWaits);
    waits.set(token, [...(waits.get(token) ?? []), request]);
    return { slice: { ...slice, consoleWaits: waits }, out: [] };
  }
  return { slice, out: [answered(request, slice.consoleUsed.has(token))] };
}

/** A console token was used to link (D121: once): its waits answer `true`. */
export function consoleTokenUsed(slice: PeopleSlice, token: TokenId): PeopleSlice {
  const used = new Set(slice.consoleUsed);
  used.add(token);
  return { ...slice, consoleUsed: used };
}

/** Every wait whose token is no longer live, answered; the slice as it was when there is none. */
export function settleConsoleWaits(slice: PeopleSlice): {
  readonly slice: PeopleSlice;
  readonly out: Out;
} {
  if (slice.consoleWaits.size === 0) return { slice, out: [] };
  const settled = [...slice.consoleWaits].filter(([token]) => !slice.tokens.has(token));
  if (settled.length === 0) return { slice, out: [] };
  const waits = new Map(slice.consoleWaits);
  const out: Internal[] = [];
  for (const [token, requests] of settled) {
    waits.delete(token);
    for (const request of requests) out.push(answered(request, slice.consoleUsed.has(token)));
  }
  return { slice: { ...slice, consoleWaits: waits }, out };
}
