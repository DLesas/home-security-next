/**
 * Gateway scenarios in the World with the scripted gateway (hub-design.md section 11): connect,
 * reconnect, takeover by a replayed hello, a hello replayed after a restart, a request that
 * never gets a result, a busy radio, two gateways, noise rising slowly and suddenly, and a
 * gateway that restarts during interference.
 */
import { describe, expect, test } from "bun:test";
import { MessageType, NO_BINDING } from "@hsn/protocol";
import type { DurableSnapshot } from "../../../src/core/model/events.ts";
import type { DeviceStateRow } from "../../../src/core/model/rows.ts";
import { TxOutcome } from "../../../src/core/model/rows.ts";
import {
  GATEWAY_ADDRESS,
  SECOND_GATEWAY_ADDRESS,
  snapshotWith,
  statusFields,
  toHub,
} from "../../unit/gateways/harness.ts";
import type { ScriptedGateway } from "../../world/scripted-gateway.ts";
import type { World } from "../../world/world.ts";
import {
  decisions,
  G1,
  G2,
  gatewayWorld,
  heartbeat,
  mono,
  scriptedGateway,
  SECOND,
  seenOf,
  silentOnRequests,
  twoGatewaySnapshot,
} from "./support.ts";

type StatusFields = Parameters<ScriptedGateway["status"]>[0];

function must(result: { isOk(): boolean }): void {
  expect(result.isOk()).toBe(true);
}

/** Opens a link with the gateway on it and sends its hello. */
function connect(
  world: World,
  gateway: ScriptedGateway,
  label = "ws",
): ReturnType<World["openLink"]> {
  const link = world.openLink("network", label, gateway);
  must(world.deliver(link, gateway.hello() ?? new Uint8Array()));
  return link;
}

/** A status with ordinary figures, changed by `fields`. */
function status(fields: Partial<StatusFields> = {}): StatusFields {
  return statusFields(fields);
}

/** The gateway's `device_state` rows committed so far, as the next boot would read them. */
function committedState(world: World): readonly DeviceStateRow[] {
  const rows = new Map<number, DeviceStateRow>();
  for (const commit of world.writer.commits) {
    for (const item of commit.items) {
      if (item.kind === "write" && item.op.op === "upsert" && item.op.table === "device_state")
        rows.set(item.op.row.deviceId, item.op.row);
    }
  }
  return [...rows.values()];
}

describe("connecting", () => {
  test("hello, welcome, settings, Started: the session is proven and the gateway holds the settings", () => {
    const { world, seen } = gatewayWorld();
    must(world.boot(snapshotWith()));
    const gateway = scriptedGateway(GATEWAY_ADDRESS);
    const link = connect(world, gateway);
    expect(gateway.session).toBeDefined();
    expect(gateway.settings?.settingsVersion).toBe(1);
    expect(seenOf(seen, "gatewayUp")).toEqual([{ kind: "gatewayUp", gateway: G1, link }]);
    expect(decisions(seen).map(([k]) => k)).toEqual(["gateway_welcomed", "gateway_settings"]);
    // The hello's counter was committed before the welcome left (section 4's rule).
    expect(world.writer.commits.length).toBeGreaterThan(0);
    expect(world.faults).toEqual([]);
  });

  test("reconnecting after the link closed: gatewayDown, then a new session on the new link", () => {
    const { world, seen } = gatewayWorld();
    must(world.boot(snapshotWith()));
    const gateway = scriptedGateway(GATEWAY_ADDRESS);
    const first = connect(world, gateway, "ws 1");
    world.closeLink(first);
    expect(seenOf(seen, "gatewayDown")).toEqual([{ kind: "gatewayDown", gateway: G1 }]);
    must(world.advanceByMs(1000));
    const second = connect(world, gateway, "ws 2");
    expect(seenOf(seen, "gatewayUp").map((u) => u.link)).toEqual([first, second]);
    must(
      world.deliver(
        second,
        gateway.forward(heartbeat(3331), {
          endedAt: world.now.mono,
          rssiDbm: -95,
          snrQuarterDb: 32,
          dataRate: 5,
          siteChannel: 1,
        }) ?? new Uint8Array(),
      ),
    );
    expect(seenOf(seen, "devicePacket")).toHaveLength(1);
  });
});

