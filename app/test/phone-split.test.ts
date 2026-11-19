/**
 * The shared UI's platform split for the phone (m3-design.md section 10, P5 steps 1 and 2;
 * docs/app-design.md, "On a phone"): the QR code drawn with Views against the matrix the web
 * draws, the faces and their weights, what the phone puts in Hermes's place, the phone's alerts,
 * announcements, export, local network permission, the bottom bar at large text, Android's back
 * rule, the keyboard's scroll and the band behind the status bar. Each phone file's logic is tested
 * here apart from React Native and Expo's native modules, which Bun cannot load.
 */
import "./support/render";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { moduleSide, QUIET, qrMatrix, qrPath, qrRows } from "../src/ui/qr-matrix";
import { faceSources, FACES } from "../src/ui/fonts";
import { EnglishListFormat, installListFormat, joinEnglish } from "../src/platform/intl-types";
import { ALERT_VIBRATION, phoneAlerts } from "../src/platform/alerts-phone";
import { phoneAnnouncer } from "../src/platform/announce-types";
import { mimeTypeOf, type ShareDeps, shareFile } from "../src/platform/save-file-share";
import { LOCAL_NETWORK_API, phoneLocalNetwork } from "../src/platform/local-network-types";
import { REVEAL_ABOVE, revealOffset } from "../src/ui/keyboard";
import { EMPTY_LIVE } from "../src/state/live";

// After `./support/render`: these load React Native, as React Native Web.
const { backTarget, barColumns, DESTINATIONS, placeOf } = await import("../src/ui/navigation");
const { BAND, statusBarStyle, topOf } = await import("../src/ui/top");
const { announceOnce } = await import("../src/ui/banners");
const { TEXT_SCALE_MAX } = await import("../src/ui/text");

const APP = join(import.meta.dir, "..");

describe("the QR code drawn with Views (qr.native.tsx)", () => {
  const TEXTS = [
    "hsn://link/1?h=AB3DEF7GHJ2KMNP4QRSTV5WXYZ&s=AAAAAAAAAAAAAAAAAAAAAA&a=192.168.1.20&p=8444&c=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "hsn://restore/1?h=x",
    "a",
  ];

  /** The dark modules the web's path draws, as "row,col". */
  function webModules(text: string): Set<string> {
    const dark = new Set<string>();
    for (const m of qrPath(text).path.matchAll(/M(\d+) (\d+)h1v1h-1z/gu))
      dark.add(`${m[2] ?? ""},${m[1] ?? ""}`);
    return dark;
  }

  /** The dark modules the phone's runs draw, as "row,col". */
  function phoneModules(text: string): Set<string> {
    const dark = new Set<string>();
    qrRows(qrMatrix(text)).forEach((runs, row) => {
      let col = 0;
      for (const run of runs) {
        for (let i = 0; i < run.length; i++)
          if (run.dark) dark.add(`${String(row)},${String(col + i)}`);
        col += run.length;
      }
    });
    return dark;
  }

  test("every row's runs cover the row exactly, alternating dark and light", () => {
    for (const text of TEXTS) {
      const matrix = qrMatrix(text);
      for (const runs of qrRows(matrix)) {
        expect(runs.reduce((sum, run) => sum + run.length, 0)).toBe(matrix.size);
        runs.forEach((run, i) => {
          expect(run.length).toBeGreaterThan(0);
          if (i > 0) expect(run.dark).not.toBe(runs[i - 1]?.dark);
        });
      }
    }
  });

  test("the phone draws exactly the modules the web draws", () => {
    for (const text of TEXTS) {
      const web = webModules(text);
      expect(web.size).toBeGreaterThan(50);
      expect([...phoneModules(text)].sort()).toEqual([...web].sort());
    }
  });

  test("a module is a whole number of the screen's pixels; the code is at least 180 points", () => {
    for (const scale of [1, 2, 2.625, 3, 3.5]) {
      for (const size of [21, 25, 29, 57]) {
        const side = moduleSide(size, scale);
        const pixels = side * scale;
        expect(Math.abs(pixels - Math.round(pixels))).toBeLessThan(1e-9);
        expect(side * (size + 2 * QUIET)).toBeGreaterThanOrEqual(180);
        expect(side).toBeGreaterThanOrEqual(4);
        // No larger than it needs to be: one pixel less would break one of the two rules.
        const less = (Math.round(pixels) - 1) / scale;
        expect(less * (size + 2 * QUIET) < 180 || less < 4).toBe(true);
      }
    }
  });
});

