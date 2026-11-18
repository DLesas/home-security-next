/**
 * Telling a device what the hub decided (docs/m3-updates-design.md sections 4 and 5): the Update
 * offer (0x83) firmware hands the module that owns the device's key (`updateOffer`; HD 2: firmware
 * decides, the owner seals), the grant that lets the shell serve the image on the link, and the
 * transition the offer makes: planned to offered with its method, verified to installing with the
 * go-ahead, which is committed before it is sent (a "now" row in the same step).
 */
import { MessageType, Role, UpdateAction } from "@hsn/protocol";
import type { Effect } from "../model/effects.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId, LinkId, Seq } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import type { HubRules } from "../model/rules.ts";
import {
  DeviceUpdateState,
  type FirmwareImageRow,
  UpdateHeld,
  UpdateMethod,
} from "../model/rows.ts";
import { monoAfterMs } from "../model/time.ts";
import { IMAGE_HEADER_BYTES, versionOf } from "./codes.ts";
import { type Decision, openRollout, sessionOf, workingRole } from "./decide.ts";
import { change, putEntry, setHeld, transition } from "./entries.ts";
import type { Steps } from "./out.ts";
import type { DeviceEntry, FirmwareSlice, Told } from "./state.ts";

/** The 8 zero bytes an offer carries where it names no image or no nonce. */
const ZEROS_8 = new Uint8Array(8);

/** The action an offer of this decision carries. */
export function actionOf(decision: Decision): UpdateAction {
  switch (decision.kind) {
    case "nothing":
      return UpdateAction.Nothing;
    case "wait":
      return UpdateAction.KeepAndWait;
    case "install":
      return UpdateAction.InstallNow;
    case "fetch":
      switch (decision.via) {
        case "link":
          return UpdateAction.Fetch;
        case "forced":
          return UpdateAction.ForcedFetch;
        case "wifi":
          return UpdateAction.JoinWifiAndFetch;
        case "bluetooth":
          return UpdateAction.OpenBluetooth;
      }
  }
}

/**
 * Fetch on a link and join Wi-Fi to fetch ask the same of a device that is already fetching. A
 * forced fetch (6) is its own: a gateway told 1 is told 6 once it is forced.
 */
function fetchClass(action: UpdateAction): boolean {
  return action === UpdateAction.Fetch || action === UpdateAction.JoinWifiAndFetch;
}

/**
 * Whether the device has already been told this: the same action (a fetch on any link counting as
 * one), and for Bluetooth the same session's nonce.
 */
export function alreadyTold(
  told: Told | undefined,
  action: UpdateAction,
  nonce: Uint8Array | undefined,
): boolean {
  if (told === undefined) return false;
  if (fetchClass(action) && fetchClass(told.action)) return true;
  if (action !== told.action) return false;
  if (action !== UpdateAction.OpenBluetooth) return true;
  return (
    nonce !== undefined &&
    told.nonce?.length === nonce.length &&
    told.nonce.every((b, i) => b === nonce[i])
  );
}

/** The rollout's image, for the entry's offer; undefined when it names none. */
export function imageOfEntry(
  slice: FirmwareSlice,
  entry: DeviceEntry,
): FirmwareImageRow | undefined {
  if (entry.row.rolloutId === null) return undefined;
  const rollout = slice.rollouts.get(entry.row.rolloutId);
  return rollout === undefined ? undefined : slice.images.get(rollout.row.image);
}

/** The Update offer's body (§6, m3-updates section 5). */
export function offerBody(
  action: UpdateAction,
  image: FirmwareImageRow | undefined,
  nonce: Uint8Array | undefined,
  windowTens: number,
): Extract<Internal, { readonly kind: "updateOffer" }>["offer"] {
  return {
    type: MessageType.UpdateOffer,
    action,
    imageId: image?.imageId ?? ZEROS_8,
    fileBytes: image === undefined ? 0 : image.bytes + IMAGE_HEADER_BYTES,
    version: versionOf(image?.version ?? 0),
    bluetoothNonce: action === UpdateAction.OpenBluetooth && nonce !== undefined ? nonce : ZEROS_8,
    bluetoothWindowUnits: action === UpdateAction.OpenBluetooth ? windowTens : 0,
  };
}

/** A grant on `link` for the entry's image; while grants are suspended it is kept and not sent. */
export function grant(steps: Steps, device: DeviceId, link: LinkId, image: FirmwareImageRow): void {
  const grants = new Map(steps.slice.grants);
  const before = grants.get(link);
  grants.set(link, { device, image: image.id });
  steps.set({ ...steps.slice, grants });
  if (steps.slice.suspended || (before?.device === device && before.image === image.id)) return;
  steps.push(grantEffect(link, image));
}

export function grantEffect(link: LinkId, image: FirmwareImageRow): Effect {
  return {
    kind: "transferGrant",
    link,
    image: image.id,
    imageId: image.imageId,
    header: image.header,
    file: image.file,
  };
}

