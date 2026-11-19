/**
 * The phone's end of the bench's **test stand-in** for pairing's security layer
 * (`boards/pairing-security.ts`): an `OpenSetupSession` (app/src/platform/ble.ts, frozen) that
 * reads `proto-ver`, writes the code **in the clear** to `prov-session`, and then carries setup
 * messages on `hsn-setup` unsealed. It is **not protocomm security 2 and not secure**: it lets the
 * app's pairing flow, the bridge and the simulators run against scripted boards before P3's
 * security 2 client and the board's side of it are joined. A board must be made with
 * `standInSecurity` for it to work; a real board, or a scripted one with security 2, refuses it.
 *
 * It answers as the frozen `PairFault` says: a refused handshake is `wrongCode` (security 2's
 * wrong proof is a refused write, as this one's is); a link that goes is `lost`; an answer of the
 * wrong shape is `protocol`. Five wrong codes are seen as the link lost after the fifth refusal.
 */
import type {
  GattLink,
  OpenSetupSession,
  PairFault,
  SetupSession,
} from "../../../app/src/platform/ble.ts";
import { pairVersion } from "../../../packages/protocol/src/pairing/types.ts";
import { PAIRING_UUIDS } from "./boards/protocomm.ts";
import { STAND_IN_ACCEPTED, standInRequest } from "./boards/pairing-security.ts";
import { fault, ok, type Outcome } from "./outcome.ts";
import { parseJson } from "./safe/json.ts";

async function request(
  link: GattLink,
  characteristic: string,
  data: Uint8Array,
): Promise<Outcome<Uint8Array, "refused" | "lost" | "other">> {
  const written = await link.write(characteristic, data, true);
  if (!written.ok)
    return fault(
      written.fault === "failed" ? "refused" : written.fault === "lost" ? "lost" : "other",
    );
  const read = await link.read(characteristic);
  if (!read.ok) return fault(read.fault === "lost" ? "lost" : "other");
  return ok(read.value);
}

/** Reads `proto-ver` as the frozen `PairVersion`; undefined when it is not one. */
export async function readPairVersion(link: GattLink) {
  const answer = await request(link, PAIRING_UUIDS.protoVersion, Uint8Array.of(0));
  if (!answer.ok) return answer;
  const json = parseJson(new TextDecoder().decode(answer.value));
  const version = json.ok ? pairVersion.safeParse(json.value) : undefined;
  return version?.success === true ? ok(version.data) : fault("other" as const);
}

export const openStandInSession: OpenSetupSession = async (link, code) => {
  const version = await readPairVersion(link);
  if (!version.ok) return fault(version.fault === "lost" ? "lost" : "protocol");
  const handshake = await request(link, PAIRING_UUIDS.session, standInRequest(code));
  if (!handshake.ok) {
    return fault(
      handshake.fault === "refused"
        ? "wrongCode"
        : handshake.fault === "lost"
          ? "lost"
          : "protocol",
    );
  }
  if (handshake.value.length !== 1 || handshake.value[0] !== STAND_IN_ACCEPTED[0])
    return fault("protocol");
  const session: SetupSession = {
    exchange: async (message): Promise<Outcome<Uint8Array, PairFault>> => {
      const answer = await request(link, PAIRING_UUIDS.setup, message);
      if (answer.ok) return answer;
      return fault(answer.fault === "lost" ? "lost" : "protocol");
    },
    close: () => {
      link.close();
    },
  };
  return ok(session);
};
