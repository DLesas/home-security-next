/**
 * History (m2-design.md section 7, "History"; HB15): the records the person may see, newest
 * first, in pages of up to 500 ‡ continued by `before`, filtered by kind and device. What the hub
 * returns is what the person may see; the screen asks and shows. Reads never force a commit on the
 * hub. Times are in the hub's zone, "about" when its clock was not trusted.
 *
 * A decision's kind, a notification's, is said in words when this build knows it, and otherwise
 * shown as the hub names it. Packet bodies are decoded with the browser-safe
 * `@hsn/protocol/messages` (HD 6: a body is the plaintext after the type byte).
 */
import { historyKind, type HistoryRow } from "@hsn/protocol/app";
import { decodeMessage, fromHexSafe, MessageType } from "./packets";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { deviceName, type Translate } from "../state/words";
import { formatTime } from "./format";
import { useHub, useLive } from "./hub-context";
import { Actions, Body, Button, Choice, Failure, Heading, List, ListItem } from "./parts";

/** Rows a page asks for ‡ (the hub allows up to 500). */
export const PAGE_ROWS = 100;

type Kind = (typeof historyKind.options)[number];
type Devices = Parameters<typeof deviceName>[1];

function hexText(hex: string): string {
  const bytes = Uint8Array.from(hex.match(/../gu) ?? [], (b) => Number.parseInt(b, 16));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** A packet: its type in words, and its fields as they decode; the type's number when it does not. */
export function packetWords(
  t: Translate,
  exists: (key: string) => boolean,
  type: number,
  bodyHex: string,
): string {
  const name = Object.entries(MessageType).find(([, value]) => value === type)?.[0];
  const what =
    name !== undefined && exists(`record.packet.${name}`)
      ? t(`record.packet.${name}`)
      : t("record.packetType", { type });
  const body = fromHexSafe(bodyHex);
  if (body === undefined) return what;
  const decoded = decodeMessage(Uint8Array.of(type, ...body));
  if (!decoded.ok) return what;
  const fields = Object.entries(decoded.value)
    .filter(
      ([key, value]) =>
        key !== "type" &&
        (typeof value === "number" || typeof value === "boolean" || typeof value === "string"),
    )
    .map(([key, value]) => `${key} ${String(value)}`);
  return fields.length === 0 ? what : `${what} (${fields.join(", ")})`;
}

/** A row in words: what happened, and to which device. */
export function rowWords(
  t: Translate,
  exists: (key: string) => boolean,
  devices: Devices,
  record: HistoryRow,
): string {
  const name = (id: number | null) => (id === null ? undefined : deviceName(t, devices, id));
  const r = record.row;
  switch (r.kind) {
    case "decision": {
      const key = `history.decision.${r.row.kind}`;
      const what = exists(key) ? t(key) : t("record.unknownDecision", { kind: r.row.kind });
      const device = name(r.row.deviceId);
      return device === undefined ? what : t("record.about", { what, device });
    }
    case "command":
      return t(r.row.outcome === "ok" ? "record.command" : "record.commandRefused", {
        actor: r.row.actor,
        kind: r.row.kind,
        outcome: r.row.outcome,
      });
    case "hubEvent": {
      const level = t(`record.level.${r.row.level}`);
      const key = `history.event.${r.row.code}`;
      return exists(key)
        ? t("record.hubEventKnown", { level, what: t(key) })
        : t("record.hubEvent", { level, message: r.row.message });
    }
    case "rx":
      return t("record.rx", {
        device: name(r.row.deviceId) ?? "",
        what: packetWords(t, exists, r.row.type, r.row.body),
        counter: r.row.counter,
      });
    case "tx":
      return t("record.tx", {
        device: name(r.row.deviceId) ?? "",
        what: packetWords(t, exists, r.row.type, r.row.body),
        counter: r.row.counter,
      });
    case "deviceLog":
      return t("record.deviceLog", {
        device: name(r.row.deviceId) ?? "",
        code: r.row.code,
        text: hexText(r.row.text),
      });
    case "notification": {
      const key = `notifications.category.${r.row.category}`;
      const what = exists(key) ? t(key) : r.row.category;
      const device = name(r.row.deviceId);
      return device === undefined
        ? t("record.notification", { what })
        : t("record.notificationAbout", { what, device });
    }
    case "notificationRead":
      return t("record.notificationRead", { client: r.row.clientId });
    case "reject":
      return t("record.reject", { count: r.row.count, reason: r.row.reason, via: r.row.via });
  }
}

function timeOf(
  record: HistoryRow,
): { readonly ms: number; readonly clockOk: boolean } | undefined {
  const r = record.row;
  if (r.kind === "reject") return { ms: r.row.minute * 60_000, clockOk: true };
  return { ms: r.row.atMs, clockOk: r.row.clockOk };
}

export function HistoryScreen() {
  const { t, i18n } = useTranslation();
  const hub = useHub();
  const devices = useLive((s) => s.devices);
  const info = useLive((s) => s.hub);
  const stale = useLive((s) => s.stale.history);
  const connected = useLive((s) => s.connection.kind === "open");
  const [kind, setKind] = useState<Kind | "all">("all");
  const [device, setDevice] = useState<number | "all">("all");
  const [pages, setPages] = useState<readonly HistoryRow[]>([]);
  const [next, setNext] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Parameters<typeof Failure>[0]["outcome"] | undefined>();
  const deviceList = useMemo(
    () => Object.values(devices).sort((a, b) => a.name.localeCompare(b.name)),
    [devices],
  );

  const load = useCallback(
    async (before: number | undefined) => {
      setBusy(true);
      const outcome = await hub.request("history.query", {
        limit: PAGE_ROWS,
        ...(kind === "all" ? {} : { kinds: [kind] }),
        ...(device === "all" ? {} : { devices: [device] }),
        ...(before === undefined ? {} : { before }),
      });
      setBusy(false);
      if (!outcome.ok) {
        setFailure(outcome);
        return;
      }
      setFailure(undefined);
      setPages((rows) =>
        before === undefined ? outcome.body.rows : [...rows, ...outcome.body.rows],
      );
      setNext(outcome.body.next);
    },
    [hub, kind, device],
  );
  // The first page again when the filter changes (`load` with it), a record comes, or a session opens.
  useEffect(() => {
    if (connected) void load(undefined);
  }, [load, stale, connected]);

  const exists = (key: string) => i18n.exists(key);
  return (
    <>
      <Choice
        label={t("history.kind")}
        value={kind}
        onChange={setKind}
        options={[
          { value: "all" as const, label: t("history.allKinds") },
          ...historyKind.options.map((k) => ({ value: k, label: t(`history.kinds.${k}`) })),
        ]}
      />
      <Choice
        label={t("history.device")}
        value={device}
        onChange={setDevice}
        options={[
          { value: "all" as const, label: t("history.allDevices") },
          ...deviceList.map((d) => ({ value: d.id, label: d.name })),
        ]}
      />
      {failure === undefined ? null : <Failure outcome={failure} />}
      <Heading level={2}>{t("history.records")}</Heading>
      {pages.length === 0 && !busy ? <Body muted>{t("history.none")}</Body> : null}
      <List label={t("history.records")}>
        {pages.map((record, i) => {
          const at = timeOf(record);
          const time =
            at === undefined
              ? ""
              : formatTime(
                  t,
                  i18n.language,
                  at.clockOk ? info : info === null ? null : { ...info, clockTrusted: false },
                  at.ms,
                );
          return (
            <ListItem key={`${record.kind}-${String(i)}`}>
              <Body muted>{time}</Body>
              <Body>{rowWords(t, exists, { devices }, record)}</Body>
            </ListItem>
          );
        })}
      </List>
      {next === undefined ? null : (
        <Actions>
          <Button
            kind="quiet"
            label={t("history.older")}
            busy={busy}
            onPress={() => void load(next)}
            testID="history-older"
          />
        </Actions>
      )}
    </>
  );
}