describe("the faces and their weights (fonts.ts, fonts-ready.native.ts)", () => {
  const css = readFileSync(join(APP, "global.css"), "utf8");
  const native = readFileSync(join(APP, "src", "ui", "fonts-ready.native.ts"), "utf8");
  const script = readFileSync(join(APP, "scripts", "fonts.ts"), "utf8");

  test("each theme token names its face's family, as the web's @font-face does", () => {
    for (const face of FACES) {
      const value = new RegExp(`--font-${face.token}:\\s*"([^"]+)";`, "u").exec(css)?.[1];
      expect(value).toBe(face.family);
      expect(css).toContain(`font-family: "${face.family}";`);
    }
    expect(FACES.map((f) => f.token).sort()).toEqual(["code", "heavy", "strong", "text"]);
  });

  test("the design's weights: text 400, strong 600, heavy 700, the Mono 400", () => {
    const weight = Object.fromEntries(FACES.map((f) => [f.token, f.weight]));
    expect(weight).toEqual({ text: 400, strong: 600, heavy: 700, code: 400 });
    for (const face of FACES) {
      expect(face.family).toContain(`_${String(face.weight)}`);
      expect(face.mono).toBe(face.family.includes("Mono"));
    }
  });

  test("the phone loads each family from the file of its weight, the web build's own file", () => {
    for (const face of FACES) {
      const dir = face.family.slice(face.family.indexOf("_") + 1);
      const pkg = face.mono ? "atkinson-hyperlegible-mono" : "atkinson-hyperlegible-next";
      expect(native).toContain(
        `import { ${face.family} } from "@expo-google-fonts/${pkg}/${dir}";`,
      );
      expect(script).toContain(`@expo-google-fonts/${pkg}/${dir}/${face.family}.ttf`);
      expect(dir.startsWith(String(face.weight))).toBe(true);
    }
  });

  test("each family is handed over by the URI its file resolves to", () => {
    expect(
      faceSources({ A_400Regular: 7, B_700Bold: 9 }, (file) => `asset://${String(file)}`),
    ).toEqual({
      A_400Regular: { uri: "asset://7" },
      B_700Bold: { uri: "asset://9" },
    });
  });
});

describe("Intl.ListFormat where Hermes has none (intl-types.ts)", () => {
  const engine = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
  const lists = [
    [],
    ["a"],
    ["a", "b"],
    ["a", "b", "c"],
    ["front-door", "back-door", "hall-siren", "x"],
  ];

  test("joins as a browser does for English", () => {
    for (const list of lists) {
      expect(joinEnglish(list)).toBe(engine.format(list));
      expect(new EnglishListFormat().format(list)).toBe(engine.format(list));
    }
  });

  test("put in place only where the engine has none", () => {
    const own = function ListFormat() {
      // The engine's own.
    };
    const has = { ListFormat: own };
    expect(installListFormat(has)).toBe("engine");
    expect(has.ListFormat).toBe(own);
    const lacks: { ListFormat?: unknown } = {};
    expect(installListFormat(lacks)).toBe("platform");
    expect(lacks.ListFormat).toBe(EnglishListFormat);
  });
});

