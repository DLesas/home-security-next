/**
 * The audit record as JSON (hub-design.md sections 6 and 9): what `hsn log` reads and
 * `--follow` streams, and what the bench's lockstep `idle` carries. One variant per kind of
 * the core's `AuditRecord`, one field per column, bytes as hex. The CLI decodes bodies with
 * `@hsn/protocol` when it shows them.
 */
import { z } from "zod";
import { hexBytes, time } from "./values.ts";

const integer = z.int();
const nullableInteger = z.int().nullable();
const seq = time;

/** The columns every audit row begins with. */
const stamped = { seq, atMs: time, clockOk: z.boolean() };

const packetTable = z.enum(["routine", "event"]);

const rxRow = z
  .object({
    ...stamped,
    deviceId: integer,
    type: integer,
    counter: integer,
    path: integer,
    gatewayId: nullableInteger,
    gwUs: nullableInteger,
    rssi: nullableInteger,
    snrQ: nullableInteger,
    rate: nullableInteger,
    body: hexBytes,
    /** The counter of the gateway's forwarded packet that carried it; null for none (D110). */
    gwCounter: nullableInteger,
  })
  .readonly();

const txRow = z
  .object({
    ...stamped,
    deviceId: integer,
    type: integer,
    counter: integer,
    path: integer,
    gatewayId: nullableInteger,
    requestCounter: nullableInteger,
    rate: nullableInteger,
    power: nullableInteger,
    outcome: integer,
    gwSentUs: nullableInteger,
    body: hexBytes,
    /** The counter of the gateway's transmit result that reported it; null for none (D110). */
    resultCounter: nullableInteger,
  })
  .readonly();

const decisionRow = z
  .object({
    ...stamped,
    /** A `DecisionKind` of the core's model. */
    kind: z.string(),
    deviceId: nullableInteger,
    causeSeq: nullableInteger,
    value: z.number().nullable(),
    detail: hexBytes.nullable(),
  })
  .readonly();

const deviceLogRow = z
  .object({
    ...stamped,
    deviceId: integer,
    counter: integer,
    madeMs: integer,
    level: integer,
    code: integer,
    text: hexBytes,
    repeatOf: nullableInteger,
  })
  .readonly();

const hubEventRow = z
  .object({
    ...stamped,
    level: z.enum(["debug", "info", "warning", "critical"]),
    origin: z.string(),
    code: z.string(),
    message: z.string(),
    detail: z.string().nullable(),
  })
  .readonly();

const commandRow = z
  .object({
    ...stamped,
    actor: z.string(),
    kind: z.string(),
    args: z.string(),
    outcome: z.string(),
    detail: z.string().nullable(),
  })
  .readonly();

const rejectRow = z
  .object({
    minute: integer,
    via: z.string(),
    reason: z.string(),
    count: integer,
    address: nullableInteger,
    sample: hexBytes,
  })
  .readonly();

export const recordJson = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rx"), table: packetTable, row: rxRow }).readonly(),
  z.object({ kind: z.literal("tx"), table: packetTable, row: txRow }).readonly(),
  z.object({ kind: z.literal("decision"), row: decisionRow }).readonly(),
  z.object({ kind: z.literal("deviceLog"), row: deviceLogRow }).readonly(),
  z.object({ kind: z.literal("hubEvent"), row: hubEventRow }).readonly(),
  z.object({ kind: z.literal("command"), row: commandRow }).readonly(),
  z.object({ kind: z.literal("reject"), row: rejectRow }).readonly(),
]);

/** One audit record as JSON. */
export type RecordJson = z.infer<typeof recordJson>;
