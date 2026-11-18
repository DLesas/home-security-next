/** The release files' values and both manifest schemas (m4-design.md section 6; m3-updates section 3). */
import { describe, expect, test } from "bun:test";
import {
  FIRMWARE_RELEASE,
  firmwareManifestRefusal,
  firmwareManifestSchema,
  firmwareReleaseFileName,
  HUB_RELEASE,
  hubManifestSchema,
  hubReleaseFileName,
  parseReleaseFileName,
} from "../src/release/index.ts";

const sha = "ab".repeat(32);

describe("the two files' fixed values", () => {
  test("hub release: HSNR, format 2, hsn-release/1, 1 MiB manifest, 256 MiB", () => {
    expect(HUB_RELEASE).toMatchObject({
      magic: "HSNR",
      format: 2,
      fixedBytes: 12,
      signatureBytes: 64,
      label: "hsn-release/1",
      extension: ".hsnr",
      maxManifestBytes: 1_048_576,
      maxFiles: 4096,
      maxFileBytes: 268_435_456,
      maxPathBytes: 255,
      maxReleaseBytes: 268_435_456,
    });
  });

  test("firmware release: HSNF, format 1, hsn-firmware/1, 64 KiB manifest, 8 MiB, a 3.5 MiB slot", () => {
    expect(FIRMWARE_RELEASE).toEqual({
      magic: "HSNF",
      format: 1,
      fixedBytes: 12,
      signatureBytes: 64,
      label: "hsn-firmware/1",
      extension: ".hsnf",
      maxManifestBytes: 65_536,
      maxReleaseBytes: 8_388_608,
      target: "esp32s3",
      slotBytes: 3_670_016,
    });
    expect(FIRMWARE_RELEASE.label).not.toBe(HUB_RELEASE.label);
  });
});

describe("the hub release's manifest", () => {
  const good = {
    version: "1.2.3",
    platform: "linux-arm64",
    madeMs: 0,
    payloadBytes: 10,
    payloadSha256: sha,
    files: [{ path: "bin/hub", bytes: 10, sha256: sha, executable: true }],
  };
  test("accepts a good one and refuses each bad field", () => {
    expect(hubManifestSchema.safeParse(good).success).toBe(true);
    const bad = [
      { ...good, version: "1.2" },
      { ...good, version: "01.2.3" },
      { ...good, platform: "linux-riscv" },
      { ...good, madeMs: -1 },
      { ...good, payloadBytes: 0 },
      { ...good, payloadSha256: sha.toUpperCase() },
      { ...good, files: [] },
      { ...good, files: [{ ...good.files[0], bytes: 268_435_457 }] },
      { ...good, extra: 1 },
    ];
    for (const manifest of bad) expect(hubManifestSchema.safeParse(manifest).success).toBe(false);
  });
});

describe("the firmware release's manifest", () => {
  const good = {
    kind: "firmware",
    version: "1.4.0",
    target: "esp32s3",
    roles: [1, 2, 3],
    payloadBytes: 1_572_864,
    payloadSha256: sha,
    madeMs: 1_763_000_000_000,
  };
  test("accepts a good one", () => {
    expect(firmwareManifestSchema.safeParse(good).success).toBe(true);
    expect(firmwareManifestSchema.safeParse({ ...good, roles: [2] }).success).toBe(true);
    expect(firmwareManifestSchema.safeParse({ ...good, payloadBytes: 8_388_608 }).success).toBe(
      true,
    );
  });
  test.each([
    ["no kind", { ...good, kind: undefined }],
    ["kind hub", { ...good, kind: "hub" }],
    ["a version with a leading zero", { ...good, version: "1.04.0" }],
    ["a version with a suffix", { ...good, version: "1.4.0-rc1" }],
    ["an empty target", { ...good, target: "" }],
    ["a target in capitals", { ...good, target: "ESP32S3" }],
    ["no roles", { ...good, roles: [] }],
    ["a role twice", { ...good, roles: [1, 1] }],
    ["role 0", { ...good, roles: [0] }],
    ["role 4", { ...good, roles: [4] }],
    ["four roles", { ...good, roles: [1, 2, 3, 3] }],
    ["an empty payload", { ...good, payloadBytes: 0 }],
    ["a payload over the file's 8 MiB", { ...good, payloadBytes: 8_388_609 }],
    ["a fractional payload", { ...good, payloadBytes: 1.5 }],
    ["a short hash", { ...good, payloadSha256: "ab" }],
    ["a negative time", { ...good, madeMs: -1 }],
    ["a platform, which is the hub's", { ...good, platform: "linux-x64" }],
  ])("refuses %s", (_, manifest) => {
    expect(firmwareManifestSchema.safeParse(manifest).success).toBe(false);
  });
  test("then wrongTarget, then tooLarge, at the slot's edge", () => {
    const parse = (m: object) => firmwareManifestSchema.parse(m);
    expect(firmwareManifestRefusal(parse(good))).toBeUndefined();
    expect(firmwareManifestRefusal(parse({ ...good, payloadBytes: 3_670_016 }))).toBeUndefined();
    expect(firmwareManifestRefusal(parse({ ...good, payloadBytes: 3_670_017 }))).toBe("tooLarge");
    expect(
      firmwareManifestRefusal(parse({ ...good, target: "esp32c6", payloadBytes: 3_670_017 })),
    ).toBe("wrongTarget");
  });
});

describe("file names", () => {
  test("hsn-hub-<version>-<platform>.hsnr and hsn-firmware-<version>.hsnf", () => {
    expect(hubReleaseFileName("1.2.3", "windows-x64")).toBe("hsn-hub-1.2.3-windows-x64.hsnr");
    expect(firmwareReleaseFileName("0.1.0")).toBe("hsn-firmware-0.1.0.hsnf");
    expect(parseReleaseFileName("hsn-hub-10.0.1-darwin-arm64.hsnr")).toEqual({
      kind: "hub",
      version: "10.0.1",
      platform: "darwin-arm64",
    });
    expect(parseReleaseFileName("hsn-firmware-2.3.4.hsnf")).toEqual({
      kind: "firmware",
      version: "2.3.4",
    });
    for (const name of [
      "hsn-hub-1.2.3.hsnr",
      "hsn-hub-1.2.3-linux-riscv.hsnr",
      "hsn-firmware-1.2.3.hsnr",
      "hsn-firmware-1.2.hsnf",
      "hsn-firmware-1.02.3.hsnf",
      "xhsn-firmware-1.2.3.hsnf",
      "hsn-firmware-1.2.3.hsnf.part",
    ])
      expect([name, parseReleaseFileName(name)]).toEqual([name, undefined]);
  });
});
