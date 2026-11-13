/**
 * The protocol package's vector files (packages/protocol/vectors/README.md), read and checked
 * with Zod, for the vector cipher and the tests that use the vectors' devices and packets.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Direction, fromHex, type MaxPacketLength } from "@hsn/protocol";
import { z } from "zod";

export const VECTOR_DIRECTORY = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "packages",
  "protocol",
  "vectors",
);

const hex = z.string().regex(/^(?:[0-9a-f]{2})*$/);
const direction = z.union([z.literal(0), z.literal(1)]);
const maxLength = z.union([z.literal(255), z.literal(1024)]);

const packetCase = z.object({
  name: z.string(),
  canonical: z.boolean(),
  key: hex,
  direction,
  address: z.int(),
  counter: z.int(),
  binding: hex,
  maxLength,
  messageType: z.int(),
  fields: z.unknown(),
  plaintext: hex,
  packet: hex,
});

const messageFile = z.object({
  messageType: z.int(),
  name: z.string(),
  direction,
  cases: z.array(packetCase),
});

/** One case of a message file, with its hex fields as bytes. */
export interface PacketVector {
  readonly file: string;
  readonly name: string;
  readonly canonical: boolean;
  readonly key: Uint8Array;
  readonly direction: Direction;
  readonly address: number;
  readonly counter: number;
  readonly binding: Uint8Array;
  readonly maxLength: MaxPacketLength;
  readonly messageType: number;
  readonly plaintext: Uint8Array;
  readonly packet: Uint8Array;
}

/** Every case of every message file (the files with a top-level `messageType`). */
export function packetVectors(directory: string = VECTOR_DIRECTORY): readonly PacketVector[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .flatMap((file) => {
      const json: unknown = JSON.parse(readFileSync(join(directory, file), "utf8"));
      const parsed = messageFile.safeParse(json);
      if (!parsed.success) return [];
      return parsed.data.cases.map((c): PacketVector => ({
        file,
        name: c.name,
        canonical: c.canonical,
        key: fromHex(c.key),
        direction: c.direction,
        address: c.address,
        counter: c.counter,
        binding: fromHex(c.binding),
        maxLength: c.maxLength,
        messageType: c.messageType,
        plaintext: fromHex(c.plaintext),
        packet: fromHex(c.packet),
      }));
    });
}

/** The packet cases of one file. */
export function vectorsOf(file: string): readonly PacketVector[] {
  return packetVectors().filter((v) => v.file === file);
}
