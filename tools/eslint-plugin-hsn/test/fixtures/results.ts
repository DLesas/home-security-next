// Declarations the rule tester's cases import: neverthrow's real types and the protocol's.
import { err, ok, okAsync, type Result, type ResultAsync } from "neverthrow";
import {
  decodeReplayWindow,
  type Result as ProtocolResult,
  type ReplayWindow,
} from "@hsn/protocol";

export function save(value: number): Result<number, string> {
  return value > 0 ? ok(value) : err("not positive");
}
export function saveLater(value: number): ResultAsync<number, string> {
  return okAsync(value);
}
export async function saveAsync(value: number): Promise<Result<number, string>> {
  return Promise.resolve(save(value));
}
export function maybeSave(value: number): Result<number, string> | undefined {
  return value === 0 ? undefined : save(value);
}
export function decode(bytes: Uint8Array): ProtocolResult<ReplayWindow> {
  return decodeReplayWindow(bytes);
}
export const store = { save, nested: { save } };
export const optionalStore: { save?: (value: number) => Result<number, string> } = {};
export function log(value: number): number {
  return value;
}
