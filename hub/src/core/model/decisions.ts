/**
 * Every decision the hub records, and the hub event kinds M2 adds: their one list is
 * `@hsn/protocol/records` (m2-design.md section 11, "Step 1, wave 2"), which the app and its
 * translation files read too. The core re-exports it here.
 */
export {
  DECISION_KINDS,
  type DecisionKind,
  M2_HUB_EVENTS,
  type M2HubEventCode,
} from "@hsn/protocol/records";
