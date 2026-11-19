/**
 * Not a test of its own: the real hub (`runHub`, the product's `main.ts`) run inside a `bun test`
 * process whose `node:os` answers with one more network interface while a file exists, so that
 * `network-changed.test.ts` can change "the computer's addresses" and see `main.ts`'s minute check
 * call the relay client's `networkChanged` (B6's note: wired, not tested). Only `bun test` can put a
 * module in place of `node:os` (`mock.module`), and only in its own process, so the hub runs here,
 * started by that test with `HSN_NETWORK_HUB` naming the file and `HSN_NETWORK_HUB_ARGS` a file of
 * the hub's arguments. Without them, this skips.
 */
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { expect, mock, test } from "bun:test";

const FILE = process.env.HSN_NETWORK_HUB;
const real = os.networkInterfaces;

/** The interface the "new network" adds: a private address, not internal. */
const ADDED: os.NetworkInterfaceInfo = {
  address: "10.123.0.7",
  netmask: "255.255.0.0",
  family: "IPv4",
  mac: "02:00:00:00:00:07",
  internal: false,
  cidr: "10.123.0.7/16",
};

if (FILE !== undefined)
  void mock.module("node:os", () => ({
    ...os,
    networkInterfaces: () => (existsSync(FILE) ? { ...real(), hsn0: [ADDED] } : real()),
  }));

test.skipIf(FILE === undefined)(
  "the hub, run where its test can change the computer's addresses",
  async () => {
    const { parseMainArgs, runHub } = await import("../../src/shell/main.ts");
    const args = JSON.parse(
      readFileSync(process.env.HSN_NETWORK_HUB_ARGS ?? "", "utf8"),
    ) as string[];
    const options = parseMainArgs(args, process.env);
    expect(typeof options).toBe("object");
    if (typeof options === "string") return;
    expect(await runHub(options, { publisherKeys: [], clockSynchronised: true })).toBe(0);
  },
  600_000,
);
