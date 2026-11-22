/** Phone and browser builds share the rollout's version 2 requests and live state. */
import {
  APP_OPS_V2,
  type AppEventBodyV2,
  type AppOpBodyV2,
  type AppOpReplyV2,
} from "@hsn/protocol/app";
import { createStore } from "zustand/vanilla";
import type { AnyOutcome } from "../hub/channel";
import type { HubClient, Version2Channel } from "../hub/client";
import { realTimers, type Timers } from "../hub/wire";
import type { LiveState } from "./live";

type Status = AppOpReplyV2<"rollout.status">;
type FirmwareList = AppOpReplyV2<"firmware.list">;
type Offers = AppOpReplyV2<"firmware.offers">["offers"];
export type RolloutFailure = Extract<AnyOutcome, { readonly ok: false }>;
type Outcome<Op extends ReadOp | ChangeOp> =
  { readonly ok: true; readonly value: AppOpReplyV2<Op> } | RolloutFailure;
type ChangeOp =
  "rollout.start" | "rollout.pause" | "rollout.resume" | "rollout.cancel" | "firmware.fetch";
type ReadOp = "rollout.status" | "firmware.list" | "firmware.offers";
export type RolloutCommand = {
  readonly [Op in ChangeOp]: { readonly op: Op; readonly body: AppOpBodyV2<Op> };
}[ChangeOp];

interface RolloutView {
  readonly status?: Status;
  readonly images?: FirmwareList["images"];
  readonly offers?: Offers;
  readonly readFailure?: RolloutFailure | undefined;
  readonly pending?: ChangeOp | undefined;
  readonly outcome?:
    { readonly op: ChangeOp; readonly failure?: RolloutFailure | undefined } | undefined;
}

/** Uses the operation's schema to keep the reply typed even through a forwarded request. */
async function request<Op extends ReadOp | ChangeOp>(
  client: Version2Channel,
  op: Op,
  body: AppOpBodyV2<Op>,
): Promise<Outcome<Op>> {
  const reply = await client.forward(op, body);
  if (!reply.ok) return reply;
  const checked = APP_OPS_V2[op].reply.safeParse(reply.body);
  return checked.success
    ? { ok: true, value: checked.data as AppOpReplyV2<Op> }
    : { ok: false, local: "badReply" };
}

/** Replaces a member's state only while the event names the rollout's image and device. */
function applyDevice(status: Status, event: AppEventBodyV2<"deviceUpdate">): Status {
  if (status.rollout?.image !== event.image) return status;
  const index = status.devices.findIndex((line) => line.device === event.device);
  if (index === -1) return status;
  const { device, state, held, method, bytes, of, reason, forceAvailable } = event;
  return {
    ...status,
    devices: status.devices.with(index, {
      device,
      state,
      held,
      method,
      bytes,
      of,
      lastReason: reason ?? null,
      ...(forceAvailable === undefined ? {} : { forceAvailable }),
    }),
  };
}

const STATUS_RECORDS = new Set([
  "rollout_started",
  "rollout_paused",
  "rollout_resumed",
  "rollout_done",
  "rollout_cancelled",
]);
const CATALOGUE_RECORDS = new Set([
  "firmware_added",
  "firmware_removed",
  "firmware_release_offered",
]);

