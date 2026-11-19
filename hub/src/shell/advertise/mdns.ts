/**
 * The hub's mDNS advertisement (protocol.md §10, "Finding the hub"; hub-design.md section 3,
 * `Advertiser`): `_hsn-hub._tcp` on the app port, with the hub identity in its TXT record, so a
 * device connects only to the hub it was paired with. Built on `bonjour-service`, the pinned
 * mDNS library (section 12).
 *
 * The TXT keys (§10, "Finding the hub"; m3-design section 2): `id`, the hub identity of §9 as 16
 * lowercase hex digits, for devices; and, for apps, `app`, the apps' listener's port in decimal
 * (the `app=8444` field m2-design section 5 promised), and `aid`, the app identity, 26
 * characters of base32 (m2-design section 5). Apps use `app` and `aid` only to choose where to
 * try: the channel's handshake proves the hub. They are given once the apps' listener is open;
 * before it, or without it, the record carries `id` alone. The instance is named
 * `hsn-<identity>`, unique per hub.
 *
 * Every call into the library goes through `shell/safe/mdns.ts` (section 10).
 */
import { toHex } from "@hsn/protocol";
import { formatIdentity } from "@hsn/protocol/app";
import { Bonjour } from "bonjour-service";
import { err, ok, type Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import type { Advertiser } from "../../ports/advertiser.ts";
import { mdnsCall } from "../safe/mdns.ts";

const ORIGIN = "shell/advertise/mdns";

/** `_hsn-hub._tcp` (§10). */
export const SERVICE_TYPE = "hsn-hub";
export const SERVICE_PROTOCOL = "tcp";
/** The TXT key that carries the hub identity. */
export const IDENTITY_TXT_KEY = "id";
/** The TXT key that carries the apps' port, decimal (m3-design section 2). */
export const APPS_PORT_TXT_KEY = "app";
/** The TXT key that carries the app identity, 26 characters of base32 (m2-design section 5). */
export const APP_IDENTITY_TXT_KEY = "aid";

/** What apps are told: the apps' listener's port and the app identity (16 bytes). */
export interface AppsRecord {
  readonly port: number;
  readonly identity: Uint8Array;
}

/** The TXT record: `id`, then `app` and `aid` when the apps' listener is known. */
export function txtRecord(
  identity: Uint8Array,
  apps: AppsRecord | undefined,
): Readonly<Record<string, string>> {
  return apps === undefined
    ? { [IDENTITY_TXT_KEY]: toHex(identity) }
    : {
        [IDENTITY_TXT_KEY]: toHex(identity),
        [APPS_PORT_TXT_KEY]: String(apps.port),
        [APP_IDENTITY_TXT_KEY]: formatIdentity(apps.identity),
      };
}

/** What of `bonjour-service` the advertiser uses, so a test can stand in for the network. */
export interface MdnsLibrary {
  publish(options: {
    readonly name: string;
    readonly type: string;
    readonly protocol: "tcp";
    readonly port: number;
    readonly txt: Readonly<Record<string, string>>;
  }): { stop?: CallableFunction };
  unpublishAll(callback?: CallableFunction): void;
  destroy(callback?: CallableFunction): void;
}

function mdnsError(message: string): HubError {
  return { kind: "link", origin: ORIGIN, message };
}

/** The real library; its errors after start are passed to `onError` to be recorded. */
export function bonjourLibrary(onError: (error: HubError) => void): MdnsLibrary {
  return new Bonjour({}, (error: unknown) => {
    onError(mdnsError(error instanceof Error ? error.message : "mDNS failed"));
  });
}

/** The instance name: `hsn-<identity>`. */
export function instanceName(identity: Uint8Array): string {
  return `hsn-${toHex(identity)}`;
}

export class MdnsAdvertiser implements Advertiser {
  readonly #servedPort: number;
  readonly #library: () => Result<MdnsLibrary, HubError>;
  readonly #apps: () => AppsRecord | undefined;
  #open: MdnsLibrary | undefined;

  /**
   * `servedPort` is the app port the shell serves `/device` on (§10); the core's `advertise`
   * effect names port 0 for it, since the core is never told the port (core/registry). `apps`
   * gives the apps' listener's port and the app identity, once the listener is open.
   */
  constructor(
    servedPort: number,
    library: () => MdnsLibrary,
    apps: () => AppsRecord | undefined = () => undefined,
  ) {
    this.#servedPort = servedPort;
    this.#library = () => mdnsCall(ORIGIN, "mDNS could not start", library);
    this.#apps = apps;
  }

  advertise(identity: Uint8Array, port: number): Result<void, HubError> {
    const stopped = this.stop();
    if (stopped.isErr()) return err(stopped.error);
    const opened = this.#library();
    if (opened.isErr()) return err(opened.error);
    const library = opened.value;
    const published = mdnsCall(ORIGIN, "the advertisement could not be published", () =>
      library.publish({
        name: instanceName(identity),
        type: SERVICE_TYPE,
        protocol: SERVICE_PROTOCOL,
        port: port === 0 ? this.#servedPort : port,
        txt: txtRecord(identity, this.#apps()),
      }),
    );
    return published.map(() => {
      this.#open = library;
    });
  }

  stop(): Result<void, HubError> {
    const library = this.#open;
    if (library === undefined) return ok(undefined);
    this.#open = undefined;
    return mdnsCall(ORIGIN, "the advertisement could not be stopped", () => {
      library.unpublishAll();
      library.destroy();
    });
  }
}
