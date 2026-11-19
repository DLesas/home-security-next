/**
 * A preview of the screens in a development build, to see each one on the simulators before a
 * phone can link (`preview-env.ts`; loaded by the root under `__DEV__` only, so no release bundle
 * holds it). It is not a hub: the client's channel is stopped, the live store is set to a house of
 * four devices, the reads the screens make are answered from the fixtures below, and the phone's
 * parts (`phone-parts.tsx`) are stand-ins set to the state asked. Changes are refused as by a hub
 * that went away.
 *
 * `EXPO_PUBLIC_HSN_PREVIEW`'s settings, `key=value;…`:
 *
 * - `look=day|night|alarm|countdown`: the house's state (default `day`); `sirens=1`: a siren reset
 *   by its owner, and groups sounding one siren of their own or none left (D144).
 * - `walk=all|/a,/b`: the routes opened in turn, `every=<s>` seconds apart (5), each logged
 *   `[preview] route "/a"`; `start=/a` opens one first.
 * - `gate=1`: not linked, so the phone's link pages show; with `link=linking|askingName|failed:<why>`,
 *   `reach=localNetworkDenied|noHubFound`, `removed=1`, `arrive=<a code opened in the app>`,
 *   `net=ask|refused|granted` (the local network permission), `camera=none|ask|refused|granted`
 *   and `scan=<text>` (read by the camera 3 s after its view shows).
 * - `vault=locked|denied|corrupt|full|failed`: the secure store's fault; `denied=1`: the system
 *   refused the local network.
 * - `keys=1`: the phone holds a backup key ("Restore a hub" shows); `restore=noKey|restoring|done|
 *   failed:<why>`: what the restore client answers, with `camera=granted;scan=<a restore code>`.
 */
import {
  type AppOpBody,
  type AppOpName,
  type AppOpReply,
  type DeviceObject,
  formatLinkQr,
  type GroupObject,
  type HubInfo,
  type ModeObject,
  type NotificationObject,
  type RestoreOffer,
} from "@hsn/protocol/app";
import { useEffect } from "react";
import { Linking, View } from "react-native";
import type { RequestOutcome } from "../hub/channel";
import type { HubClient, LinkView } from "../hub/client";
import type { Permission, Scanner, ScannerViewProps } from "../platform/scanner";
import { EMPTY_LIVE, type LiveState } from "../state/live";
import { ROUTES } from "../dev/wave0-parts";
import type { RestoreFailure } from "../hub/restore";
import type { ReachFault } from "./phone-parts";
import { parseSettings, previewSettings } from "./preview-env";
import { overridePhoneParts, standInPhoneParts } from "./stand-ins";
import { createStore } from "zustand/vanilla";
import type { ReachState } from "../hub/phone-client";
import type { VaultStatus } from "../platform/vault";

function log(what: string, value: unknown): void {
  console.log(`[preview] ${what} ${JSON.stringify(value)}`);
}

const IDENTITY = "AB3DEF7GHJ2KMNP4QRSTV5WXYZ";
const HOUR = 3_600_000;

function device(
  id: number,
  name: string,
  role: DeviceObject["role"],
  battery: number | null,
  health: Partial<DeviceObject["health"]> = {},
): DeviceObject {
  return {
    id,
    name,
    role,
    state: "contacted",
    firmware: "1.2.0",
    batteryPercent: battery,
    signal: { rssiDbm: -78, snrQuarterDb: 24 },
    temperatureC: 19,
    lastSeenMs: Date.now() - 40_000,
    heardBy: role === "gateway" ? null : 4,
    health: { silent: false, batteryLow: false, tamperOpen: false, poorLink: false, ...health },
  };
}

const DEVICES: readonly DeviceObject[] = [
  device(1, "front-door", "sensor", 88),
  device(2, "back-door", "sensor", 12, { batteryLow: true }),
  device(3, "hall-siren", "siren", null),
  device(4, "garage-gateway", "gateway", null),
];

const MODES: readonly ModeObject[] = [
  { id: 1, name: "Away", fixed: "away", groups: [1], revision: 1 },
  { id: 2, name: "Disarmed", fixed: "disarmed", groups: [], revision: 1 },
  { id: 3, name: "Night", fixed: "no", groups: [1], revision: 1 },
];

