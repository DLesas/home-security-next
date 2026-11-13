/**
 * Read-only selectors over the audit module's slice that other modules and the dispatcher may
 * use (hub-design.md section 2).
 */
import type { Seq } from "../model/ids.ts";
import type { HubState } from "../model/state.ts";

/** The sequence number the next record of this boot takes. */
export function nextRecordSeq(view: HubState): Seq {
  return view.audit.nextRecord;
}
