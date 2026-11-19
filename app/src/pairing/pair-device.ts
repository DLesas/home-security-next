/** Pairing coordination over the shared GATT and hub interfaces. */
import { Role } from "@hsn/protocol/messages";
import {
  PAIRING_CODE,
  PAIR_PROTOCOL_LABEL,
  PROTOCOMM,
  type BoardQr,
  type PairVersion,
  type PairingCodeText,
  pairingAttempts,
  pairingCharacteristic,
  readPairAdvert,
  setupSessionOpener,
} from "@hsn/protocol/pairing";
import { APP_OPS_V2, type DeviceObjectV2, type GroupObject } from "@hsn/protocol/app";
import { toHex } from "../hub/digest";
import { fromBase64url } from "../hub/files";
import type { Advert, BleCentral, BleFault, GattLink, PairFault } from "../platform/ble";
import type { Outcome } from "../platform/split";
import { phoneRequest, refusal, type PhoneHub } from "./hub";
import { discover, isAborted, type RadioClock } from "./radio";
import { readVersion } from "./safe/version";

export interface Candidate {
  readonly advert: Advert;
  readonly version: PairVersion;
}

export const pairingRoles: readonly Role[] = [Role.Sensor, Role.Siren, Role.Gateway];

const versionCharacteristic = pairingCharacteristic(PROTOCOMM.endpoints.protoVersion.uuid16);
const identifyMessage = Uint8Array.of(0xf1, 0x01);
const versionRequest = new TextEncoder().encode(PAIR_PROTOCOL_LABEL);
const discoveryMs = 20_000;
const mtu = 517;

/** Reads the advertised board's full identity without using a pairing code. */
async function inspect(
  link: GattLink,
  clock: RadioClock,
): Promise<Outcome<PairVersion, PairFault>> {
  let cancel: (() => void) | undefined;
  const timeout = new Promise<Outcome<PairVersion, PairFault>>((resolve) => {
    cancel = clock.after(5000, () => {
      resolve({ ok: false, fault: "timeout" });
    });
  });
  /** Reads the GATT endpoint in protocomm's write-then-read order. */
  async function read(): Promise<Outcome<PairVersion, PairFault>> {
    const written = await link.write(versionCharacteristic, versionRequest, true);
    if (!written.ok) return written;
    const answer = await link.read(versionCharacteristic);
    if (!answer.ok) return answer;
    const version = readVersion(answer.value);
    return version === undefined ? { ok: false, fault: "protocol" } : { ok: true, value: version };
  }
  const result = await Promise.race([read(), timeout]);
  cancel?.();
  return result;
}

/** Finds compatible boards by service and verifies a QR's full chip id across name collisions. */
export async function findPairingBoards(
  central: BleCentral,
  clock: RadioClock,
  signal: AbortSignal,
  role?: Role,
  qr?: BoardQr,
): Promise<Outcome<readonly Candidate[], PairFault>> {
  const expected = qr === undefined ? undefined : toHex(qr.chipId);
  const seen = await discover(
    central,
    clock,
    PROTOCOMM.serviceUuid,
    (advert) => {
      const read = readPairAdvert(advert.name);
      return read !== undefined && (expected === undefined || expected.endsWith(read.chipSuffix));
    },
    discoveryMs,
    signal,
    600,
  );
  if (!seen.ok) return seen;
  const found: Candidate[] = [];
  let failure: PairFault = "notFound";
  for (const advert of seen.value) {
    if (isAborted(signal)) return { ok: false, fault: "lost" };
    const connected = await central.connect(advert.id, mtu);
    if (!connected.ok) {
      failure = connected.fault;
      continue;
    }
    const link = connected.value;
    /** Closes the probe when leaving the page. */
    const close = () => {
      link.close();
    };
    signal.addEventListener("abort", close, { once: true });
    const info = await inspect(link, clock);
    signal.removeEventListener("abort", close);
    link.close();
    if (!info.ok) {
      failure = info.fault;
      continue;
    }
    if (expected !== undefined && info.value.chip !== expected) continue;
    if (!pairingRoles.some((supported) => supported === info.value.role)) {
      failure = "protocol";
      continue;
    }
    if (role !== undefined && info.value.role !== role) continue;
    found.push({ advert, version: info.value });
  }
  return found.length ? { ok: true, value: found } : { ok: false, fault: failure };
}

type Session = Extract<
  Awaited<ReturnType<ReturnType<typeof setupSessionOpener>>>,
  { ok: true }
>["value"];

export interface OpenBoard {
  readonly version: PairVersion;
  readonly identity: Uint8Array;
  readonly session: Session;
  disconnected(): BleFault | null | undefined;
}

