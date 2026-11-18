/**
 * Every decision the hub records, and the hub event kinds M2 adds: their one list is
 * `@hsn/protocol/records` (m2-design.md section 11, "Step 1, wave 2"), which the app and its
 * translation files read too. The core re-exports it here, with the joint step 0's additions
 * (docs/m3-m4-plan.md), which are their own lists; and the one form of an event time in a
 * decision's `detail` (`eventAtDetail`, D102), which `alarm` writes and `notify` reads.
 */
export {
  ALL_DECISION_KINDS,
  DECISION_KINDS,
  type DecisionKind,
  EVENT_AT_DETAIL_BYTES,
  eventAtDetail,
  eventAtOf,
  M2_HUB_EVENTS,
  M3M4_DECISION_KINDS,
  M3M4_HUB_EVENTS,
  type M2HubEventCode,
  type M3M4HubEventCode,
} from "@hsn/protocol/records";