/** Takes back every grant the device holds. */
export function revokeDevice(
  steps: Steps,
  device: DeviceId,
  reason: "paused" | "notGranted" = "notGranted",
): void {
  const grants = new Map(steps.slice.grants);
  for (const [link, held] of steps.slice.grants) {
    if (held.device !== device) continue;
    grants.delete(link);
    if (!steps.slice.suspended) steps.push({ kind: "transferRevoke", link, reason });
  }
  if (grants.size !== steps.slice.grants.size) steps.set({ ...steps.slice, grants });
}

/** The method a fetch of this kind is recorded with. */
function methodOf(decision: Extract<Decision, { kind: "fetch" }>, role: number): UpdateMethod {
  if (decision.via === "bluetooth") return UpdateMethod.Bluetooth;
  return role === Role.Sensor ? UpdateMethod.JoinWifi : UpdateMethod.OwnLink;
}

/**
 * Applies a decision for the device: the transition it makes, the hold it shows, and, when
 * `send` says so, the offer itself (bound to `answers` for a sensor). Returns the offer sent, if any.
 */
export function deliver(
  steps: Steps,
  ctx: Context,
  device: DeviceId,
  decision: Decision,
  answers: { readonly counter: number; readonly record: Seq } | undefined,
  send: boolean,
): void {
  const entry = steps.slice.updates.get(device);
  const role = workingRole(ctx.view, device);
  const action = actionOf(decision);
  const image = entry === undefined ? currentImage(steps.slice) : imageOfEntry(steps.slice, entry);
  const nonce = entry === undefined ? undefined : sessionOf(entry, ctx.now);

  if (entry !== undefined && role !== undefined && image !== undefined) {
    applyDecision(steps, ctx, entry, decision, role, image, answers?.record);
  }
  if (!send) return;
  const after = steps.slice.updates.get(device);
  steps.push({
    kind: "updateOffer",
    device,
    offer: offerBody(action, image, nonce, ctx.deps.rules.firmware.bluetoothWindowTens),
    answers,
  });
  if (after !== undefined) {
    const link =
      decision.kind === "fetch" && (decision.via === "link" || decision.via === "forced")
        ? decision.link
        : undefined;
    putEntry(steps, {
      ...after,
      told: { action, link, nonce: action === UpdateAction.OpenBluetooth ? nonce : undefined },
      discard: action === UpdateAction.Nothing ? false : after.discard,
    });
  }
}

/** The open rollout's image: what a device with no entry is told about, if anything. */
function currentImage(slice: FirmwareSlice): FirmwareImageRow | undefined {
  const rollout = openRollout(slice);
  return rollout === undefined ? undefined : slice.images.get(rollout.row.image);
}

function applyDecision(
  steps: Steps,
  ctx: Context,
  entry: DeviceEntry,
  decision: Decision,
  role: number,
  image: FirmwareImageRow,
  cause: Seq | undefined,
): void {
  const device = entry.row.deviceId;
  switch (decision.kind) {
    case "wait":
      if (decision.held !== undefined) setHeld(steps, ctx, device, decision.held);
      return;
    case "nothing":
      return;
    case "fetch": {
      if (entry.deviceHeld !== undefined) putEntry(steps, { ...entry, deviceHeld: undefined });
      if (decision.via === "link" || decision.via === "forced") {
        grant(steps, device, decision.link, image);
      }
      const method = methodOf(decision, role);
      if (entry.row.state === DeviceUpdateState.Planned) {
        transition(
          steps,
          ctx,
          device,
          DeviceUpdateState.Offered,
          { method, held: UpdateHeld.No },
          {
            kind: "firmware_device_offered",
            value: method,
            ...(cause === undefined ? {} : { cause }),
          },
        );
      } else if (decision.via === "bluetooth" && entry.row.method !== method) {
        change(steps, ctx, device, { method, held: UpdateHeld.No });
      } else {
        setHeld(steps, ctx, device, UpdateHeld.No);
      }
      return;
    }
    case "install": {
      if (entry.row.state !== DeviceUpdateState.Verified) return;
      setHeld(steps, ctx, device, UpdateHeld.No);
      transition(
        steps,
        ctx,
        device,
        DeviceUpdateState.Installing,
        {},
        {
          kind: "firmware_installing",
          value: image.version,
          ...(cause === undefined ? {} : { cause }),
        },
      );
      steps.timer(
        { module: "firmware", kind: "trialWatch", device },
        monoAfterMs(ctx.now.mono, trialWatchMs(ctx.deps.rules, role)),
      );
      return;
    }
  }
}

/** How long after the go-ahead a device has to come back confirmed: its trial deadline and the grace. */
export function trialWatchMs(rules: HubRules, role: number): number {
  const deadlines = rules.firmware.trialDeadlineMs;
  const deadline =
    role === Role.Sensor
      ? deadlines.sensor
      : role === Role.Siren
        ? deadlines.siren
        : deadlines.gateway;
  return deadline + rules.firmware.noContactGraceMs;
}