/** Keeps one attempt counter and one protocol opener for each full chip id. */
export function pairingFlow(central: BleCentral, clock: RadioClock) {
  const boards = new Map<
    string,
    { attempts: ReturnType<typeof pairingAttempts>; open: ReturnType<typeof setupSessionOpener> }
  >();
  /** Reuses the board's opener across retries, even if its advertising name collides. */
  function entry(chip: string) {
    const previous = boards.get(chip);
    if (previous !== undefined) return previous;
    const attempts = pairingAttempts();
    const open = setupSessionOpener({
      attempts,
      clock: {
        now: () => clock.now(),
        sleep: (ms) =>
          new Promise((resolve) => {
            clock.after(ms, resolve);
          }),
      },
    });
    const added = { attempts, open };
    boards.set(chip, added);
    return added;
  }

  return {
    /** Opens the encrypted session and gets the Identity that the hub checks. */
    async open(
      candidate: Candidate,
      code: PairingCodeText,
      signal: AbortSignal,
    ): Promise<Outcome<OpenBoard, PairFault>> {
      const { attempts, open } = entry(candidate.version.chip);
      if (attempts.stopped(clock.now())) return { ok: false, fault: "tooManyTries" };
      const connected = await central.connect(candidate.advert.id, mtu);
      if (!connected.ok) return connected;
      const link = connected.value;
      if (isAborted(signal)) {
        link.close();
        return { ok: false, fault: "lost" };
      }
      /** Discards the active Bluetooth connection if the person leaves. */
      const close = () => {
        link.close();
      };
      signal.addEventListener("abort", close, { once: true });
      let disconnected: BleFault | null | undefined;
      link.onClosed((reason) => {
        disconnected = reason;
        signal.removeEventListener("abort", close);
      });
      const session = await open(link, code);
      if (!session.ok) return session;
      if (session.value.version.chip !== candidate.version.chip) {
        session.value.close();
        return { ok: false, fault: "protocol" };
      }
      const identity = await session.value.exchange(identifyMessage);
      if (!identity.ok) return identity;
      const valid = APP_OPS_V2["pair.prepare"].body
        .unwrap()
        .shape.identity.safeParse(toHex(identity.value));
      // The wire Identity has the role followed by the six chip bytes.
      if (
        !valid.success ||
        identity.value[2] !== session.value.version.role ||
        toHex(identity.value.subarray(3, 9)) !== session.value.version.chip
      ) {
        session.value.close();
        return { ok: false, fault: "protocol" };
      }
      return {
        ok: true,
        value: {
          version: session.value.version,
          identity: identity.value,
          session: session.value,
          disconnected: () => disconnected,
        },
      };
    },
    /** Reports the attempts left for this specific window. */
    remaining: (chip: string) => PAIRING_CODE.maxTries - entry(chip).attempts.wrongCodes,
    /** Clears the counter only once the person sees the light after the five-second hold. */
    reopened: (chip: string) => {
      entry(chip).attempts.reopened();
    },
  };
}

type PairEnd =
  | { readonly kind: "added"; readonly device: DeviceObjectV2; readonly groupsFailed: boolean }
  | { readonly kind: "refused"; readonly reason: string };

/** Provisions the board with opaque hub bytes and records its exact result at the hub. */
export async function addBoard(
  hub: PhoneHub,
  board: OpenBoard,
  name: string,
  groups: readonly number[],
  signal: AbortSignal,
): Promise<PairEnd> {
  if (signal.aborted) {
    board.session.close();
    return { kind: "refused", reason: "interrupted" };
  }
  const reason = board.disconnected();
  if (reason !== undefined) {
    return {
      kind: "refused",
      reason: reason === "off" || reason === "unauthorized" ? reason : "vanished",
    };
  }
  const prepared = await phoneRequest(hub, "pair.prepare", {
    identity: toHex(board.identity),
    name,
  });
  if (!prepared.ok) {
    board.session.close();
    return { kind: "refused", reason: refusal(prepared) };
  }
  const provision = fromBase64url(prepared.value.provision);
  if (isAborted(signal) || provision === undefined) {
    provision?.fill(0);
    board.session.close();
    return { kind: "refused", reason: "unfinished" };
  }
  const answer = await board.session.exchange(provision);
  provision.fill(0);
  board.session.close();
  if (!answer.ok || isAborted(signal)) return { kind: "refused", reason: "unfinished" };
  const result = APP_OPS_V2["pair.finish"].body
    .unwrap()
    .shape.result.safeParse(toHex(answer.value));
  // The third result byte is zero for accepted, one for refused and two for not valid.
  const code = answer.value[2];
  if (!result.success || (code !== 0 && code !== 1 && code !== 2))
    return { kind: "refused", reason: "unfinished" };
  const finished = await phoneRequest(hub, "pair.finish", {
    device: prepared.value.device,
    result: result.data,
  });
  if (!finished.ok) return { kind: "refused", reason: "unfinished" };
  if (finished.value.device === null || code !== 0)
    return {
      kind: "refused",
      reason: board.version.role === Role.Sensor ? "boardRefused" : "boardWifi",
    };

  let groupsFailed = false;
  for (const id of groups) {
    if (isAborted(signal)) {
      groupsFailed = true;
      break;
    }
    const group = hub.client.live.getState().groups[id];
    if (group === undefined) {
      groupsFailed = true;
      continue;
    }
    const edit = includeDevice(group, finished.value.device);
    if (edit === undefined) continue;
    const saved = await hub.client.request("group.update", edit);
    if (!saved.ok) groupsFailed = true;
  }
  return { kind: "added", device: finished.value.device, groupsFailed };
}

/** Adds a sensor or siren to the group's existing membership or leaves an all-sirens group alone. */
function includeDevice(group: GroupObject, device: DeviceObjectV2) {
  const base = {
    group: group.id,
    name: group.name,
    sensors: group.sensors,
    sirens: group.sirens,
    ifRevision: group.revision,
  };
  if (device.role === "sensor" && !group.sensors.includes(device.id))
    return { ...base, sensors: [...group.sensors, device.id] };
  if (device.role === "siren" && group.sirens !== "all" && !group.sirens.includes(device.id))
    return { ...base, sirens: [...group.sirens, device.id] };
  return undefined;
}
