/**
 * The firmware store's index and where a release comes from (docs/m3-updates-design.md section 4,
 * D140; section 3, an owner's own build): uploads with their refusals in order, the four-image and
 * 8 MB limits at their edges, the same image twice, removal (not of one a rollout uses), download;
 * the relay's offers, each version recorded once, a fetch refused over 8 MB at its edge, an older
 * version fetched.
 */
import { describe, expect, test } from "bun:test";
import {
  FIRMWARE_FILE_REFUSALS,
  OFFER_AND_ROLLOUT_REFUSALS,
  type ReleaseOffer,
} from "@hsn/protocol/app";
import { UpdateAction, UpdateHolding, UpdateReason } from "@hsn/protocol";
import {
  connId,
  imageId,
  type JobId,
  jobId,
  jobOwner,
  linkId,
} from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { ImageKind, RolloutStage } from "../../../src/core/model/rows.ts";
import {
  ANNA,
  answerOf,
  bootedView,
  COMPUTER,
  CONSOLE,
  decisions,
  effectsOf,
  hubEvents,
  imageRow,
  offerTo,
  okBody,
  openRow,
  refusal,
  type Ran,
  Runner,
  S1,
  siteSnapshot,
  wifi,
  writes,
} from "./support.ts";

const MB = 1024 * 1024;

function storeRunner(images = 0): Runner {
  const rows = Array.from({ length: images }, (_, i) =>
    imageRow(i + 1, 0x010000 + i, { bytes: 1 * MB }),
  );
  const snapshot = siteSnapshot({ firmwareImages: rows });
  const runner = new Runner(bootedView(snapshot));
  runner.boot(snapshot);
  return runner;
}

function staged(id: number, bytes = 1 * MB) {
  const row = imageRow(id, 0x020000 + id, { bytes });
  const image = {
    imageId: row.imageId,
    sha256: row.sha256,
    version: row.version,
    kind: row.kind,
    roles: row.roles,
    bytes: row.bytes,
    header: row.header,
    manifest: row.manifest,
    file: row.file,
  };
  return { kind: "firmwareStaged" as const, image };
}

/** The job a step asked the shell for. */
function jobOf(ran: Ran): JobId {
  const job = effectsOf(ran, "fileJob")[0];
  expect(job).toBeDefined();
  return (job?.job ?? 0) as JobId;
}