describe("alerting on a phone while the app is open (alerts-phone.ts)", () => {
  test("no system notification without expo-notifications; the notice is announced; a vibration for the tone", async () => {
    const said: string[] = [];
    const buzzed: (readonly number[])[] = [];
    const alerts = phoneAlerts({
      announce: (text) => said.push(text),
      vibrate: (pattern) => buzzed.push(pattern),
    });
    expect(alerts.noticePermission()).toBe("unsupported");
    expect(await alerts.askNoticePermission()).toBe("unsupported");
    alerts.showNotice("Needs attention now", "Cover opened: front-door", "7");
    expect(said).toEqual(["Needs attention now. Cover opened: front-door"]);
    alerts.tone();
    expect(buzzed).toEqual([ALERT_VIBRATION]);
  });

  test("iOS is told; Android and a browser read the live region, so nothing is said twice", () => {
    for (const [os, told] of [
      ["ios", ["Alarm. Set off by back-door."]],
      ["android", []],
      ["web", []],
    ] as const) {
      const said: string[] = [];
      phoneAnnouncer({ os, announceForAccessibility: (text) => said.push(text) })(
        "Alarm. Set off by back-door.",
      );
      expect(said).toEqual([...told]);
    }
    const said: string[] = [];
    phoneAnnouncer({ os: "ios", announceForAccessibility: (text) => said.push(text) })("");
    expect(said).toEqual([]);
  });

  test("an alarm or a countdown is said once, not again on every screen it is shown on", () => {
    const said: string[] = [];
    const say = (text: string) => said.push(text);
    expect(announceOnce("alarm:100", "Alarm. Set off by back-door.", say)).toBe(true);
    expect(announceOnce("alarm:100", "Alarm. Set off by back-door.", say)).toBe(false);
    expect(announceOnce("countdown:2", "Countdown. Started by back-door.", say)).toBe(true);
    expect(announceOnce("alarm:200", "Alarm. Set off by front-door.", say)).toBe(true);
    expect(said).toHaveLength(3);
  });
});

describe("an export handed to the share sheet (save-file-share.ts)", () => {
  function deps(overrides: Partial<ShareDeps> = {}) {
    const steps: string[] = [];
    const made: ShareDeps = {
      available: () => Promise.resolve(true),
      write: (name, bytes) => {
        steps.push(`write ${name} ${String(bytes.length)}`);
        return Promise.resolve(`file:///cache/${name}`);
      },
      share: (uri, mime) => {
        steps.push(`share ${uri} ${mime}`);
        return Promise.resolve();
      },
      remove: (uri) => {
        steps.push(`remove ${uri}`);
        return Promise.resolve();
      },
      ...overrides,
    };
    return { made, steps };
  }

  test("written to the cache, shared, then deleted from the cache", async () => {
    const { made, steps } = deps();
    expect(await shareFile(made, "hsn-history.jsonl", new Uint8Array(3))).toEqual({ ok: true });
    expect(steps).toEqual([
      "write hsn-history.jsonl 3",
      "share file:///cache/hsn-history.jsonl application/x-ndjson",
      "remove file:///cache/hsn-history.jsonl",
    ]);
    expect(mimeTypeOf("hsn-backup.hsnb")).toBe("application/octet-stream");
  });

  test("each step's failure is `failed`, never thrown; a shared file is deleted even when sharing fails", async () => {
    const none = deps({ available: () => Promise.resolve(false) });
    expect(await shareFile(none.made, "a", new Uint8Array(1))).toEqual({
      ok: false,
      fault: "failed",
    });
    expect(none.steps).toEqual([]);
    const unwritable = deps({ write: () => Promise.reject(new Error("full")) });
    expect(await shareFile(unwritable.made, "a", new Uint8Array(1))).toEqual({
      ok: false,
      fault: "failed",
    });
    expect(unwritable.steps).toEqual([]);
    const unshared = deps({ share: () => Promise.reject(new Error("no")) });
    expect(await shareFile(unshared.made, "a", new Uint8Array(1))).toEqual({
      ok: false,
      fault: "failed",
    });
    expect(unshared.steps).toEqual(["write a 1", "remove file:///cache/a"]);
    const stuck = deps({ remove: () => Promise.reject(new Error("busy")) });
    expect(await shareFile(stuck.made, "a", new Uint8Array(1))).toEqual({ ok: true });
  });
});