describe("hellos that must not take over", () => {
  test("a hello recorded but never delivered, replayed on another socket: answered, never proven, closed after 10 s; the gateway is undisturbed", () => {
    const { world, seen } = gatewayWorld({ reply: true });
    must(world.boot(snapshotWith()));
    const gateway = scriptedGateway(GATEWAY_ADDRESS);
    const real = connect(world, gateway);
    // An attacker's copy of a hello the hub never saw: its counter is above every one accepted.
    const recorded = toHub(
      GATEWAY_ADDRESS,
      {
        type: MessageType.Hello,
        gatewayRandom: new Uint8Array(8).fill(0xee),
        firmwareVersion: { major: 1, minor: 0, patch: 0 },
        settingsVersion: 1,
      },
      50_000,
      NO_BINDING,
    );
    const stranger = world.openLink("network", "stranger");
    must(world.deliver(stranger, recorded));
    expect(world.links.get(stranger)?.sent).toHaveLength(2);
    // Meanwhile the gateway forwards a heartbeat, and its reply goes out through the real link.
    must(
      world.deliver(
        real,
        gateway.forward(heartbeat(10), {
          endedAt: world.now.mono,
          rssiDbm: -90,
          snrQuarterDb: 30,
          dataRate: 5,
          siteChannel: 1,
        }) ?? new Uint8Array(),
      ),
    );
    must(world.advanceByMs(10_000));
    expect(world.links.get(stranger)?.open).toBe(false);
    expect(world.links.get(real)?.open).toBe(true);
    expect(gateway.transmissions).toHaveLength(1);
    expect(seenOf(seen, "radioResult").map((r) => r.outcome)).toEqual([TxOutcome.Sent]);
    expect(seenOf(seen, "gatewayUp")).toHaveLength(1);
  });

  test("a hello already accepted, replayed: tooOld, never answered", () => {
    const { world, seen } = gatewayWorld();
    must(world.boot(snapshotWith()));
    const gateway = scriptedGateway(GATEWAY_ADDRESS);
    const link = world.openLink("network", "ws", gateway);
    const hello = gateway.hello() ?? new Uint8Array();
    must(world.deliver(link, hello));
    const stranger = world.openLink("network", "stranger");
    must(world.deliver(stranger, hello));
    expect(world.links.get(stranger)?.sent).toEqual([]);
    expect(seenOf(seen, "rejected").map((r) => r.reason)).toEqual(["tooOld"]);
  });

  test("a hello replayed after a restart is refused: its counter was committed now, before the welcome", () => {
    const first = gatewayWorld();
    must(first.world.boot(snapshotWith()));
    const gateway = scriptedGateway(GATEWAY_ADDRESS);
    const link = first.world.openLink("network", "ws", gateway);
    const hello = gateway.hello() ?? new Uint8Array();
    must(first.world.deliver(link, hello));
    // The power is cut right after: only what was committed survives.
    const snapshot: DurableSnapshot = snapshotWith({ deviceState: committedState(first.world) });
    const after = gatewayWorld();
    must(after.world.boot(snapshot, 2));
    const stranger = after.world.openLink("network", "stranger");
    must(after.world.deliver(stranger, hello));
    expect(after.world.links.get(stranger)?.sent).toEqual([]);
    expect(seenOf(after.seen, "rejected").map((r) => r.reason)).toEqual(["tooOld"]);
    // The real gateway's next hello carries a higher counter and is welcomed.
    const real = connect(after.world, gateway, "ws again");
    expect(after.world.links.get(real)?.sent).toHaveLength(2);
  });
});

