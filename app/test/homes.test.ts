/**
 * Several homes on one phone (m3-design.md section 6, "Several hubs"; `src/ui/homes.ts`), over the
 * phone's real vault in memory and a stand-in of its session: the names on this phone ("Home",
 * "Home 2", kept when another goes, kept across a restart, a bad one refused); choosing another;
 * removing a home, its three steps in order and each step's failure, which leaves the home as it
 * was; then This phone's homes, the line on Home, the Settings row, and the way back after "Link
 * another home". Against two real hubs: `homes-real-hub.test.ts`.
 */
import "./support/render";
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import assert from "node:assert/strict";
import { nodeSha256 } from "@hsn/protocol";
import { appIdentityBytes, formatIdentity, x25519StaticKey } from "@hsn/protocol/app";
import type { AnyOutcome } from "../src/hub/channel";
import type { StoredClient } from "../src/platform/client-key";
import { keyPairOf } from "../src/platform/keys.native";
import { memorySecureItems, type MemoryItems, phoneRecords } from "../src/platform/vault";
import { createLiveStore, EMPTY_LIVE, type LiveState } from "../src/state/live";
import {
  followHomes,
  type Homes,
  type HomesDeps,
  nextHomeName,
  phoneHomes,
  pushRegistrationOf,
  REMOVAL_REACH_MS,
} from "../src/ui/homes";
import { clientScreen } from "./support/client-screen";
import { screenWorld, textOf } from "./support/screens";
import { manualTimers } from "./support/timers";

const { PhoneProvider } = await import("../src/ui/phone-parts");
const { standInPhoneParts } = await import("../src/ui/stand-ins");
const { ThisPhoneScreen, afterLinking, removeFaultKey } = await import("../src/ui/this-phone");
const { StateField } = await import("../src/ui/state-field");
const { backTarget, placeOf } = await import("../src/ui/navigation");

function hubOf(seed: number): { identity: string; staticKey: Uint8Array } {
  const key = x25519StaticKey(new Uint8Array(32).fill(seed));
  assert(key.ok, "hub test key");
  return {
    identity: formatIdentity(appIdentityBytes(nodeSha256, key.value.publicKey)),
    staticKey: key.value.publicKey,
  };
}

const HUBS = [hubOf(7), hubOf(8), hubOf(9), hubOf(10)] as const;
const [A, B, C, D] = HUBS.map((h) => h.identity) as [string, string, string, string];

function recordFor(hub: { identity: string; staticKey: Uint8Array }, client: number) {
  const pair = keyPairOf(new Uint8Array(32).fill(client + 40));
  assert(pair !== undefined, "phone test key");
  const record: StoredClient<Uint8Array> = {
    key: pair,
    hub: { identity: hub.identity, staticKey: hub.staticKey, client, person: 1 },
    lastSeq: 0,
    reach: {
      addresses: ["192.168.1.20"],
      appsPort: 8444,
      lastAddress: null,
      relayUrl: null,
      homeName: "",
    },
  };
  return record;
}

const OPEN: Partial<LiveState> = {
  connection: { kind: "open" },
  session: { boot: 1, client: 1, person: 1, kind: "phone", hub: "hub" },
};

/**
 * A phone with `count` homes linked (the first chosen), and a stand-in of its session: choosing a
 * home closes the session and opens the chosen one's at once, unless the test says it cannot be
 * reached. Every step a removal takes is written to `log`.
 */
