/**
 * The two ports M2 adds (m2-design.md section 2): `ClientKeys` and `LinkSecrets`, as step 0's
 * in-memory implementations keep them.
 */
import { describe, expect, test } from "bun:test";
import { clientId, personId, tokenId } from "../../../src/core/model/ids.ts";
import { ClientKind, type ClientRow } from "../../../src/core/model/rows.ts";
import { MemoryClientKeys } from "../../../src/shell/app/client-keys.ts";
import { MemoryLinkSecrets } from "../../../src/shell/app/link-secrets.ts";

function client(id: number, key: number, removedMs: number | null = null): ClientRow {
  return {
    id: clientId(id),
    personId: personId(1),
    staticKey: new Uint8Array(32).fill(key),
    kind: ClientKind.Web,
    name: `client ${id}`,
    linkedByClient: null,
    createdMs: 1,
    removedMs,
    lastSeq: 0,
    lastSeenMs: null,
    backupKeyEpoch: null,
  };
}

describe("ClientKeys", () => {
  test("knows linked clients by key, not removed ones, and follows committed writes", () => {
    const keys = new MemoryClientKeys([client(1, 1), client(2, 2, 5)]);
    expect(keys.lookup(new Uint8Array(32).fill(1))).toEqual({
      client: clientId(1),
      kind: ClientKind.Web,
    });
    expect(keys.lookup(new Uint8Array(32).fill(2))).toBeUndefined();
    keys.applyCommitted([{ table: "clients", op: "upsert", row: client(1, 1, 9) }]);
    expect(keys.lookup(new Uint8Array(32).fill(1))).toBeUndefined();
    keys.applyCommitted([{ table: "clients", op: "upsert", row: client(3, 3) }]);
    expect(keys.lookup(new Uint8Array(32).fill(3))?.client).toBe(clientId(3));
    keys.applyCommitted([{ table: "clients", op: "delete", key: { id: clientId(3) } }]);
    expect(keys.lookup(new Uint8Array(32).fill(3))).toBeUndefined();
  });
});

describe("LinkSecrets", () => {
  test("a token is found by its lookup while given, and not once withdrawn", () => {
    const secrets = new MemoryLinkSecrets();
    const psk = new Uint8Array(32).fill(7);
    secrets.apply(tokenId(4), "link", "0a1b2c3d", psk);
    expect(secrets.find("0a1b2c3d")).toEqual({ token: tokenId(4), purpose: "link", psk });
    secrets.apply(tokenId(4), "link", "0a1b2c3d", null);
    expect(secrets.find("0a1b2c3d")).toBeUndefined();
  });
});