describe("transmit requests", () => {
  test("a request that never gets a result is 'no result' 5 s ‡ after its moment", () => {
    const { world, seen } = gatewayWorld({ reply: true });
    must(world.boot(snapshotWith()));
    const gateway = scriptedGateway(GATEWAY_ADDRESS);
    const link = world.openLink("network", "ws", silentOnRequests(gateway));
    must(world.deliver(link, gateway.hello() ?? new Uint8Array()));
    const end = world.now.mono;
    must(
      world.deliver(
        link,
        gateway.forward(heartbeat(20), {
          endedAt: end,
          rssiDbm: -90,
          snrQuarterDb: 30,
          dataRate: 5,
          siteChannel: 1,
        }) ?? new Uint8Array(),
      ),
    );
    // The reply's moment is 1 s † after the heartbeat's end; its result is due 5 s ‡ later.
    must(world.advanceTo(mono(end + 6 * SECOND - 1)));
    expect(seenOf(seen, "radioResult")).toEqual([]);
    must(world.advanceTo(mono(end + 6 * SECOND)));
    expect(seenOf(seen, "radioResult").map((r) => [r.outcome, r.gateway])).toEqual([
      [TxOutcome.NoResult, G1],
    ]);
  });

  test("a busy radio: requests beyond its places are answered radio busy", () => {
    const { world, seen } = gatewayWorld({ reply: true });
    must(world.boot(snapshotWith()));
    const gateway = scriptedGateway(GATEWAY_ADDRESS, { radioPlaces: 1 });
    const link = connect(world, gateway);
    const at = world.now.mono;
    // Three heartbeats ending together: one reply waits for its moment, the others find no place.
    for (const counter of [30, 31, 32]) {
      must(
        world.deliver(
          link,
          gateway.forward(heartbeat(counter), {
            endedAt: at,
            rssiDbm: -90,
            snrQuarterDb: 30,
            dataRate: 5,
            siteChannel: 1,
          }) ?? new Uint8Array(),
        ),
      );
    }
    must(world.advanceByMs(10_000));
    const outcomes = seenOf(seen, "radioResult").map((r) => r.outcome);
    expect(outcomes.filter((o) => o === TxOutcome.RadioBusy)).toHaveLength(2);
    expect(outcomes.filter((o) => o === TxOutcome.Sent)).toHaveLength(1);
  });

  test("a reply whose moment comes while the radio is still sending is too late", () => {
    const { world, seen } = gatewayWorld({ reply: true });
    must(world.boot(snapshotWith()));
    const gateway = scriptedGateway(GATEWAY_ADDRESS);
    const link = connect(world, gateway);
    // Two heartbeats ending 30 ms apart: the second reply's moment comes while the radio still
    // sends the first (72 ms at DR5), more than 20 ms † late, so the gateway says too late.
    const later = world.now.mono;
    for (const [counter, end] of [
      [33, later],
      [34, mono(later + 30_000)],
    ] as const) {
      must(
        world.deliver(
          link,
          gateway.forward(heartbeat(counter), {
            endedAt: end,
            rssiDbm: -90,
            snrQuarterDb: 30,
            dataRate: 5,
            siteChannel: 1,
          }) ?? new Uint8Array(),
        ),
      );
    }
    must(world.advanceByMs(10_000));
    expect(
      seenOf(seen, "radioResult")
        .map((r) => r.outcome)
        .slice(-2),
    ).toEqual([TxOutcome.Sent, TxOutcome.TooLate]);
    // Recorded as the outcome on the tx row, not as a decision.
    expect(decisions(seen).map(([k]) => k)).not.toContain("too_late");
  });
});

describe("two gateways", () => {
  test("both forward the same heartbeat; the reply goes through the one whose copy came first, on its own clock", () => {
    const { world, seen } = gatewayWorld({ reply: true });
    must(world.boot(twoGatewaySnapshot()));
    const one = scriptedGateway(GATEWAY_ADDRESS, { clockOffsetMicros: 123_456_789 });
    const two = scriptedGateway(SECOND_GATEWAY_ADDRESS, {
      clockOffsetMicros: 4_000_000_000,
      drift: 0.0001,
    });
    const a = connect(world, one, "ws one");
    const b = connect(world, two, "ws two");
    must(world.advanceByMs(5_000));
    const end = world.now.mono;
    const packet = heartbeat(3331);
    must(
      world.deliver(
        b,
        two.forward(packet, {
          endedAt: end,
          rssiDbm: -100,
          snrQuarterDb: 10,
          dataRate: 5,
          siteChannel: 1,
        }) ?? new Uint8Array(),
      ),
    );
    must(
      world.deliver(
        a,
        one.forward(packet, {
          endedAt: end,
          rssiDbm: -80,
          snrQuarterDb: 40,
          dataRate: 5,
          siteChannel: 1,
        }) ?? new Uint8Array(),
      ),
    );
    const copies = seenOf(seen, "devicePacket").map((d) =>
      d.arrival.path === "lora" ? [d.arrival.gateway, d.arrival.endedAt] : [],
    );
    // Each copy's end is mapped onto the hub's clock through its own gateway's session.
    expect(copies).toEqual([
      [G2, end],
      [G1, end],
    ]);
    must(world.advanceByMs(5_000));
    expect(two.transmissions.map((t) => t.startMicros)).toEqual([two.clockMicros(end) + SECOND]);
    expect(one.transmissions).toEqual([]);
    expect(seenOf(seen, "radioResult").map((r) => [r.gateway, r.outcome])).toEqual([
      [G2, TxOutcome.Sent],
    ]);
    expect(world.links.get(a)?.open).toBe(true);
  });

  test("one goes silent for 60 s: offline, the other carries on", () => {
    const { world, seen } = gatewayWorld();
    must(world.boot(twoGatewaySnapshot()));
    const one = scriptedGateway(GATEWAY_ADDRESS);
    const two = scriptedGateway(SECOND_GATEWAY_ADDRESS);
    connect(world, one, "ws one");
    const b = connect(world, two, "ws two");
    for (let t = 0; t < 4; t++) {
      must(world.advanceByMs(30_000));
      must(world.deliver(b, two.status(status()) ?? new Uint8Array()));
    }
    expect(decisions(seen)).toContainEqual(["gateway_offline", G1]);
    expect(decisions(seen)).not.toContainEqual(["gateway_offline", G2]);
    expect(seenOf(seen, "gatewayDown")).toEqual([{ kind: "gatewayDown", gateway: G1 }]);
  });
});