async function phoneWith(
  count: number,
  options: {
    items?: MemoryItems;
    registered?: boolean;
    unregister?: AnyOutcome;
    remove?: Awaited<ReturnType<HomesDeps["request"]>>;
  } = {},
) {
  const items = options.items ?? memorySecureItems();
  const records = phoneRecords(items);
  for (const [n, hub] of HUBS.slice(0, count).entries())
    await records.add(recordFor(hub, n + 4), null, n === 0);
  const live = createLiveStore({ ...EMPTY_LIVE, ...OPEN });
  const timers = manualTimers();
  const log: string[] = [];
  const unreachable = new Set<string>();
  const removedByHub = new Set<string>();
  const deps: HomesDeps = {
    records: {
      list: () => records.list(),
      chosen: () => records.chosen(),
      hub: (identity) => records.hub(identity),
      remove: async (identity) => {
        log.push(`delete ${identity}`);
        return records.remove(identity);
      },
    },
    choose: async (identity) => {
      log.push(`choose ${identity ?? "none"}`);
      live.setState(EMPTY_LIVE, true);
      const chose = await records.choose(identity);
      if (identity === null) live.setState({ connection: { kind: "notLinked" } });
      else if (removedByHub.has(identity)) live.setState({ connection: { kind: "removed" } });
      else if (!unreachable.has(identity)) live.setState(OPEN);
      return chose;
    },
    live,
    request: (op, body) => {
      log.push(`${op} ${JSON.stringify(body)}`);
      return Promise.resolve(options.remove ?? { ok: true, body: {}, repeat: false });
    },
    unregister: () => {
      log.push("push.unregister");
      return Promise.resolve(options.unregister ?? { ok: true, body: {}, repeat: false });
    },
    pushRegistered: () => Promise.resolve(options.registered ?? false),
    timers,
    defaultName: (n) => (n === 1 ? "Home" : `Home ${String(n)}`),
  };
  const homes = phoneHomes(deps);
  await homes.refresh();
  return { homes, records, items, live, timers, log, unreachable, removedByHub, deps };
}

const names = (homes: Homes) => homes.store.getState().homes.map((h) => h.name);

describe("names on this phone", () => {
  test("the first free of Home, Home 2, Home 3, in the order linked; written, so they stay when another goes", async () => {
    const phone = await phoneWith(3);
    expect(names(phone.homes)).toEqual(["Home", "Home 2", "Home 3"]);
    const written = await phone.records.hub(C).read();
    expect(written.ok && written.value?.reach?.homeName).toBe("Home 3");
    // Home goes: the others keep their names; a new home takes the free "Home".
    expect((await phone.homes.remove(A)).ok).toBe(true);
    expect(names(phone.homes)).toEqual(["Home 2", "Home 3"]);
    await phone.records.add(recordFor(HUBS[3], 9), null);
    await phone.homes.refresh();
    expect(names(phone.homes)).toEqual(["Home 2", "Home 3", "Home"]);
  });

  test("a default name never repeats one the person gave to a later home", async () => {
    expect(nextHomeName([], (n) => `H${String(n)}`)).toBe("H1");
    expect(nextHomeName(["H1", "H2"], (n) => `H${String(n)}`)).toBe("H3");
    expect(nextHomeName(["H2"], (n) => `H${String(n)}`)).toBe("H1");
    const items = memorySecureItems();
    const records = phoneRecords(items);
    await records.add(recordFor(HUBS[0], 4), null, true);
    await records.add({ ...recordFor(HUBS[1], 5) }, null);
    await records.hub(B).update((r) => ({ ...r, reach: { ...r.reach!, homeName: "Home" } }));
    const phone = await phoneWith(0, { items });
    expect(names(phone.homes)).toEqual(["Home 2", "Home"]);
  });

  test("renaming is this phone's only, and is kept across a restart", async () => {
    const phone = await phoneWith(2);
    expect(await phone.homes.rename(B, "  The flat  ")).toEqual({ ok: true, value: undefined });
    expect(names(phone.homes)).toEqual(["Home", "The flat"]);
    // Nothing was sent to any hub.
    expect(phone.log).toEqual([]);
    const restarted = await phoneWith(0, { items: memorySecureItems(phone.items.disk) });
    expect(names(restarted.homes)).toEqual(["Home", "The flat"]);
  });

  test("a name the hub would not take either is refused, and nothing is written", async () => {
    const phone = await phoneWith(1);
    const before = phone.items.writes.length;
    expect(await phone.homes.rename(A, "   ")).toEqual({ ok: false, fault: "badName" });
    expect(await phone.homes.rename(A, "x".repeat(65))).toEqual({ ok: false, fault: "badName" });
    expect(phone.items.writes.length).toBe(before);
    expect((await phone.homes.rename(A, "x".repeat(64))).ok).toBe(true);
  });
});

