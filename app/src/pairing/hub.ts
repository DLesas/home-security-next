/** The phone's existing version 2 channel, typed for pairing and firmware operations. */
import {
  APP_OPS_V2,
  type AppOpBodyV2,
  type AppOpNameV2,
  type AppOpReplyV2,
} from "@hsn/protocol/app";
import type { AnyOutcome } from "../hub/channel";
import type { PhoneClient } from "../hub/phone-client";

export type PhoneHub = Pick<PhoneClient, "forward" | "client" | "onNewEvent">;

type HubFailure = Extract<AnyOutcome, { ok: false }>;
export type HubOutcome<N extends AppOpNameV2> =
  { readonly ok: true; readonly value: AppOpReplyV2<N> } | HubFailure;

/** Validates the typed reply, without keeping it in a query, store or log. */
export async function phoneRequest<N extends AppOpNameV2>(
  hub: Pick<PhoneHub, "forward">,
  op: N,
  body: AppOpBodyV2<N>,
): Promise<HubOutcome<N>> {
  const response = await hub.forward(op, body);
  if (!response.ok) return response;
  const parsed = APP_OPS_V2[op].reply.safeParse(response.body);
  return parsed.success
    ? { ok: true, value: parsed.data as AppOpReplyV2<N> }
    : { ok: false, local: "offline" };
}

/** Gives the operation's refusal reason without retaining the rest of the response. */
export function refusal(failure: HubFailure): string {
  if ("local" in failure) return failure.local;
  const error = failure.error;
  if (error.code === "invalid") return error.detail.reason;
  if (error.code === "busy") return error.detail.because;
  return error.code;
}
