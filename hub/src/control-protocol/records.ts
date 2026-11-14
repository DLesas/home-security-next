/**
 * The audit record as JSON. Its schema lives in `@hsn/protocol/records` (m2-design.md section 6),
 * which `hsn` and the app both import; the control protocol re-exports it.
 */
export { recordJson, type RecordJson } from "@hsn/protocol/records";