describe("firmware.upload", () => {
  test("console only: from a person's app it is refused; from hsn and the console it is staged", () => {
    const runner = storeRunner();
    // Anna has manage system, but is not on the console.
    const fromApp = runner.op({ op: "firmware.upload", body: { job: 1 } }, ANNA, "app");
    expect(refusal(fromApp.answer)).toEqual({ code: "consoleOnly", detail: {} });
    const fromConsole = runner.op({ op: "firmware.upload", body: { job: 1 } }, CONSOLE, "app");
    expect(fromConsole.answer).toBeUndefined();
    const job = effectsOf(fromConsole, "fileJob")[0];
    expect(job?.work).toEqual({
      kind: "stageFirmware",
      upload: { conn: connId(8), job: 1 },
      own: null,
    });
  });

  test("an own build needs the console's confirmation", () => {
    const runner = storeRunner();
    const unconfirmed = runner.op({
      op: "firmware.upload",
      body: { job: 3, own: { version: "1.4.0" } },
    });
    expect(refusal(unconfirmed.answer)).toEqual(FIRMWARE_FILE_REFUSALS.notConfirmed);
    expect(effectsOf(unconfirmed, "fileJob")).toEqual([]);
    const confirmed = runner.op({
      op: "firmware.upload",
      body: { job: 3, own: { version: "1.4.0" }, confirmOwn: true },
    });
    expect(effectsOf(confirmed, "fileJob")[0]?.work).toMatchObject({ own: { version: "1.4.0" } });
  });

  test("staged: its row written now, firmware_added, and the image as the answer", () => {
    const runner = storeRunner();
    const asked = runner.op({ op: "firmware.upload", body: { job: 1 } });
    const done = runner.fileReady(jobOf(asked), staged(1));
    const rows = writes(done).filter((w) => w.table === "firmware_images");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.durability).toBe("now");
    expect(decisions(done).find((d) => d.kind === "firmware_added")?.value).toBe(1);
    expect(answerOf(done)).toEqual({
      ok: true,
      body: {
        id: 1,
        imageId: "4141414141414141",
        version: "2.0.1",
        kind: "official",
        roles: [1, 2, 3],
        bytes: MB,
        addedMs: runner.now.wall,
      },
    });
  });

  test.each(["badFile", "badSignature", "wrongTarget", "tooLarge", "storeFull"] as const)(
    "refused %s: the answer, and firmware_file_refused",
    (reason) => {
      const runner = storeRunner();
      const job = jobOf(runner.op({ op: "firmware.upload", body: { job: 1 } }));
      const done = runner.fileReady(job, { kind: "failed", reason, message: "no" });
      expect(answerOf(done)).toEqual({
        ok: false,
        error: FIRMWARE_FILE_REFUSALS[reason],
      });
      expect(hubEvents(done)[0]).toMatchObject({
        code: "firmware_file_refused",
        durability: "routine",
      });
      expect(JSON.parse(hubEvents(done)[0]?.detail ?? "{}")).toMatchObject({ reason });
    },
  );

  test("an upload that is not there: notFound, naming it", () => {
    const runner = storeRunner();
    const job = jobOf(runner.op({ op: "firmware.upload", body: { job: 9 } }));
    const done = runner.fileReady(job, { kind: "failed", reason: "noUpload", message: "gone" });
    expect(answerOf(done)).toEqual({
      ok: false,
      error: { code: "notFound", detail: { what: "upload", id: 9 } },
    });
    expect(hubEvents(done)).toEqual([]);
  });

  test("the fourth image is taken; a fifth is refused before staging", () => {
    const three = storeRunner(DEFAULT_RULES.firmware.maxImages - 1);
    expect(
      effectsOf(three.op({ op: "firmware.upload", body: { job: 1 } }), "fileJob"),
    ).toHaveLength(1);
    const four = storeRunner(DEFAULT_RULES.firmware.maxImages);
    const refused = four.op({ op: "firmware.upload", body: { job: 1 } });
    expect(refusal(refused.answer)).toEqual(FIRMWARE_FILE_REFUSALS.storeFull);
    expect(effectsOf(refused, "fileJob")).toEqual([]);
  });

  test("8 MB: an image that fills the store exactly is taken; one byte more is refused and its file taken out", () => {
    const runner = storeRunner(2); // 2 MB stored
    const exact = DEFAULT_RULES.firmware.storeMaxBytes - 2 * MB;
    const first = runner.fileReady(
      jobOf(runner.op({ op: "firmware.upload", body: { job: 1 } })),
      staged(5, exact),
    );
    expect(answerOf(first)).toMatchObject({ ok: true });
    expect(writes(first).filter((w) => w.table === "firmware_images")).toHaveLength(1);

    const over = storeRunner(2);
    const done = over.fileReady(
      jobOf(over.op({ op: "firmware.upload", body: { job: 1 } })),
      staged(5, exact + 1),
    );
    expect(answerOf(done)).toEqual({
      ok: false,
      error: FIRMWARE_FILE_REFUSALS.storeFull,
    });
    expect(writes(done).filter((w) => w.table === "firmware_images")).toEqual([]);
    expect(effectsOf(done, "fileJob")[0]?.work).toMatchObject({
      kind: "removeFirmware",
      image: imageId(0),
    });
  });

  test("the same image twice is the stored one: no second row", () => {
    const runner = storeRunner();
    runner.fileReady(jobOf(runner.op({ op: "firmware.upload", body: { job: 1 } })), staged(1));
    const again = runner.fileReady(
      jobOf(runner.op({ op: "firmware.upload", body: { job: 2 } })),
      staged(1),
    );
    expect(writes(again).filter((w) => w.table === "firmware_images")).toEqual([]);
    expect(effectsOf(again, "fileJob")).toEqual([]);
    const answer = again.messages.find((m) => m.kind === "opAnswer");
    expect(answer?.kind === "opAnswer" && answer.outcome.ok).toBe(true);
  });

  test("an own build is stored as one", () => {
    const runner = storeRunner();
    const job = jobOf(
      runner.op({
        op: "firmware.upload",
        body: { job: 1, own: { version: "2.0.1" }, confirmOwn: true },
      }),
    );
    const image = { ...staged(1).image, kind: ImageKind.OwnBuild, manifest: null };
    const done = runner.fileReady(job, { kind: "firmwareStaged", image });
    const answer = done.messages.find((m) => m.kind === "opAnswer");
    expect(
      answer?.kind === "opAnswer" && answer.outcome.ok ? answer.outcome.body : undefined,
    ).toMatchObject({
      kind: "ownBuild",
    });
  });
});

