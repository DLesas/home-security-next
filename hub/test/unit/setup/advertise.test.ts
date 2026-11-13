/**
 * The hub's signing key pair and its mDNS advertisement (hub-design.md section 9; protocol.md §9
 * and §10): P-256 made with Web Crypto at the first start and written now before anything else,
 * its identity the first 8 bytes of SHA-256 of X‖Y, the private half never handed back or
 * printed, the stored pair checked at later starts, and `_hsn-hub._tcp` advertised with the
 * identity on the served port.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { hubIdentity, toHex } from "@hsn/protocol";
import { ok } from "neverthrow";
import type { StagedEffect } from "../../../src/ports/writer.ts";
import { checkHubKeys, ensureHubKeys, makeHubKeys } from "../../../src/shell/advertise/hub-keys.ts";
import {
  IDENTITY_TXT_KEY,
  instanceName,
  type MdnsLibrary,
  MdnsAdvertiser,
  SERVICE_TYPE,
} from "../../../src/shell/advertise/mdns.ts";
import { HUB_IDENTITY, HUB_SIGNING_PUBLIC } from "./support/driver.ts";
import { expectNoKeyLeaks, noteKey, noteValue } from "./support/leak-guard.ts";

afterAll(() => {
  expectNoKeyLeaks();
});

function recordingWriter() {
  const staged: StagedEffect[] = [];
  const flushes: string[] = [];
  return {
    staged,
    flushes,
    writer: {
      stage: (items: readonly StagedEffect[]) => {
        staged.push(...items);
      },
      flush: (reason: string) => {
        flushes.push(reason);
        return ok({ items: staged.length, durationMs: 0 });
      },
    },
  };
}

describe("the signing key pair (section 9, §9)", () => {
  test("a new pair: P-256, X‖Y of 64 bytes, its identity the hash's first 8 bytes, the private half PKCS #8", async () => {
    const made = (await makeHubKeys())._unsafeUnwrap();
    noteKey(made.signingPrivate);
    expect(made.signingPublic.length).toBe(64);
    expect(toHex(made.identity)).toBe(toHex(hubIdentity(made.signingPublic)));
    const imported = await crypto.subtle.importKey(
      "pkcs8",
      new Uint8Array(made.signingPrivate),
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      imported,
      new Uint8Array([1]),
    );
    const publicKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array([4, ...made.signingPublic]),
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signature,
        new Uint8Array([1]),
      ),
    ).toBe(true);
  });

  test("at the first start the pair is written now and committed, and only the public half comes back", async () => {
    const { staged, flushes, writer } = recordingWriter();
    const keys = (await ensureHubKeys(undefined, writer))._unsafeUnwrap();
    expect(flushes).toEqual(["now"]);
    expect(staged).toHaveLength(1);
    const item = staged[0];
    expect(item?.kind === "write" ? [item.durability, item.op.table, item.op.op] : []).toEqual([
      "now",
      "hub_keys",
      "upsert",
    ]);
    if (item?.kind === "write" && item.op.table === "hub_keys" && item.op.op === "upsert") {
      noteKey(item.op.row.signingPrivate);
      expect(item.op.row.identity).toEqual(keys.identity);
    }
    expect(Object.keys(keys).toSorted()).toEqual(["identity", "signingPublic"]);
    noteValue(keys);
  });

  test("a stored pair is used as it is, and one whose identity is not its hash is refused", async () => {
    const { flushes, writer } = recordingWriter();
    const kept = (
      await ensureHubKeys({ signingPublic: HUB_SIGNING_PUBLIC, identity: HUB_IDENTITY }, writer)
    )._unsafeUnwrap();
    expect(kept.identity).toEqual(HUB_IDENTITY);
    expect(flushes).toEqual([]);
    expect(
      checkHubKeys({ signingPublic: HUB_SIGNING_PUBLIC, identity: new Uint8Array(8) }).isErr(),
    ).toBe(true);
    expect(
      checkHubKeys({ signingPublic: new Uint8Array(10), identity: HUB_IDENTITY }).isErr(),
    ).toBe(true);
  });

  test("a failed commit is an error, not a key the hub would then forget", async () => {
    const writer = {
      stage: () => undefined,
      flush: () =>
        ({
          isOk: () => false,
          isErr: () => true,
          error: { kind: "storage", origin: "t", message: "disk" },
        }) as never,
    };
    expect((await ensureHubKeys(undefined, writer)).isErr()).toBe(true);
  });
});

describe("mDNS (§10)", () => {
  function fake() {
    const published: Parameters<MdnsLibrary["publish"]>[0][] = [];
    let destroyed = 0;
    const library: MdnsLibrary = {
      publish: (options) => {
        published.push(options);
        return {};
      },
      unpublishAll: () => undefined,
      destroy: () => {
        destroyed += 1;
      },
    };
    return { library, published, destroyed: () => destroyed };
  }

  test("_hsn-hub._tcp on the served port, with the identity in its TXT record", () => {
    const { library, published } = fake();
    const advertiser = new MdnsAdvertiser(8080, () => library);
    expect(advertiser.advertise(HUB_IDENTITY, 0).isOk()).toBe(true);
    expect(published).toEqual([
      {
        name: instanceName(HUB_IDENTITY),
        type: SERVICE_TYPE,
        protocol: "tcp",
        port: 8080,
        txt: { [IDENTITY_TXT_KEY]: toHex(HUB_IDENTITY) },
      },
    ]);
    expect(SERVICE_TYPE).toBe("hsn-hub");
  });

  test("advertising again replaces the advertisement; stop ends it", () => {
    const { library, published, destroyed } = fake();
    const advertiser = new MdnsAdvertiser(8080, () => library);
    expect(advertiser.advertise(HUB_IDENTITY, 9000).isOk()).toBe(true);
    expect(advertiser.advertise(HUB_IDENTITY, 0).isOk()).toBe(true);
    expect(published.map((p) => p.port)).toEqual([9000, 8080]);
    expect(advertiser.stop().isOk()).toBe(true);
    expect(destroyed()).toBe(2);
  });

  test("a library that throws becomes an error result, to be recorded", () => {
    const advertiser = new MdnsAdvertiser(8080, () => ({
      publish: () => {
        return JSON.parse("{") as never;
      },
      unpublishAll: () => undefined,
      destroy: () => undefined,
    }));
    expect(advertiser.advertise(HUB_IDENTITY, 0).isErr()).toBe(true);
  });
});
