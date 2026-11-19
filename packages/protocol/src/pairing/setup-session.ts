/**
 * Pairing's layers 2 and 3 over a Bluetooth link (docs/m3-design.md section 5): protocomm's
 * endpoints, the security 2 handshake with the board's code, then §10's setup messages inside the
 * session, behind the frozen `SetupSession` and `OpenSetupSession` of `app/src/platform/ble.ts`.
 * The link's and the session's types are written here to that file's shapes, so the app's
 * `GattLink` is a `PairingLink` and the opener is an `OpenSetupSession`; this package cannot import
 * the app.
 *
 * On the board (ESP-IDF v6.1.1's `protocomm_nimble.c`, read for this): one GATT service, one
 * characteristic per endpoint, each read and write with response; a write runs the endpoint's
 * handler and keeps its answer, which a read of the same characteristic then returns; a write the
 * handler refuses is answered with ATT error 0x04 and leaves the earlier answer there, so nothing
 * is read after a refused write. Values are at most 512 bytes either way (a long write or read
 * where the MTU is smaller; the phone's Bluetooth stack does both).
 *
 * The steps, each write followed by a read of the same characteristic:
 *
 *   1. `proto-ver`: write the label `hsn-pair/1` (the board answers its text whatever is written),
 *      read `PairVersion` as UTF-8 JSON; not ours, or not security 2, is `protocol`.
 *   2. `prov-session`: command 0, response 0, command 1. The board refusing command 1's write is
 *      a wrong code: the attempt stops there, nothing more is written or read.
 *   3. `prov-session`: response 1; the board's proof is checked before the key is used.
 *   4. `hsn-setup`: one sealed setup message a write, its sealed answer a read.
 *
 * Any failure closes the link and ends the session: the next attempt connects again. Each step
 * waits at most `stepTimeoutMs` on the caller's clock. Five wrong codes for one board stop it
 * (`PairingAttempts`), as the board stops listening; the time is the caller's.
 */
import { PAIR_PROTOCOL_LABEL, PAIRING_CODE, PAIRING_SECURITY, PROTOCOMM } from "./constants.ts";
import { parseJson } from "./safe/throwing.ts";
import { startSecurity2 } from "./security2.ts";
import {
  pairVersion,
  type PairingCodeText,
  type PairVersion,
  type Security2Session,
  type StartSecurity2,
} from "./types.ts";

/** `BleFault` of `app/src/platform/ble.ts`. */
export type LinkFault = "off" | "unauthorized" | "notFound" | "lost" | "timeout" | "failed";

/** `Outcome` of `app/src/platform/split.ts`. */
export type PairingOutcome<T, F> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly fault: F };

/** What pairing uses of `GattLink`. */
export interface PairingLink {
  write(
    characteristic: string,
    data: Uint8Array,
    response: boolean,
  ): Promise<PairingOutcome<void, LinkFault>>;
  read(characteristic: string): Promise<PairingOutcome<Uint8Array, LinkFault>>;
  onClosed(closed: (fault: LinkFault | null) => void): void;
  close(): void;
}

/** `PairFault`. */
export type SetupFault = LinkFault | "wrongCode" | "tooManyTries" | "protocol";

/** `SetupSession`, and what `proto-ver` said, read in the clear before the handshake. */
export interface PairingSetupSession {
  readonly version: PairVersion;
  exchange(message: Uint8Array): Promise<PairingOutcome<Uint8Array, SetupFault>>;
  close(): void;
}

/** The caller's time, in milliseconds. */
export interface PairingClock {
  now(): number;
  /** Resolves after `ms`. */
  sleep(ms: number): Promise<void>;
}

/** The setup session's own values. */
export const SETUP_SESSION = {
  /** One write or read waits this long at most †. */
  stepTimeoutMs: 10_000,
  /** The longest value protocomm_nimble.c takes or gives (`BLE_ATT_ATTR_MAX_LEN`). */
  maxValueBytes: 512,
  /** So the longest setup message, sealed with its 16-byte tag. */
  maxMessageBytes: 512 - PAIRING_SECURITY.tagBytes,
} as const;

