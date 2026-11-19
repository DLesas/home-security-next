/**
 * Step 3's screens as the web build renders them (m2-design.md sections 7, 8 and 9): states in
 * words; fixed modes not editable; a missed schedule said with why; permissions hidden while user
 * management is off (D13), "no access yet" when on; a removal naming what it takes with it; the
 * critical notices announced at once; the restore code shown only after going on (D122); what
 * the store does not know said so, not guessed.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import type {
  ClientObject,
  DeviceObject,
  GroupObject,
  ModeObject,
  ScheduleObject,
} from "@hsn/protocol/app";
import { renderWith, textOf } from "./support/screens";

const groups = await import("../src/ui/groups");
const modes = await import("../src/ui/modes");
const schedules = await import("../src/ui/schedules");
const clients = await import("../src/ui/clients");
const people = await import("../src/ui/people");
const notifications = await import("../src/ui/notifications");
const backup = await import("../src/ui/backup");
const site = await import("../src/ui/site");
const banners = await import("../src/ui/banners");

function device(id: number, name: string, role: DeviceObject["role"]): DeviceObject {
  return {
    id,
    name,
    role,
    state: "paired",
    firmware: "1",
    batteryPercent: null,
    signal: null,
    temperatureC: null,
    lastSeenMs: null,
    heardBy: null,
    health: { silent: false, batteryLow: false, tamperOpen: false, poorLink: false },
  };
}
const DEVICES = {
  4: device(4, "front-door", "sensor"),
  5: device(5, "back-door", "sensor"),
  9: device(9, "hall-siren", "siren"),
};
const AWAY: ModeObject = { id: 1, name: "Away", fixed: "away", groups: [], revision: 0 };
const NIGHT: ModeObject = { id: 3, name: "Night", fixed: "no", groups: [7], revision: 2 };
const DOWNSTAIRS: GroupObject = {
  id: 7,
  name: "Downstairs",
  sensors: [4, 5],
  sirens: [9],
  revision: 1,
};
const HUB = {
  hub: "1",
  proto: 1,
  identity: "x",
  fingerprint: "y",
  timeZone: "Europe/London",
  clockTrusted: true,
  boot: 1,
};

describe("groups, modes and schedules", () => {
  test("a group: its sensors and its sirens in words, with change and delete", async () => {
    const html = await renderWith(createElement(groups.GroupsScreen), {
      devices: DEVICES,
      groups: { 7: DOWNSTAIRS },
    });
    const text = textOf(html);
    expect(text).toContain("Sensors: front-door and back-door.");
    // Which sirens sound, in one sentence under its name (D144).
    expect(text).toContain("Downstairs hall-siren sounds for this group.");
    expect(html).toContain('aria-label="Delete Downstairs"');
  });

  test("no group yet: said so", async () => {
    expect(textOf(await renderWith(createElement(groups.GroupsScreen), {}))).toContain(
      "No groups yet. A group says which sirens sound when its doors open.",
    );
  });

  test("fixed modes cannot be changed or deleted; the current one is said", async () => {
    const html = await renderWith(createElement(modes.ModesScreen), {
      groups: { 7: DOWNSTAIRS },
      modes: { 1: AWAY, 3: NIGHT },
      mode: { mode: 1, modified: false },
    });
    const text = textOf(html);
    expect(text).toContain(
      "Away Arms every sensor. This is the current mode. A fixed mode: it cannot be changed or deleted.",
    );
    expect(text).toContain("Night Arms: Downstairs.");
    expect(html).not.toContain('aria-label="Delete Away"');
    expect(html).toContain('aria-label="Delete Night"');
  });

  test("a schedule entry: what, when, the next run in the hub's zone, and a miss with why", async () => {
    const entry: ScheduleObject = {
      id: 2,
      name: "Bedtime",
      action: "switchMode",
      target: { mode: 3 },
      at: "22:00",
      days: ["mon", "fri"],
      enabled: true,
      nextMs: Date.UTC(2026, 10, 16, 22, 0),
      missed: { dueMs: Date.UTC(2026, 10, 13, 22, 0), why: "hubOff", count: 3 },
      revision: 0,
    };
    const text = textOf(
      await renderWith(createElement(schedules.SchedulesScreen), {
        hub: HUB,
        modes: { 3: NIGHT },
        schedules: { 2: entry },
      }),
    );
    expect(text).toContain("Switches to Night at 22:00 On Monday and Friday");
    expect(text).toContain("Next: Nov 16, 2026 at 10:00 PM");
    expect(text).toContain("Missed at Nov 13, 2026 at 10:00 PM: the hub was off. And 2 earlier.");
  });

  test("the schedules page: its introduction, under the title, names the hub's time zone", async () => {
    const route = await import("../src/app/schedules");
    const text = textOf(await renderWith(createElement(route.default), { hub: HUB }));
    expect(text).toContain("Schedules Each entry does one thing at one time");
    expect(text).toContain("time zone (Europe/London)");
  });
});

describe("people", () => {
  const ben = {
    id: 2,
    name: "Ben",
    manageUsers: false,
    manageSystem: false,
    devices: [],
    revision: 0,
  };
  test("while user management is off, no permissions are shown (D13); on, a person with none has no access yet", async () => {
    const off = textOf(
      await renderWith(
        createElement(people.PersonItem, {
          person: ben,
          clients: [],
          managing: false,
          onRemoved: () => undefined,
        }),
        { devices: DEVICES },
      ),
    );
    expect(off).not.toContain("What Ben may do");
    expect(off).not.toContain("No access yet");
    const on = textOf(
      await renderWith(
        createElement(people.PersonItem, {
          person: ben,
          clients: [],
          managing: true,
          onRemoved: () => undefined,
        }),
        { devices: DEVICES },
      ),
    );
    expect(on).toContain("No access yet: give this person permissions below.");
    expect(on).toContain("What Ben may do");
    expect(on).toContain("Arm, disarm and set front-door");
  });

  test("a device's removal lists what it linked, ticked; the question counts them", async () => {
    const now = Date.now();
    const phone: ClientObject = {
      id: 1,
      person: 1,
      kind: "phone",
      name: "Anna's phone",
      createdMs: now - 1000,
      lastSeenMs: null,
      linkedBy: null,
    };
    const all: readonly ClientObject[] = [
      phone,
      {
        id: 2,
        person: 1,
        kind: "web",
        name: "Laptop",
        createdMs: now - 1000,
        lastSeenMs: null,
        linkedBy: 1,
      },
    ];
    const html = await renderWith(
      createElement(clients.ClientItem, { client: phone, all, onRemoved: () => undefined }),
      {
        session: { boot: 1, client: 2, person: 1, kind: "web", hub: "1" },
      },
    );
    const text = textOf(html);
    expect(text).toContain(
      "Devices Anna's phone linked in the last 30 days, removed with it unless unticked:",
    );
    expect(html).toMatch(
      /role="checkbox"[^>]*aria-checked="true"[^>]*aria-label="Also remove Laptop"|aria-checked="true"[^>]*aria-label="Also remove Laptop"/u,
    );
  });
});

describe("notifications", () => {
  test("critical ones not yet read: announced at once, in words", async () => {
    const n = {
      seq: 3,
      atMs: 0,
      clockOk: true,
      kind: "tamper_opened",
      category: "tamper" as const,
      critical: true,
      device: 4,
      cause: null,
      read: false,
      delayed: false,
    };
    const html = await renderWith(createElement(notifications.CriticalNotices), {
      devices: DEVICES,
      notifications: [n, { ...n, seq: 4, critical: false, category: "batteryLow" as const }],
    });
    expect(html).toContain('aria-live="assertive"');
    expect(textOf(html)).toContain("Needs attention now Cover opened: front-door");
    expect(textOf(html)).not.toContain("Low batteries");
  });

  test("none critical: no banner", async () => {
    expect(await renderWith(createElement(notifications.CriticalNotices), {})).toBe("");
  });

  test("the categories as the hub has them for this client (the snapshot's), each in words", async () => {
    const html = await renderWith(createElement(notifications.NotificationsScreen), {
      notificationPrefs: { categories: ["batteryLow", "updates"], revision: 2 },
    });
    const checked = [
      ...html.matchAll(/aria-checked="(true|false)"[^>]*aria-label="([^"]+)"/gu),
    ].map((m) => `${m[2] ?? ""}:${m[1] ?? ""}`);
    expect(checked).toEqual([
      "A sensor silent while disarmed:false",
      "A siren lost a path:false",
      "A gateway offline:false",
      "Low batteries:true",
      "Arming and disarming:false",
      "Updates:true",
    ]);
    expect(textOf(html)).toContain("A closed tab is told nothing");
  });
});

describe("restore, site and connection", () => {
  test("restore says the file's age and keeps the code until the person goes on (D122)", async () => {
    const offer = {
      identity: "abc",
      madeMs: Date.UTC(2026, 2, 3),
      lastChangeMs: Date.UTC(2026, 2, 1),
      qr: "hsn://restore/1?h=abc",
    };
    const html = await renderWith(createElement(backup.RestoreOffer, { offer }), { hub: HUB });
    expect(textOf(html)).toContain("Its people and permissions are from Mar 1, 2026");
    expect(textOf(html)).toContain("Keep the old hub switched off");
    expect(html).not.toContain("hsn://restore/1");
    expect(html).toContain('aria-label="Go on: show the restore code"');
  });

  test("the countdown setting says it is for sensors added from now on, and where a sensor's own is changed", async () => {
    const html = await renderWith(createElement(site.SiteScreen), {
      site: {
        channel: 1,
        rate: 2,
        countdownS: 30,
        autoStopS: 180,
        wifiName: "",
        retentionRoutineDays: 30,
        retentionEventDays: 365,
      },
    });
    const text = textOf(html);
    expect(text).toContain("sensors added from now on start with a countdown of 30 s");
    expect(text).toContain("Countdown for sensors added from now on, in seconds");
    expect(text).toContain("change it on that sensor's page, under Devices");
  });

  test("the history list has an accessible name", async () => {
    const history = await import("../src/ui/history");
    const html = await renderWith(createElement(history.HistoryScreen), { hub: HUB });
    expect(html).toMatch(/<[^>]*role="list"[^>]*>/u);
    expect(/<[^>]*role="list"[^>]*>/u.exec(html)?.[0]).toContain('aria-label="');
  });

  test("the hub computer's browser (no person) is offered a code for a new person only, and told why", async () => {
    const link = await import("../src/ui/link-device");
    const SESSION = { boot: 1, client: 1, kind: "web" as const, hub: "1" };
    const console = await renderWith(createElement(link.LinkDeviceScreen), {
      session: { ...SESSION, person: null, kind: "console" },
    });
    expect(textOf(console)).not.toContain("Another device of mine");
    expect(textOf(console)).toContain("it can make a code only for a new person");
    const mine = await renderWith(createElement(link.LinkDeviceScreen), {
      session: { ...SESSION, person: 1 },
    });
    expect(textOf(mine)).toContain("Another device of mine");
  });

  test("a site move's stage and count in words", async () => {
    const html = await renderWith(createElement(site.SiteScreen), {
      site: {
        channel: 1,
        rate: 2,
        countdownS: 30,
        autoStopS: 180,
        wifiName: "",
        retentionRoutineDays: 30,
        retentionEventDays: 365,
      },
      siteMove: { stage: "announcing", channel: 2, rate: null, confirmed: 3, total: 5 },
    });
    expect(textOf(html)).toContain("Telling the devices. 3 of 5 devices confirmed.");
    expect(html).toContain('aria-label="Cancel the move"');
  });

  test("five refusals over a minute: perhaps removed, with linking again offered", async () => {
    const html = await renderWith(createElement(banners.ConnectionNotice), {
      connection: {
        kind: "waiting",
        failure: "refused",
        retryInMs: 10_000,
        attempt: 6,
        mayBeRemoved: true,
      },
    });
    expect(textOf(html)).toContain("It may have been removed from the hub.");
    expect(html).toContain('aria-label="Link this browser again"');
  });
});

describe("the second pass's pieces", () => {
  test("the export says which file is which before the person chooses; the history is not encrypted", async () => {
    const html = await renderWith(createElement(backup.BackupScreen), {});
    const text = textOf(html);
    expect(text).toContain("A backup of the settings is sealed");
    expect(text).toContain(
      "The history is a readable file of every record (JSON Lines). It holds no keys, is not encrypted, and cannot be restored",
    );
    expect(html).toContain(
      'aria-checked="true" aria-label="A backup of the settings" role="radio"',
    );
  });

  test("a QR code drawn as SVG: a role and a label, dark modules on a quiet zone", async () => {
    const { QrCode, qrPath } = await import("../src/ui/qr");
    const { size, path } = qrPath("hsn://link/1?h=abc");
    expect(size).toBeGreaterThanOrEqual(21);
    expect((size - 17) % 4).toBe(0);
    expect(path.length).toBeGreaterThan(100);
    const html = await renderWith(
      createElement(QrCode, { text: "hsn://link/1?h=abc", label: "The code" }),
      {},
    );
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="The code"/u);
  });

  test("the hub asks for the new person's name: a labelled field, said plainly", async () => {
    const gate = await import("../src/ui/link-gate");
    const html = await renderWith(
      createElement(gate.LinkGate),
      { connection: { kind: "notLinked" } },
      { kind: "askingName", from: "typed" },
    );
    expect(textOf(html)).toContain(
      "This code makes you a new person of the house. What is your name?",
    );
    expect(html).toMatch(/<input[^>]*aria-label="Your name"/u);
  });
});
