/** Shared relay, offered-update, and test-alert sections driven through their controls in Bun. */
import "./support/render";
import { afterEach, expect, test } from "bun:test";
import {
  type AppEvent,
  type AppEventV2,
  type AppOpBody,
  type AppOpName,
  type AppOpNameV2,
  type AppOpReply,
  type RelayStatusObject,
} from "@hsn/protocol/app";
import { createElement, Fragment } from "react";
import type { AnyOutcome, RequestOutcome } from "../src/hub/channel";
import type { HubClient } from "../src/hub/client";
import { applyEvent } from "../src/state/live";
import { clientScreen, screenAct } from "./support/client-screen";
import { screenWorld, textOf } from "./support/screens";

const { HubProvider } = await import("../src/ui/hub-context");
const { StatusScreen } = await import("../src/ui/status");
const { UpdatesScreen } = await import("../src/ui/updates");
const { NotificationsScreen } = await import("../src/ui/notifications");
const { VersionTwoProvider } = await import("../src/ui/version-two");

const up: RelayStatusObject = {
  url: "wss://relay.example.com",
  isDefault: true,
  state: "up",
  sinceMs: Date.UTC(2026, 10, 22, 12),
  roles: ["relay"],
};
const release = { version: "2.9.0", bytes: 12_345, platform: "darwin-arm64" };
const emptyStage: AppOpReply<"update.status"> = {
  staged: null,
  approvedBy: null,
  switching: false,
  lastResult: "none",
  lastResultMs: null,
};
const denied: AnyOutcome = {
  ok: false,
  error: { code: "unauthorized", detail: { permission: "manageSystem" } },
};

/** Wraps a successful fake reply as the application channel does. */
function answer<T>(body: T) {
  return { ok: true, body, repeat: false } as const;
}

let view: ReturnType<typeof clientScreen> | undefined;
afterEach(async () => {
  await view?.close();
  view = undefined;
});