describe("firmware.remove, firmware.download, firmware.list", () => {
  test("remove: written now with its removal time, firmware_removed, the file job; then gone from the list", () => {
    const runner = storeRunner(2);
    const ran = runner.op({ op: "firmware.remove", body: { image: 1 } });
    okBody(ran.answer);
    const row = writes(ran).find((w) => w.table === "firmware_images");
    expect(row?.durability).toBe("now");
    expect(
      row?.op.op === "upsert" && row.op.table === "firmware_images" ? row.op.row.removedMs : null,
    ).toBe(runner.now.wall);
    expect(decisions(ran).find((d) => d.kind === "firmware_removed")?.value).toBe(1);
    expect(effectsOf(ran, "fileJob")[0]?.work).toEqual({
      kind: "removeFirmware",
      image: imageId(1),
      file: "1.bin",
    });
    const list = okBody(runner.op({ op: "firmware.list", body: {} }).answer) as {
      images: { id: number }[];
    };
    expect(list.images.map((i) => i.id)).toEqual([2]);
    expect(refusal(runner.op({ op: "firmware.remove", body: { image: 1 } }).answer)).toEqual({
      code: "notFound",
      detail: { what: "image", id: 1 },
    });
  });

  test("an image a rollout uses is not removed; once the rollout is cancelled, it is", () => {
    const runner = storeRunner(1);
    runner.op({ op: "rollout.start", body: { image: 1 } });
    expect(refusal(runner.op({ op: "firmware.remove", body: { image: 1 } }).answer)).toEqual({
      code: "invalid",
      detail: { field: "image", reason: "inUse", refs: [1] },
    });
    runner.op({ op: "rollout.cancel", body: { rollout: 1 } });
    okBody(runner.op({ op: "firmware.remove", body: { image: 1 } }).answer);
  });

  test("download: the header and file to the asking connection, {job}; an unknown image notFound", () => {
    const runner = storeRunner(1);
    const ran = runner.op({ op: "firmware.download", body: { image: 1 } }, COMPUTER, "app");
    const job = effectsOf(ran, "fileJob")[0];
    expect(job?.work).toEqual({
      kind: "sendFirmware",
      conn: connId(8),
      header: imageRow(1).header,
      file: "1.bin",
    });
    expect(okBody(ran.answer)).toEqual({ job: job?.job });
    expect(refusal(runner.op({ op: "firmware.download", body: { image: 7 } }).answer)).toEqual({
      code: "notFound",
      detail: { what: "image", id: 7 },
    });
  });

  test("list: every paired device's version and update", () => {
    const runner = storeRunner(1);
    const list = okBody(runner.op({ op: "firmware.list", body: {} }).answer) as {
      devices: { device: number; version: string; update: unknown }[];
    };
    expect(list.devices).toHaveLength(10);
    expect(list.devices[0]).toEqual({ device: 10, version: "1.0.0", update: null });
    runner.op({ op: "rollout.start", body: { image: 1 } });
    const after = okBody(runner.op({ op: "firmware.list", body: {} }).answer) as {
      devices: { device: number; update: unknown }[];
    };
    expect(after.devices[0]?.update).toEqual({ state: "planned", held: null, method: "joinWifi" });
  });
});

