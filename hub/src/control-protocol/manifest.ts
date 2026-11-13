/**
 * The bench's manifest (hub-design.md section 11, "What the bench must provide", item 3):
 * written when a run starts, naming each device, its role, its link kinds and each terminal's
 * path, so the hub's `--serial` paths and the bench bridge can find them.
 */
import { z } from "zod";
import { deviceName, roleName } from "./values.ts";

export const MANIFEST_VERSION = 1;

const manifestLink = z
  .object({
    kind: z.enum(["usb", "network"]),
    /** The pseudo-terminal's path. */
    path: z.string().min(1),
  })
  .readonly();

export const benchManifest = z
  .object({
    version: z.literal(MANIFEST_VERSION),
    devices: z
      .array(
        z
          .object({ name: deviceName, role: roleName, links: z.array(manifestLink).readonly() })
          .readonly(),
      )
      .readonly(),
  })
  .readonly();

export type BenchManifest = z.infer<typeof benchManifest>;
