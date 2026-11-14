/**
 * The setup module's handler (hub-design.md section 2, module 4; section 9, "Adding a device
 * over USB"; protocol.md §10; D100, D103, PR2, PR5, PR7).
 *
 * - A USB link opens: Identify. An Identity is kept as the board's latest, recorded, and read
 *   for whom the board belongs to. A gateway that is not paired is added at once as
 *   `gateway-<chip>` (D100); every other board is left alone.
 * - `usbAddRequest`: Set role first if asked and the board's role differs, then provisioning:
 *   a board paired to another hub is refused unless it is a development build; one already ours
 *   is refused; a 4-byte address and a 16-byte key are drawn from the input's entropy; the row
 *   (registry, on `deviceAdded`), the key and the resume point of 1,024 are written now in the
 *   same step as the Provision message, so the loop commits them before it goes (section 4).
 * - The Provision result: accepted gives paired; refused or not valid deletes the rows, unless
 *   the board said it was paired to this hub, when it may hold the key (PR2); no answer in 5 s ‡
 *   leaves the device provisioning, and a retry sends the same address and key.
 * - `usbEraseRequest`: Erase, to development builds only.
 *
 * Every setup frame sent or received is recorded as a hub event, the Provision message with its
 * key and Wi-Fi password zeroed. Pairing during a site move (D115) takes the site's current
 * channel and rates: the old ones while announcing, the new ones after the switch.
 */
import {
  decodeSetupMessage,
  ProvisionResultCode,
  Role,
  type SetupMessage,
  SetupType,
  toHex,
} from "@hsn/protocol";
import { err, ok, type Result } from "neverthrow";
import { answerError, answerOk, type ControlErrorCode } from "../control/view.ts";
import type { Effect } from "../model/effects.ts";
import type { DurableSnapshot } from "../model/events.ts";
import { type CoreFault, coreFault } from "../model/errors.ts";
import type { Context, Handled, Handler } from "../model/handler.ts";
import { type DeviceId, type LinkId, moduleSendRef } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { type DeviceRow, DeviceState } from "../model/rows.ts";
import { type Mono, monoAfterMs } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";
import {
  addressFree,
  deviceById,
  devicesByChip,
  deviceFields,
  firmwareNumber,
  firmwareText,
  gatewayName,
  hubEventRecord,
  type HubEventSpec,
  hubSigning,
  NAME_PROBLEM_TEXT,
  newNameProblem,
  nextDeviceId,
  roleName,
} from "../registry/view.ts";
import {
  drawAddress,
  drawKey,
  pairingData,
  pairingForRecord,
  provisionMessage,
  setupBytes,
  SITE_PROBLEM_TEXT,
  siteForPairing,
} from "./provision.ts";
import type { Asker, Exchange, Identity, SetupSlice, SitePairing, UsbBoard } from "./state.ts";
import { siteRow } from "../site/view.ts";
import { belonging } from "./view.ts";

const ORIGIN = "core/setup";

/**
 * The `ref` of every setup frame sent. Setup ignores `sendFailed`: a frame that did not leave is
 * covered by the 5 s ‡ answer timeout like a lost one. SPEC-QUESTION: section 2 gives no rule for
 * sharing `SendRef` numbers between modules; setup needs none of its own.
 */
export const SETUP_SEND_REF = moduleSendRef("setup", 0);

/** The hub's resume point written at pairing: counters 1 to 1,023 are usable at once (section 4). */
export const PAIRING_RESUME_POINT = 1024;

/** Rows a new add finds already ours (section 9: "refuses one already ours"). */
const ALREADY_OURS: ReadonlySet<DeviceState> = new Set([
  DeviceState.Paired,
  DeviceState.Contacted,
  DeviceState.LeftBehind,
]);
const PROVISIONING: ReadonlySet<DeviceState> = new Set([DeviceState.Provisioning]);

type Out = Internal | Effect;

/** A slice and what the handler emits so far. */
interface Acc {
  readonly slice: SetupSlice;
  readonly out: readonly Out[];
}
type Step = Result<Acc, CoreFault>;

