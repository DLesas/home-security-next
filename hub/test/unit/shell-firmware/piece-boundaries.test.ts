import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeTransferFrame,
  encodeTransferFrame,
  GoneReason,
  IMAGE_HEADER,
  TRANSFER_LIMITS,
  TransferKind,
} from "@hsn/protocol/update";
import type { HubEvent } from "../../../src/core/model/events.ts";
import { linkId } from "../../../src/core/model/ids.ts";
import { TransferServer } from "../../../src/shell/firmware/serve.ts";
import { imageFileName, storeFolder } from "../../../src/shell/firmware/store.ts";
import { sha256, tempFolder } from "./support.ts";

const rigs: { server: TransferServer; folder: ReturnType<typeof tempFolder> }[] = [];

afterEach(() => {
  for (const { server, folder } of rigs.splice(0)) {
    server.close();
    folder.remove();
  }
});

const piece = TRANSFER_LIMITS.maxDataBytes;

test.each([piece, piece + 1])(
  "serves a %i-byte payload including its exact final piece",
  (size) => {
    const folder = tempFolder("piece-boundary");
    const dataDir = folder.path;
    const sent: Uint8Array[] = [];
    const events: HubEvent[] = [];
    const server = new TransferServer({
      dataDir,
      send: (_link, bytes) => {
        sent.push(bytes);
        return true;
      },
      emit: (event) => events.push(event),
      stopwatch: () => 0,
    });
    rigs.push({ server, folder });

    const payload = Uint8Array.from({ length: size }, (_, i) => i % 251);
    const digest = sha256(payload);
    const file = imageFileName(digest);
    const imageId = digest.slice(0, 8);
    const header = new Uint8Array(IMAGE_HEADER.bytes);
    // Protocol §10 stores the payload length in the four bytes before the hash.
    new DataView(header.buffer).setUint32(IMAGE_HEADER.sha256Offset - 4, size, true);
    mkdirSync(storeFolder(dataDir), { recursive: true });
    writeFileSync(join(storeFolder(dataDir), file), payload);
    const link = linkId(1);
    server.grant(link, { imageId, header, file });

    /** Requests one piece and requires exactly one reply on the granted link. */
    function get(offset: number, length: number) {
      const request = encodeTransferFrame({ kind: TransferKind.Get, imageId, offset, length });
      if (!request.ok) return expect.unreachable("invalid Get fixture");
      expect(server.take(link, request.value)).toBe(true);
      expect(sent).toHaveLength(1);
      const reply = decodeTransferFrame(sent.pop() ?? new Uint8Array());
      if (!reply.ok) return expect.unreachable("invalid transfer reply");
      return reply.value;
    }

    expect(get(0, header.length)).toMatchObject({
      kind: TransferKind.Data,
      offset: 0,
      data: header,
    });
    expect(get(header.length, piece)).toMatchObject({
      kind: TransferKind.Data,
      offset: header.length,
      data: payload.slice(0, piece),
    });
    if (size > piece) {
      expect(events).toEqual([]);
      expect(get(header.length + piece, 1)).toMatchObject({
        kind: TransferKind.Data,
        offset: header.length + piece,
        data: payload.slice(piece),
      });
    }
    expect(events).toEqual([
      { kind: "transferProgress", link, image: imageId, bytes: header.length + size },
    ]);
    expect(get(header.length + size, 1)).toEqual({
      kind: TransferKind.Gone,
      imageId,
      reason: GoneReason.OutOfRange,
    });
  },
);
