/**
 * Backup and restore (m2-design.md section 9; D53, D78, D119, D122, HB22): the backups' state, the
 * folder (chosen on the hub computer only), the daily hour and how many are kept; a backup now; an
 * export streamed to this browser, with or without history, never written on the hub; and, on the
 * hub computer of a hub with no devices, a restore from a file, unlocked by a phone that holds the
 * backup key (from M3: before then nothing can unlock it, D119).
 *
 * Restore asks before going on (D122): the file's age and what that means are shown first; the
 * restore code only after the person says to go on.
 */
import type { AppOpReply } from "@hsn/protocol/app";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppRefusal } from "../hub/channel";
import { downloadFile, sendFile, uploadJob } from "../hub/files";
import { realTimers } from "../hub/wire";
import { saveFile } from "../platform/save-file";
import { FileInput } from "./file-input";
import { QrCode } from "./qr";
import { formatTime } from "./format";
import { useAction, useHub, useLive, useRead } from "./hub-context";
import {
  Actions,
  Body,
  Button,
  Choice,
  Copyable,
  Done,
  Failure,
  Field,
  Heading,
  Notice,
  Section,
} from "./parts";
import { numberOrKeep } from "./device-detail";
import { HERE } from "./words-here";

const RESULT_KEYS = {
  ok: "backup.result.ok",
  failed: "backup.result.failed",
  never: "backup.result.never",
} as const;

function Status() {
  const { t, i18n } = useTranslation();
  const info = useLive((s) => s.hub);
  const status = useRead("backup.status", {}, "hub");
  const settings = useAction("backup.settings");
  const now = useAction("backup.now");
  const [folder, setFolder] = useState("");
  const [hour, setHour] = useState("");
  const [keep, setKeep] = useState("");
  const [bad, setBad] = useState(false);
  const data = status.data?.ok === true ? status.data.body : undefined;
  return (
    <Section label={t("backup.statusTitle")}>
      <Heading level={2}>{t("backup.statusTitle")}</Heading>
      {status.data !== undefined && !status.data.ok ? <Failure outcome={status.data} /> : null}
      {data === undefined ? null : (
        <>
          <Body>
            {data.folder === null
              ? t("backup.noFolder")
              : t("backup.folder", { folder: data.folder })}
          </Body>
          <Body>
            {t("backup.schedule", { hour: String(data.hour).padStart(2, "0"), keep: data.keep })}
          </Body>
          <Body>
            {data.newestMs === null
              ? t("backup.noneYet")
              : t("backup.newest", { time: formatTime(t, i18n.language, info, data.newestMs) })}
            {` ${t(RESULT_KEYS[data.lastResult])}`}
          </Body>
          {data.due ? (
            <Notice kind="warning">
              <Body>{t("backup.due")}</Body>
            </Notice>
          ) : null}
        </>
      )}
      <Body muted>{t("deviceDetail.keepEmpty")}</Body>
      <Field
        label={t("backup.folderLabel")}
        hint={t("backup.folderHint")}
        value={folder}
        onChange={setFolder}
      />
      <Field
        label={t("backup.hourLabel")}
        hint={t("backup.hourHint")}
        value={hour}
        onChange={setHour}
      />
      <Field label={t("backup.keepLabel")} value={keep} onChange={setKeep} />
      {bad ? <Body>{t("deviceDetail.badSetting")}</Body> : null}
      <Actions>
        <Button
          label={t("backup.saveSettings")}
          busy={settings.busy}
          onPress={() => {
            const h = numberOrKeep(hour);
            const k = numberOrKeep(keep);
            const ok =
              typeof h !== "string" &&
              h !== null &&
              typeof k !== "string" &&
              k !== null &&
              (folder.trim() !== "" || h !== undefined || k !== undefined);
            setBad(!ok);
            if (ok)
              void settings.run({
                ...(folder.trim() === "" ? {} : { folder: folder.trim() }),
                ...(h === undefined ? {} : { hour: h }),
                ...(k === undefined ? {} : { keep: k }),
              });
          }}
        />
        <Button
          kind="quiet"
          label={t("backup.now")}
          busy={now.busy}
          onPress={() => void now.run({})}
          testID="backup-now"
        />
      </Actions>
      {settings.outcome === undefined ? null : settings.outcome.ok ? (
        <Done text={t("editing.saved")} />
      ) : (
        <Failure outcome={settings.outcome} />
      )}
      {now.outcome === undefined ? null : now.outcome.ok ? (
        <Done text={t("backup.started")} />
      ) : (
        <Failure outcome={now.outcome} />
      )}
    </Section>
  );
}

function Export() {
  const { t } = useTranslation();
  const hub = useHub();
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof downloadFile>> | undefined>();
  // Whether the file was handed over (a phone's share sheet can fail; a browser's download not).
  const [handed, setHanded] = useState(true);
  const run = async () => {
    setBusy(true);
    const got = await downloadFile(hub, history, realTimers);
    setBusy(false);
    setResult(got);
    setHanded(true);
    if (got.ok && "bytes" in got)
      void saveFile(history ? "hsn-history.jsonl" : "hsn-backup.hsnb", got.bytes).then((saved) => {
        setHanded(saved.ok);
      });
  };
  return (
    <Section label={t("backup.exportTitle", HERE)}>
      <Heading level={2}>{t("backup.exportTitle", HERE)}</Heading>
      <Body>{t("backup.exportIntro", HERE)}</Body>
      <Choice
        label={t("backup.exportWhich")}
        value={history ? "history" : "backup"}
        onChange={(which) => {
          setHistory(which === "history");
          setResult(undefined);
        }}
        options={[
          { value: "backup", label: t("backup.exportBackup") },
          { value: "history", label: t("backup.exportHistory") },
        ]}
      />
      <Body>{t("backup.exportBackupIs")}</Body>
      <Body>{t("backup.exportHistoryIs")}</Body>
      <Actions>
        <Button
          label={t("backup.export")}
          busy={busy}
          onPress={() => void run()}
          testID="backup-export"
        />
      </Actions>
      {result === undefined ? null : result.ok && !handed ? (
        <Notice kind="danger" live="polite">
          <Body>{t("backup.notHanded")}</Body>
        </Notice>
      ) : result.ok ? (
        <Done text={t(history ? "backup.exportedHistory" : "backup.exported", HERE)} />
      ) : "fault" in result ? (
        <Notice kind="danger" live="polite">
          <Body>{t(`backup.downloadFault.${result.fault}`)}</Body>
        </Notice>
      ) : (
        <Failure outcome={result} />
      )}
    </Section>
  );
}