const SETUP_TYPE_NAMES: Readonly<Record<number, string>> = {
  [SetupType.Identify]: "Identify",
  [SetupType.Identity]: "Identity",
  [SetupType.Provision]: "Provision",
  [SetupType.ProvisionResult]: "Provision result",
  [SetupType.Erase]: "Erase",
  [SetupType.SetRole]: "Set role",
};

// The slice.

function timersOf(boards: ReadonlyMap<LinkId, UsbBoard>): readonly TimerOf<"setup">[] {
  const timers: TimerOf<"setup">[] = [];
  for (const board of boards.values()) {
    const at = board.exchange?.deadline;
    if (at !== undefined)
      timers.push({ at, key: { module: "setup", kind: "provisionAnswer", link: board.link } });
  }
  return timers;
}

function withBoards(slice: SetupSlice, boards: ReadonlyMap<LinkId, UsbBoard>): SetupSlice {
  return { ...slice, boards, timers: timersOf(boards) };
}

function withBoard(slice: SetupSlice, board: UsbBoard): SetupSlice {
  const boards = new Map(slice.boards);
  boards.set(board.link, board);
  return withBoards(slice, boards);
}

function withRetryKey(
  slice: SetupSlice,
  device: DeviceId,
  key: Uint8Array | undefined,
): SetupSlice {
  const retryKeys = new Map(slice.retryKeys);
  if (key === undefined) retryKeys.delete(device);
  else retryKeys.set(device, key);
  return { ...slice, retryKeys };
}

/**
 * What pairing data takes from the site now (§9), from the site module's view: its current
 * channel and rate, before and after a site move's switch (D115), and the Wi-Fi details.
 */
function sitePairing(ctx: Context): SitePairing {
  const site = siteRow(ctx.view);
  return {
    channel: site.channel,
    rateMask: site.rateMask,
    wifiName: site.wifiName,
    wifiPassword: site.wifiPassword,
  };
}

// Small pieces of output.

function more(acc: Acc, ...out: readonly Out[]): Acc {
  return { slice: acc.slice, out: [...acc.out, ...out] };
}

/** A setup record's fields (section 6, the setup events of `hub_events.detail`). */
type Fields = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Records a setup event with its fields as JSON in `detail`, so a program never reads the text:
 * every setup event names its `link`, and the rest as its code says (section 6).
 */
function record(
  acc: Acc,
  ctx: Context,
  spec: Omit<HubEventSpec, "origin" | "detail">,
  fields: Fields,
): Step {
  return hubEventRecord(ctx, { ...spec, origin: ORIGIN, detail: JSON.stringify(fields) }).map(
    (item) => more(acc, item),
  );
}

/** The result code of a Provision as records name it. */
function resultName(result: number): string {
  return result === ProvisionResultCode.Accepted
    ? "accepted"
    : result === ProvisionResultCode.Refused
      ? "refused"
      : result === ProvisionResultCode.NotValid
        ? "notValid"
        : `unknown:${result}`;
}

function sendFrame(link: LinkId, bytes: Uint8Array): Effect {
  return { kind: "send", link, bytes, ref: SETUP_SEND_REF, counters: [] };
}

/** Sends a setup message and records it; `recorded` replaces it in the record (Provision). */
function send(
  acc: Acc,
  ctx: Context,
  board: UsbBoard,
  message: SetupMessage,
  recorded?: SetupMessage,
  durability?: "now",
): Step {
  return setupBytes(ctx, message).andThen((bytes) =>
    setupBytes(ctx, recorded ?? message).andThen((shown) =>
      record(
        more(acc, sendFrame(board.link, bytes)),
        ctx,
        {
          level: "info",
          code: "usb_sent",
          message: `${SETUP_TYPE_NAMES[message.type] ?? "setup message"} to ${board.label}`,
          ...(durability === undefined ? {} : { durability }),
        },
        {
          link: board.label,
          message: SETUP_TYPE_NAMES[message.type] ?? `type ${message.type}`,
          // The setup message as sent, its key bytes zeroed (section 9: a key is never recorded).
          bytes: toHex(shown),
          ...(message.type === SetupType.Provision ? { address: message.pairing.address } : {}),
        },
      ),
    ),
  );
}

