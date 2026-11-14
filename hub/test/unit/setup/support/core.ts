/**
 * The core under test for E5's modules: the real registry, setup, control and site handlers, with
 * every other module replaced by a stand-in, so these tests do not depend on modules other
 * engineers are writing. Two stand-ins do what the design gives their owners:
 *
 * - links (E1): a frame that starts with 0xF1 is a `setupFrame` (§10);
 * - audit (E4): an `auditRecord` becomes a `record` effect, and the next sequence number follows
 *   it (section 2).
 *
 * The rest accept every message and change nothing.
 */
import { SETUP_MARKER } from "@hsn/protocol";
import { ok } from "neverthrow";
import type { Effect } from "../../../../src/core/model/effects.ts";
import type { Handler } from "../../../../src/core/model/handler.ts";
import { seq } from "../../../../src/core/model/ids.ts";
import type { Internal } from "../../../../src/core/model/messages.ts";
import type { ModuleName } from "../../../../src/core/model/modules.ts";
import { makeControlHandler } from "../../../../src/core/control/handle.ts";
import { type ControlSources, VIEW_SOURCES } from "../../../../src/core/control/sources.ts";
import { handleRegistry } from "../../../../src/core/registry/handle.ts";
import { handleSetup } from "../../../../src/core/setup/handle.ts";
import {
  type Core,
  makeCore,
  type ModuleDefinition,
  type Modules,
  MODULES,
} from "../../../../src/core/step.ts";

function standIn<K extends ModuleName>(name: K, handle?: Handler<K>): ModuleDefinition<K> {
  return {
    empty: MODULES[name].empty,
    handle: handle ?? ((slice) => ok({ slice, out: [] })),
    deadlines: () => [],
  };
}

/**
 * E1's rule for setup frames (§10), simplified: every frame starting with 0xF1 is one; setup
 * itself refuses one from a link that is not a USB board.
 */
const links: Handler<"links"> = (slice, message) =>
  ok({
    slice,
    out:
      message.kind === "frame" && message.bytes[0] === SETUP_MARKER
        ? [{ kind: "setupFrame", link: message.link, bytes: message.bytes }]
        : [],
  });

/** E4's audit, as far as these tests need it: records pass through in order; rejections count. */
const audit: Handler<"audit"> = (slice, message, ctx) => {
  if (message.kind === "rejected") {
    const via =
      "device" in message.source
        ? `device:${message.source.device}`
        : `link:${message.source.link}`;
    const record: Effect = {
      kind: "record",
      durability: "routine",
      record: {
        kind: "reject",
        row: {
          minute: Math.floor(ctx.now.wall / 60_000),
          via,
          reason: message.reason,
          count: 1,
          address: message.address ?? null,
          sample: message.sample,
        },
      },
    };
    return ok({ slice, out: [record] });
  }
  if (message.kind !== "auditRecord") return ok({ slice, out: [] });
  const record: Effect = { kind: "record", durability: message.durability, record: message.record };
  const row = message.record.row;
  const next =
    "seq" in row ? { ...slice, nextRecord: seq(Math.max(slice.nextRecord, row.seq + 1)) } : slice;
  return ok({ slice: next, out: [record] satisfies readonly (Internal | Effect)[] });
};

/** Handlers a test gives the stand-ins, for example an alarm that answers arm requests. */
export type StandIns = {
  readonly [K in Exclude<ModuleName, "registry" | "setup" | "control">]?: Handler<K>;
};

/** The core with E5's modules and stand-ins for the rest. */
export function setupCore(sources: ControlSources = VIEW_SOURCES, given: StandIns = {}): Core {
  const modules: Modules = {
    clock: standIn("clock", given.clock),
    registry: { ...MODULES.registry, handle: handleRegistry },
    links: standIn("links", given.links ?? links),
    setup: { ...MODULES.setup, handle: handleSetup },
    control: { ...MODULES.control, handle: makeControlHandler(sources) },
    people: standIn("people", given.people),
    layout: standIn("layout", given.layout),
    app: standIn("app", given.app),
    schedules: standIn("schedules", given.schedules),
    gateways: standIn("gateways", given.gateways),
    intake: standIn("intake", given.intake),
    alarm: standIn("alarm", given.alarm),
    // The real site module: setup reads the site's settings through its view.
    site: given.site === undefined ? MODULES.site : { ...MODULES.site, handle: given.site },
    sensors: standIn("sensors", given.sensors),
    slots: standIn("slots", given.slots),
    sirens: standIn("sirens", given.sirens),
    health: standIn("health", given.health),
    notify: standIn("notify", given.notify),
    upkeep: standIn("upkeep", given.upkeep),
    audit: standIn("audit", given.audit ?? audit),
  };
  return makeCore(modules);
}