/** With `sirens=1`: a siren reset by its owner, not yet added again (D144). */
const OLD_SIREN: DeviceObject = { ...device(6, "old-siren", "siren", null), state: "resetByOwner" };

/** With `sirens=1`: a group sounding one siren of its own, and one whose only siren is gone. */
const SIREN_GROUPS: readonly GroupObject[] = [
  { id: 2, name: "Upstairs", sensors: [1], sirens: [3], revision: 1 },
  { id: 3, name: "Shed", sensors: [2], sirens: [6], revision: 1 },
];

const GROUPS: readonly GroupObject[] = [
  { id: 1, name: "Downstairs", sensors: [1, 2], sirens: "all", revision: 1 },
];

const HUB: HubInfo = {
  hub: "0.1.0",
  proto: 2,
  identity: IDENTITY,
  fingerprint: "3F:A1:09:C4:7E:22:5B:90",
  timeZone: "Europe/London",
  clockTrusted: true,
  boot: 1,
};

function notification(
  seq: number,
  category: NotificationObject["category"],
  deviceId: number | null,
  critical: boolean,
  read: boolean,
): NotificationObject {
  return {
    seq,
    atMs: Date.now() - seq * HOUR,
    clockOk: true,
    kind: category,
    category,
    critical,
    device: deviceId,
    cause: null,
    read,
    delayed: false,
  };
}

/** The house in the look asked. */
export function previewLive(look: string, linked: boolean, sirens = false): LiveState {
  const now = Date.now();
  const armed = look !== "day";
  const byId = <T extends { readonly id: number }>(items: readonly T[]) =>
    Object.fromEntries(items.map((item) => [item.id, item]));
  return {
    ...EMPTY_LIVE,
    connection: linked ? { kind: "open" } : { kind: "notLinked" },
    session: linked ? { boot: 1, client: 5, person: 1, kind: "phone", hub: IDENTITY } : null,
    rev: 1,
    hub: HUB,
    site: {
      channel: 1,
      rate: 2,
      countdownS: 30,
      autoStopS: 180,
      wifiName: "home",
      retentionRoutineDays: 30,
      retentionEventDays: 365,
    },
    mode: { mode: armed ? 1 : 2, modified: false },
    devices: byId(sirens ? [...DEVICES, OLD_SIREN] : DEVICES),
    sensors: {
      1: { id: 1, arm: armed ? "armed" : "disarmed", door: "closed", countdownSecondsLeft: null },
      2: {
        id: 2,
        arm: armed ? "armed" : "disarmed",
        door: look === "day" ? "closed" : look === "night" ? "closed" : "open",
        countdownSecondsLeft: look === "countdown" ? 25 : null,
      },
    },
    countdowns: look === "countdown" ? { 2: { secondsLeft: 25, toldAtMs: now } } : {},
    sirens: {
      3: {
        id: 3,
        should:
          look === "alarm"
            ? { kind: "sound", secondsLeft: 160 }
            : { kind: "off", secondsLeft: null },
        commanded: null,
        reported: null,
        wifi: "up",
        lora: "up",
      },
    },
    gateways: { 4: { id: 4, session: true, offline: false, lastStatusMs: now - 20_000 } },
    alarm: look === "alarm" ? { startedMs: now - 20_000, triggers: [2], sirens: [3] } : null,
    notifications: [
      notification(1, "batteryLow", 2, false, false),
      notification(2, "armDisarm", null, false, true),
    ],
    modes: byId(MODES),
    groups: byId(sirens ? [...GROUPS, ...SIREN_GROUPS] : GROUPS),
    notificationPrefs: { categories: ["batteryLow", "armDisarm", "updates"], revision: 1 },
  };
}

