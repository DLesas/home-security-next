/**
 * The text frames of the hub link and the relay link (docs/m4-design.md section 3): one JSON object
 * with `t` per WebSocket text message, read with the frozen schemas of `frames.ts` for its link and
 * direction.
 *
 * Decoding refuses, in this order: a frame of more than 131,072 UTF-8 bytes (`tooLarge`), checked
 * before any JSON is parsed; text that is not JSON (`badJson`); JSON the direction's schema does
 * not accept (`badFrame`). Every refusal closes the link with 4400 (`RELAY_CLOSE.badFrame`).
 *
 * 131,072 bytes is the roster's bound (`RELAY_LIMITS.maxRosterBytes`), the largest text frame the
 * design names, and is the bound of every text frame: nothing a hub, a relay or the push service
 * sends is larger. A `push` frame on a relay link whose 32 items carry long tokens could pass it,
 * so `encodeTextFrame` refuses a frame over the bound as `tooLarge`, and the relay sends its items
 * in more frames. Encoding also refuses a frame its own schema does not accept (`badFrame`), so a
 * sender never sends what the other end must refuse. Nothing here throws.
 */
import type { z } from "zod";
import { RELAY_LIMITS } from "./constants.ts";
import {
  hubPushItem,
  hubToRelayFrame,
  pushToRelayFrame,
  type RelayPushItem,
  relayPushItem,
  relayToHubFrame,
  relayToPushFrame,
} from "./frames.ts";

/** A hub's push item: the outbox row's id, the phone's key id, the sealed content. */
export type HubPushItem = z.infer<typeof hubPushItem>;

/** The schema of each direction's text frames, by the names `relay-frames.json` uses. */
export const RELAY_TEXT_SCHEMAS = {
  /** A hub to its relay, on `/v1/hub`. */
  hubToRelay: hubToRelayFrame,
  /** A relay to a hub. */
  relayToHub: relayToHubFrame,
  /** A relay to the push service, on `/v1/relay`. */
  relayToPush: relayToPushFrame,
  /** The push service to a relay. */
  pushToRelay: pushToRelayFrame,
} as const;

export type RelayTextDirection = keyof typeof RELAY_TEXT_SCHEMAS;
export type RelayTextFrame<D extends RelayTextDirection> = z.infer<(typeof RELAY_TEXT_SCHEMAS)[D]>;

/** The largest text frame on any link, in UTF-8 bytes: the roster's bound. */
export const RELAY_TEXT_LIMITS = { maxTextBytes: RELAY_LIMITS.maxRosterBytes } as const;

/** Why a text frame was refused. Each closes the link with 4400. */
export type RelayTextError = "tooLarge" | "badJson" | "badFrame";

export type RelayTextResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RelayTextError };

const encoder = new TextEncoder();

/** A string's UTF-8 length, or more than `limit` as soon as it is known to pass it. */
function utf8Within(text: string, limit: number): boolean {
  // Every UTF-16 unit is at least one UTF-8 byte, so a longer string cannot fit.
  if (text.length > limit) return false;
  return encoder.encode(text).length <= limit;
}

