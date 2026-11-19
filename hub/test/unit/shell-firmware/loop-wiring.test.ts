/**
 * The loop's part in firmware transfers (`shell/loop.ts`; docs/m3-updates-design.md section 4):
 * `transferGrant` and `transferRevoke` reach the `Transfers` port at once, in effect order, with
 * every field, even while a commit fails (a grant serves only what a signed header covers); a
 * hub without the port reports them instead of dropping them silently. And the registry: a
 * transfer frame on a granted link never reaches the core, and a link the hub closes is forgotten.
 */
import { describe, expect, test } from "bun:test";
import { nodeSha256 } from "@hsn/protocol";
import { err, ok } from "neverthrow";
import type { TransferRevokeReason } from "../../../src/core/model/effects.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { HubError } from "../../../src/core/model/errors.ts";
import type { HubEvent, Input } from "../../../src/core/model/events.ts";
import { imageId, type LinkId, linkId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import { mono, type Now } from "../../../src/core/model/time.ts";
import type { Core } from "../../../src/core/step.ts";
import type { TransferGrant, Transfers } from "../../../src/ports/transfers.ts";
import { UNBUILT_CALENDAR } from "../../../src/shell/calendar/unbuilt.ts";
import { TransferServer } from "../../../src/shell/firmware/serve.ts";
import { LinkRegistry } from "../../../src/shell/links/registry.ts";
import { HubLoop, type LoopWriter } from "../../../src/shell/loop.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";

const HEADER = new Uint8Array(128).fill(3);
const IMAGE_ID = new Uint8Array(8).fill(4);

function core(effects: readonly Effect[]): Core {
  const state = { clock: { boot: { id: 1 } } } as unknown as HubState;
  return {
    emptyState: () => state,
    nextDeadline: () => undefined,
    step: (current: HubState, input: Input) =>
      ok({
        state: current,
        effects: input.event.kind === "tick" ? effects : [],
        wake: undefined,
      }),
  };
}

function loop(
  effects: readonly Effect[],
  transfers: Transfers | undefined,
  failing: boolean,
  reports: HubError[],
): HubLoop {
  const writer = {
    stage: () => undefined,
    setCadence: () => undefined,
    durable: () => undefined,
    due: () => undefined,
    flushIfDue: () =>
      failing
        ? err({ kind: "storage", origin: "test", message: "disk full" })
        : ok({ items: 0, durationMs: 0, committed: true }),
    flush: () => ok({ items: 0, durationMs: 0, committed: true }),
    takeOutcome: () => undefined,
    maintain: () => ok(undefined),
  } as LoopWriter;
  return new HubLoop(
    core(effects),
    {
      cipher: new VectorCipher([]),
      rules: DEFAULT_RULES,
      calendar: UNBUILT_CALENDAR,
      sha256: nodeSha256,
    },
    {
      clock: { now: (): Now => ({ mono: mono(1), wall: 1, wallTrusted: true }) },
      random: { bytes: (n) => ok(new Uint8Array(n)) },
      links: { listen: () => undefined, send: () => ok(undefined), close: () => ok(undefined) },
      control: { respond: () => undefined, publish: () => undefined },
      writer,
      advertiser: { advertise: () => ok(undefined), stop: () => ok(undefined) },
      wakeAt: () => undefined,
      soon: () => undefined,
      report: (error) => reports.push(error),
      fatal: (error) => reports.push(error),
      ...(transfers === undefined ? {} : { transfers }),
    },
  );
}

const EFFECTS: readonly Effect[] = [
  {
    kind: "write",
    durability: "now",
    op: { table: "relay_settings", op: "upsert", row: { url: null, revision: 1 } },
  },
  {
    kind: "transferGrant",
    link: linkId(5),
    image: imageId(2),
    imageId: IMAGE_ID,
    header: HEADER,
    file: "f.bin",
  },
  { kind: "transferRevoke", link: linkId(6), reason: "paused" },
  { kind: "transferRevoke", link: linkId(7) },
  {
    kind: "transferGrant",
    link: linkId(6),
    image: imageId(2),
    imageId: IMAGE_ID,
    header: HEADER,
    file: "g.bin",
  },
];

describe("the loop gives grants and revokes to the port", () => {
  for (const failing of [false, true]) {
    test(`in effect order, every field${failing ? ", while the commit fails" : ""}`, () => {
      const calls: (
        | { readonly grant: LinkId; readonly with: TransferGrant }
        | { readonly revoke: LinkId; readonly reason: TransferRevokeReason | undefined }
      )[] = [];
      const reports: HubError[] = [];
      const hub = loop(
        EFFECTS,
        {
          grant: (link, grant) => calls.push({ grant: link, with: grant }),
          revoke: (link, reason) => calls.push({ revoke: link, reason }),
        },
        failing,
        reports,
      );
      hub.enqueue({ kind: "tick" });
      hub.turn();
      expect(calls).toEqual([
        { grant: linkId(5), with: { imageId: IMAGE_ID, header: HEADER, file: "f.bin" } },
        { revoke: linkId(6), reason: "paused" },
        { revoke: linkId(7), reason: undefined },
        { grant: linkId(6), with: { imageId: IMAGE_ID, header: HEADER, file: "g.bin" } },
      ]);
      expect(reports.filter((r) => r.message.includes("transfer"))).toEqual([]);
    });
  }

  test("a hub without the port reports each, by name", () => {
    const reports: HubError[] = [];
    const hub = loop(EFFECTS, undefined, false, reports);
    hub.enqueue({ kind: "tick" });
    hub.turn();
    expect(reports.map((r) => r.message)).toEqual([
      "the transferGrant effect is not built yet (m2-design.md section 11, step 2)",
      "the transferRevoke effect is not built yet (m2-design.md section 11, step 2)",
      "the transferRevoke effect is not built yet (m2-design.md section 11, step 2)",
      "the transferGrant effect is not built yet (m2-design.md section 11, step 2)",
    ]);
  });
});

describe("the registry", () => {
  test("a link the hub closes is forgotten by the server; its next frame is the core's", () => {
    const registry = new LinkRegistry();
    const events: HubEvent[] = [];
    registry.listen((event) => events.push(event));
    const server = new TransferServer({
      dataDir: "/nowhere",
      send: (link, bytes) => registry.sendTransfer(link, bytes),
      emit: (event) => events.push(event),
    });
    registry.serveTransfers(server);
    const link = registry.open("usb", "/dev/x", {
      send: () => ok(undefined),
      close: () => ok(undefined),
    });
    server.grant(link, { imageId: IMAGE_ID, header: HEADER, file: "f.bin" });
    expect(server.holds(link)).toBe(true);
    expect(registry.close(link, "test").isOk()).toBe(true);
    expect(server.holds(link)).toBe(false);
    // Frames after the close are no link's: nothing is answered and nothing reaches the core.
    registry.frame(link, Uint8Array.of(0xf2, 0x01));
    expect(events.filter((e) => e.kind === "frame")).toEqual([]);
    expect(registry.sendTransfer(link, Uint8Array.of(1))).toBe(false);
  });
});
