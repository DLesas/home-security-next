/**
 * The relay's own static key (docs/m4-design.md section 3, D142): made at its first start, kept
 * in its data folder for its life, and proved to the push service in XN on its relay link
 * (`hsn-relay-peer/1`). 32 raw bytes in `relay.key`, readable only by the relay's account; a key
 * file others can read is refused on POSIX. On Windows it inherits the data folder's ACL.
 * It is never logged or sent anywhere.
 */
import { join } from "node:path";
import { type StaticKey, x25519StaticKey } from "@hsn/protocol/app";
import { err, ok, type Result } from "neverthrow";
import { relayError, type RelayError } from "./errors.ts";
import { random } from "./safe/crypto.ts";
import { exists, modeOf, readBytes, writeSecretFile } from "./safe/fs.ts";

const ORIGIN = "shell/relay-key";
const KEY_BYTES = 32;
export const RELAY_KEY_FILE = "relay.key";

/** Loads the relay's key or creates it inside the operator's private data folder. */
export function loadOrMakeRelayKey(dataFolder: string): Result<StaticKey, RelayError> {
  const path = join(dataFolder, RELAY_KEY_FILE);
  if (!exists(path)) {
    const made = random(KEY_BYTES).andThen((bytes) => writeSecretFile(path, bytes));
    if (made.isErr()) return err(made.error);
  }
  if (process.platform !== "win32") {
    const mode = modeOf(path);
    if (mode.isErr()) return err(mode.error);
    if ((mode.value & 0o077) !== 0) {
      return err(relayError("crypto", ORIGIN, "the relay's key file is readable by others"));
    }
  }
  const bytes = readBytes(path, "the relay's key");
  if (bytes.isErr()) return err(bytes.error);
  if (bytes.value.length !== KEY_BYTES) {
    return err(relayError("crypto", ORIGIN, "the relay's key file is not 32 bytes"));
  }
  const key = x25519StaticKey(bytes.value);
  bytes.value.fill(0);
  return key.ok
    ? ok(key.value)
    : err(relayError("crypto", ORIGIN, "the relay's key is not usable"));
}
