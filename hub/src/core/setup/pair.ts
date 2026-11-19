/**
 * Adding a device from a phone over Bluetooth (docs/m3-design.md section 5, "Phone and hub: two
 * operations", D133; hub-design.md section 9, "Adding a device over USB"): the phone relays the
 * board's Identity in `pair.prepare` and its Provision result in `pair.finish`; the hub makes the
 * Provision message, by `hsn usb add`'s rules, with these differences:
 *
 * - **`pair.prepare`** writes the device row (provisioning), its key, its counters (1,024) and
 *   settings now, in the step that answers, so the commit comes before the reply leaves (HD 4).
 *   Its reply is `{device, provision}`, the Provision as base64url. Refusals (`PAIR_PREPARE_REFUSALS`):
 *   `badIdentity` (not an Identity of a role this hub knows), `pairedElsewhere` (a release build
 *   paired to another hub), `alreadyOurs` (paired to this hub and in use, or a retry whose key
 *   the hub can no longer send), `noWifi` (a siren or a gateway, and the site has no Wi-Fi
 *   details: over Bluetooth a gateway has no USB link to the hub), `busy {provisioning}` (the
 *   board is in a USB exchange that is waiting for its answer). A name is refused as `usb.add`'s
 *   is: `invalid {field: "name", reason: "taken" | "format"}`; a site with no channel yet is
 *   `invalid {field: "identity", reason: "noGateway"}`, since only a survey through a gateway
 *   chooses one (HD 8).
 * - **A retry**: a second `pair.prepare` for a chip whose row is provisioning gets the same
 *   address and key, as a USB retry does, after a restart too (`retryKeys` from the boot
 *   snapshot's `provisioningKeys`). A retry of the same request (`seq`) is `app`'s stored reply.
 * - **A device its owner reset** (state 3), or left behind by a forced move (state 5), keeps its
 *   row (`keptPlan`, shared with USB): number, name given again, permissions, history; a new key,
 *   new counters and new settings. A removed device (state 4) gets a new row.
 * - **`pair.finish`** with "accepted": paired, waiting for first contact; the reply is the device
 *   as version 2 has it. With "refused" or "not valid": the rows are deleted, or a kept row goes
 *   back to "reset by its owner" (the registry), and the reply's device is null; but a board that
 *   said it was paired to this hub may hold the key (PR2), so its rows stay provisioning and the
 *   reply is the device as it is.
 * - **Records**: as USB's, with the link named `bluetooth:<client>` (HD 6): `usb_sent` with the
 *   Provision's key and Wi-Fi password zeroed, then `provision_accepted` or `provision_refused`.
 *   The key leaves the core only in the Provision of the reply, which `people` keeps with the
 *   `seq` in `client_replies` (m3-design section 5); never in a record.
 */
import { decodeSetupMessage, ProvisionResultCode, Role, SetupType, toHex } from "@hsn/protocol";
import { type AppErrorV2, type AppOpV2, PAIR_PREPARE_REFUSALS } from "@hsn/protocol/app";
import { err, ok, type Result } from "neverthrow";
import { deviceObjectV2Of } from "../app/view.ts";
import type { Effect } from "../model/effects.ts";
import { type CoreFault, coreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import { type DeviceId, deviceId } from "../model/ids.ts";
import type { Actor, AnswerTo, Internal, OpOutcome } from "../model/messages.ts";
import { type DeviceRow, DeviceState } from "../model/rows.ts";
import {
  addressFree,
  deviceById,
  deviceFields,
  devicesByChip,
  hubEventRecord,
  hubSigning,
  newNameProblem,
  nextDeviceId,
  roleName,
} from "../registry/view.ts";
import { siteRow } from "../site/view.ts";
import { keptPlan, keyWrites } from "./kept.ts";
import {
  drawAddress,
  drawKey,
  pairingData,
  pairingForRecord,
  provisionMessage,
  setupBytes,
  siteForPairing,
} from "./provision.ts";
import type { Identity, PhonePairing, SetupSlice, SitePairing } from "./state.ts";
import { belonging } from "./view.ts";

const ORIGIN = "core/setup";

type Out = Internal | Effect;
type Request = Extract<Internal, { readonly kind: "v2OpRequest" }>;
type Prepare = Extract<AppOpV2, { readonly op: "pair.prepare" }>;
type Finish = Extract<AppOpV2, { readonly op: "pair.finish" }>;

/** What a pairing operation leaves: the slice and what it emits, its answer last. */
export interface Paired {
  readonly slice: SetupSlice;
  readonly out: readonly Out[];
}

const WORKING: ReadonlySet<DeviceState> = new Set([DeviceState.Paired, DeviceState.Contacted]);
const PROVISIONING: ReadonlySet<DeviceState> = new Set([DeviceState.Provisioning]);

function answer(answerTo: AnswerTo, outcome: OpOutcome): Internal {
  return { kind: "opAnswer", answerTo, outcome };
}

function refused(slice: SetupSlice, answerTo: AnswerTo, error: AppErrorV2): Paired {
  return { slice, out: [answer(answerTo, { ok: false, error })] };
}

function invalid(field: string, reason: "taken" | "format" | "noGateway" | "range"): AppErrorV2 {
  return { code: "invalid", detail: { field, reason } };
}

/** Lowercase hex as bytes; the body's schema has checked it is whole bytes of hex. */
export function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Bytes as base64url without padding (`pair.prepare`'s `provision`). */
export function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    const chars = [n >> 18, (n >> 12) & 63, (n >> 6) & 63, n & 63].map((k) => BASE64URL[k] ?? "");
    out += chars.slice(0, Math.min(4, bytes.length - i + 1)).join("");
  }
  return out;
}

