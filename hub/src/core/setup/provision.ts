/**
 * Provisioning's pieces (hub-design.md section 9, "Adding a device over USB"; protocol.md §9 and
 * §10): the address and key drawn from the input's entropy, the pairing data, and the frames, the
 * Provision message among them with a copy for the record whose secrets are zeroed.
 */
import {
  isValidAddress,
  KEY_LENGTH,
  type PairingData,
  Role,
  SetupType,
  SiteChannel,
  type SetupMessage,
} from "@hsn/protocol";
import { err, ok, type Result } from "neverthrow";
import { type CoreFault, coreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import { safeEncodeSetupMessage } from "../util/protocol-safe.ts";
import type { SitePairing } from "./state.ts";

const ORIGIN = "core/setup";

/** A device address is a 32-bit number (§3). */
export const ADDRESS_BYTES = 4;

/**
 * How many 4-byte addresses one step may draw before it gives up: 3, so an add takes at most
 * 3 × 4 + 16 = 28 of the input's 32 bytes, the most section 2 allows a step.
 */
export const MAX_ADDRESS_DRAWS = 3;

/**
 * The channel a gateway is paired with before the site has one (section 8: the survey's last
 * tie-break is 868.3 MHz). A gateway listens where its settings say (§6), so this only fills the
 * field; a sensor or siren is not paired before the site has a channel.
 */
export const GATEWAY_CHANNEL_BEFORE_SURVEY = SiteChannel.Mhz868_3;

/** Little-endian, as every number in the protocol (§3). */
function u32(bytes: Uint8Array): number {
  const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = bytes;
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

/**
 * Draws a device address (section 9): 4 bytes of the input's entropy, not 0, not 0xFFFFFFFF and
 * not in use; the next 4 bytes if so, up to `MAX_ADDRESS_DRAWS`. Running out is a `CoreFault`
 * (section 2).
 */
export function drawAddress(
  ctx: Context,
  free: (address: number) => boolean,
): Result<number, CoreFault> {
  for (let draw = 0; draw < MAX_ADDRESS_DRAWS; draw++) {
    const taken = ctx.entropy.take(ADDRESS_BYTES);
    if (taken.isErr()) return err(taken.error);
    const address = u32(taken.value);
    if (isValidAddress(address) && free(address)) return ok(address);
  }
  return err(
    coreFault(ctx.event, ORIGIN, "no free device address in the input's entropy", {
      draws: MAX_ADDRESS_DRAWS,
    }),
  );
}

/** A device key: 16 bytes of the input's entropy (PR5, HB17). */
export function drawKey(ctx: Context): Result<Uint8Array, CoreFault> {
  return ctx.entropy.take(KEY_LENGTH);
}

/** What stops the site's settings from pairing a device of this role. */
export type SiteProblem = "noChannel" | "noWifi";

export const SITE_PROBLEM_TEXT: Readonly<Record<SiteProblem, string>> = {
  noChannel:
    "the site has no channel yet: run `hsn site survey` with a gateway connected, or `hsn site set channel=…`",
  noWifi:
    "a siren needs the site's Wi-Fi details (PR2): set them with `hsn site wifi --name … --password …`",
};

/** The site's part of the pairing data for a device of `role` (§9, PR2, section 8). */
export function siteForPairing(
  site: SitePairing,
  role: number,
): Result<{ readonly channel: number; readonly site: SitePairing }, SiteProblem> {
  if (site.channel === null && role !== Role.Gateway) return err("noChannel");
  if (role === Role.Siren && site.wifiName.length === 0) return err("noWifi");
  return ok({ channel: site.channel ?? GATEWAY_CHANNEL_BEFORE_SURVEY, site });
}

/** The pairing data of §9. */
export function pairingData(
  address: number,
  key: Uint8Array,
  hub: { readonly signingPublic: Uint8Array; readonly identity: Uint8Array },
  channel: number,
  site: SitePairing,
): PairingData {
  return {
    address,
    key,
    hubIdentity: hub.identity,
    firmwareSigningKey: hub.signingPublic,
    siteChannel: channel,
    allowedDataRateMask: site.rateMask,
    wifiName: site.wifiName,
    wifiPassword: site.wifiPassword,
  };
}

/**
 * The pairing data as it may be recorded (section 9: "the Provision frame is recorded with the
 * key bytes zeroed"). SPEC-QUESTION: the Wi-Fi password is as secret as the key, so its bytes are
 * zeroed too; its length stays, as do the address, the hub's public key and the site settings.
 */
export function pairingForRecord(pairing: PairingData): PairingData {
  return {
    ...pairing,
    key: new Uint8Array(pairing.key.length),
    wifiPassword: new Uint8Array(pairing.wifiPassword.length),
  };
}

/** A setup message's bytes; an encoding error is the core's own fault. */
export function setupBytes(ctx: Context, message: SetupMessage): Result<Uint8Array, CoreFault> {
  return safeEncodeSetupMessage(message).mapErr((error) =>
    coreFault(ctx.event, ORIGIN, `setup message did not encode: ${error.message}`, {
      type: message.type,
    }),
  );
}

/** The Provision message (§10) carrying `pairing`. */
export function provisionMessage(pairing: PairingData): SetupMessage {
  return { type: SetupType.Provision, pairing };
}