describe("releases the relay offered (M4)", () => {
  const offer = (version: string, bytes = 1 * MB): ReleaseOffer => ({
    kind: "firmware",
    version,
    target: "esp32s3",
    roles: [1, 2, 3],
    file: `hsn-firmware-${version}.hsnf`,
    bytes,
    sha256: "ab".repeat(32),
  });
  const hub: ReleaseOffer = {
    kind: "hub",
    version: "2.0.0",
    platform: "linux-arm64",
    file: "hsn-hub-2.0.0-linux-arm64.hsnr",
    bytes: 50 * MB,
    sha256: "cd".repeat(32),
  };

  test("firmware entries kept for firmware.offers, hub ones left to upkeep; each version recorded once", () => {
    const runner = storeRunner();
    const first = runner.send({ kind: "releaseOffered", releases: [hub, offer("1.2.0")] });
    expect(decisions(first)).toEqual([
      { kind: "firmware_release_offered", device: null, value: 0x010200, durability: "routine" },
    ]);
    const again = runner.send({ kind: "releaseOffered", releases: [hub, offer("1.2.0")] });
    expect(decisions(again)).toEqual([]);
    expect(okBody(runner.op({ op: "firmware.offers", body: {} }).answer)).toEqual({
      offers: [{ version: "1.2.0", bytes: MB, roles: [1, 2, 3] }],
    });
  });

  test("fetch: the relay's file, its size and hash, answered {job}; staged with no further answer", () => {
    const runner = storeRunner();
    runner.send({ kind: "releaseOffered", releases: [offer("1.2.0")] });
    const ran = runner.op({ op: "firmware.fetch", body: { version: "1.2.0" } });
    const job = effectsOf(ran, "fileJob")[0];
    expect(job?.work).toEqual({
      kind: "fetchRelease",
      release: "firmware",
      file: "hsn-firmware-1.2.0.hsnf",
      bytes: MB,
      sha256: new Uint8Array(32).fill(0xab),
    });
    expect(okBody(ran.answer)).toEqual({ job: job?.job });
    const done = runner.fileReady(job?.job ?? (0 as JobId), staged(1));
    expect(writes(done).filter((w) => w.table === "firmware_images")).toHaveLength(1);
    expect(done.messages.filter((m) => m.kind === "opAnswer")).toEqual([]);
  });

  test("a version not offered is refused; over 8 MB it is refused before a byte is fetched, at its edge", () => {
    const runner = storeRunner();
    expect(refusal(runner.op({ op: "firmware.fetch", body: { version: "1.2.0" } }).answer)).toEqual(
      OFFER_AND_ROLLOUT_REFUSALS.notOffered,
    );
    const max = DEFAULT_RULES.firmware.fileMaxBytes;
    runner.send({
      kind: "releaseOffered",
      releases: [offer("1.2.0", max), offer("1.3.0", max + 1)],
    });
    expect(
      effectsOf(runner.op({ op: "firmware.fetch", body: { version: "1.2.0" } }), "fileJob"),
    ).toHaveLength(1);
    const over = runner.op({ op: "firmware.fetch", body: { version: "1.3.0" } });
    expect(refusal(over.answer)).toEqual(OFFER_AND_ROLLOUT_REFUSALS.offerTooLarge);
    expect(effectsOf(over, "fileJob")).toEqual([]);
  });

  test("an older version than the stored ones may be fetched: no notNewer", () => {
    const runner = storeRunner(2);
    runner.send({ kind: "releaseOffered", releases: [offer("0.9.0")] });
    expect(
      effectsOf(runner.op({ op: "firmware.fetch", body: { version: "0.9.0" } }), "fileJob"),
    ).toHaveLength(1);
  });

  test("a fetched release refused is recorded with its version", () => {
    const runner = storeRunner();
    runner.send({ kind: "releaseOffered", releases: [offer("1.2.0")] });
    const job = effectsOf(
      runner.op({ op: "firmware.fetch", body: { version: "1.2.0" } }),
      "fileJob",
    )[0];
    const done = runner.fileReady(job?.job ?? (0 as JobId), {
      kind: "failed",
      reason: "badSignature",
      message: "x",
    });
    expect(JSON.parse(hubEvents(done)[0]?.detail ?? "{}")).toEqual({
      reason: "badSignature",
      message: "x",
      version: "1.2.0",
    });
  });
});

describe("jobs", () => {
  test("firmware's job numbers are its own: upkeep's, counted from 1, never meet them", () => {
    const runner = storeRunner(1);
    const job = effectsOf(runner.op({ op: "firmware.download", body: { image: 1 } }), "fileJob")[0]
      ?.job;
    expect(job).toBeGreaterThanOrEqual(2 ** 31);
    // A fileReady for a job it did not make is not its.
    const other = runner.fileReady(jobId(1), staged(3));
    expect(other.out).toEqual([]);
  });
});

