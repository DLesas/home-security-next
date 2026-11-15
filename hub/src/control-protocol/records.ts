/**
 * The audit record as JSON. Its schema lives in `@hsn/protocol/records` (m2-design.md section 6),
 * which `hsn` and the app both import; the control protocol re-exports it: an audit record only
 * (`auditRecordJson`), since `lossDaily` lines belong to the history export, never to `hsn log`.
 */
export {
  auditRecordJson as recordJson,
  type AuditRecordJson as RecordJson,
} from "@hsn/protocol/records";