describe("the local network permission (local-network-types.ts)", () => {
  const network = (os: string, version: number | string, granted: boolean, answer = "granted") => {
    const asked: string[] = [];
    return {
      asked,
      made: phoneLocalNetwork({
        os,
        version,
        check: () => {
          asked.push("check");
          return Promise.resolve(granted);
        },
        request: () => {
          asked.push("request");
          return Promise.resolve(answer as "granted" | "denied" | "never_ask_again");
        },
      }),
    };
  };

  test("Android 17 is asked; older Android has nothing to ask", async () => {
    const older = network("android", LOCAL_NETWORK_API - 1, false);
    expect(await older.made.permission()).toEqual({ state: "granted", canAskAgain: true });
    expect(await older.made.ask()).toEqual({ state: "granted", canAskAgain: true });
    expect(older.asked).toEqual([]);
    const notYet = network("android", LOCAL_NETWORK_API, false);
    expect((await notYet.made.permission()).state).toBe("undetermined");
    expect(await notYet.made.ask()).toEqual({ state: "granted", canAskAgain: true });
    expect(notYet.asked).toEqual(["check", "request"]);
    expect((await network("android", 38, true).made.permission()).state).toBe("granted");
  });

  test("Android's no, and its no for good", async () => {
    expect(await network("android", 37, false, "denied").made.ask()).toEqual({
      state: "denied",
      canAskAgain: true,
    });
    expect(await network("android", 37, false, "never_ask_again").made.ask()).toEqual({
      state: "denied",
      canAskAgain: false,
    });
  });

  test("iOS cannot be asked or read: the page explains, and the connection asks", async () => {
    const ios = network("ios", "27.0", false);
    expect((await ios.made.permission()).state).toBe("undetermined");
    expect((await ios.made.ask()).state).toBe("granted");
    expect(ios.asked).toEqual([]);
  });
});

describe("the bottom bar at large text (navigation.tsx, rule 4)", () => {
  test("four across at the phone's own size; rows of two as the text grows; never shrunk", () => {
    expect(barColumns(8, 1, 402)).toBe(4);
    expect(barColumns(8, 1.235, 402)).toBe(4);
    expect(barColumns(8, 1.353, 402)).toBe(2);
    expect(barColumns(8, TEXT_SCALE_MAX, 402)).toBe(2);
    // Past 200% the app's text stops growing, so the bar does too.
    expect(barColumns(8, 3.1, 402)).toBe(barColumns(8, TEXT_SCALE_MAX, 402));
    expect(barColumns(8, 2, 250)).toBe(1);
  });
});

describe("Android's back button (navigation.tsx, rule 3)", () => {
  test("a page goes to its destination's first page or index, that to Home, Home out", () => {
    expect(backTarget("/")).toBeNull();
    expect(backTarget("/devices")).toBe("/");
    expect(backTarget("/groups")).toBe("/devices");
    expect(backTarget("/device/4")).toBe("/devices");
    expect(backTarget("/notifications")).toBe("/history");
    expect(backTarget("/history")).toBe("/");
    expect(backTarget("/backup")).toBe("/settings");
    expect(backTarget("/restore")).toBe("/settings");
    expect(backTarget("/settings")).toBe("/");
    expect(backTarget("/nowhere")).toBe("/");
  });

  test("the phone's restore page belongs to Settings without being one of its eight", () => {
    expect(placeOf("/restore").destination.index).toBe("/settings");
    const settings = DESTINATIONS.find((d) => d.index === "/settings");
    expect(settings?.pages.map(([href]) => href)).not.toContain("/restore");
    expect(settings?.pages).toHaveLength(8);
  });
});

describe("the keyboard (keyboard.ts, rule 5)", () => {
  const at = { height: 48, below: 96 };
  test("a field already shown with room for its action: no scroll", () => {
    expect(revealOffset({ ...at, top: 100, offset: 0, visible: 400 })).toBeNull();
    // Exactly at the edge.
    expect(revealOffset({ ...at, top: 256, offset: 0, visible: 400 })).toBeNull();
  });
  test("a field under the keyboard: scrolled up just enough for it and its action", () => {
    expect(revealOffset({ ...at, top: 257, offset: 0, visible: 400 })).toBe(1);
    expect(revealOffset({ ...at, top: 900, offset: 100, visible: 400 })).toBe(900 + 48 + 96 - 400);
  });
  test("a field above the view: scrolled down to it, with room above", () => {
    expect(revealOffset({ ...at, top: 300, offset: 500, visible: 400 })).toBe(300 - REVEAL_ABOVE);
    expect(revealOffset({ ...at, top: 10, offset: 500, visible: 400 })).toBe(0);
  });
  test("a view too short for both: the field's top wins", () => {
    expect(revealOffset({ ...at, top: 600, offset: 0, visible: 100 })).toBe(600 - REVEAL_ABOVE);
  });
});

