/** mDNS advertising (hub-design.md section 3; protocol.md §10). */
import type { Result } from "neverthrow";
import type { HubError } from "../core/model/errors.ts";

/**
 * Advertises `_hsn-hub._tcp` with the hub's identity. Never blocks. A failure is recorded; Wi-Fi
 * devices cannot find the hub until it works.
 */
export interface Advertiser {
  advertise(identity: Uint8Array, port: number): Result<void, HubError>;
  stop(): Result<void, HubError>;
}