/** The link label of a phone's provisioning (HD 6, `usb_sent`): `bluetooth:<client number>`. */
export function bluetoothLabel(actor: Actor): string {
  return actor.kind === "person" || actor.kind === "console"
    ? `bluetooth:${actor.client}`
    : `bluetooth:${actor.name}`;
}

function sitePairing(ctx: Context): SitePairing {
  const site = siteRow(ctx.view);
  return {
    channel: site.channel,
    rateMask: site.rateMask,
    wifiName: site.wifiName,
    wifiPassword: site.wifiPassword,
  };
}

/** A board in a USB exchange that waits for its answer, for this chip. */
function inUsbExchange(slice: SetupSlice, view: Context["view"], chip: Uint8Array): boolean {
  for (const board of slice.boards.values()) {
    const exchange = board.exchange;
    if (exchange?.deadline === undefined) continue;
    if (exchange.kind === "setRole" && board.identity !== undefined) {
      if (toHex(board.identity.chipId) === toHex(chip)) return true;
      continue;
    }
    if (exchange.kind === "provision") {
      const row = deviceById(view, exchange.device);
      if (row !== undefined && toHex(row.chipId) === toHex(chip)) return true;
    }
  }
  return false;
}

interface PrepareFields {
  readonly ctx: Context;
  readonly request: Request;
  readonly identity: Identity;
  readonly name: string;
}

/** `pair.prepare` (m3-design section 5). */
export function pairPrepare(
  slice: SetupSlice,
  ctx: Context,
  request: Request,
  op: Prepare,
): Result<Paired, CoreFault> {
  const answerTo = request.answerTo;
  const decoded = decodeSetupMessage(hexBytes(op.body.identity));
  if (!decoded.ok || decoded.value.type !== SetupType.Identity)
    return ok(refused(slice, answerTo, PAIR_PREPARE_REFUSALS.badIdentity));
  const identity = decoded.value;
  if (roleName(identity.role) === undefined)
    return ok(refused(slice, answerTo, PAIR_PREPARE_REFUSALS.badIdentity));
  const hub = hubSigning(ctx.view);
  if (hub === undefined) return ok(refused(slice, answerTo, { code: "unavailable", detail: {} }));
  const belongs = belonging(identity, hub.identity);
  if (belongs === "elsewhere" && !identity.developmentBuild)
    return ok(refused(slice, answerTo, PAIR_PREPARE_REFUSALS.pairedElsewhere));
  if (inUsbExchange(slice, ctx.view, identity.chipId))
    return ok(refused(slice, answerTo, PAIR_PREPARE_REFUSALS.provisioning));
  const fields: PrepareFields = { ctx, request, identity, name: op.body.name };
  const pending = devicesByChip(ctx.view, identity.chipId, PROVISIONING)[0];
  if (pending !== undefined) return retry(slice, fields, pending, belongs === "ours");
  if (belongs === "ours" && devicesByChip(ctx.view, identity.chipId, WORKING).length > 0)
    return ok(refused(slice, answerTo, PAIR_PREPARE_REFUSALS.alreadyOurs));
  const kept = keptRow(ctx, identity);
  const problem = newNameProblem(ctx.view, op.body.name, kept?.id);
  if (problem === "taken") return ok(refused(slice, answerTo, invalid("name", "taken")));
  if (problem !== undefined) return ok(refused(slice, answerTo, invalid("name", "format")));
  const site = siteFor(ctx, identity.role);
  if (site !== undefined) return ok(refused(slice, answerTo, site));
  if (kept !== undefined) {
    return keptPlan(ctx, kept, identity.role, op.body.name).andThen((plan) =>
      provide(slice, fields, { ...plan, mayHoldKey: belongs === "ours" }),
    );
  }
  const device = nextDeviceId(ctx.view);
  return drawAddress(ctx, (address) => addressFree(ctx.view, address)).andThen((address) =>
    drawKey(ctx).andThen((key) =>
      provide(slice, fields, {
        device,
        address,
        key,
        mayHoldKey: false,
        before: [
          {
            kind: "deviceAdded",
            device,
            role: identity.role,
            address,
            name: op.body.name,
          } satisfies Internal,
          ...keyWrites(device, key),
        ],
      }),
    ),
  );
}