/** The reads the screens make, answered as a hub of that house would. */
const REPLIES: { readonly [N in AppOpName]?: (body: AppOpBody<N>) => AppOpReply<N> } = {
  "hub.info": () => HUB,
  "hub.status": () => ({
    lastCommitMs: Date.now() - 60_000,
    stagedItems: 0,
    databaseBytes: 2_400_000,
    historyShortened: false,
    missingAfterRestartMs: null,
  }),
  "people.list": () => ({
    userManagement: true,
    people: [
      { id: 1, name: "Sam", manageUsers: true, manageSystem: true, devices: [], revision: 1 },
      { id: 2, name: "Alex", manageUsers: false, manageSystem: false, devices: [], revision: 1 },
    ],
    clients: [
      {
        id: 5,
        person: 1,
        kind: "phone",
        name: "iPhone",
        createdMs: Date.now() - 48 * HOUR,
        lastSeenMs: Date.now(),
        linkedBy: 2,
      },
      {
        id: 2,
        person: 1,
        kind: "web",
        name: "Web browser",
        createdMs: Date.now() - 96 * HOUR,
        lastSeenMs: Date.now() - 3 * HOUR,
        linkedBy: 1,
      },
    ],
  }),
  "backup.status": () => ({
    folder: "D:\\Backups\\Home",
    hour: 3,
    keep: 14,
    newestMs: Date.now() - 8 * HOUR,
    due: false,
    lastResult: "ok",
  }),
  "update.status": () => ({
    staged: null,
    approvedBy: null,
    switching: false,
    lastResult: "healthy",
    lastResultMs: Date.now() - 120 * HOUR,
  }),
  "notifications.list": () => ({
    notifications: [
      notification(1, "batteryLow", 2, false, false),
      notification(2, "armDisarm", null, false, true),
      notification(3, "tamper", 1, true, true),
    ],
  }),
  "device.show": ({ device: id }) => {
    const shown = [...DEVICES, OLD_SIREN].find((d) => d.id === id) ?? DEVICES[0] ?? OLD_SIREN;
    return {
      device: shown,
      settings:
        shown.role === "siren"
          ? { max: 180, version: 2 }
          : {
              countdown: 30,
              heartbeat: 60,
              linkCheck: 10,
              replyRate: "learn",
              correction: "learn",
              version: 3,
            },
    };
  },
  "history.query": () => ({ rows: [] }),
  // A QR code as the hub makes one, to see it drawn on the phone (`qr.native.tsx`).
  "link.create": () => ({
    token: 1,
    qr: formatLinkQr({
      identity: "abcdefghijklmnopqrstuvwxya",
      secret: new Uint8Array(16).fill(7),
      addresses: ["192.168.1.20", "fd00::20"],
      port: 8444,
      fingerprint: new Uint8Array(32).fill(3),
    }),
    expiresInMs: 600_000,
  }),
};

function reply<N extends AppOpName>(op: N, body: AppOpBody<N>): RequestOutcome<N> | undefined {
  const answer: ((body: AppOpBody<N>) => AppOpReply<N>) | undefined = REPLIES[op];
  return answer === undefined ? undefined : { ok: true, body: answer(body), repeat: false };
}

const GRANTED: Permission = { state: "granted", canAskAgain: true };
const permissionOf = (asked: string | undefined): Permission =>
  asked === "granted"
    ? GRANTED
    : asked === "refused"
      ? { state: "denied", canAskAgain: false }
      : { state: "undetermined", canAskAgain: true };

/** A camera stand-in: a filled square, which reads `scan` 3 s after it shows. */
function previewScanner(camera: string | undefined, scan: string | undefined): Scanner {
  function View3({ onScanned }: ScannerViewProps) {
    useEffect(() => {
      if (scan === undefined) return;
      const timer = setTimeout(() => {
        onScanned(scan);
      }, 3000);
      return () => {
        clearTimeout(timer);
      };
    }, [onScanned]);
    return <View className="flex-1" />;
  }
  return {
    available: () => Promise.resolve(camera !== undefined && camera !== "none"),
    permission: () => Promise.resolve(permissionOf(camera)),
    ask: () => Promise.resolve({ state: "denied", canAskAgain: false }),
    View: View3,
  };
}

const OFFER: RestoreOffer = {
  identity: IDENTITY,
  epoch: 2,
  madeMs: Date.UTC(2026, 2, 3, 3, 0, 0),
  lastChangeMs: Date.UTC(2026, 2, 1, 12, 0, 0),
};