describe("noise", () => {
  /** Statuses every 30 s for `minutes`, the median from `median(minute)`. */
  function statuses(
    world: World,
    link: ReturnType<World["openLink"]>,
    gateway: ScriptedGateway,
    minutes: number,
    median: (minute: number) => number,
    normal = -120,
  ): void {
    for (let i = 0; i < minutes * 2; i++) {
      must(world.advanceByMs(30_000));
      must(
        world.deliver(
          link,
          gateway.status(
            status({ noiseMedianDbm: Math.round(median(i / 2)), normalNoiseDbm: normal }),
          ) ?? new Uint8Array(),
        ),
      );
    }
  }

  test("rising slowly it is learned; rising suddenly it is raised after 2 statuses, and ends", () => {
    const { world, seen } = gatewayWorld();
    must(world.boot(snapshotWith()));
    const gateway = scriptedGateway(GATEWAY_ADDRESS);
    const link = connect(world, gateway);
    statuses(world, link, gateway, 61, () => -120);
    expect(world.state.gateways.gateways.get(G1)?.noise.baseline).toBe(-120);
    // 2 dB over six hours, in whole dB steps.
    statuses(world, link, gateway, 360, (m) => -120 + (2 * m) / 360);
    const kinds = () => decisions(seen).map(([k]) => k);
    expect(kinds()).not.toContain("noise_interference_started");
    // Then 15 dB at once.
    statuses(world, link, gateway, 0.5, () => -103);
    expect(kinds()).not.toContain("noise_interference_started");
    statuses(world, link, gateway, 0.5, () => -103);
    expect(kinds().filter((k) => k === "noise_interference_started")).toHaveLength(1);
    statuses(world, link, gateway, 5, () => -103);
    expect(kinds().filter((k) => k === "noise_interference_started")).toHaveLength(1);
    statuses(world, link, gateway, 1, () => -119);
    expect(kinds()).toContain("noise_interference_ended");
  });

  test("a gateway that restarts during interference learns it as normal; the hub's baseline does not", () => {
    const { world, seen } = gatewayWorld();
    must(world.boot(snapshotWith()));
    const gateway = scriptedGateway(GATEWAY_ADDRESS);
    const first = connect(world, gateway, "ws 1");
    statuses(world, first, gateway, 61, () => -120);
    statuses(world, first, gateway, 1, () => -100);
    const kinds = () => decisions(seen).map(([k]) => k);
    expect(kinds()).toContain("noise_interference_started");
    // The gateway restarts: a new connection, and it now thinks −100 dBm is normal.
    world.closeLink(first);
    const second = connect(world, gateway, "ws 2");
    statuses(world, second, gateway, 1, () => -100, -100);
    expect(kinds()).toContain("interference_learned_as_normal");
    expect(kinds()).not.toContain("noise_interference_ended");
    expect(world.state.gateways.gateways.get(G1)?.noise.baseline).toBe(-120);
    expect(world.faults).toEqual([]);
  });
});
