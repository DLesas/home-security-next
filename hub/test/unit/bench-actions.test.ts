/**
 * The bench's `HubAction`s from the hub's records (`core/model/bench-actions.ts`): a packet's
 * outcome lives on its `tx` row, and the bench's `reply`, `transmit_result`, `too_late` and
 * `reply_skipped` come from it.
 */
import { describe, expect, test } from "bun:test";
import { MessageType } from "@hsn/protocol";
import type { AuditRecord } from "../../src/core/model/audit.ts";
import { benchActions } from "../../src/core/model/bench-actions.ts";
import { deviceId, seq } from "../../src/core/model/ids.ts";
import { PacketPath, TxOutcome } from "../../src/core/model/rows.ts";

function tx(
  table: "routine" | "event",
  type: number,
  outcome: TxOutcome,
  path: PacketPath = PacketPath.Lora,
): AuditRecord {
  return {
    kind: "tx",
    table,
    row: {
      seq: seq(1),
      atMs: 0,
      clockOk: true,
      deviceId: deviceId(3),
      type,
      counter: 1025,
      path,
      gatewayId: deviceId(1),
      requestCounter: 7,
      rate: 5,
      power: 14,
      outcome,
      gwSentUs: null,
      body: new Uint8Array(),
    },
  };
}

describe("the bench's actions", () => {
  test("a heartbeat's reply: reply and transmit_result; too late or skipped when it missed", () => {
    expect(benchActions(tx("routine", MessageType.Reply, TxOutcome.Sent))).toEqual([
      "reply",
      "transmit_result",
    ]);
    expect(benchActions(tx("routine", MessageType.Reply, TxOutcome.TooLate))).toEqual([
      "reply",
      "transmit_result",
      "too_late",
    ]);
    expect(benchActions(tx("routine", MessageType.Reply, TxOutcome.RadioBusy))).toEqual([
      "reply",
      "transmit_result",
      "reply_skipped",
    ]);
    // No gateway answered: no transmit result, the reply skipped.
    expect(benchActions(tx("routine", MessageType.Reply, TxOutcome.NoResult))).toEqual([
      "reply",
      "reply_skipped",
    ]);
  });

  test("an event's reply or a siren command over LoRa: transmit_result; over Wi-Fi: nothing", () => {
    expect(benchActions(tx("event", MessageType.Reply, TxOutcome.Sent))).toEqual([
      "transmit_result",
    ]);
    expect(benchActions(tx("event", MessageType.SirenCommand, TxOutcome.TooLate))).toEqual([
      "transmit_result",
      "too_late",
    ]);
    expect(
      benchActions(tx("event", MessageType.SirenCommand, TxOutcome.HandedToLink, PacketPath.Wifi)),
    ).toEqual([]);
  });
});