describe("behind the status bar (top.ts, rules 1 and 2)", () => {
  const sensor = (arm: "armed" | "disarmed") => ({
    1: { id: 1, arm, door: "closed" as const, countdownSecondsLeft: null },
  });
  const base = { ...EMPTY_LIVE, mode: { mode: 2, modified: false } };

  test("Home: the field's look; another page: the page; the alarm and a countdown everywhere", () => {
    expect(topOf({ ...base, sensors: sensor("disarmed") }, true)).toBe("day");
    expect(topOf({ ...base, sensors: sensor("armed") }, true)).toBe("night");
    expect(topOf({ ...base, sensors: sensor("armed") }, false)).toBe("page");
    const counting = {
      ...base,
      sensors: sensor("armed"),
      countdowns: { 1: { secondsLeft: 20, toldAtMs: 0 } },
    };
    expect(topOf(counting, false)).toBe("night");
    // A countdown on a sensor already disarmed is over.
    expect(topOf({ ...counting, sensors: sensor("disarmed") }, false)).toBe("page");
    const alarm = {
      ...base,
      sensors: sensor("armed"),
      alarm: { startedMs: 1, triggers: [1], sirens: [] },
    };
    expect(topOf(alarm, false)).toBe("alarm");
    expect(topOf(alarm, true)).toBe("alarm");
  });

  test("dark text on day and every page, light on night and alarm; the band in the field's colour", () => {
    expect(statusBarStyle("day")).toBe("dark");
    expect(statusBarStyle("page")).toBe("dark");
    expect(statusBarStyle("night")).toBe("light");
    expect(statusBarStyle("alarm")).toBe("light");
    expect(BAND).toEqual({
      page: "bg-limewash",
      day: "bg-sage",
      night: "bg-spruce",
      alarm: "bg-signal",
    });
  });
});

describe("the export and alert pairs' two files (save-file*, alerts*)", () => {
  const source = (file: string) => readFileSync(join(APP, "src", "platform", file), "utf8");

  test("the browser downloads the bytes under the file's name, and lets the link go", async () => {
    const scope = globalThis as unknown as { document?: unknown; URL: typeof URL };
    const clicked: { href: string; download: string }[] = [];
    const revoked: string[] = [];
    const realDocument = scope.document;
    const realUrl = {
      create: URL.createObjectURL.bind(URL),
      revoke: URL.revokeObjectURL.bind(URL),
    };
    scope.document = {
      createElement: () => {
        const a = {
          href: "",
          download: "",
          click: () => clicked.push({ href: a.href, download: a.download }),
        };
        return a;
      },
    };
    URL.createObjectURL = () => "blob:x";
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
    const timers: (() => void)[] = [];
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((run: () => void) => {
      timers.push(run);
      return 0;
    }) as unknown as typeof setTimeout;
    const web = await import("../src/platform/save-file.web");
    expect(await web.saveFile("hsn-backup.hsnb", new Uint8Array(2))).toEqual({ ok: true });
    globalThis.setTimeout = realTimeout;
    expect(clicked).toEqual([{ href: "blob:x", download: "hsn-backup.hsnb" }]);
    for (const run of timers) run();
    expect(revoked).toEqual(["blob:x"]);
    scope.document = realDocument;
    URL.createObjectURL = realUrl.create;
    URL.revokeObjectURL = realUrl.revoke;
  });

  test("the phone's files are the logic tested above over Expo's and React Native's modules", () => {
    // Bun cannot load React Native or Expo's native modules; tsc checks both files against the
    // pair's interface (`Split` in `save-file.ts` and `alerts.ts`), and this checks the wiring.
    const save = source("save-file.native.ts");
    expect(save).toContain('import { File, Paths } from "expo-file-system";');
    expect(save).toContain('import { isAvailableAsync, shareAsync } from "expo-sharing";');
    expect(save).toContain("shareFile(");
    expect(save).toContain("new File(Paths.cache, fileName)");
    const alerts = source("alerts.native.ts");
    expect(alerts).toContain("phoneAlerts(");
    expect(alerts).toContain("Vibration.vibrate");
    expect(alerts).toContain('from "./announce.native"');
    for (const pair of ["save-file.ts", "alerts.ts", "announce.ts", "local-network.ts", "intl.ts"])
      expect(source(pair)).toMatch(/export type Platforms = Split</u);
  });
});
