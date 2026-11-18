/**
 * The relay program (docs/m4-design.md section 3, "Self-hosting"): its configuration file, its
 * own static key (made once, 0600, refused when others can read it), and the executable started
 * as an operator would start it: a hub joins it, SIGTERM stops it with 1001, a bad configuration
 * exits 78.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELAY_CLOSE } from "@hsn/protocol/relay";
import { readConfig, readRefusedHubs } from "../src/shell/config.ts";
import { loadOrMakeRelayKey, RELAY_KEY_FILE } from "../src/shell/relay-key.ts";
import { cleanup, hubKey, must, StandInHub, tempFolder, until } from "./helpers.ts";

let folder: string;

beforeEach(() => {
  folder = tempFolder();
});

afterEach(() => {
  cleanup(folder);
});

function configFile(config: unknown): string {
  const path = join(folder, "relay.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

const base = (dataFolder: string) => ({
  listen: { hostname: "127.0.0.1", port: 0 },
  dataFolder,
  roles: ["relay"],
  push: { url: `ws+unix://${join(dataFolder, "no-push.sock")}:/v1/relay` },
});

describe("the configuration", () => {
  test("reads a valid file, and refuses what it does not name", () => {
    const ok = configFile({ ...base(folder), roles: ["relay", "releases"], releases: { folder } });
    expect(must(readConfig(["--config", ok])).roles).toEqual(["relay", "releases"]);
    const unknown = configFile({ ...base(folder), extra: true });
    expect(readConfig(["--config", unknown]).isErr()).toBe(true);
    const names = configFile({ ...base(folder), roles: ["relay", "names"] });
    expect(readConfig(["--config", names]).isErr()).toBe(true);
    const push = configFile({ ...base(folder), roles: ["push"] });
    expect(readConfig(["--config", push]).isErr()).toBe(true);
    const noFolder = configFile({ ...base(folder), roles: ["relay", "releases"] });
    expect(readConfig(["--config", noFolder])._unsafeUnwrapErr().message).toContain(
      "releases.folder",
    );
    expect(readConfig([]).isErr()).toBe(true);
    expect(readConfig(["--config", join(folder, "missing.json")]).isErr()).toBe(true);
  });

  test("refused hubs: one identity a line, comments and blanks skipped", () => {
    const path = join(folder, "refused");
    const a = hubKey().identity;
    writeFileSync(path, `# refused\n${a}\n\n  ${a}  # again\n`);
    expect([...must(readRefusedHubs(path))]).toEqual([a]);
  });
});

describe("the relay's own key", () => {
  test("is made once, readable only by its account, and the same at every start", () => {
    const first = must(loadOrMakeRelayKey(folder));
    expect(statSync(join(folder, RELAY_KEY_FILE)).mode & 0o777).toBe(0o600);
    const second = must(loadOrMakeRelayKey(folder));
    expect(second.publicKey).toEqual(first.publicKey);
  });

  test("is refused when others can read it, or it is not 32 bytes", () => {
    must(loadOrMakeRelayKey(folder));
    const path = join(folder, RELAY_KEY_FILE);
    chmodSync(path, 0o644);
    expect(loadOrMakeRelayKey(folder).isErr()).toBe(true);
    chmodSync(path, 0o600);
    writeFileSync(path, new Uint8Array(31));
    expect(loadOrMakeRelayKey(folder).isErr()).toBe(true);
  });
});

describe("the executable", () => {
  const main = join(import.meta.dir, "../src/shell/main.ts");

  test("starts from its configuration, takes a hub, and stops on SIGTERM with 1001", async () => {
    const path = configFile(base(folder));
    const program = Bun.spawn([process.execPath, main, "--config", path], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const reader = program.stderr.getReader();
    let text = "";
    // Read standard error as it comes.
    const pump = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        text += new TextDecoder().decode(chunk.value);
      }
    })();
    await until(() => text.includes('"event":"started"'), "the program to start", 10_000);
    const port = Number(/"event":"started","port":(\d+)/u.exec(text)?.[1] ?? 0);
    const hub = await StandInHub.connect(`ws://127.0.0.1:${port}`);
    expect((await hub.next("joined")).identity).toBe(hub.identity);
    expect(statSync(join(folder, "relay.db")).isFile()).toBe(true);
    expect(statSync(join(folder, RELAY_KEY_FILE)).mode & 0o777).toBe(0o600);
    program.kill("SIGTERM");
    expect(await hub.client.closed()).toBe(RELAY_CLOSE.stopping);
    expect(await program.exited).toBe(0);
    await pump;
    expect(text).toContain('"event":"stopped"');
    expect(text).not.toContain(hub.identity);
  }, 20_000);

  test("exits 78 on a configuration it cannot use", async () => {
    const path = configFile({ ...base(folder), listen: { hostname: "127.0.0.1" } });
    const program = Bun.spawn([process.execPath, main, "--config", path], {
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await program.exited).toBe(78);
    const text = await new Response(program.stderr).text();
    expect(text).toContain('"event":"config"');
    expect(readFileSync(path, "utf8")).toContain("listen");
  });
});