/** A row this chip keeps when it is added again (state 3 or 5), of the same role. */
export function keptRow(ctx: Context, identity: Identity): DeviceRow | undefined {
  return devicesByChip(
    ctx.view,
    identity.chipId,
    new Set([DeviceState.ResetByOwner, DeviceState.LeftBehind]),
  ).find((row) => row.role === identity.role);
}

/** Why the site cannot pair this role over Bluetooth, or undefined. */
function siteFor(ctx: Context, role: number): AppErrorV2 | undefined {
  const site = sitePairing(ctx);
  // Over Bluetooth a gateway has no USB link to the hub: it needs the Wi-Fi too (PR2).
  if (role === Role.Gateway && site.wifiName.length === 0) return PAIR_PREPARE_REFUSALS.noWifi;
  const checked = siteForPairing(site, role);
  if (checked.isOk()) return undefined;
  return checked.error === "noWifi"
    ? PAIR_PREPARE_REFUSALS.noWifi
    : invalid("identity", "noGateway");
}

function retry(
  slice: SetupSlice,
  fields: PrepareFields,
  pending: DeviceRow,
  ours: boolean,
): Result<Paired, CoreFault> {
  const { ctx, request, identity, name } = fields;
  const answerTo = request.answerTo;
  if (pending.role !== identity.role)
    return ok(refused(slice, answerTo, PAIR_PREPARE_REFUSALS.badIdentity));
  if (pending.name !== name) return ok(refused(slice, answerTo, invalid("name", "taken")));
  const site = siteFor(ctx, identity.role);
  if (site !== undefined) return ok(refused(slice, answerTo, site));
  const key = slice.retryKeys.get(pending.id);
  if (key !== undefined) {
    return provide(slice, fields, {
      device: pending.id,
      address: pending.address,
      key,
      mayHoldKey: ours,
      before: [],
    });
  }
  // The board may hold a key the hub can no longer send again (section 9): it is ours.
  if (ours) return ok(refused(slice, answerTo, PAIR_PREPARE_REFUSALS.alreadyOurs));
  return drawKey(ctx).andThen((fresh) =>
    provide(slice, fields, {
      device: pending.id,
      address: pending.address,
      key: fresh,
      mayHoldKey: false,
      before: keyWrites(pending.id, fresh),
    }),
  );
}

interface Plan {
  readonly device: DeviceId;
  readonly address: number;
  readonly key: Uint8Array;
  readonly mayHoldKey: boolean;
  readonly before: readonly Out[];
}

function provide(slice: SetupSlice, fields: PrepareFields, plan: Plan): Result<Paired, CoreFault> {
  const { ctx, request, identity } = fields;
  const hub = hubSigning(ctx.view);
  const site = siteForPairing(sitePairing(ctx), identity.role);
  if (hub === undefined || site.isErr())
    return ok(refused(slice, request.answerTo, { code: "unavailable", detail: {} }));
  const pairing = pairingData(plan.address, plan.key, hub, site.value.channel, site.value.site);
  const label = bluetoothLabel(request.actor);
  return setupBytes(ctx, provisionMessage(pairing)).andThen((bytes) =>
    setupBytes(ctx, provisionMessage(pairingForRecord(pairing))).andThen((shown) =>
      hubEventRecord(ctx, {
        level: "info",
        origin: ORIGIN,
        code: "usb_sent",
        message: `Provision to ${label}`,
        detail: JSON.stringify({
          link: label,
          message: "Provision",
          bytes: toHex(shown),
          address: plan.address,
        }),
      }).map((record) => {
        const retryKeys = new Map(slice.retryKeys).set(plan.device, plan.key);
        const pairings = new Map(slice.pairings).set(plan.device, {
          device: plan.device,
          identity,
          label,
          mayHoldKey: plan.mayHoldKey,
        } satisfies PhonePairing);
        return {
          slice: { ...slice, retryKeys, pairings },
          out: [
            ...plan.before,
            record,
            answer(request.answerTo, {
              ok: true,
              body: { device: plan.device, provision: base64url(bytes) },
            }),
          ],
        };
      }),
    ),
  );
}