/**
 * An endpoint's characteristic: the service's UUID with its 16-bit value in place of bytes 12 and
 * 13 of the little-endian array protocomm_nimble.c builds it from, which in the written form are
 * the 5th to 8th hex digits.
 */
export function pairingCharacteristic(uuid16: number): string {
  const digits = (uuid16 & 0xffff).toString(16).padStart(4, "0");
  return `${PROTOCOMM.serviceUuid.slice(0, 4)}${digits}${PROTOCOMM.serviceUuid.slice(8)}`;
}

const CHARACTERISTIC = {
  version: pairingCharacteristic(PROTOCOMM.endpoints.protoVersion.uuid16),
  session: pairingCharacteristic(PROTOCOMM.endpoints.session.uuid16),
  setup: pairingCharacteristic(PROTOCOMM.endpoints.setup.uuid16),
} as const;

// ----- Five wrong codes -----

/**
 * The wrong codes counted against one board, as the board counts them in its window (DS7: 2
 * minutes; 5 wrong codes close it). One per board the person is adding, kept across attempts.
 *
 * - The fifth wrong code within a window stops it: that attempt and every one after it are
 *   `tooManyTries`, without a write, until `reopened()` (the person pressed the board's button
 *   again) or a window's length has passed since the stop.
 * - A count whose first wrong code is a window's length old starts again: that window has ended.
 * - A right code clears the count.
 */
export interface PairingAttempts {
  readonly wrongCodes: number;
  stopped(now: number): boolean;
  /** Records a wrong code; true when it is the one that stops the board. */
  wrongCode(now: number): boolean;
  rightCode(): void;
  reopened(): void;
}

export function pairingAttempts(): PairingAttempts {
  let wrong = 0;
  let firstAt = 0;
  let stoppedAt: number | undefined;
  const clear = (): void => {
    wrong = 0;
    stoppedAt = undefined;
  };
  const stopped = (now: number): boolean => {
    if (stoppedAt !== undefined && now - stoppedAt >= PAIRING_CODE.windowMs) clear();
    return stoppedAt !== undefined;
  };
  return {
    get wrongCodes() {
      return wrong;
    },
    stopped,
    wrongCode(now) {
      if (stopped(now)) return false;
      if (wrong > 0 && now - firstAt >= PAIRING_CODE.windowMs) wrong = 0;
      if (wrong === 0) firstAt = now;
      wrong++;
      if (wrong >= PAIRING_CODE.maxTries) stoppedAt = now;
      return stoppedAt !== undefined;
    },
    rightCode: clear,
    reopened: clear,
  };
}

// ----- Opening a session -----

export interface SetupSessionOptions {
  readonly clock: PairingClock;
  /** The board's count; without it, wrong codes are not counted here. */
  readonly attempts?: PairingAttempts;
  readonly stepTimeoutMs?: number;
  /** The security 2 client; the default makes a random a. Tests give one with a fixed a. */
  readonly start?: StartSecurity2;
}

type Opened = PairingOutcome<PairingSetupSession, SetupFault>;