function parseJson(text: string): { readonly json: unknown } | undefined {
  try {
    return { json: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/** Reads one text frame travelling in `direction`. */
export function decodeTextFrame<D extends RelayTextDirection>(
  direction: D,
  text: string,
): RelayTextResult<RelayTextFrame<D>> {
  if (!utf8Within(text, RELAY_TEXT_LIMITS.maxTextBytes)) return { ok: false, error: "tooLarge" };
  const parsed = parseJson(text);
  if (parsed === undefined) return { ok: false, error: "badJson" };
  const frame = RELAY_TEXT_SCHEMAS[direction].safeParse(parsed.json);
  return frame.success
    ? { ok: true, value: frame.data as RelayTextFrame<D> }
    : { ok: false, error: "badFrame" };
}

/** Writes one text frame to travel in `direction`, refusing what the other end would refuse. */
export function encodeTextFrame<D extends RelayTextDirection>(
  direction: D,
  frame: RelayTextFrame<D>,
): RelayTextResult<string> {
  if (!RELAY_TEXT_SCHEMAS[direction].safeParse(frame).success)
    return { ok: false, error: "badFrame" };
  const text = JSON.stringify(frame);
  return utf8Within(text, RELAY_TEXT_LIMITS.maxTextBytes)
    ? { ok: true, value: text }
    : { ok: false, error: "tooLarge" };
}

// ----- Splitting push items into frames that fit -----

/** One `push` frame made by `splitHubPushItems` or `splitRelayPushItems`: its text and its items. */
export interface PushFrame<T> {
  readonly text: string;
  readonly items: readonly T[];
}

/**
 * Smaller bounds than the protocol's, as a relay's `RelayWelcome.limits` may announce them
 * (`maxPushItemsPerFrame`; `maxRosterBytes`, the text bound). Larger ones are ignored: a frame
 * never passes 32 items or 131,072 bytes.
 */
export interface PushFrameLimits {
  readonly maxItems?: number;
  readonly maxBytes?: number;
}

/** Why items could not be split: the item at `index` is not one the schema accepts, or alone does not fit. */
export interface PushSplitError {
  readonly error: "badFrame" | "tooLarge";
  readonly index: number;
}

export type PushSplitResult<T> =
  | { readonly ok: true; readonly value: readonly PushFrame<T>[] }
  | { readonly ok: false; readonly error: PushSplitError };

const PUSH_HEAD = '{"t":"push","items":[';
const PUSH_TAIL = "]}";

function splitPushItems<T>(
  direction: "hubToRelay" | "relayToPush",
  itemSchema: z.ZodType<T>,
  items: readonly T[],
  limits: PushFrameLimits,
): PushSplitResult<T> {
  const bound = (given: number | undefined, most: number) =>
    given === undefined || !Number.isInteger(given) || given < 1 ? most : Math.min(given, most);
  const maxItems = bound(limits.maxItems, RELAY_LIMITS.maxPushItemsPerFrame);
  const maxBytes = bound(limits.maxBytes, RELAY_TEXT_LIMITS.maxTextBytes);
  const frames: PushFrame<T>[] = [];
  let group: T[] = [];
  let groupStart = 0;
  let bytes = 0;
  const close = (): PushSplitError | undefined => {
    if (group.length === 0) return undefined;
    const text = JSON.stringify({ t: "push", items: group });
    // The frame is exactly the counted bytes, and the other end reads it.
    if (encoder.encode(text).length > maxBytes || !decodeTextFrame(direction, text).ok)
      return { error: "badFrame", index: groupStart };
    frames.push({ text, items: group });
    group = [];
    return undefined;
  };
  for (const [index, item] of items.entries()) {
    if (!itemSchema.safeParse(item).success)
      return { ok: false, error: { error: "badFrame", index } };
    const itemBytes = encoder.encode(JSON.stringify(item)).length;
    if (PUSH_HEAD.length + itemBytes + PUSH_TAIL.length > maxBytes)
      return { ok: false, error: { error: "tooLarge", index } };
    if (group.length === maxItems || bytes + 1 + itemBytes > maxBytes) {
      const failed = close();
      if (failed !== undefined) return { ok: false, error: failed };
    }
    if (group.length === 0) {
      groupStart = index;
      bytes = PUSH_HEAD.length + PUSH_TAIL.length + itemBytes;
    } else {
      bytes += 1 + itemBytes;
    }
    group.push(item);
  }
  const failed = close();
  return failed === undefined ? { ok: true, value: frames } : { ok: false, error: failed };
}

/**
 * A hub's push items as the fewest `push` frames that fit, in order, each at most 32 items and
 * 131,072 bytes (or the smaller `limits`). An item the schema refuses, or one that alone would not
 * fit, refuses the whole list with its index; nothing is sent then.
 */
export function splitHubPushItems(
  items: readonly HubPushItem[],
  limits: PushFrameLimits = {},
): PushSplitResult<HubPushItem> {
  return splitPushItems("hubToRelay", hubPushItem, items, limits);
}

/** A relay's push items to the push service, split as `splitHubPushItems` splits a hub's. */
export function splitRelayPushItems(
  items: readonly RelayPushItem[],
  limits: PushFrameLimits = {},
): PushSplitResult<RelayPushItem> {
  return splitPushItems("relayToPush", relayPushItem, items, limits);
}
