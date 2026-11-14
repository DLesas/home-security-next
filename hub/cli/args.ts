/**
 * `hsn`'s command line (hub-design.md section 9): every command of the table, parsed into the
 * control protocol's command, then checked with its schema so the hub never sees a malformed one.
 */
import { err, ok, type Result } from "neverthrow";
import { type ControlCommand, controlCommand } from "../src/control-protocol/index.ts";

/** Options that go with any command. */
export interface Globals {
  readonly data: string | undefined;
  readonly socket: string | undefined;
  /** Print the hub's replies as JSON lines, for scripts. */
  readonly json: boolean;
  /** Seconds to wait for the answer, or undefined for the command's own. */
  readonly timeoutS: number | undefined;
}

export type Parsed =
  | { readonly kind: "help" }
  | {
      readonly kind: "command";
      readonly globals: Globals;
      readonly command: ControlCommand;
      readonly passwordFromStdin: boolean;
    };

/** Site channels as the user types them (§2). */
const CHANNELS: Readonly<Record<string, number>> = { "868.1": 0, "868.3": 1, "868.5": 2 };

const UNITS_MS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** What `--password -` means: read the password from standard input. */
export const PASSWORD_FROM_STDIN = "-";

type Fields = Record<string, unknown>;

class Words {
  readonly #words: string[];
  constructor(words: readonly string[]) {
    this.#words = [...words];
  }
  next(): string | undefined {
    return this.#words.shift();
  }
  rest(): readonly string[] {
    return this.#words.splice(0);
  }
}

function usage(message: string): Result<never, string> {
  return err(message);
}

function integer(text: string, what: string): Result<number, string> {
  return /^-?\d+$/u.test(text)
    ? ok(Number(text))
    : usage(`${what} must be a whole number, not "${text}"`);
}

function rate(text: string): Result<number, string> {
  const match = /^DR([0-5])$/iu.exec(text);
  return match?.[1] === undefined
    ? usage(`a data rate is DR0 to DR5, not "${text}"`)
    : ok(Number(match[1]));
}

function channel(text: string): Result<number, string> {
  const value = CHANNELS[text];
  return value === undefined
    ? usage(`a channel is 868.1, 868.3 or 868.5, not "${text}"`)
    : ok(value);
}

/** `key=value` settings, each through its parser, into the command's fields. */
function settings(
  words: readonly string[],
  parsers: Readonly<Record<string, readonly [string, (text: string) => Result<unknown, string>]>>,
): Result<Fields, string> {
  const fields: Fields = {};
  for (const word of words) {
    const at = word.indexOf("=");
    const key = at < 0 ? word : word.slice(0, at);
    const parser = parsers[key];
    if (at < 0 || parser === undefined) {
      return usage(
        `unknown setting "${word}": use ${Object.keys(parsers)
          .map((k) => `${k}=…`)
          .join(", ")}`,
      );
    }
    const value = parser[1](word.slice(at + 1));
    if (value.isErr()) return err(value.error);
    fields[parser[0]] = value.value;
  }
  return ok(fields);
}

/** Pulls `--flag` and `--flag value` options out of the words. */
function options(
  words: readonly string[],
  withValue: readonly string[],
  bare: readonly string[],
): Result<
  {
    readonly values: Readonly<Record<string, string>>;
    readonly flags: ReadonlySet<string>;
    readonly rest: readonly string[];
  },
  string
> {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    if (withValue.includes(word)) {
      const value = words[i + 1];
      if (value === undefined) return usage(`${word} needs a value`);
      values[word] = value;
      i++;
    } else if (bare.includes(word)) {
      flags.add(word);
    } else if (word.startsWith("--")) {
      return usage(`unknown option ${word}`);
    } else {
      rest.push(word);
    }
  }
  return ok({ values, flags, rest });
}

/** `--since`: a date and time (ISO 8601), or a time ago such as 10m, 2h, 1d. */
export function since(text: string, nowMs: number): Result<number, string> {
  const ago = /^(\d+)([smhd])$/u.exec(text);
  if (ago?.[1] !== undefined && ago[2] !== undefined)
    return ok(nowMs - Number(ago[1]) * (UNITS_MS[ago[2]] ?? 0));
  const at = Date.parse(text);
  return Number.isNaN(at) || at < 0
    ? usage(`--since takes a date and time or a time ago (10m, 2h, 1d), not "${text}"`)
    : ok(at);
}

function onlyOne(words: readonly string[], what: string): Result<string, string> {
  const [first, ...more] = words;
  if (first === undefined) return usage(`give the ${what}`);
  return more.length > 0 ? usage(`unexpected "${more.join(" ")}"`) : ok(first);
}

function none(words: readonly string[]): Result<void, string> {
  return words.length === 0 ? ok(undefined) : usage(`unexpected "${words.join(" ")}"`);
}