const fault = <T>(f: SetupFault): PairingOutcome<T, SetupFault> => ({ ok: false, fault: f });
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** An `OpenSetupSession`: reads `proto-ver`, runs security 2 with `code`, then serves setup messages. */
export function setupSessionOpener(
  options: SetupSessionOptions,
): (link: PairingLink, code: PairingCodeText) => Promise<Opened> {
  const { clock, attempts } = options;
  const timeoutMs = options.stepTimeoutMs ?? SETUP_SESSION.stepTimeoutMs;
  const start = options.start ?? startSecurity2;

  return async (link, code) => {
    let closed: LinkFault | undefined;
    link.onClosed((f) => {
      closed ??= f ?? "lost";
    });
    /** Read through a call: the link's callback changes `closed` between awaits. */
    const closedNow = (): LinkFault | undefined => closed;
    const shut = (): void => {
      closed ??= "lost";
      link.close();
    };
    const failWith = <T>(f: SetupFault): PairingOutcome<T, SetupFault> => {
      shut();
      return fault(f);
    };

    /** One link operation, at most `timeoutMs`; a link already closed is `lost`. */
    const step = async <T>(
      op: () => Promise<PairingOutcome<T, LinkFault>>,
    ): Promise<PairingOutcome<T, LinkFault>> => {
      if (closed !== undefined) return { ok: false, fault: closed };
      const timer = clock.sleep(timeoutMs).then(() => ({ ok: false, fault: "timeout" }) as const);
      const result = await Promise.race([op(), timer]);
      const after = closedNow();
      if (after !== undefined && result.ok) return { ok: false, fault: after };
      return result;
    };
    const ask = async (characteristic: string, request: Uint8Array) => {
      const written = await step(() => link.write(characteristic, request, true));
      if (!written.ok) return written;
      return step(() => link.read(characteristic));
    };

    if (attempts?.stopped(clock.now())) return failWith("tooManyTries");

    // 1. proto-ver, in the clear.
    const versionRead = await ask(CHARACTERISTIC.version, encoder.encode(PAIR_PROTOCOL_LABEL));
    if (!versionRead.ok) return failWith(versionRead.fault);
    const version = pairVersion.safeParse(parseJson(decoder.decode(versionRead.value)));
    if (!version.success) return failWith("protocol");

    // 2. and 3. security 2.
    const client = start(code);
    const command0 = await client.command0();
    if (!command0.ok) return failWith("protocol");
    const response0 = await ask(CHARACTERISTIC.session, command0.value);
    if (!response0.ok) return failWith(response0.fault);
    const command1 = await client.command1(response0.value);
    if (!command1.ok) return failWith("protocol");
    const written = await step(() => link.write(CHARACTERISTIC.session, command1.value, true));
    if (!written.ok) {
      // The board refuses the write when the proof is not the code's (security2.c,
      // esp_srp_exchange_proofs); a link that went away is not a wrong code.
      if (written.fault !== "failed") return failWith(written.fault);
      const stops = attempts?.wrongCode(clock.now()) ?? false;
      return failWith(stops ? "tooManyTries" : "wrongCode");
    }
    const response1 = await step(() => link.read(CHARACTERISTIC.session));
    if (!response1.ok) return failWith(response1.fault);
    const finished = await client.finish(response1.value);
    if (!finished.ok) {
      if (finished.error !== "wrongCode") return failWith("protocol");
      const stops = attempts?.wrongCode(clock.now()) ?? false;
      return failWith(stops ? "tooManyTries" : "wrongCode");
    }
    attempts?.rightCode();
    return { ok: true, value: setupSession(finished.value, version.data) };

    function setupSession(session: Security2Session, info: PairVersion): PairingSetupSession {
      let busy = false;
      let ended = false;
      return {
        version: info,
        async exchange(message) {
          if (busy) return fault("protocol");
          if (ended || closed !== undefined) return fault(closed ?? "lost");
          if (message.length === 0 || message.length > SETUP_SESSION.maxMessageBytes)
            return fault("protocol");
          busy = true;
          const result = await once(message);
          busy = false;
          if (!result.ok) ended = true;
          return result;
        },
        close() {
          ended = true;
          shut();
        },
      };

      async function once(message: Uint8Array): Promise<PairingOutcome<Uint8Array, SetupFault>> {
        const sealed = session.seal(message);
        if (!sealed.ok) return failWith("protocol");
        const answer = await ask(CHARACTERISTIC.setup, sealed.value);
        if (!answer.ok) return failWith(answer.fault);
        const opened = session.open(answer.value);
        if (!opened.ok) return failWith("protocol");
        return { ok: true, value: opened.value };
      }
    }
  };
}
