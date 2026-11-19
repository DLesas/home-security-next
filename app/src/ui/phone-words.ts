/**
 * The words the phone's link and restore pages give for what they were handed (m3-design.md
 * sections 3 and 4): a code they cannot take, and a link that failed. Pure, so the tests check
 * that every case has its words.
 */
import type { CodeFault } from "../hub/finder";
import type { LinkView } from "../hub/client";
import type { ReachState } from "../hub/phone-client";
import type { ReachFault } from "./phone-parts";

/** The notice for a code not taken: not ours, ours but unreadable, or not at a home address (D132). */
export function codeNotice(fault: CodeFault): string {
  return fault === "notOurs" ? "scan.notOurs" : `phoneLink.code.${fault}`;
}

/** The words for a link that failed on a phone: the reach's own two, else the link view's. */
export function phoneFailureKey(
  failure: Extract<LinkView, { kind: "failed" }>["failure"],
  reach: ReachFault | undefined,
): string {
  if (failure === "unreachable" && reach !== undefined) return `phoneLink.reach.${reach}`;
  return `phoneLink.failure.${failure}`;
}

/** Why the last link reached no hub: the system's refusal, or a browse that found none to try. */
export function reachFaultOf(reach: ReachState): ReachFault | undefined {
  if (reach.localNetworkDenied || reach.browse === "localNetworkDenied")
    return "localNetworkDenied";
  return reach.browse === null ? undefined : "noHubFound";
}