/** Keeps the Updates section current for one app session and drops replies after it ends. */
export function rolloutView(
  hub: Pick<HubClient, "live" | "onEvent">,
  client: Version2Channel,
  timers: Timers = realTimers,
) {
  const store = createStore<RolloutView>()(() => ({}));
  let watching = false;
  let generation = 0;
  let statusQueued = false;
  let catalogueQueued = false;
  let reading = false;
  let cancelTimer: (() => void) | undefined;
  let retriedSoak: { readonly id: number; readonly until: number } | undefined;
  let session: LiveState["session"] = null;

  /** The same home and linked client, including across reconnects and hub restarts. */
  function current() {
    const live = hub.live.getState().session;
    return (
      watching && session !== null && live?.hub === session.hub && live.client === session.client
    );
  }

  /** A soak can end silently, and a pilot's pause record can be hidden by device permissions. */
  function watchSoak(status: Status) {
    cancelTimer?.();
    const { rollout } = status;
    if (rollout?.stage !== "soak" || rollout.soakUntilMs === null) {
      retriedSoak = undefined;
      return;
    }
    const soak = { id: rollout.id, until: rollout.soakUntilMs };
    const left = soak.until - timers.now();
    if (left <= 0) {
      const retried = retriedSoak?.id === soak.id && retriedSoak.until === soak.until;
      cancelTimer = timers.after(retried ? 60_000 : 5000, () => {
        retriedSoak = soak;
        refresh();
      });
      return;
    }
    retriedSoak = undefined;
    const { devices } = hub.live.getState();
    const hiddenPilot = rollout.pilots.some((id) => !Object.hasOwn(devices, id));
    const maxDelay = hiddenPilot ? 60_000 : 60 * 60 * 1000;
    cancelTimer = timers.after(Math.min(left, maxDelay), refresh);
  }

  /** Leaves a newer event visible while the follow-up read catches up. */
  function publishStatus(status: Status) {
    if (statusQueued && store.getState().status !== undefined) return;
    store.setState({ status, readFailure: undefined });
    watchSoak(status);
  }

  /** Coalesces state invalidations during a read and refreshes the catalogue only when needed. */
  function refresh(catalogue = false) {
    if (!current() || hub.live.getState().connection.kind !== "open") return;
    statusQueued = true;
    catalogueQueued ||= catalogue;
    if (!reading) void read();
  }

  /** The successful status reply is the hub's permission check for everything in this section. */
  async function read() {
    reading = true;
    while (current() && statusQueued && hub.live.getState().connection.kind === "open") {
      statusQueued = false;
      const requested = generation;
      const result = await request(client, "rollout.status", {});
      if (requested !== generation || !current()) continue;
      if (!result.ok) {
        const failure = result;
        if ("error" in failure && failure.error.code === "unauthorized") {
          cancelTimer?.();
          store.setState({}, true);
        } else if ("local" in failure && failure.local === "badReply") {
          cancelTimer?.();
          catalogueQueued = true;
          store.setState({ readFailure: failure }, true);
        } else if (store.getState().status !== undefined) {
          store.setState({ readFailure: failure });
        }
        continue;
      }
      publishStatus(result.value);
      if (catalogueQueued) {
        catalogueQueued = false;
        const [images, offers] = await Promise.all([
          request(client, "firmware.list", {}),
          request(client, "firmware.offers", {}),
        ]);
        if (requested !== generation || !current()) continue;
        if (images.ok) store.setState({ images: images.value.images });
        if (offers.ok) store.setState({ offers: offers.value.offers });
        const failure = !images.ok ? images : !offers.ok ? offers : undefined;
        if (failure !== undefined) store.setState({ readFailure: failure });
      }
    }
    reading = false;
  }

  /** Subscribes before the first read and checks permissions again when the hub says they changed. */
  function watch() {
    session = hub.live.getState().session;
    watching = true;
    const offLive = hub.live.subscribe((state, before) => {
      if (state.connection.kind === "open" && before.connection.kind !== "open") refresh(true);
    });
    const offRecord = hub.onEvent((event) => {
      if (!current()) return;
      if (
        event.ev === "people" &&
        ("userManagement" in event.body ||
          ("person" in event.body && event.body.person.id === session?.person) ||
          ("personRemoved" in event.body && event.body.personRemoved === session?.person))
      ) {
        generation++;
        cancelTimer?.();
        store.setState({}, true);
        refresh(true);
      }
      if (event.ev !== "record" || event.body.row.kind !== "decision") return;
      const kind = event.body.row.row.kind;
      if (STATUS_RECORDS.has(kind)) refresh();
      if (CATALOGUE_RECORDS.has(kind)) refresh(true);
    });
    const offDevice = client.onNewEvent((event) => {
      if (!current() || event.ev !== "deviceUpdate") return;
      const { status } = store.getState();
      if (status?.rollout != null) {
        const next = applyDevice(status, event.body);
        if (next === status) return;
        store.setState({ status: next });
        const before = status.devices.find((line) => line.device === event.body.device);
        // Progress updates alone need no status request, unless one could overwrite the event.
        if (
          !reading &&
          before?.state === event.body.state &&
          before.held === event.body.held &&
          before.lastReason === (event.body.reason ?? null)
        )
          return;
      }
      refresh();
    });
    refresh(true);
    return () => {
      watching = false;
      generation++;
      cancelTimer?.();
      offLive();
      offRecord();
      offDevice();
      store.setState({}, true);
    };
  }

  /** Runs one command at a time, keeps its outcome, then reads the hub's current rollout. */
  async function run(command: RolloutCommand) {
    const { status, pending } = store.getState();
    if (!current() || status === undefined || pending !== undefined) return;
    const requested = generation;
    store.setState({ pending: command.op, outcome: undefined });
    const result = await request(client, command.op, command.body);
    if (requested !== generation || !current() || store.getState().status === undefined) return;
    store.setState({
      pending: undefined,
      outcome: { op: command.op, failure: result.ok ? undefined : result },
    });
    refresh();
  }

  return { store, watch, run };
}
