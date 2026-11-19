/**
 * The update page's decisions (`update-steps.ts`, which `update-page.tsx` calls), against
 * m3-design.md section 7: the grant's life in memory ends with its key zeroed, going to the
 * background ends an update that holds or asks for a grant, and "Carry on" is offered and started
 * only before its deadline.
 */
import { describe, expect, test } from "bun:test";
import type { ImageCache } from "../src/pairing/download";
import { updateTransfer } from "../src/pairing/update-flow";
import {
  type ActiveUpdate,
  afterFailedSend,
  backgroundEnds,
  mayResume,
  releaseUpdate,
} from "../src/pairing/update-steps";
import type { BleCentral, BluetoothUpdate } from "../src/platform/ble";
import { ManualClock } from "../../tools/ble-bench/src/clock";

/** An update as the page holds it, with what releasing it touches made visible. */
function held() {
  const clock = new ManualClock();
  const grant: BluetoothUpdate = {
    device: 1,
    address: 0x1a2b3c4d,
    imageId: new Uint8Array(8).fill(3),
    version: "1.4.0",
    fileBytes: 640,
    sha256: new Uint8Array(32).fill(4),
    sessionKey: new Uint8Array(32).fill(0xa5),
    windowS: 120,
    expiresAtMs: 900_000,
    needsWake: false,
  };
  const seen = { removed: 0, expiryStopped: 0 };
  const cache: ImageCache = {
    size: 0,
    read: () => undefined,
    append: () => true,
    remove: () => {
      seen.removed += 1;
    },
  };
  const central: BleCentral = {
    state: () => Promise.resolve("on"),
    scan: () => () => undefined,
    connect: () => Promise.resolve({ ok: false, fault: "failed" }),
  };
  const running: ActiveUpdate = {
    offer: { imageId: "03".repeat(8), fileBytes: 640, sha256: "04".repeat(32) },
    image: 7,
    grant,
    cache,
    transfer: updateTransfer(central, clock, grant),
    abort: new AbortController(),
    stopExpiry: () => {
      seen.expiryStopped += 1;
    },
  };
  return { running, seen, grant };
}

describe("releasing the update", () => {
  test("the session key is zeroed, the cached file deleted, the link cancelled and the expiry stopped", () => {
    const { running, seen, grant } = held();
    releaseUpdate(running);
    expect(grant.sessionKey.every((byte) => byte === 0)).toBe(true);
    expect(grant.sessionKey).toHaveLength(32);
    expect(seen).toEqual({ removed: 1, expiryStopped: 1 });
    expect(running.abort.signal.aborted).toBe(true);
  });
});

describe("going to the background", () => {
  test("ends the update while a grant is asked for or held, and nothing otherwise", () => {
    expect(backgroundEnds(true)).toBe(true);
    expect(backgroundEnds(false)).toBe(false);
  });
});

describe("Carry on", () => {
  test("starts only before the resume deadline, to the millisecond", () => {
    expect(mayResume(9_999, 10_000)).toBe(true);
    expect(mayResume(10_000, 10_000)).toBe(false);
    expect(mayResume(10_001, 10_000)).toBe(false);
  });

  test("is offered after a drop or a radio that may come back, once the sensor was reached", () => {
    for (const fault of ["lost", "timeout", "off", "notFound"]) {
      expect(afterFailedSend(fault, 0, 1, false, true)).toBe("resume");
      expect(afterFailedSend(fault, 0, 1, true, false)).toBe("resume");
    }
  });

  test("is not offered at or after its deadline", () => {
    expect(afterFailedSend("lost", 1, 1, true, true)).toBe("fail");
    expect(afterFailedSend("lost", 2, 1, true, true)).toBe("fail");
  });

  test("is not offered when the phone never reached the sensor: the first search failed", () => {
    expect(afterFailedSend("notFound", 0, 1, false, false)).toBe("fail");
  });

  test("is not offered for a fault that another attempt would not cure", () => {
    for (const fault of [
      "failed",
      "unauthorized",
      "wrongTag",
      "windowEnded",
      "expired",
      "protocol",
      "smallMtu",
    ])
      expect({ fault, next: afterFailedSend(fault, 0, 1, true, true) }).toEqual({
        fault,
        next: "fail",
      });
  });
});