/** Tells whoever asked that it did not work: the CLI's answer, or a warning for an automatic add. */
function fail(acc: Acc, ctx: Context, asker: Asker, code: ControlErrorCode, message: string): Step {
  if (asker.kind === "command") return ok(more(acc, answerError(asker.request, code, message)));
  return record(
    acc,
    ctx,
    { level: "warning", code: "automatic_add_failed", message },
    { error: code },
  );
}

function exchangeDeadline(ctx: Context): Mono {
  return monoAfterMs(ctx.now.mono, ctx.deps.rules.setup.provisionAnswerMs);
}

// Provisioning.

/** What a provisioning sends: a new device, a retry with its key, or a retry with a new key. */
interface Plan {
  readonly device: DeviceId;
  readonly address: number;
  readonly key: Uint8Array;
  readonly mayHoldKey: boolean;
  /** Messages and writes that come before the Provision message. */
  readonly before: readonly Out[];
}

/** Why an add stops before anything is written: told to the asker. */
interface Refusal {
  readonly kind: "refusal";
  readonly code: ControlErrorCode;
  readonly message: string;
}

function refusal(code: ControlErrorCode, message: string): Refusal {
  return { kind: "refusal", code, message };
}

function keyWrites(device: DeviceId, key: Uint8Array): readonly Effect[] {
  return [
    {
      kind: "write",
      durability: "now",
      op: { table: "device_keys", op: "upsert", row: { deviceId: device, key } },
    },
    {
      kind: "write",
      durability: "now",
      op: {
        table: "send_counters",
        op: "upsert",
        row: { deviceId: device, resumePoint: PAIRING_RESUME_POINT },
      },
    },
  ];
}

/** A retry of an add that left `pending` provisioning (section 9: the same address and key). */
function retryPlan(
  slice: SetupSlice,
  ctx: Context,
  pending: DeviceRow,
  identity: Identity,
  ours: boolean,
): Result<Plan, Refusal | CoreFault> {
  if (identity.role !== pending.role) {
    return err(
      refusal(
        "boardRefused",
        `the board's role changed since ${pending.name}'s add began: remove ${pending.name} and add the board again`,
      ),
    );
  }
  const key = slice.retryKeys.get(pending.id);
  if (key !== undefined) {
    return ok({ device: pending.id, address: pending.address, key, mayHoldKey: ours, before: [] });
  }
  if (ours) {
    return err(
      refusal(
        "boardRefused",
        `the board says it is paired to this hub, so it may hold the key of ${pending.name}'s interrupted add, ` +
          "which the hub cannot send again after a restart: wait for its first packet (`hsn devices` shows it contacted), " +
          "or erase it (development builds) and run the command again",
      ),
    );
  }
  // The board holds none of this hub's keys, so a new key under the same address is safe.
  return drawKey(ctx).map((fresh) => ({
    device: pending.id,
    address: pending.address,
    key: fresh,
    mayHoldKey: false,
    before: keyWrites(pending.id, fresh),
  }));
}