describe("a damaged store (firmwareStoreDamaged)", () => {
  test("recorded critical and now; the image dropped from the index, written now", () => {
    const runner = storeRunner(2);
    const ran = runner.send({
      kind: "firmwareStoreDamaged",
      image: imageId(1),
      problem: "missing",
    });
    expect(hubEvents(ran)).toHaveLength(1);
    expect(hubEvents(ran)[0]).toMatchObject({ code: "firmware_store_damaged", durability: "now" });
    expect(JSON.parse(hubEvents(ran)[0]?.detail ?? "{}")).toEqual({
      image: 1,
      problem: "missing",
      version: "1.0.0",
    });
    const row = writes(ran).find((w) => w.table === "firmware_images");
    expect(row?.durability).toBe("now");
    expect(
      row?.op.op === "upsert" && row.op.table === "firmware_images" ? row.op.row.removedMs : null,
    ).toBe(runner.now.wall);
    const list = okBody(runner.op({ op: "firmware.list", body: {} }).answer) as {
      images: { id: number }[];
    };
    expect(list.images.map((i) => i.id)).toEqual([2]);
  });

  test("an image it does not index: recorded, nothing else", () => {
    const runner = storeRunner(1);
    const ran = runner.send({
      kind: "firmwareStoreDamaged",
      image: imageId(9),
      problem: "wrongHash",
    });
    expect(hubEvents(ran).map((e) => e.code)).toEqual(["firmware_store_damaged"]);
    expect(writes(ran)).toEqual([]);
  });

  test("the open rollout's image: its grants taken back, the rollout paused hashMismatch; added again, it resumes", () => {
    const runner = storeRunner(1);
    runner.hearAll();
    runner.op({ op: "rollout.start", body: { image: 1, devices: [S1] } });
    runner.query(S1);
    runner.query(S1, {}, wifi(501));
    const damaged = runner.send({
      kind: "firmwareStoreDamaged",
      image: imageId(1),
      problem: "wrongHash",
    });
    expect(effectsOf(damaged, "transferRevoke")).toEqual([
      { kind: "transferRevoke", link: linkId(501), reason: "notGranted" },
    ]);
    expect(openRow(runner)).toMatchObject({
      stage: RolloutStage.Paused,
      pausedReason: UpdateReason.HashMismatch,
      pausedDevice: null,
    });
    const status = okBody(runner.op({ op: "rollout.status", body: {} }).answer) as {
      rollout: { paused: unknown };
    };
    expect(status.rollout.paused).toEqual({ reason: "hashMismatch", device: null });
    // Nothing can be served: the device asking on its link is told to wait, with no grant.
    const asked = runner.query(S1, { held: UpdateHolding.Part }, wifi(501));
    expect(offerTo(asked, S1)?.offer.action).toBe(UpdateAction.KeepAndWait);
    expect(effectsOf(asked, "transferGrant")).toEqual([]);
    expect(refusal(runner.op({ op: "rollout.resume", body: { rollout: 1 } }).answer)).toEqual({
      code: "notFound",
      detail: { what: "image", id: 1 },
    });
    // Added again: its own row comes back, and the rollout goes on.
    const again = runner.fileReady(jobOf(runner.op({ op: "firmware.upload", body: { job: 4 } })), {
      kind: "firmwareStaged",
      image: { ...stagedOf(imageRow(1, 0x010000, { bytes: MB })) },
    });
    expect(answerOf(again)).toMatchObject({ ok: true, body: { id: 1 } });
    okBody(runner.op({ op: "rollout.resume", body: { rollout: 1 } }).answer);
    const back = runner.query(S1, { held: UpdateHolding.Part }, wifi(501));
    expect(offerTo(back, S1)?.offer.action).toBe(UpdateAction.Fetch);
  });
});

describe("job numbers", () => {
  test("firmware's are in JOB_RANGES.firmware", () => {
    const runner = storeRunner(1);
    const job = effectsOf(runner.op({ op: "firmware.download", body: { image: 1 } }), "fileJob")[0]
      ?.job;
    expect(job === undefined ? undefined : jobOwner(job)).toBe("firmware");
  });
});

/** A row's staged fields, as the shell's `firmwareStaged` gives them. */
function stagedOf(row: ReturnType<typeof imageRow>) {
  return {
    imageId: row.imageId,
    sha256: row.sha256,
    version: row.version,
    kind: row.kind,
    roles: row.roles,
    bytes: row.bytes,
    header: row.header,
    manifest: row.manifest,
    file: row.file,
  };
}