function sensors(words: readonly string[]): Result<Fields, string> {
  return options(words, [], ["--all", "--continue"]).andThen(({ flags, rest }) => {
    if (flags.has("--all") && rest.length > 0) return usage("give --all or sensor names, not both");
    if (!flags.has("--all") && rest.length === 0)
      return usage("give --all or at least one sensor name");
    return ok({ sensors: flags.has("--all") ? "all" : rest, continue: flags.has("--continue") });
  });
}

/** The command's fields from its words, before the schema checks them. */
function fields(
  words: Words,
  nowMs: number,
): Result<Fields & { readonly passwordFromStdin?: boolean }, string> {
  const word = words.next();
  const sub = (): string | undefined => words.next();
  switch (word) {
    case "status":
    case "devices":
      return none(words.rest()).map(() => ({ kind: word }));
    case "arm":
      return sensors(words.rest()).map((f) => ({ kind: "arm", ...f }));
    case "disarm":
      return sensors(words.rest()).andThen((f) =>
        f.continue === true
          ? usage("disarm takes no --continue")
          : ok({ kind: "disarm", sensors: f.sensors }),
      );
    case "device": {
      const what = sub();
      const rest = words.rest();
      if (what === "show")
        return onlyOne(rest, "device's name").map((name) => ({ kind: "deviceShow", name }));
      if (what === "remove")
        return onlyOne(rest, "device's name").map((name) => ({ kind: "deviceRemove", name }));
      if (what === "rename") {
        return rest.length === 2
          ? ok({ kind: "deviceRename", from: rest[0], to: rest[1] })
          : usage("device rename <old> <new>");
      }
      return usage("device show <name> | device rename <old> <new> | device remove <name>");
    }
    case "usb": {
      const what = sub();
      const rest = words.rest();
      if (what === "list") return none(rest).map(() => ({ kind: "usbList" }));
      if (what === "erase")
        return onlyOne(rest, "port").map((port) => ({ kind: "usbErase", port }));
      if (what === "add") {
        return options(rest, ["--name", "--role"], []).andThen(({ values, rest: ports }) =>
          onlyOne(ports, "port").andThen((port) => {
            const name = values["--name"];
            if (name === undefined) return usage("usb add needs --name <name>");
            const role = values["--role"];
            return ok(
              role === undefined
                ? { kind: "usbAdd", port, name }
                : { kind: "usbAdd", port, name, role },
            );
          }),
        );
      }
      return usage(
        "usb list | usb add <port> --name <name> [--role sensor|siren|gateway] | usb erase <port>",
      );
    }
    case "sensor": {
      if (sub() !== "set")
        return usage(
          "sensor set <name> countdown=<s> heartbeat=<units> link-check=<n> reply-rate=<DRn|learn> correction=<units|learn>",
        );
      const [name, ...rest] = words.rest();
      if (name === undefined) return usage("give the sensor's name");
      const learnOr = (parse: (t: string) => Result<number, string>) => (t: string) =>
        t === "learn" ? ok("learn") : parse(t);
      return settings(rest, {
        countdown: ["countdown", (t) => integer(t, "countdown")],
        heartbeat: ["heartbeat", (t) => integer(t, "heartbeat")],
        "link-check": ["linkCheck", (t) => integer(t, "link-check")],
        "reply-rate": ["replyRate", learnOr(rate)],
        correction: ["correction", learnOr((t) => integer(t, "correction"))],
      }).map((f) => ({ kind: "sensorSet", name, ...f }));
    }
    case "gateway": {
      const what = sub();
      const [name, ...rest] = words.rest();
      if (what !== "set" || name === undefined)
        return usage(
          "gateway set <name> status=<s> interference=<dB>/<s> power=<dBm> siren-power=<dBm>",
        );
      return gatewaySettings(name, rest);
    }
    case "siren": {
      const what = sub();
      const [name, ...rest] = words.rest();
      if (name === undefined) return usage("give the siren's name");
      if (what === "set")
        return settings(rest, { max: ["max", (t) => integer(t, "max")] }).map((f) => ({
          kind: "sirenSet",
          name,
          ...f,
        }));
      if (what === "test") {
        if (rest.length > 1) return usage("siren test <name> [<seconds>]");
        const [seconds] = rest;
        return seconds === undefined
          ? ok({ kind: "sirenTest", name })
          : integer(seconds, "seconds").map((s) => ({ kind: "sirenTest", name, seconds: s }));
      }
      return usage("siren set <name> max=<s> | siren test <name> [<s>]");
    }
    case "site":
      return siteFields(words);
    case "log":
      return options(words.rest(), ["--device", "--since", "--kind"], ["--follow"]).andThen(
        ({ values, flags, rest }) =>
          none(rest).andThen(() => {
            const sinceText = values["--since"];
            const from = sinceText === undefined ? ok(undefined) : since(sinceText, nowMs);
            return from.map((sinceMs) => ({
              kind: "log",
              follow: flags.has("--follow"),
              ...(values["--device"] === undefined ? {} : { device: values["--device"] }),
              ...(sinceMs === undefined ? {} : { since: sinceMs }),
              ...(values["--kind"] === undefined ? {} : { logKind: values["--kind"] }),
            }));
          }),
      );
    case undefined:
      return usage("give a command: see hsn --help");
    default:
      return usage(`unknown command "${word}": see hsn --help`);
  }
}