/** Provisions the board on `board` as `name` (section 9). */
function provision(
  acc: Acc,
  ctx: Context,
  board: UsbBoard,
  asker: Asker,
  requestedName: string,
): Step {
  const identity = board.identity;
  if (identity === undefined)
    return fail(acc, ctx, asker, "unknownPort", "the board has given no Identity");
  const hub = hubSigning(ctx.view);
  if (hub === undefined) {
    return fail(
      acc,
      ctx,
      asker,
      "failed",
      "the hub has no signing key yet, so it cannot pair a board (section 9)",
    );
  }
  const belongs = belonging(identity, hub.identity);
  if (belongs === "elsewhere" && !identity.developmentBuild) {
    return fail(
      acc,
      ctx,
      asker,
      "boardRefused",
      `the board is paired to another hub (${toHex(identity.hubIdentity)}); a release build joins this hub only after its owner resets it`,
    );
  }
  const role = roleName(identity.role);
  if (role === undefined) {
    return fail(
      acc,
      ctx,
      asker,
      "boardRefused",
      `the board has no role this hub knows (${identity.role}): give --role`,
    );
  }
  const pending = devicesByChip(ctx.view, identity.chipId, PROVISIONING)[0];
  const name = pending !== undefined && asker.kind === "automatic" ? pending.name : requestedName;

  let plan: Result<Plan, Refusal | CoreFault>;
  if (pending !== undefined) {
    if (pending.name !== name) {
      return fail(
        acc,
        ctx,
        asker,
        "nameTaken",
        `this board is being added as ${pending.name}: run the command again with --name ${pending.name}, or remove ${pending.name} first`,
      );
    }
    plan = retryPlan(acc.slice, ctx, pending, identity, belongs === "ours");
  } else {
    const known = devicesByChip(ctx.view, identity.chipId, ALREADY_OURS)[0];
    if (belongs === "ours" && known !== undefined) {
      return fail(
        acc,
        ctx,
        asker,
        "boardRefused",
        `the board is already paired to this hub as ${known.name}`,
      );
    }
    const problem = newNameProblem(ctx.view, name);
    if (problem === "taken")
      return fail(acc, ctx, asker, "nameTaken", `another device is called ${name}`);
    if (problem !== undefined)
      return fail(acc, ctx, asker, "badRequest", NAME_PROBLEM_TEXT[problem]);
    const site = siteForPairing(sitePairing(ctx), identity.role);
    if (site.isErr()) return fail(acc, ctx, asker, "failed", SITE_PROBLEM_TEXT[site.error]);
    const device = nextDeviceId(ctx.view);
    plan = drawAddress(ctx, (address) => addressFree(ctx.view, address)).andThen((address) =>
      drawKey(ctx).map((key) => ({
        device,
        address,
        key,
        mayHoldKey: false,
        before: [
          { kind: "deviceAdded", device, role: identity.role, address, name } satisfies Internal,
          ...keyWrites(device, key),
        ],
      })),
    );
  }
  if (plan.isErr()) {
    const problem = plan.error;
    return problem.kind === "refusal"
      ? fail(acc, ctx, asker, problem.code, problem.message)
      : err(problem);
  }
  return sendProvision(acc, ctx, board, asker, identity.role, plan.value);
}

function sendProvision(
  acc: Acc,
  ctx: Context,
  board: UsbBoard,
  asker: Asker,
  role: number,
  plan: Plan,
): Step {
  const hub = hubSigning(ctx.view);
  const site = siteForPairing(sitePairing(ctx), role);
  if (hub === undefined || site.isErr()) {
    return err(coreFault(ctx.event, ORIGIN, "provisioning without a signing key or site settings"));
  }
  const pairing = pairingData(plan.address, plan.key, hub, site.value.channel, site.value.site);
  const exchange: Exchange = {
    kind: "provision",
    asker,
    device: plan.device,
    deadline: exchangeDeadline(ctx),
    mayHoldKey: plan.mayHoldKey,
  };
  const slice = withRetryKey(withBoard(acc.slice, { ...board, exchange }), plan.device, plan.key);
  const started = { slice, out: [...acc.out, ...plan.before] };
  const automatic = asker.kind === "automatic";
  return send(
    started,
    ctx,
    board,
    provisionMessage(pairing),
    provisionMessage(pairingForRecord(pairing)),
    automatic ? "now" : undefined,
  );
}

/** Starts `hsn usb add` on a board with an Identity: Set role first if its role differs. */
function add(
  acc: Acc,
  ctx: Context,
  board: UsbBoard,
  asker: Asker,
  name: string,
  role: number | undefined,
): Step {
  const identity = board.identity;
  if (identity === undefined || role === undefined || identity.role === role) {
    return provision(acc, ctx, board, asker, name);
  }
  const exchange: Exchange = {
    kind: "setRole",
    asker,
    name,
    role,
    deadline: exchangeDeadline(ctx),
  };
  return send({ slice: withBoard(acc.slice, { ...board, exchange }), out: acc.out }, ctx, board, {
    type: SetupType.SetRole,
    role,
  });
}

// What arrives.