function resultName(result: number): string {
  return result === ProvisionResultCode.Accepted
    ? "accepted"
    : result === ProvisionResultCode.Refused
      ? "refused"
      : result === ProvisionResultCode.NotValid
        ? "notValid"
        : `unknown:${result}`;
}

/** `pair.finish` (m3-design section 5). */
export function pairFinish(
  slice: SetupSlice,
  ctx: Context,
  request: Request,
  op: Finish,
): Result<Paired, CoreFault> {
  const answerTo = request.answerTo;
  const decoded = decodeSetupMessage(hexBytes(op.body.result));
  if (!decoded.ok || decoded.value.type !== SetupType.ProvisionResult)
    return ok(refused(slice, answerTo, invalid("result", "format")));
  const result = decoded.value.result;
  const row = deviceById(ctx.view, deviceId(op.body.device));
  const notFound: AppErrorV2 = { code: "notFound", detail: { what: "device", id: op.body.device } };
  if (row === undefined || row.role === 0) return ok(refused(slice, answerTo, notFound));
  const object = (shown: DeviceRow) => deviceObjectV2Of(ctx.view, ctx.deps, shown) ?? null;
  if (row.state !== DeviceState.Provisioning) {
    // A finish sent again after its device was paired (a new `seq`): the device as it is.
    return ok(
      result === ProvisionResultCode.Accepted && WORKING.has(row.state)
        ? { slice, out: [answer(answerTo, { ok: true, body: { device: object(row) } })] }
        : refused(slice, answerTo, notFound),
    );
  }
  const pairing = slice.pairings.get(row.id);
  const label = pairing?.label ?? bluetoothLabel(request.actor);
  const known = result === ProvisionResultCode.Refused || result === ProvisionResultCode.NotValid;
  if (result !== ProvisionResultCode.Accepted && !known)
    return ok(refused(slice, answerTo, invalid("result", "range")));
  const retryKeys = new Map(slice.retryKeys);
  const pairings = new Map(slice.pairings);
  pairings.delete(row.id);
  const fields = JSON.stringify({ link: label, result: resultName(result), ...deviceFields(row) });
  if (result !== ProvisionResultCode.Accepted && pairing?.mayHoldKey === true) {
    // The board may hold the key (PR2): the rows stay provisioning.
    return hubEventRecord(ctx, {
      level: "warning",
      origin: ORIGIN,
      code: "provision_unsettled",
      message: `${row.name} on ${label}: the board ${resultName(result)}, but it said it is paired to this hub and may hold ${row.name}'s key, so it stays provisioning`,
      detail: fields,
    }).map((record) => ({
      slice: { ...slice, pairings },
      out: [record, answer(answerTo, { ok: true, body: { device: object(row) } })],
    }));
  }
  retryKeys.delete(row.id);
  const accepted = result === ProvisionResultCode.Accepted;
  return hubEventRecord(ctx, {
    level: accepted ? "info" : "warning",
    origin: ORIGIN,
    code: accepted ? "provision_accepted" : "provision_refused",
    message: accepted
      ? `${row.name} accepted its pairing on ${label} and restarts`
      : `${row.name} on ${label}: the board ${resultName(result)}; its rows are deleted or it is reset again`,
    detail: fields,
    durability: "now",
  }).map((record) => ({
    slice: { ...slice, retryKeys, pairings },
    out: [
      { kind: "provisionAnswered", device: row.id, result },
      record,
      answer(answerTo, {
        ok: true,
        body: {
          device: accepted ? object({ ...row, state: DeviceState.Paired, removedMs: null }) : null,
        },
      }),
    ],
  }));
}

/** A `v2OpRequest` for `setup`: `pair.prepare` or `pair.finish`. */
export function onPairRequest(
  slice: SetupSlice,
  ctx: Context,
  request: Request,
): Result<Paired, CoreFault> {
  const op = request.op;
  if (op.op === "pair.prepare") return pairPrepare(slice, ctx, request, op);
  if (op.op === "pair.finish") return pairFinish(slice, ctx, request, op);
  return err(
    coreFault(ctx.event, ORIGIN, "setup was given an operation it does not own", { op: op.op }),
  );
}