/** Mounts the production screens on a non-phone client with scripted replies. */
async function mount(
  initial: Readonly<Partial<Record<AppOpNameV2, AnyOutcome>>> = {},
  options: { readonly version?: 1 | 2; readonly testAlert?: boolean } = {},
) {
  const session = { hub: "fixture", boot: 1, client: 7, person: 2, kind: "web" } as const;
  const world = await screenWorld({
    session,
    hub: {
      hub: "1.0.0",
      proto: options.version ?? 2,
      identity: "fixture",
      fingerprint: "fixture",
      timeZone: "Europe/London",
      clockTrusted: true,
      boot: 1,
    },
  });
  let staging = emptyStage;
  let revision = 0;
  let cancel: Promise<RequestOutcome<"update.cancel">> = Promise.resolve(answer({}));
  const replies: Partial<Record<AppOpNameV2, AnyOutcome>> = {
    "relay.status": answer(up),
    "relay.set": answer(up),
    "update.offers": answer({ offer: release }),
    "update.fetch": answer({ job: 7 }),
    "push.test": answer({ sent: false }),
    ...initial,
  };
  const calls: { readonly op: AppOpNameV2; readonly body: unknown }[] = [];
  const listeners = new Set<(event: AppEvent) => void>();
  const client: HubClient = {
    ...world.client,
    /** Serves the existing update flow and keeps an exact request record. */
    async request<N extends AppOpName>(op: N, body: AppOpBody<N>): Promise<RequestOutcome<N>> {
      calls.push({ op, body });
      if (op === "update.status") return answer(staging) as RequestOutcome<N>;
      if (op === "update.cancel") return (await cancel) as RequestOutcome<N>;
      return { ok: false, local: "offline" };
    },
    /** Records listeners until their screen is unmounted. */
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const channel =
    options.version === 1
      ? undefined
      : {
          testAlert: options.testAlert ?? true,
          /** Serves v2 requests from the stand-in without any dependency on the phone wiring. */
          forward(op: AppOpNameV2, body: unknown): Promise<AnyOutcome> {
            calls.push({ op, body });
            return Promise.resolve(replies[op] ?? { ok: false, local: "offline" });
          },
        };
  const screen = clientScreen();
  view = screen;
  await screen.render(
    world.wrap(
      createElement(HubProvider, {
        client,
        children: createElement(VersionTwoProvider, {
          client: channel,
          children: createElement(
            Fragment,
            null,
            createElement(StatusScreen),
            createElement(UpdatesScreen),
            createElement(NotificationsScreen),
          ),
        }),
      }),
    ),
  );

  /** Reads the text of the mounted production screen. */
  const text = () => textOf(screen.html());
  /** Waits for a query or action render, then asserts with the actual screen text on failure. */
  async function visible(words: string) {
    const end = performance.now() + 450;
    while (!text().includes(words) && performance.now() < end) {
      await screenAct(() => Bun.sleep(5));
    }
    expect(text()).toContain(words);
  }
  /** Delivers real hub event shapes through the reducer and the screen's event listener. */
  async function tell(body: Extract<AppEventV2, { ev: "hub" }>["body"]) {
    await screenAct(() => {
      const event = { t: "evt", ev: "hub", rev: ++revision, body } as const;
      client.live.setState((state) => applyEvent(state, event, 0), true);
      if (body.what !== "relay" && body.what !== "updateOffered") {
        for (const listener of listeners)
          listener({ ...event, body: { ...body, what: body.what } });
      }
    });
  }
  return {
    screen,
    client,
    text,
    visible,
    calls,
    tell,
    replies,
    /** Filters the exact recorded requests for one operation. */
    sent: (op: AppOpNameV2) => calls.filter((call) => call.op === op).map((call) => call.body),
    /** Makes the update-status reply reflect a staged version. */
    stage: (version: string) => {
      staging = { ...emptyStage, staged: version };
    },
    /** Holds a cancellation reply so the test can observe the state before success or refusal. */
    deferCancel: (pending: Promise<RequestOutcome<"update.cancel">>) => {
      cancel = pending;
    },
    /** Replaces the session and re-reads status as on reconnect. */
    reconnect: () =>
      screenAct(() => {
        client.live.setState((state) => ({
          ...state,
          session: { ...session },
          stale: { ...state.stale, hub: state.stale.hub + 1 },
        }));
      }),
  };
}

test.each([
  [
    up,
    [
      "Using the default relay setting.",
      "The relay is connected.",
      "wss://relay.example.com",
      "Since Nov 22, 2026 at 12:00 PM.",
    ],
  ],
  [
    {
      ...up,
      url: "ws://127.0.0.1:8480",
      isDefault: false,
      state: "down",
      lastError: "tls",
      roles: [],
    },
    [
      "Using a custom relay address.",
      "The relay is disconnected.",
      "ws://127.0.0.1:8480",
      "Last error: The hub could not verify the relay's secure connection.",
    ],
  ],
  [
    { ...up, state: "off", sinceMs: null, roles: [] },
    ["The relay is off.", "Since the hub started."],
  ],
  [{ ...up, url: null, state: "off", roles: [] }, ["No relay chosen."]],
] as const)("relay shows status %j in words", async (status, words) => {
  const app = await mount({ "relay.status": answer(status) });
  for (const word of words) await app.visible(word);
  expect(app.sent("relay.status")[0]).toEqual({});
  if (status.url === null) expect(app.text()).not.toContain("Relay address:");
});

test("saving trims the address, sends it unchanged otherwise, and uses the hub's refreshed status", async () => {
  const app = await mount();
  await app.visible("The relay is connected.");
  const url = "ws://127.0.0.1:8480";
  const changed = { ...up, url, isDefault: false, state: "down", roles: [] };
  app.replies["relay.status"] = answer(changed);
  app.replies["relay.set"] = answer(changed);
  expect(await app.screen.enter("Custom relay address", `   ${url}  `)).toBe(true);
  expect(await app.screen.press("Save relay address")).toBe(true);
  expect(app.sent("relay.set")).toEqual([{ url }]);
  await app.visible("Relay setting saved.");
  await app.visible("The relay is disconnected.");
  await app.visible(url);
});

test("returning to the default sends null and shows the hub's acceptance", async () => {
  const app = await mount();
  await app.visible("The relay is connected.");
  expect(await app.screen.press("Use the default relay")).toBe(true);
  expect(app.sent("relay.set")).toEqual([{ url: null }]);
  await app.visible("Relay setting saved.");
});

test("refuses an empty trimmed address on this screen without sending it", async () => {
  const app = await mount();
  await app.visible("The relay is connected.");
  expect(await app.screen.enter("Custom relay address", "   ")).toBe(true);
  expect(await app.screen.press("Save relay address")).toBe(true);
  await app.visible("Enter a relay address.");
  expect(app.sent("relay.set")).toEqual([]);
});

// The hub's bad-address table in hub/test/unit/relay-core/settings.test.ts, including its stricter cases.
const badAddress = [
  [
    "notLocal",
    [
      "ws://relay.example.com",
      "ws://relay.local",
      "ws://9.255.255.255",
      "ws://11.0.0.1",
      "ws://172.15.255.255",
      "ws://172.32.0.1",
      "ws://192.167.255.255",
      "ws://192.169.0.1",
      "ws://169.254.1.1",
      "ws://203.0.113.9",
      "ws://[fe80::1]",
      "ws://[fbff::1]",
      "ws://[fe00::1]",
      "ws://[2001:db8::1]",
      "ws://256.1.1.1",
      "ws://127.1",
    ],
    "An insecure relay address must be on this computer or the home network.",
  ],
  [
    "format",
    [
      "http://relay.example.com",
      "https://relay.example.com",
      "wss://",
      "wss://relay.example.com/v1",
      "wss://relay.example.com/v1/hub",
      "wss://user@relay.example.com",
      "wss://user:pass@relay.example.com",
      "wss://relay.example.com:0",
      "wss://relay.example.com:65536",
      "wss://relay.example.com:",
      "wss://relay.example.com?x=1",
      "wss://relay.example.com#f",
      "wss://relay .example.com",
      "ws://::1",
      "wss://[::1",
    ],
    "The hub did not accept that relay address.",
  ],
] as const;

for (const [reason, urls, words] of badAddress) {
  test.each(urls.map((url, index) => [reason, index + 1, url] as const))(
    "sends bad address %s case %i and says the hub's refusal",
    async (_reason, _number, url) => {
      const app = await mount({
        "relay.set": { ok: false, error: { code: "invalid", detail: { field: "url", reason } } },
      });
      await app.visible("The relay is connected.");
      expect(await app.screen.enter("Custom relay address", url)).toBe(true);
      expect(await app.screen.press("Save relay address")).toBe(true);
      expect(app.sent("relay.set")).toEqual([{ url }]);
      await app.visible(words);
      expect(app.text()).not.toContain("Relay setting saved.");
    },
  );
}

test("says when saving cannot reach the hub", async () => {
  const app = await mount({ "relay.set": { ok: false, local: "offline" } });
  await app.visible("The relay is connected.");
  expect(await app.screen.press("Use the default relay")).toBe(true);
  await app.visible("Not connected to the hub, so nothing was sent.");
  expect(app.text()).not.toContain("Relay setting saved.");
});

test("a relay event refreshes the status and adds no empty global notice", async () => {
  const app = await mount();
  await app.visible("The relay is connected.");
  app.replies["relay.status"] = answer({ ...up, state: "down", lastError: "dns" });
  await app.tell({ what: "relay", detail: {} });
  await app.visible("Last error: The relay address could not be found.");
  expect(app.client.live.getState().hubNotices).toEqual([]);
});

test("no release is offered", async () => {
  const app = await mount({ "update.offers": answer({ offer: null }) });
  await app.visible("No hub update is available to download.");
  expect(app.screen.html()).not.toContain('aria-label="Download"');
  expect(app.sent("update.offers")[0]).toEqual({});
});

/** Presses Download as a user would and checks the version sent to the hub. */
async function download(app: Awaited<ReturnType<typeof mount>>) {
  await app.visible("Version 2.9.0 is available (12,345 bytes).");
  expect(await app.screen.press("Download")).toBe(true);
  expect(app.sent("update.fetch")).toEqual([{ version: "2.9.0" }]);
}

test("an accepted download stays in progress until staging, then uses the existing approval", async () => {
  const app = await mount();
  await download(app);
  await app.visible("Downloading version 2.9.0.");
  expect(await app.screen.press("Download")).toBe(false);
  expect(app.screen.html()).not.toContain('aria-label="Approve version 2.9.0"');
  app.stage("2.9.0");
  await app.tell({ what: "updateStaged", detail: { value: null } });
  await app.visible("Version 2.9.0 downloaded.");
  await app.visible("Version 2.9.0 is ready.");
  expect(app.screen.html()).toContain('aria-label="Approve version 2.9.0"');
  expect(app.text()).not.toContain("Downloading version 2.9.0.");
  expect(app.screen.html()).not.toContain('aria-label="Download"');
});

test("a removed offer is refused immediately with its own words", async () => {
  const app = await mount({
    "update.fetch": {
      ok: false,
      error: { code: "invalid", detail: { field: "version", reason: "unknownReference" } },
    },
  });
  await download(app);
  await app.visible("This version is no longer available. Check the latest offer.");
  expect(app.text()).not.toContain("Downloading version 2.9.0.");
});

test("a later matching fetch refusal uses the hub's reason and ignores an unrelated one", async () => {
  const app = await mount();
  await download(app);
  await app.visible("Downloading version 2.9.0.");
  await app.tell({
    what: "updateRefused",
    detail: { reason: JSON.stringify({ version: "2.8.0", reason: "badFile" }) },
  });
  expect(app.text()).toContain("Downloading version 2.9.0.");
  await app.tell({
    what: "updateRefused",
    detail: { reason: JSON.stringify({ version: "2.9.0", reason: "badSignature" }) },
  });
  await app.visible(
    "Could not download version 2.9.0. That release is not signed by a key this hub trusts.",
  );
  expect(app.text()).not.toContain("Downloading version 2.9.0.");
});

test.each([[false], [true]] as const)(
  "a newer offer replaces the download, including when its refusal arrives first (%s)",
  async (first) => {
    const app = await mount();
    await download(app);
    await app.visible("Downloading version 2.9.0.");
    if (first)
      await app.tell({
        what: "updateRefused",
        detail: {
          reason: JSON.stringify({
            version: "2.9.0",
            reason: "io",
            message: "the release fetch is no longer wanted",
          }),
        },
      });
    app.replies["update.offers"] = answer({ offer: { ...release, version: "2.10.0" } });
    await app.tell({ what: "updateOffered", detail: { version: "2.10.0", bytes: release.bytes } });
    await app.visible("A newer update replaced version 2.9.0.");
    await app.visible("Version 2.10.0 is available");
    expect(app.text()).not.toContain("Downloading version 2.9.0.");
    expect(
      app.client.live
        .getState()
        .hubNotices.some((notice) => !(notice.what in { updateRefused: true })),
    ).toBe(false);
  },
);

test.each([[true], [false]] as const)(
  "cancelling reports the hub's answer only after it arrives (%s)",
  async (accepted) => {
    const app = await mount();
    const pending = Promise.withResolvers<RequestOutcome<"update.cancel">>();
    app.deferCancel(pending.promise);
    await download(app);
    await app.visible("Downloading version 2.9.0.");
    expect(await app.screen.press("Cancel download")).toBe(true);
    expect(app.sent("update.cancel")).toEqual([{}]);
    expect(app.text()).toContain("Downloading version 2.9.0.");
    expect(app.text()).not.toContain("Download cancelled.");
    await screenAct(() => {
      pending.resolve(accepted ? answer({}) : { ok: false, local: "offline" });
    });
    if (accepted) {
      await app.visible("Download cancelled.");
      expect(app.text()).not.toContain("Downloading version 2.9.0.");
      expect(await app.screen.press("Download")).toBe(true);
      await app.visible("Downloading version 2.9.0.");
      expect(app.text()).not.toContain("Download cancelled.");
    } else {
      await app.visible("Not connected to the hub, so nothing was sent.");
      expect(app.text()).toContain("Downloading version 2.9.0.");
    }
  },
);

test("a fresh status read on reconnect has no stale in-progress or local cancellation text", async () => {
  const app = await mount();
  await download(app);
  await app.visible("Downloading version 2.9.0.");
  await app.reconnect();
  await app.visible("No update is waiting.");
  expect(app.text()).not.toContain("Downloading version 2.9.0.");
  expect(app.text()).not.toContain("Download cancelled.");
  expect(app.screen.html()).toContain('aria-label="Download"');
});

test.each([
  [false, "No test alert was sent."],
  [true, "The hub sent a test alert."],
] as const)("a test alert says whether it was sent (%s)", async (sent, words) => {
  const app = await mount({ "push.test": answer({ sent }) });
  expect(await app.screen.press("Send a test alert")).toBe(true);
  expect(app.sent("push.test")).toEqual([{}]);
  await app.visible(words);
  expect(app.text()).not.toContain(sent ? "No test alert was sent." : "The hub sent a test alert.");
});

test("read refusals hide relay settings and offers from a person without manage system", async () => {
  const app = await mount({ "relay.status": denied, "update.offers": denied });
  expect(app.sent("relay.status")).toEqual([{}]);
  expect(app.sent("update.offers")).toEqual([{}]);
  expect(app.text()).not.toContain("Available hub updates");
  expect(app.screen.html()).not.toContain('aria-label="Save relay address"');
  expect(app.screen.html()).not.toContain('aria-label="Use the default relay"');
  expect(app.screen.html()).not.toContain('aria-label="Download"');
  expect(app.screen.html()).toContain('aria-label="Send a test alert"');
});

test("version 1 clients show none of the three sections and send none of their requests", async () => {
  const app = await mount({}, { version: 1 });
  expect(app.text()).not.toContain("Available hub updates");
  expect(app.screen.html()).not.toContain('aria-label="Relay"');
  expect(app.screen.html()).not.toContain('aria-label="Send a test alert"');
  expect(app.calls.map((call) => call.op)).not.toContain("relay.status");
  expect(app.calls.map((call) => call.op)).not.toContain("update.offers");
  expect(app.calls.map((call) => call.op)).not.toContain("push.test");
});

test("all three shared sections render for a non-phone stand-in with version 2", async () => {
  const app = await mount();
  await app.visible("The relay is connected.");
  await app.visible("Available hub updates");
  expect(app.screen.html()).toContain('aria-label="Send a test alert"');
  expect(app.client.live.getState().session?.kind).toBe("web");
});

test("a version 2 client without the test-alert capability has no test-alert button", async () => {
  const app = await mount({}, { testAlert: false });
  await app.visible("The relay is connected.");
  await app.visible("Available hub updates");
  expect(app.screen.html()).not.toContain('aria-label="Send a test alert"');
});