function identityArrived(acc: Acc, ctx: Context, board: UsbBoard, identity: Identity): Step {
  const hub = hubSigning(ctx.view);
  const belongs = belonging(identity, hub?.identity);
  const updated: UsbBoard = { ...board, identity };
  const kept: Acc = { slice: withBoard(acc.slice, updated), out: acc.out };
  const role = roleName(identity.role) ?? `role ${identity.role}`;
  return record(
    kept,
    ctx,
    {
      level: "info",
      code: "usb_identity",
      message: `${board.label}: ${role}, chip ${toHex(identity.chipId)}, firmware ${firmwareText(firmwareNumber(identity.firmwareVersion))}, ${
        belongs === "unpaired"
          ? "not paired"
          : belongs === "ours"
            ? "paired to this hub"
            : "paired to another hub"
      }, ${identity.developmentBuild ? "development" : "release"} build`,
    },
    {
      link: board.label,
      role: roleName(identity.role) ?? String(identity.role),
      chip: toHex(identity.chipId),
      // As `devices.firmware`: major × 65,536 + minor × 256 + patch.
      firmware: firmwareNumber(identity.firmwareVersion),
      // `unpaired`, `ours` or `other`: whether it is paired, and to this hub.
      paired: belongs,
      hubIdentity: identity.paired ? toHex(identity.hubIdentity) : null,
      development: identity.developmentBuild,
    },
  ).andThen((done) => {
    const exchange = board.exchange;
    if (exchange?.kind === "setRole") {
      const cleared: UsbBoard = { ...updated, exchange: undefined };
      const next: Acc = { slice: withBoard(done.slice, cleared), out: done.out };
      if (identity.role === exchange.role)
        return provision(next, ctx, cleared, exchange.asker, exchange.name);
      return fail(
        next,
        ctx,
        exchange.asker,
        "boardRefused",
        `the board kept role ${role}: a release build takes a role only while it has none (§10)`,
      );
    }
    const busy = exchange?.deadline !== undefined;
    const automatic = !busy && identity.role === Role.Gateway && belongs === "unpaired";
    return automatic
      ? provision(done, ctx, updated, { kind: "automatic" }, gatewayName(identity.chipId))
      : ok(done);
  });
}

function resultArrived(acc: Acc, ctx: Context, board: UsbBoard, result: number): Step {
  const exchange = board.exchange;
  if (exchange?.kind !== "provision") {
    return record(
      acc,
      ctx,
      {
        level: "warning",
        code: "usb_unexpected",
        message: `${board.label}: a Provision result with no Provision waiting (${result})`,
      },
      { link: board.label, result: resultName(result) },
    );
  }
  const told = exchange.deadline === undefined;
  const cleared: Acc = {
    slice: withBoard(acc.slice, { ...board, exchange: undefined }),
    out: acc.out,
  };
  /** Records what happened, then tells the asker, unless the timeout already did. */
  const row = deviceById(ctx.view, exchange.device);
  const fields: Fields = {
    link: board.label,
    result: resultName(result),
    ...(row === undefined ? { device: exchange.device } : deviceFields(row)),
  };
  const settle = (
    from: Acc,
    spec: Omit<HubEventSpec, "origin" | "detail">,
    tell: (done: Acc) => Step,
  ): Step => record(from, ctx, spec, fields).andThen((done) => (told ? ok(done) : tell(done)));
  if (row?.state !== DeviceState.Provisioning) {
    return settle(
      cleared,
      {
        level: "warning",
        code: "provision_orphaned",
        message: `${board.label}: a Provision result (${result}) for a device no longer provisioning`,
      },
      (done) =>
        fail(
          done,
          ctx,
          exchange.asker,
          "failed",
          "the device was removed while it was being added",
        ),
    );
  }
  const forget: Acc = { slice: withRetryKey(cleared.slice, row.id, undefined), out: cleared.out };
  const answered = more(forget, { kind: "provisionAnswered", device: row.id, result });
  if (result === ProvisionResultCode.Accepted) {
    const role = roleName(row.role) ?? "gateway";
    return settle(
      answered,
      {
        level: "info",
        code: "provision_accepted",
        message: `${row.name} accepted its pairing on ${board.label} and restarts`,
        durability: "now",
      },
      (done) =>
        ok(
          exchange.asker.kind === "command"
            ? more(
                done,
                answerOk(exchange.asker.request, {
                  kind: "usbAdd",
                  device: row.id,
                  name: row.name,
                  role,
                  address: row.address,
                  chip: toHex(row.chipId),
                }),
              )
            : done,
        ),
    );
  }
  const known = result === ProvisionResultCode.Refused || result === ProvisionResultCode.NotValid;
  const why =
    result === ProvisionResultCode.NotValid
      ? "found the pairing data not valid"
      : known
        ? "refused the pairing"
        : `answered ${result}, which this hub does not know`;
  if (!known || exchange.mayHoldKey) {
    // The board may hold the key (PR2): the rows stay, provisioning.
    const kept = known
      ? `the board ${why}, but it said it is paired to this hub and may hold ${row.name}'s key, so ${row.name} stays provisioning: wait for its first packet, or erase it (development builds) and run the command again`
      : `the board ${why}; ${row.name} stays provisioning: run the command again`;
    return settle(
      cleared,
      {
        level: "warning",
        code: "provision_unsettled",
        message: `${row.name} on ${board.label}: ${kept}`,
      },
      (done) => fail(done, ctx, exchange.asker, known ? "boardRefused" : "noAnswer", kept),
    );
  }
  return settle(
    answered,
    {
      level: "warning",
      code: "provision_refused",
      message: `${row.name} on ${board.label}: the board ${why}; its rows are deleted`,
    },
    (done) => fail(done, ctx, exchange.asker, "boardRefused", `the board ${why}; nothing was kept`),
  );
}

