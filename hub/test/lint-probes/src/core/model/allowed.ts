// Lint probe: core/model may take types from state.ts and control-protocol.
// Expect: clean
export type { AlarmSlice } from "../alarm/state.ts";
export type { ControlCommand } from "../../control-protocol/index.ts";
export type { Result } from "neverthrow";
export type { Message } from "@hsn/protocol";