describe("choosing a home", () => {
  test("closes the chosen one's session and opens the other's; choosing the chosen one does nothing", async () => {
    const phone = await phoneWith(2);
    expect(phone.homes.store.getState().chosen).toBe(A);
    await phone.homes.choose(A);
    expect(phone.log).toEqual([]);
    await phone.homes.choose(B);
    expect(phone.log).toEqual([`choose ${B}`]);
    expect(phone.homes.store.getState().chosen).toBe(B);
    const chosen = await phone.records.chosen();
    expect(chosen.ok && chosen.value).toBe(B);
  });
});

describe("removing a home from this phone", () => {
  const removal = (client: number) => `client.remove {"client":${String(client)},"also":[]}`;

  test("with a push registration: push.unregister, then client.remove for itself, then the record; the first home left is chosen", async () => {
    const phone = await phoneWith(2, { registered: true });
    expect(await phone.homes.remove(A)).toEqual({ ok: true, value: undefined });
    expect(phone.log).toEqual(["push.unregister", removal(4), `delete ${A}`, `choose ${B}`]);
    expect(phone.homes.store.getState()).toMatchObject({
      chosen: B,
      removing: null,
      homes: [{ identity: B, name: "Home 2" }],
    });
    expect([...phone.items.disk.keys()].some((k) => k.startsWith(`hub.${A}`))).toBe(false);
  });

  test("with none (as today): no push.unregister, and pushRegistrationOf finds none", async () => {
    expect(await pushRegistrationOf(A)).toBe(false);
    const phone = await phoneWith(2);
    expect((await phone.homes.remove(A)).ok).toBe(true);
    expect(phone.log).toEqual([removal(4), `delete ${A}`, `choose ${B}`]);
  });

  test("a home not chosen: its session is opened for the steps, and the chosen one's again after", async () => {
    const phone = await phoneWith(3, { registered: true });
    expect((await phone.homes.remove(B)).ok).toBe(true);
    expect(phone.log).toEqual([
      `choose ${B}`,
      "push.unregister",
      removal(5),
      `delete ${B}`,
      `choose ${A}`,
    ]);
    expect(phone.homes.store.getState().chosen).toBe(A);
    expect(names(phone.homes)).toEqual(["Home", "Home 3"]);
  });

  test("the last home: none is chosen after, so the phone shows its link pages", async () => {
    const phone = await phoneWith(1);
    expect((await phone.homes.remove(A)).ok).toBe(true);
    expect(phone.log.at(-1)).toBe("choose none");
    expect(phone.homes.store.getState()).toMatchObject({ chosen: null, homes: [] });
  });

  test("a home whose session does not open within 15 s: nothing sent, kept, and the chosen one back", async () => {
    const phone = await phoneWith(2, { registered: true });
    phone.unreachable.add(B);
    let done: Awaited<ReturnType<Homes["remove"]>> | undefined;
    const running = phone.homes.remove(B).then((outcome) => {
      done = outcome;
    });
    await Bun.sleep(5);
    expect(phone.homes.store.getState().removing).toBe(B);
    phone.timers.advance(REMOVAL_REACH_MS - 1);
    await Bun.sleep(5);
    expect(done).toBeUndefined();
    phone.timers.advance(1);
    await running;
    expect(done).toEqual({ ok: false, fault: { step: "reach" } });
    expect(phone.log).toEqual([`choose ${B}`, `choose ${A}`]);
    expect(names(phone.homes)).toEqual(["Home", "Home 2"]);
    expect(phone.homes.store.getState()).toMatchObject({ chosen: A, removing: null });
  });

  test("push.unregister refused: client.remove is not sent, the home stays", async () => {
    const refused: AnyOutcome = { ok: false, local: "offline" };
    const phone = await phoneWith(2, { registered: true, unregister: refused });
    const outcome = await phone.homes.remove(A);
    expect(outcome).toEqual({ ok: false, fault: { step: "push", failure: refused } });
    expect(phone.log).toEqual(["push.unregister"]);
    expect(names(phone.homes)).toEqual(["Home", "Home 2"]);
    expect(phone.homes.store.getState().chosen).toBe(A);
  });

  test("client.remove refused: the record is not deleted", async () => {
    const refused: AnyOutcome = { ok: false, local: "lost" };
    const phone = await phoneWith(2, { remove: refused });
    const outcome = await phone.homes.remove(B);
    expect(outcome).toEqual({ ok: false, fault: { step: "client", failure: refused } });
    expect(phone.log).toEqual([`choose ${B}`, removal(5), `choose ${A}`]);
    expect(names(phone.homes)).toEqual(["Home", "Home 2"]);
  });

  test("the hub's session event before its reply (`removed`) counts as removed", async () => {
    const phone = await phoneWith(2, { remove: { ok: false, local: "removed" } });
    expect((await phone.homes.remove(A)).ok).toBe(true);
    expect(phone.log).toContain(`delete ${A}`);
  });

  test("a home the hub had already removed: only the record is left to delete", async () => {
    const phone = await phoneWith(2, { registered: true });
    phone.removedByHub.add(B);
    expect((await phone.homes.remove(B)).ok).toBe(true);
    expect(phone.log).toEqual([`choose ${B}`, `delete ${B}`, `choose ${A}`]);
  });

  test("one removal at a time; a home not on the phone is already removed", async () => {
    const phone = await phoneWith(2);
    const first = phone.homes.remove(A);
    expect(await phone.homes.remove(B)).toEqual({ ok: false, fault: { step: "reach" } });
    await first;
    expect(await phone.homes.remove(A)).toEqual({ ok: true, value: undefined });
  });
});