function frameArrived(acc: Acc, ctx: Context, link: LinkId, bytes: Uint8Array): Step {
  const board = acc.slice.boards.get(link);
  const reject = (reason: Extract<Internal, { readonly kind: "rejected" }>["reason"]): Step =>
    ok(
      more(acc, {
        kind: "rejected",
        source: { link },
        reason,
        address: undefined,
        sample: bytes.slice(0, REJECT_SAMPLE_BYTES),
        copy: undefined,
      }),
    );
  if (board === undefined) return reject("wrongPath");
  const decoded = decodeSetupMessage(bytes);
  if (!decoded.ok) return reject(decoded.error.code);
  const message = decoded.value;
  switch (message.type) {
    case SetupType.Identity:
      return identityArrived(acc, ctx, board, message);
    case SetupType.ProvisionResult:
      return resultArrived(acc, ctx, board, message.result);
    default:
      // Identify, Provision, Erase and Set role travel from the hub only (§10).
      return reject("wrongDirection");
  }
}

/** `rejects.sample` keeps the first 16 bytes (section 6). */
const REJECT_SAMPLE_BYTES = 16;

// Requests and timers.

function boardFor(
  acc: Acc,
  ctx: Context,
  link: LinkId,
  request: Asker & { readonly kind: "command" },
): Result<UsbBoard, Step> {
  const board = acc.slice.boards.get(link);
  if (board === undefined)
    return err(fail(acc, ctx, request, "unknownPort", "no USB board on that port"));
  if (board.identity === undefined) {
    return err(
      send(acc, ctx, board, { type: SetupType.Identify }).andThen((asked) =>
        fail(
          asked,
          ctx,
          request,
          "unknownPort",
          "the board has given no Identity yet; it was asked again: retry in a moment",
        ),
      ),
    );
  }
  if (board.exchange?.deadline !== undefined) {
    return err(
      fail(
        acc,
        ctx,
        request,
        "failed",
        "the board is in another setup exchange: retry in a few seconds",
      ),
    );
  }
  return ok(board);
}

