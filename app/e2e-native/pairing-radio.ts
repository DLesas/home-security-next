/** Lets the simulator's scripted boards report to the real hub's device endpoint. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  counterBinding,
  Direction,
  MaxPacketLength,
  type Message,
  MessageType,
  NO_BINDING,
  openPacket,
  type PairingData,
  ResumeStep,
  Role,
  sealPacket,
  toHex,
  UpdateAction,
  UpdateHolding,
  UpdateReason,
  UpdateStage,
} from "../../packages/protocol/src/index";
import { fromHex } from "../../packages/protocol/src/bytes";
import { APP_OPS, APP_OPS_V2 } from "../../packages/protocol/src/app/index";
import { type CliIo, runCli } from "../../hub/cli/main";
import { replyLine } from "../../hub/src/control-protocol";
import { deviceId } from "../../hub/src/core/model/ids";
import { DeviceState } from "../../hub/src/core/model/rows";
import type { StoreOp } from "../../hub/src/core/model/store";
import { mono } from "../../hub/src/core/model/time";
import { DEVICE_PATH } from "../../hub/src/shell/links/websocket";
import { espImage } from "../../hub/test/unit/shell-firmware/support";
import { ScriptedGateway } from "../../hub/test/world/scripted-gateway";
import { ScriptedSiren } from "../../hub/test/world/scripted-siren";
import type { ScriptedBoard } from "../../tools/ble-bench/src/boards/board";
import type { UpdateStatusReport } from "../../tools/ble-bench/src/boards/update-service";
import type { RealHub } from "../test/support/real-hub";

const gatewayId = deviceId(1);
const gatewayAddress = 0x5e0e0001;
const gatewayKey = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
export const SIMULATOR_GATEWAY: readonly StoreOp[] = [
  {
    table: "devices",
    op: "upsert",
    row: {
      id: gatewayId,
      address: gatewayAddress,
      role: Role.Gateway,
      name: "Fixture-gateway",
      chipId: new Uint8Array(6),
      firmware: 0x010000,
      development: false,
      state: DeviceState.Contacted,
      addedMs: 0,
      removedMs: null,
    },
  },
  {
    table: "device_keys",
    op: "upsert",
    row: { deviceId: gatewayId, key: gatewayKey, nextKey: null, rekey: 0 },
  },
  { table: "send_counters", op: "upsert", row: { deviceId: gatewayId, resumePoint: 1024 } },
  {
    table: "gateway_config",
    op: "upsert",
    row: {
      deviceId: gatewayId,
      version: 1,
      statusIntervalS: 1,
      interferenceDb: 10,
      interferenceS: 30,
      defaultPowerDbm: 22,
      sirenPowerDbm: 22,
    },
  },
];

/** Opens the seeded gateway and moves the sensor's reports through its authenticated session. */
export function pairingRadio(hub: RealHub, say: (line: string) => void) {
  const now = () => mono(Math.round(performance.now() * 1000));
  const endpoint = `ws://127.0.0.1:${hub.devicePort}${DEVICE_PATH}`;
  const gateway = new ScriptedGateway({
    key: gatewayKey,
    address: gatewayAddress,
    nextRandom: () => crypto.getRandomValues(new Uint8Array(8)),
  });
  const socket = new WebSocket(endpoint);
  socket.binaryType = "arraybuffer";
  const sirens: { socket: WebSocket; role: ScriptedSiren }[] = [];
  let sensor: { pairing: PairingData; board: ScriptedBoard; counter: number } | undefined;
  let lastQuery = 0;
  let nextPatch = 0;
  let planned:
    | {
        readonly rollout: number;
        readonly imageId: string;
        readonly firmware: ScriptedBoard["firmware"];
      }
    | undefined;
  let sent = 0;

  /** Sends a gateway packet after it is fully sealed. */
  function send(packet: Uint8Array | undefined) {
    if (packet !== undefined && socket.readyState === WebSocket.OPEN)
      socket.send(new Uint8Array(packet));
  }
  socket.onopen = () => {
    send(gateway.hello());
  };
  socket.onmessage = (event: MessageEvent<unknown>) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    for (const answer of gateway.receive(new Uint8Array(event.data), now())) send(answer);
    const transmissions = gateway.transmissions.splice(0);
    const paired = sensor;
    if (paired === undefined || lastQuery === 0) return;
    for (const transmission of transmissions) {
      const read = openPacket(transmission.packet, {
        key: paired.pairing.key,
        expectedDirection: Direction.FromHub,
        binding: counterBinding(lastQuery),
        maxLength: MaxPacketLength.Radio,
      });
      if (
        !read.ok ||
        read.value.message.type !== MessageType.UpdateOffer ||
        read.value.message.action !== UpdateAction.OpenBluetooth
      )
        continue;
      const action = read.value.message;
      paired.board.offerUpdate({
        imageId: action.imageId,
        nonce: action.bluetoothNonce,
        windowUnits: action.bluetoothWindowUnits,
      });
      say("Sensor advertising for the offered update");
      lastQuery = 0;
    }
  };

  const tick = setInterval(() => {
    for (const answer of gateway.wake(now())) send(answer);
    for (const siren of sirens) {
      if (siren.socket.readyState !== WebSocket.OPEN) continue;
      for (const packet of siren.role.wifi.wake(now())) siren.socket.send(new Uint8Array(packet));
    }
  }, 25);
  const status = setInterval(() => {
    send(
      gateway.status({
        settingsVersion: gateway.settings?.settingsVersion ?? 0,
        uptimeSeconds: Math.floor(performance.now() / 1000),
        airtimeHundredthsPercent: 0,
        noiseMedianDbm: -105,
        noiseHighestDbm: -100,
        normalNoiseDbm: -105,
        packetsReceived: sent,
        packetsCrcFailed: 0,
        wifiRssiDbm: -50,
        flags: { usbConnected: false, cellFitted: false, onMains: true },
      }),
    );
  }, 1000);

  /** Seals one scripted sensor report and forwards it through the gateway. */
  function report(message: Message): number {
    if (sensor === undefined) return 0;
    const counter = ++sensor.counter;
    const { pairing } = sensor;
    const payload = sealPacket(message, {
      key: pairing.key,
      address: pairing.address,
      counter,
      direction: Direction.ToHub,
      binding: NO_BINDING,
      maxLength: MaxPacketLength.Radio,
    });
    send(
      gateway.forward(payload, {
        endedAt: now(),
        rssiDbm: -60,
        snrQuarterDb: 20,
        dataRate: 5,
        siteChannel: pairing.siteChannel,
      }),
    );
    sent += 1;
    return counter;
  }

  /** Runs a fixture-only app operation over the real hub's local socket. */
  async function request(op: string, body: object): Promise<unknown> {
    const parsed = replyLine.safeParse(await hub.control({ kind: "op", op, body }));
    const reply = parsed.success ? parsed.data.reply : undefined;
    return reply?.ok && reply.result.kind === "op" ? reply.result.body : undefined;
  }

  return {
    /** Reports first contact after the scripted board restarts with its new setup. */
    paired(pairing: PairingData, board: ScriptedBoard) {
      if (board.role === Role.Sensor) {
        const paired = { pairing, board, counter: ResumeStep.Sensor };
        sensor = paired;
        lastQuery = 0;
        // Give the simulator a chance to capture the page before the first report arrives.
        setTimeout(() => {
          if (sensor !== paired) return;
          report({
            type: MessageType.Started,
            role: Role.Sensor,
            firmwareVersion: board.firmware,
            resetCause: 1,
            lastFatalError: 0,
            settingsVersion: 0,
          });
        }, 2000);
      } else if (board.role === Role.Siren) {
        const role = new ScriptedSiren({
          key: pairing.key,
          address: pairing.address,
          wifiUp: false,
        });
        const link = new WebSocket(endpoint);
        link.binaryType = "arraybuffer";
        link.onopen = () => {
          role.setWifi(true, now());
        };
        link.onmessage = (event: MessageEvent<unknown>) => {
          if (!(event.data instanceof ArrayBuffer)) return;
          for (const bytes of role.wifi.receive(new Uint8Array(event.data), now()))
            link.send(new Uint8Array(bytes));
        };
        sirens.push({ socket: link, role });
      }
    },

    /** Stages a signed own-build image, then models a sensor that cannot join the home's Wi-Fi. */
    async plan() {
      const paired = sensor;
      if (paired === undefined || paired.board.pairing !== paired.pairing) {
        say("Pair the sensor before starting a rollout");
        return;
      }
      const control = replyLine.safeParse(await hub.control({ kind: "devices" }));
      const reply = control.success ? control.data.reply : undefined;
      const named =
        reply?.ok && reply.result.kind === "devices"
          ? reply.result.devices.find(
              (row) => row.address === paired.pairing.address && row.state === "contacted",
            )
          : undefined;
      const listed = APP_OPS.snapshot.reply.safeParse(await request("snapshot", {}));
      const id = listed.success
        ? listed.data.devices.find(
            (row) => row.name === named?.name && row.role === "sensor" && row.state === "contacted",
          )?.id
        : undefined;
      if (id === undefined || sensor !== paired) {
        say("Wait for the hub to hear the paired sensor");
        return;
      }
      const firmware = { major: 1, minor: 4 + Math.floor(nextPatch / 256), patch: nextPatch % 256 };
      nextPatch += 1;
      const version = `${firmware.major}.${firmware.minor}.${firmware.patch}`;
      const path = join(hub.dataDir, "simulator-image.bin");
      writeFileSync(path, espImage({ size: 70_000, version, seed: 42 }));
      const io: CliIo = {
        out: () => undefined,
        err: () => undefined,
        env: { HSN_DATA_DIR: hub.dataDir },
        stdin: () => Promise.resolve(""),
        nowMs: Date.now,
        onInterrupt: () => undefined,
        ask: () => Promise.resolve("y"),
      };
      const uploaded = await runCli(["firmware", "add", path, "--own", "--version", version], io);
      const list = APP_OPS_V2["firmware.list"].reply.safeParse(await request("firmware.list", {}));
      const entry = list.success
        ? list.data.images.find((stored) => stored.version === version)
        : undefined;
      if (uploaded !== 0 || entry === undefined) {
        say("The fixture image was not stored");
        return;
      }
      if (planned !== undefined) {
        const status = APP_OPS_V2["rollout.status"].reply.safeParse(
          await request("rollout.status", {}),
        );
        const previous = status.success ? status.data.rollout : null;
        if (previous?.id === planned.rollout && previous.endedMs === null) {
          const cancelled = APP_OPS_V2["rollout.cancel"].reply.safeParse(
            await request("rollout.cancel", { rollout: planned.rollout }),
          );
          if (!cancelled.success) {
            say("Could not cancel the previous fixture rollout");
            return;
          }
        }
      }
      const plan = APP_OPS_V2["rollout.start"].reply.safeParse(
        await request("rollout.start", { image: entry.id, devices: [id] }),
      );
      if (!plan.success) {
        say("The hub refused the fixture rollout");
        return;
      }
      planned = { rollout: plan.data.id, imageId: entry.imageId, firmware };
      report({
        type: MessageType.UpdateStatus,
        imageId: fromHex(entry.imageId),
        stage: UpdateStage.Refused,
        reason: UpdateReason.NoWifi,
        bytesWritten: 0,
      });
      say(`Fixture rollout started for sensor ${id}: ${version}`);
    },

    /** Models the sensor's next reply opportunity after the phone asks the hub. */
    wake() {
      lastQuery = report({
        type: MessageType.UpdateQuery,
        imageId: new Uint8Array(8),
        held: UpdateHolding.Nothing,
        bytesHeld: 0,
        batteryCode: 200,
        flags: { hasWifiDetails: false, externalPower: false },
      });
    },

    /** Relays the scripted update service's real result, then models a successful trial restart. */
    result(status: UpdateStatusReport) {
      report({
        type: MessageType.UpdateStatus,
        imageId: status.imageId,
        stage: status.stage,
        reason: status.reason,
        bytesWritten: status.bytesWritten,
      });
      const completed = planned;
      const paired = sensor;
      if (status.stage !== UpdateStage.Verified || completed?.imageId !== toHex(status.imageId))
        return;
      setTimeout(() => {
        if (planned !== completed || sensor !== paired) return;
        report({
          type: MessageType.Started,
          role: Role.Sensor,
          firmwareVersion: completed.firmware,
          resetCause: 1,
          lastFatalError: 0,
          settingsVersion: 0,
        });
        report({
          type: MessageType.UpdateStatus,
          imageId: status.imageId,
          stage: UpdateStage.Confirmed,
          reason: UpdateReason.None,
          bytesWritten: status.bytesWritten,
        });
      }, 5000);
    },

    /** Closes only the fixture's own device sockets. */
    close() {
      clearInterval(tick);
      clearInterval(status);
      socket.close();
      for (const siren of sirens) siren.socket.close();
    },
  };
}