/** Starts the preview over the real client; returns the client the screens use. */
export function startPreview(real: HubClient): HubClient {
  const settings = parseSettings(previewSettings());
  log("settings", Object.fromEntries(settings));
  log("Intl", {
    ListFormat: typeof (Intl as { ListFormat?: unknown }).ListFormat,
    PluralRules: typeof (Intl as { PluralRules?: unknown }).PluralRules,
    NumberFormat: typeof (Intl as { NumberFormat?: unknown }).NumberFormat,
    RelativeTimeFormat: typeof (Intl as { RelativeTimeFormat?: unknown }).RelativeTimeFormat,
    Collator: typeof (Intl as { Collator?: unknown }).Collator,
  });
  real.stop();
  const look = settings.get("look") ?? "day";
  const linked = settings.get("gate") !== "1";
  const live = (): LiveState => {
    const state = previewLive(look, linked, settings.get("sirens") === "1");
    return settings.get("removed") === "1" ? { ...state, connection: { kind: "removed" } } : state;
  };
  const client: HubClient = {
    ...real,
    request: (op, body) => {
      const answer = reply(op, body);
      return answer === undefined ? real.request(op, body) : Promise.resolve(answer);
    },
  };
  // Again once the stopped channel's last word is in.
  real.live.setState(live(), true);
  setTimeout(() => {
    real.live.setState(live(), true);
  }, 1500);
  const linkAsked = settings.get("link");
  if (linkAsked !== undefined) {
    const [kind = "", why = "unreachable"] = linkAsked.split(":");
    const view: LinkView =
      kind === "failed"
        ? {
            kind: "failed",
            from: "qr",
            failure: why as Extract<LinkView, { kind: "failed" }>["failure"],
          }
        : kind === "askingName"
          ? { kind: "askingName", from: "qr" }
          : { kind: "linking", from: "qr" };
    real.local.setState({ link: view });
  }
  const [restoreKind = "", restoreWhy = "busy"] = (settings.get("restore") ?? "").split(":");
  const arrive = settings.get("arrive");
  overridePhoneParts((hub) => {
    const stand = standInPhoneParts(hub);
    return {
      ...stand,
      scanner: previewScanner(settings.get("camera"), settings.get("scan")),
      localNetwork: {
        permission: () => Promise.resolve(permissionOf(settings.get("net") ?? "granted")),
        ask: () => Promise.resolve({ state: "denied", canAskAgain: false }),
      },
      linker: {
        link: (secret, from, request) => {
          log("link", { from, reach: "reach" in secret ? secret.reach : null, request });
          return Promise.resolve();
        },
        reachFault: () => settings.get("reach") as ReachFault | undefined,
      },
      restorer: {
        run: (_code, offered) => {
          if (restoreKind === "failed")
            return Promise.resolve({ ok: false, fault: restoreWhy as RestoreFailure });
          if (restoreKind === "noKey")
            return Promise.resolve({ ok: false, fault: "noKey", offer: OFFER });
          offered({ offer: OFFER, homeName: "Home" });
          // "restoring" stays on its page; "done" ends at once.
          return restoreKind === "restoring"
            ? new Promise<never>(() => undefined)
            : Promise.resolve({ ok: true, offer: OFFER });
        },
      },
      holdsBackupKey: () => Promise.resolve(settings.get("keys") === "1"),
      arrived:
        arrive === undefined
          ? stand.arrived
          : { claim: () => ({ from: "deepLink", text: arrive }), subscribe: () => () => undefined },
      vault: createStore<VaultStatus>()(() => ({
        fault: (settings.get("vault") ?? null) as VaultStatus["fault"],
        identity: null,
      })),
      reach: createStore<ReachState>()(() => ({
        localNetworkDenied: settings.get("denied") === "1",
        browse: null,
      })),
    };
  });
  const first = settings.get("start");
  const walk = settings.get("walk");
  const routes = walk === undefined ? [] : walk === "all" ? ROUTES : walk.split(",");
  const open = [...(first === undefined ? [] : [first]), ...routes];
  const every = Number(settings.get("every") ?? "5") * 1000;
  open.forEach((route, n) => {
    setTimeout(
      () => {
        void Linking.openURL(`hsn://${route}`);
        log("route", route);
      },
      2500 + every * n,
    );
  });
  setTimeout(
    () => {
      log("routes", "done");
    },
    2500 + every * open.length,
  );
  return client;
}