function erase(
  acc: Acc,
  ctx: Context,
  link: LinkId,
  asker: Asker & { readonly kind: "command" },
): Step {
  const found = boardFor(acc, ctx, link, asker);
  if (found.isErr()) return found.error;
  const board = found.value;
  if (board.identity?.developmentBuild !== true) {
    return fail(acc, ctx, asker, "boardRefused", "Erase works on development builds only (§10)");
  }
  // The board erases and restarts; its Identity is asked again when it is next needed.
  const forgotten: Acc = {
    slice: withBoard(acc.slice, { ...board, identity: undefined }),
    out: acc.out,
  };
  return send(forgotten, ctx, board, { type: SetupType.Erase }).map((done) =>
    more(done, answerOk(asker.request, { kind: "usbErase", port: board.label })),
  );
}

function timedOut(acc: Acc, ctx: Context, link: LinkId): Step {
  const board = acc.slice.boards.get(link);
  const exchange = board?.exchange;
  if (board === undefined || exchange?.deadline === undefined || exchange.deadline > ctx.now.mono)
    return ok(acc);
  if (exchange.kind === "setRole") {
    const cleared: Acc = {
      slice: withBoard(acc.slice, { ...board, exchange: undefined }),
      out: acc.out,
    };
    return fail(
      cleared,
      ctx,
      exchange.asker,
      "noAnswer",
      "the board did not answer Set role in time: run the command again",
    );
  }
  const waiting: Acc = {
    slice: withBoard(acc.slice, { ...board, exchange: { ...exchange, deadline: undefined } }),
    out: acc.out,
  };
  return fail(
    waiting,
    ctx,
    exchange.asker,
    "noAnswer",
    "the board did not answer in time; the device stays provisioning: run the same command again, which sends the same address and key",
  );
}

function linkClosed(acc: Acc, ctx: Context, link: LinkId): Step {
  const board = acc.slice.boards.get(link);
  if (board === undefined) return ok(acc);
  const boards = new Map(acc.slice.boards);
  boards.delete(link);
  const closed: Acc = { slice: withBoards(acc.slice, boards), out: acc.out };
  const exchange = board.exchange;
  if (exchange?.deadline === undefined) return ok(closed);
  return fail(
    closed,
    ctx,
    exchange.asker,
    "noAnswer",
    "the board's USB link closed before it answered: plug it in and run the command again",
  );
}

function linkOpened(acc: Acc, ctx: Context, link: LinkId, label: string): Step {
  const board: UsbBoard = { link, label, identity: undefined, exchange: undefined };
  return send({ slice: withBoard(acc.slice, board), out: acc.out }, ctx, board, {
    type: SetupType.Identify,
  });
}

function booted(slice: SetupSlice, snapshot: DurableSnapshot): Step {
  return ok({
    slice: {
      ...slice,
      timers: [],
      boards: new Map(),
      // A device still provisioning keeps its committed key, so a retry sends it again (section 9).
      retryKeys: new Map(snapshot.provisioningKeys),
    },
    out: [],
  });
}

export const handleSetup: Handler<"setup"> = (slice, message, ctx) => {
  const acc: Acc = { slice, out: [] };
  const done = (step: Step): Result<Handled<"setup">, CoreFault> => step;
  switch (message.kind) {
    case "boot":
      return done(booted(slice, message.snapshot));
    case "linkOpened":
      return done(
        message.linkKind === "usb" ? linkOpened(acc, ctx, message.link, message.label) : ok(acc),
      );
    case "linkClosed":
      return done(linkClosed(acc, ctx, message.link));
    case "setupFrame":
      return done(frameArrived(acc, ctx, message.link, message.bytes));
    case "usbAddRequest": {
      const asker = { kind: "command", request: message.request, actor: message.actor } as const;
      const found = boardFor(acc, ctx, message.link, asker);
      return done(
        found.isErr() ? found.error : add(acc, ctx, found.value, asker, message.name, message.role),
      );
    }
    case "usbEraseRequest":
      return done(
        erase(acc, ctx, message.link, {
          kind: "command",
          request: message.request,
          actor: message.actor,
        }),
      );
    case "deviceRemoved":
      return done(ok({ slice: withRetryKey(slice, message.device, undefined), out: [] }));
    case "timer":
      return done(message.key.module === "setup" ? timedOut(acc, ctx, message.key.link) : ok(acc));
    default:
      return done(ok(acc));
  }
};