function siteFields(
  words: Words,
): Result<Fields & { readonly passwordFromStdin?: boolean }, string> {
  const what = words.next();
  const rest = words.rest();
  switch (what) {
    case "show":
      return none(rest).map(() => ({ kind: "siteShow" }));
    case "survey":
      return none(rest).map(() => ({ kind: "siteSurvey" }));
    case "set":
      return settings(rest, {
        channel: ["channel", channel],
        rate: ["rate", rate],
        countdown: ["countdown", (t) => integer(t, "countdown")],
        "auto-stop": ["autoStop", (t) => integer(t, "auto-stop")],
      }).map((f) => ({ kind: "siteSet", ...f }));
    case "wifi":
      return options(rest, ["--name", "--password"], []).andThen(({ values, rest: extra }) =>
        none(extra).andThen(() => {
          const name = values["--name"];
          const password = values["--password"];
          if (name === undefined || password === undefined)
            return usage("site wifi --name <name> --password <password|->");
          return ok({
            kind: "siteWifi",
            name,
            password,
            passwordFromStdin: password === PASSWORD_FROM_STDIN,
          });
        }),
      );
    case "change": {
      const [first, ...more] = rest;
      if (first === "status") return none(more).map(() => ({ kind: "siteChangeStatus" }));
      if (first === "cancel") return none(more).map(() => ({ kind: "siteChangeCancel" }));
      if (first === "force") {
        return options(more, [], ["--yes"]).andThen(({ flags, rest: extra }) =>
          none(extra).map(() => ({ kind: "siteChangeForce", yes: flags.has("--yes") })),
        );
      }
      return settings(rest, { channel: ["channel", channel], rate: ["rate", rate] }).andThen((f) =>
        Object.keys(f).length === 0
          ? usage("site change channel=… rate=… | status | cancel | force [--yes]")
          : ok({ kind: "siteChange", ...f }),
      );
    }
    default:
      return usage("site show | survey | set … | wifi … | change …");
  }
}

/** The whole command line. */
export function parseArgs(argv: readonly string[], nowMs: number): Result<Parsed, string> {
  const words: string[] = [];
  let data: string | undefined;
  let socket: string | undefined;
  let json = false;
  let timeoutS: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] ?? "";
    if (word === "--help" || word === "-h" || word === "help") return ok({ kind: "help" });
    if (word === "--json") {
      json = true;
    } else if (word === "--data" || word === "--socket" || word === "--timeout") {
      const value = argv[i + 1];
      if (value === undefined) return usage(`${word} needs a value`);
      i++;
      if (word === "--data") data = value;
      else if (word === "--socket") socket = value;
      else {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0)
          return usage("--timeout takes a number of seconds");
        timeoutS = seconds;
      }
    } else {
      words.push(word);
    }
  }
  return fields(new Words(words), nowMs).andThen(({ passwordFromStdin, ...raw }) => {
    const checked = controlCommand.safeParse(raw);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      return usage(
        `not valid: ${issue === undefined ? "?" : `${issue.path.join(".") || "command"}: ${issue.message}`}`,
      );
    }
    return ok<Parsed, string>({
      kind: "command",
      globals: { data, socket, json, timeoutS },
      command: checked.data,
      passwordFromStdin: passwordFromStdin === true,
    });
  });
}

/** `gateway set <name> …`'s words into the command (section 9). */
function gatewaySettings(name: string, words: readonly string[]): Result<Fields, string> {
  const out: Record<string, number> = {};
  for (const word of words) {
    const at = word.indexOf("=");
    const key = at < 0 ? word : word.slice(0, at);
    const value = at < 0 ? "" : word.slice(at + 1);
    const number = (text: string, what: string): Result<number, string> =>
      /^-?\d+$/u.test(text)
        ? ok(Number(text))
        : usage(`${what} must be a whole number, not "${text}"`);
    if (key === "status") {
      const n = number(value, "status");
      if (n.isErr()) return err(n.error);
      out.statusS = n.value;
    } else if (key === "interference") {
      const [db, seconds, ...more] = value.split("/");
      if (db === undefined || seconds === undefined || more.length > 0)
        return usage("interference takes <dB>/<s>, as interference=10/30");
      const d = number(db, "the interference level");
      const s = number(seconds, "the interference duration");
      if (d.isErr()) return err(d.error);
      if (s.isErr()) return err(s.error);
      out.interferenceDb = d.value;
      out.interferenceS = s.value;
    } else if (key === "power" || key === "siren-power") {
      const n = number(value, key);
      if (n.isErr()) return err(n.error);
      out[key === "power" ? "powerDbm" : "sirenPowerDbm"] = n.value;
    } else {
      return usage(`unknown gateway setting "${key}": status, interference, power or siren-power`);
    }
  }
  return ok({ kind: "gatewaySet", name, ...out });
}
