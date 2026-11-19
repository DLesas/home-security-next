/**
 * `@hsn/protocol/pairing`: pairing over Bluetooth (docs/m3-design.md section 5, D133). Frozen by
 * the joint step 0; P3 adds the implementations beside these files. Not to be confused with
 * `../pairing.ts`, §9's pairing data, which this pairing carries inside its Provision message.
 */
export * from "./constants.ts";
export * from "./types.ts";
export * from "./vector-formats.ts";
// P3's implementations (FROZEN-CHANGE: these exports added).
export * from "./board-vector-formats.ts";
export * from "./code.ts";
export * from "./protobuf.ts";
export * from "./security2.ts";
export * from "./setup-session.ts";
export * from "./srp.ts";