/** True when a file begins as a history export does (`hsn-history/1`'s first line), not `HSNB`. */
export function isHistoryExport(bytes: Uint8Array): boolean {
  const start = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 200));
  return /^\{\s*"format"\s*:\s*"hsn-history\/1"/u.test(start);
}

/** `badFile` when the hub refused the file as not a backup, else undefined. */
export function restoreRefusal(
  outcome: { readonly ok: false } & ({ readonly error: AppRefusal } | { readonly local: string }),
): "badFile" | undefined {
  return "error" in outcome &&
    outcome.error.code === "invalid" &&
    outcome.error.detail.reason === "badFile"
    ? "badFile"
    : undefined;
}

/**
 * What a phone is told when a restore it unlocks ends (`RestoreResult`, section 9): the words for
 * each reason, the console's and the phone's alike, `wrongKey` apart from a damaged file.
 */
export const RESTORE_RESULT_KEYS = {
  wrongKey: "backup.restoreResult.wrongKey",
  badFile: "backup.damaged",
  expired: "backup.restoreResult.expired",
  busy: "backup.restoreResult.busy",
} as const;

/**
 * What the file is and how old its people are, always, in plain words; the restore code only once
 * the person says to go on (D122).
 */
export function RestoreOffer({ offer }: { readonly offer: AppOpReply<"restore.start"> }) {
  const { t, i18n } = useTranslation();
  const info = useLive((s) => s.hub);
  const [goOn, setGoOn] = useState(false);
  return (
    <Notice kind="warning" live="polite" testID="restore-offer">
      <Body>
        {t("backup.fileFrom", {
          identity: offer.identity,
          made: formatTime(t, i18n.language, info, offer.madeMs),
        })}
      </Body>
      <Body>
        {t("backup.peopleAge", { time: formatTime(t, i18n.language, info, offer.lastChangeMs) })}
      </Body>
      <Body>{t("backup.oldHubOff")}</Body>
      {goOn ? (
        <>
          <Body>{t("backup.scanWithPhone")}</Body>
          <QrCode text={offer.qr} label={t("backup.qrLabel")} testID="restore-qr-code" />
          <Copyable size="small" testID="restore-qr">
            {offer.qr}
          </Copyable>
        </>
      ) : (
        <Actions>
          <Button
            label={t("backup.goOn")}
            onPress={() => {
              setGoOn(true);
            }}
            testID="restore-go-on"
          />
        </Actions>
      )}
    </Notice>
  );
}

function Restore() {
  const { t } = useTranslation();
  const hub = useHub();
  const start = useAction("restore.start");
  const [sending, setSending] = useState<
    { readonly sent: number; readonly total: number } | undefined
  >();
  const [uploadFailure, setUploadFailure] = useState<
    Parameters<typeof Failure>[0]["outcome"] | undefined
  >();
  const [historyFile, setHistoryFile] = useState(false);
  const onFile = async (file: { readonly bytes: Uint8Array }) => {
    start.clear();
    setHistoryFile(isHistoryExport(file.bytes));
    const job = uploadJob();
    const sent = await sendFile(hub, job, file.bytes, (s, total) => {
      setSending({ sent: s, total });
    });
    setSending(undefined);
    if (!sent.ok) {
      setUploadFailure(sent);
      return;
    }
    setUploadFailure(undefined);
    await start.run({ job });
  };
  const offer = start.outcome?.ok === true ? start.outcome.body : undefined;
  return (
    <Section label={t("backup.restoreTitle")}>
      <Heading level={2}>{t("backup.restoreTitle")}</Heading>
      <Body>{t("backup.restoreIntro")}</Body>
      <FileInput
        label={t("backup.restoreFile")}
        accept=".hsnb"
        onFile={(f) => void onFile(f)}
        testID="restore-file"
      />
      {sending === undefined ? null : (
        <Body>{t("backup.sending", { sent: sending.sent, total: sending.total })}</Body>
      )}
      {uploadFailure === undefined ? null : <Failure outcome={uploadFailure} />}
      {start.outcome !== undefined && !start.outcome.ok ? (
        restoreRefusal(start.outcome) === "badFile" ? (
          <Notice kind="danger" live="polite" testID="restore-bad-file">
            <Body>{t(historyFile ? "backup.historyNotBackup" : "backup.damaged")}</Body>
          </Notice>
        ) : (
          <Failure outcome={start.outcome} />
        )
      ) : null}
      {offer === undefined ? null : <RestoreOffer key={offer.qr} offer={offer} />}
    </Section>
  );
}

export function BackupScreen() {
  return (
    <>
      <Status />
      <Export />
      <Restore />
    </>
  );
}
