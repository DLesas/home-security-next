/**
 * Rule 6 of docs/m3-m4-plan.md, checked on everything the relay work's processes wrote: no key, no
 * push token, no push key and no sealed push in any output. The secrets are gathered from where
 * they live (the stand-ins' keys and what they received, each phone's keys, the relay's key file,
 * the hub's key tables), each in every form a line could carry it (hex, base64, base64url, and
 * stretches of a long text), and every output is searched for each.
 *
 * Also the two guards that must never engage: the hub loop's guard against a deadline left behind
 * (`shell/loop.ts`, "a deadline was left at or before its time") and the relay's against a
 * presence deadline that does not move (`presenceStalled`).
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { secretsOf, type StandIns } from "../../../relay/test/push/helpers.ts";
import type { AwayPhone } from "./phone.ts";
import { arrivedFor } from "./pushes.ts";

/** Each of a secret's forms a line could carry. */
export function formsOf(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes);
  return [
    buffer.toString("hex"),
    buffer.toString("base64"),
    buffer.toString("base64url"),
    buffer.toString("base64").replace(/=+$/u, ""),
  ];
}

/** The hub's tables that hold keys or secrets, read as they are on disk. */
const HUB_SECRET_TABLES = ["hub_keys", "device_keys", "push_keys", "link_secrets", "backup_key"];

function hubSecrets(dataDir: string): string[] {
  const file = join(dataDir, "hub.db");
  if (!existsSync(file)) return [];
  const db = new Database(file, { readonly: true });
  const out: string[] = [];
  for (const table of HUB_SECRET_TABLES) {
    const exists = db
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table);
    if ((exists?.n ?? 0) === 0) continue;
    for (const row of db.query<Record<string, unknown>, []>(`SELECT * FROM ${table}`).all())
      for (const value of Object.values(row))
        if (value instanceof Uint8Array && value.length >= 16) out.push(...formsOf(value));
  }
  db.close();
  return out;
}

export interface SecretSources {
  /** The stand-ins, when the run used them: their keys and everything they received. */
  readonly standIns?: StandIns;
  /** Sealed pushes the run saw elsewhere (an in-process relay's push sender). */
  readonly sealed?: readonly string[];
  readonly phones: readonly AwayPhone[];
  /** The push tokens the phones registered. */
  readonly tokens: readonly string[];
  readonly relayDataFolders: readonly string[];
  readonly hubDataFolders: readonly string[];
  readonly deviceKeys?: readonly Uint8Array[];
}

/** Everything secret a run handled, in every form. */
export function collectSecrets(sources: SecretSources): string[] {
  const s = sources.standIns;
  const sent =
    s === undefined
      ? []
      : sources.tokens.flatMap((token) =>
          arrivedFor(s, token).map((arrived) => ({ token, h: arrived.h })),
        );
  const phones = sources.phones.flatMap((phone) => [
    ...formsOf(phone.push.key),
    ...formsOf(phone.record.key.privateKey),
    ...(phone.backupKey === undefined ? [] : [phone.backupKey.key]),
  ]);
  const relays = sources.relayDataFolders.flatMap((folder) => {
    const file = join(folder, "relay.key");
    return existsSync(file) ? formsOf(new Uint8Array(readFileSync(file))) : [];
  });
  return [
    ...(s === undefined ? [] : secretsOf(s, sent)),
    ...(sources.sealed ?? []).flatMap((h) => [h, h.slice(19, 80)]),
    ...sources.tokens,
    ...phones,
    ...relays,
    ...sources.hubDataFolders.flatMap(hubSecrets),
    ...(sources.deviceKeys ?? []).flatMap(formsOf),
  ].filter((secret) => secret.length >= 12);
}

/** The secrets found in `texts`, each named by its first characters only. */
export function leaksIn(texts: readonly string[], secrets: readonly string[]): string[] {
  const all = texts.join("\n");
  return [...new Set(secrets.filter((secret) => all.includes(secret)))].map(
    (secret) => `${secret.slice(0, 6)}… (${String(secret.length)} characters)`,
  );
}

/** The guards' own words. */
export const GUARD_WORDS = ["a deadline was left at or before its time", '"presenceStalled"'];

/** Which guard words appear in `texts`. */
export function guardsEngaged(texts: readonly string[]): string[] {
  const all = texts.join("\n");
  return GUARD_WORDS.filter((word) => all.includes(word));
}

/**
 * The end of a test: what the processes it started wrote so far (those it stopped, whole), and
 * `logs` (an in-process relay's log), hold none of the run's secrets, and no guard engaged.
 * Returns what was found, for `expect`.
 */
export async function outputsClean(
  outputs: readonly { readonly text: string }[],
  logs: readonly string[],
  sources: SecretSources,
): Promise<{ readonly leaks: string[]; readonly guards: string[] }> {
  // A stopped process's last lines may still be on their way.
  await Bun.sleep(200);
  const texts = [...outputs.map((out) => out.text), ...logs];
  return { leaks: leaksIn(texts, collectSecrets(sources)), guards: guardsEngaged(texts) };
}

/** What a test file's runs touched, gathered as they go, for its last test's search. */
export class Seen {
  readonly phones: AwayPhone[] = [];
  readonly tokens: string[] = [];
  readonly hubDirs: string[] = [];
  readonly relayDirs: string[] = [];
  readonly logs: (() => string)[] = [];
  readonly sealed: (() => readonly string[])[] = [];
  standIns: StandIns | undefined;

  /** Every output so far and every log kept: no secret in any, no guard engaged. */
  async check(
    outputs: readonly { readonly text: string }[],
  ): Promise<{ readonly leaks: string[]; readonly guards: string[] }> {
    return outputsClean(
      outputs,
      this.logs.map((log) => log()),
      {
        ...(this.standIns === undefined ? {} : { standIns: this.standIns }),
        sealed: this.sealed.flatMap((of) => of()),
        phones: this.phones,
        tokens: this.tokens,
        relayDataFolders: this.relayDirs,
        hubDataFolders: this.hubDirs,
      },
    );
  }
}
