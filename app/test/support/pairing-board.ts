import type { DeviceObjectV2 } from "@hsn/protocol/app";
import { toHex } from "@hsn/protocol/messages";
import type { OpenBoard } from "../../src/pairing/pair-device";
import type { PhoneHub } from "../../src/pairing/hub";
import { toBase64url } from "../../src/hub/files";
import { security2Server } from "../../../tools/ble-bench/src/boards/security2-server";
import type { StartPairingSecurity } from "../../../tools/ble-bench/src/boards/pairing-security";

const device = {
  id: 1,
  name: "Hall-siren",
  role: "siren",
  state: "provisioning",
  firmware: "1.0.0",
  batteryPercent: null,
  signal: null,
  temperatureC: null,
  lastSeenMs: null,
  heardBy: null,
  health: { silent: false, batteryLow: false, tamperOpen: false, poorLink: false },
  update: null,
} satisfies DeviceObjectV2;

/** Changes a plaintext Identity field inside the actual encrypted board session. */
export function falseIdentity(index: number, value: number): StartPairingSecurity {
  const start = security2Server();
  return (code) => {
    const security = start(code);
    return {
      get established() {
        return security.established;
      },
      session: (request) => security.session(request),
      decrypt: (data) => security.decrypt(data),
      encrypt(data) {
        const answer = data.slice();
        if (answer[0] === 0xf1 && answer[1] === 0x02) answer[index] = value;
        return security.encrypt(answer);
      },
    };
  };
}

/** Models Provision replies and keeps a reference to the buffer passed across the session. */
export function provisionReply(client: PhoneHub["client"], board: OpenBoard, resultCode: number) {
  const commands: string[] = [];
  const provision = Uint8Array.of(0xf1, 0x03, 0x7f);
  let sent: Uint8Array | undefined;
  let sentExpected = false;
  const hub: PhoneHub = {
    client,
    onNewEvent: () => () => undefined,
    forward(op) {
      commands.push(op);
      if (op === "pair.prepare")
        return Promise.resolve({
          ok: true,
          body: { device: device.id, provision: toBase64url(provision) },
          repeat: false,
        });
      // A board that may already hold the key can leave a provisioning row even after refusal.
      return Promise.resolve({ ok: true, body: { device }, repeat: false });
    },
  };
  const model: OpenBoard = {
    ...board,
    session: {
      ...board.session,
      exchange(data) {
        sent = data;
        sentExpected = toHex(data) === toHex(provision);
        return Promise.resolve({ ok: true, value: Uint8Array.of(0xf1, 0x04, resultCode) });
      },
    },
  };
  return {
    hub,
    board: model,
    commands,
    sentExpected: () => sentExpected,
    wiped: () => sent?.every((byte) => byte === 0) === true,
  };
}
