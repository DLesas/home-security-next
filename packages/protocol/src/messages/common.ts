/** Fields and values shared by several message bodies. */
import { u8 } from "../codec/field.ts";
import { layout, struct } from "../codec/layout.ts";

/** Device roles, as in Started (section 6) and Identity (section 10). */
export const Role = { Sensor: 1, Siren: 2, Gateway: 3 } as const;
export type Role = (typeof Role)[keyof typeof Role];

/** Firmware version: major, minor, patch, one byte each. */
export const firmwareVersion = struct(
  layout([
    ["major", u8],
    ["minor", u8],
    ["patch", u8],
  ]),
);