describe("following the phone client", () => {
  test("read again when the connection changes kind (a link chose a new home)", async () => {
    const phone = await phoneWith(1);
    const stop = followHomes(phone.homes, phone.live);
    await phone.records.add(recordFor(HUBS[1], 5), null, true);
    phone.live.setState({ connection: { kind: "loading" } });
    await Bun.sleep(20);
    expect(phone.homes.store.getState().chosen).toBe(B);
    expect(names(phone.homes)).toEqual(["Home", "Home 2"]);
    stop();
  });
});

describe("the pages", () => {
  async function shown(
    homes: Homes,
    page: ReturnType<typeof createElement>,
    live: Partial<LiveState> = {},
  ) {
    const made = await screenWorld(live);
    const parts = { ...standInPhoneParts(made.client), homes };
    const screen = clientScreen();
    await screen.render(made.wrap(createElement(PhoneProvider, { parts, children: page })));
    return screen;
  }

  test("This phone's homes: each name, In use beside the chosen one, switching, Link another home", async () => {
    const phone = await phoneWith(2);
    let linking = 0;
    const screen = await shown(
      phone.homes,
      createElement(ThisPhoneScreen, {
        onLinkAnother: () => {
          linking += 1;
        },
      }),
    );
    const text = textOf(screen.html());
    expect(text).toContain("Homes");
    expect(text).toMatch(/Home\s+In use/u);
    expect(text).toContain("Home 2");
    expect(text).toContain("Remove this home from this phone");
    expect(await screen.press("Switch to Home")).toBe(false);
    expect(await screen.press("Switch to Home 2")).toBe(true);
    expect(phone.log).toEqual([`choose ${B}`]);
    expect(textOf(screen.html())).toMatch(/Home 2\s+In use/u);
    expect(await screen.press("Link another home")).toBe(true);
    expect(linking).toBe(1);
    await screen.close();
  });

  test("removing from the page asks twice, then says it; a removal that could not reach the home says so", async () => {
    const phone = await phoneWith(2);
    const screen = await shown(
      phone.homes,
      createElement(ThisPhoneScreen, { onLinkAnother: () => undefined }),
    );
    expect(await screen.press("Remove this home from this phone")).toBe(true);
    expect(textOf(screen.html())).toContain("Remove Home from this phone?");
    expect(await screen.press("Remove Home")).toBe(true);
    expect(textOf(screen.html())).toContain("Home was removed from this phone.");
    expect(names(phone.homes)).toEqual(["Home 2"]);
    phone.unreachable.add(B);
    phone.live.setState({ ...EMPTY_LIVE, connection: { kind: "connecting", attempt: 0 } }, true);
    await screen.press("Remove this home from this phone");
    const removing = screen.press("Remove Home 2");
    await Bun.sleep(5);
    phone.timers.advance(REMOVAL_REACH_MS);
    await removing;
    await Bun.sleep(5);
    expect(textOf(screen.html())).toContain(
      "This phone could not reach Home 2, so it is still on this phone.",
    );
    await screen.close();
  });

  test("each fault of a removal has its words", () => {
    expect(removeFaultKey({ step: "reach" })).toBe("homes.notReached");
    expect(removeFaultKey({ step: "push", failure: { ok: false, local: "offline" } })).toBe(
      "homes.pushRefused",
    );
    expect(removeFaultKey({ step: "storage" })).toBe("homes.storage");
    expect(removeFaultKey({ step: "client", failure: { ok: false, local: "offline" } })).toBeNull();
  });

  test("Home names the chosen home above the state sentence, with Change, only with more than one; never in the sentence", async () => {
    const two = await phoneWith(2);
    await two.homes.rename(A, "Grandma's");
    const screen = await shown(two.homes, createElement(StateField), { ...OPEN, modes: {} });
    const html = screen.html();
    const text = textOf(html);
    expect(text.indexOf("Grandma's Change")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Grandma's")).toBeLessThan(text.indexOf("Disarmed"));
    expect(html).toContain('href="/this-phone"');
    const sentence = /data-testid="current-mode"[^>]*>([^<]*)</u.exec(html)?.[1];
    expect(sentence).toBe("Disarmed");
    await screen.close();
    const one = await phoneWith(1);
    const alone = await shown(one.homes, createElement(StateField), { ...OPEN, modes: {} });
    expect(alone.html()).not.toContain("home-line");
    expect(textOf(alone.html())).not.toContain("Change");
    await alone.close();
  });

  test("the home name stays outside the alarm heading and announcement", async () => {
    const phone = await phoneWith(2);
    const screen = await shown(phone.homes, createElement(StateField), {
      ...OPEN,
      alarm: { startedMs: 1, triggers: [], sirens: [] },
    });
    const html = screen.html();
    const text = textOf(html);
    expect(text).toContain("Home Change Alarm");
    expect(html.match(/<[^>]+role="alert"[^>]*>(.*?)<\/div>/u)?.[1]).not.toContain("Change");
    expect(html).toMatch(/<[^>]+aria-level="1"[^>]*>Alarm</u);
    await screen.close();
  });

  test("This phone and Link another home belong to Settings; once linked, back to This phone", () => {
    expect(placeOf("/this-phone").destination.index).toBe("/settings");
    expect(backTarget("/this-phone")).toBe("/settings");
    expect(backTarget("/link-home")).toBe("/settings");
    expect(afterLinking("linking", "linked", "/link-home")).toBe("/this-phone");
    expect(afterLinking("linked", "linked", "/link-home")).toBeNull();
    expect(afterLinking("linking", "failed", "/link-home")).toBeNull();
    expect(afterLinking("linking", "linked", "/")).toBeNull();
  });
});
