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
      resultCounter: null,
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

function rx(type: number, oldKey = false): AuditRecord {
  return {
    kind: "rx",
    table: "event",
    row: {
      seq: seq(2),
      atMs: 0,
      clockOk: true,
      deviceId: deviceId(3),
      type,
      counter: 1026,
      path: PacketPath.Lora,
      gatewayId: deviceId(1),
      gwUs: 1000,
      gwCounter: 9,
      rssi: -80,
      snrQ: 20,
      rate: 5,
      body: new Uint8Array(),
      oldKey,
    },
  };
}

describe("the bench's firmware actions from packet records (m3-updates-design section 8)", () => {
  test("a sent Update offer is firmware_offer on every path, before its transmit_result", () => {
    expect(benchActions(tx("event", MessageType.UpdateOffer, TxOutcome.Sent))).toEqual([
      "firmware_offer",
      "transmit_result",
    ]);
    expect(benchActions(tx("event", MessageType.UpdateOffer, TxOutcome.TooLate))).toEqual([
      "firmware_offer",
      "transmit_result",
      "too_late",
    ]);
    for (const path of [PacketPath.Wifi, PacketPath.Usb])
      expect(
        benchActions(tx("event", MessageType.UpdateOffer, TxOutcome.HandedToLink, path)),
      ).toEqual(["firmware_offer"]);
    expect(benchActions(tx("event", MessageType.KeyChange, TxOutcome.Sent))).toEqual([
      "transmit_result",
    ]);
  });

  test("a received query or status is firmware_query or firmware_status; other packets nothing", () => {
    expect(benchActions(rx(MessageType.UpdateQuery))).toEqual(["firmware_query"]);
    expect(benchActions(rx(MessageType.UpdateStatus))).toEqual(["firmware_status"]);
    for (const type of [MessageType.Heartbeat, MessageType.Started, MessageType.DoorChanged])
      expect([type, benchActions(rx(type))]).toEqual([type, []]);
  });

  test("a packet under the old key is old_key_packet only, whatever its type", () => {
    for (const type of [MessageType.Heartbeat, MessageType.UpdateQuery, MessageType.UpdateStatus])
      expect([type, benchActions(rx(type, true))]).toEqual([type, ["old_key_packet"]]);
  });
});
