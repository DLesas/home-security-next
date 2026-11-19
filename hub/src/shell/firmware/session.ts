/**
 * `firmware.bluetooth`'s reply (docs/m3-updates-design.md section 5, "The session key", D138):
 * the core has committed the session's nonce and gives the shell everything of the reply but the
 * key; the shell derives the session key here and sends the reply itself, on the connection that
 * asked, as it sends a history page.
 *
 *   K = HKDF-SHA256(the device's 16-byte key, salt = the nonce, info = "hsn-ble-update/1", a zero
 *       byte, the device address u32), 32 bytes (`@hsn/protocol/update`'s `bluetoothSessionKey`)
 *
 * The device key comes from the `KeyStore` and goes nowhere but into that derivation: never into
 * the reply, a record, an event, an error or the core. K itself is put only in the reply, inside
 * the app's encrypted channel (or the control socket's, for the bench, which the hub's account
 * alone can open), and is never stored, logged or recorded. A device whose key the hub no longer
 * holds (removed meanwhile) is answered `unavailable`.
 */
import type { AppReply, BluetoothSessionObject } from "@hsn/protocol/app";
import { bluetoothSessionKey } from "@hsn/protocol/update";
import { err, ok, type Result } from "neverthrow";
import type { ControlReply } from "../../core/model/control.ts";
import type { Effect } from "../../core/model/effects.ts";
import type { ConnId, RequestId } from "../../core/model/ids.ts";
import type { KeyStore } from "../../ports/key-store.ts";

export type BluetoothSessionEffect = Extract<Effect, { readonly kind: "bluetoothSession" }>;

/** Where the reply goes: a session's queue, or the control socket. */
export interface SessionReplies {
  /** An app reply `{t: "res", id, ...}` on a session (the app channel encrypts it). */
  app(conn: ConnId, message: AppReply): void;
  control(request: RequestId, reply: ControlReply): void;
}

/** The reply's body, its session key derived from the device's key. */
export function sessionBody(
  effect: BluetoothSessionEffect,
  keys: Pick<KeyStore, "key">,
): Result<BluetoothSessionObject, string> {
  const deviceKey = keys.key(effect.device);
  if (deviceKey === undefined) return err(`the hub holds no key for device ${effect.device}`);
  const key = bluetoothSessionKey(deviceKey, effect.nonce, effect.address);
  if (!key.ok) return err(`the session key could not be derived (${key.error.code})`);
  return ok({ ...effect.reply, sessionKey: Buffer.from(key.value).toString("base64url") });
}

/** Derives the key and sends the reply where the request came from. */
export function sendSession(
  effect: BluetoothSessionEffect,
  keys: Pick<KeyStore, "key">,
  replies: SessionReplies,
): Result<void, string> {
  const body = sessionBody(effect, keys);
  const to = effect.to;
  if (to.kind === "app") {
    replies.app(
      to.conn,
      body.isOk()
        ? { t: "res", id: to.id, ok: true, body: body.value }
        : { t: "res", id: to.id, ok: false, error: { code: "unavailable", detail: {} } },
    );
  } else {
    replies.control(
      to.request,
      body.isOk()
        ? { ok: true, result: { kind: "op", body: body.value } }
        : {
            ok: false,
            error: {
              code: "opRefused",
              message: "unavailable",
              app: { code: "unavailable", detail: {} },
            },
          },
    );
  }
  return body.isOk() ? ok(undefined) : err(body.error);
}
