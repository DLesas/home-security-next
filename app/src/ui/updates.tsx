/**
 * Updates (m2-design.md section 9; D54, D84, HB23): what is staged and approved; a release file
 * sent from the hub computer (its signature, version and platform checked by the hub); approval by
 * *manage system*; the switch waits until no countdown, alarm, site move, provisioning or restore
 * runs, which the hub says when it answers. Offered downloads stage here just like uploads.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { sendFile, uploadJob } from "../hub/files";
import { FileInput } from "./file-input";
import { formatTime } from "./format";
import { useAction, useHub, useLive, useRead } from "./hub-context";
import { OfferedUpdate, useOfferedUpdate } from "./offered-update";
import { RolloutSection } from "./rollout";
import {
  Actions,
  Body,
  Button,
  ConfirmButton,
  Done,
  Failure,
  Heading,
  Notice,
  Section,
} from "./parts";

const LAST_KEYS = {
  none: "updates.last.none",
  healthy: "updates.last.healthy",
  rolledBack: "updates.last.rolledBack",
} as const;

export function UpdatesScreen() {
  const { t, i18n } = useTranslation();
  const info = useLive((s) => s.hub);
  const hub = useHub();
  const status = useRead("update.status", {}, "hub");
  const upload = useAction("update.upload");
  const approve = useAction("update.approve");
  const cancel = useAction("update.cancel");
  const [sending, setSending] = useState<
    { readonly sent: number; readonly total: number } | undefined
  >();
  const [uploadFailure, setUploadFailure] = useState<
    Parameters<typeof Failure>[0]["outcome"] | undefined
  >();
  const data = status.data?.ok === true ? status.data.body : undefined;
  const offered = useOfferedUpdate(data?.staged, cancel);
  const staged = data?.staged ?? null;
  /** Refreshes the staged release after this screen cancels an update. */
  const cancelUpdate = async () => {
    if ((await offered.cancelUpdate()).ok) void status.refetch();
  };
  /** Sends a picked release through the existing upload and staging path. */
  const onFile = async (file: { readonly bytes: Uint8Array }) => {
    const job = uploadJob();
    const sent = await sendFile(hub, job, file.bytes, (s, total) => {
      setSending({ sent: s, total });
    });
    setSending(undefined);
    setUploadFailure(sent.ok ? undefined : sent);
    if (sent.ok) await upload.run({ job });
  };
  return (
    <>
      <RolloutSection />
      <Section label={t("updates.statusTitle")}>
        <Heading level={2}>{t("updates.statusTitle")}</Heading>
        {status.data !== undefined && !status.data.ok ? <Failure outcome={status.data} /> : null}
        {data === undefined ? null : (
          <>
            <Body>
              {data.staged === null
                ? t("updates.noneStaged")
                : t("updates.staged", { version: data.staged })}
            </Body>
            {data.approvedBy === null ? null : (
              <Body>{t("updates.approvedBy", { name: data.approvedBy })}</Body>
            )}
            {data.switching ? (
              <Notice kind="warning">
                <Body>{t("updates.switching")}</Body>
              </Notice>
            ) : null}
            <Body>
              {data.lastResultMs === null
                ? t(LAST_KEYS[data.lastResult])
                : `${t(LAST_KEYS[data.lastResult])} ${t("updates.lastAt", { time: formatTime(t, i18n.language, info, data.lastResultMs) })}`}
            </Body>
          </>
        )}
        {staged !== null || offered.downloading ? (
          <Actions>
            {staged === null ? null : (
              <ConfirmButton
                label={t("updates.approve", { version: staged })}
                question={t("updates.approveQuestion", { version: staged })}
                yes={t("updates.yesApprove")}
                no={t("editing.no")}
                busy={approve.busy}
                onConfirm={() => void approve.run({})}
              />
            )}
            <Button
              kind="quiet"
              label={t(staged === null ? "updates.offer.cancel" : "updates.cancel")}
              busy={cancel.busy}
              onPress={() => void cancelUpdate()}
            />
          </Actions>
        ) : null}
        {approve.outcome === undefined ? null : approve.outcome.ok ? (
          <Done text={t("updates.willSwitch", { when: approve.outcome.body.switchWhen })} />
        ) : (
          <Failure outcome={approve.outcome} />
        )}
        {offered.cancelledDownload || cancel.outcome === undefined ? null : cancel.outcome.ok ? (
          <Done text={t("updates.cancelled")} />
        ) : (
          <Failure outcome={cancel.outcome} />
        )}
      </Section>
      <OfferedUpdate update={offered} />
      <Section label={t("updates.uploadTitle")}>
        <Heading level={2}>{t("updates.uploadTitle")}</Heading>
        <Body>{t("updates.uploadIntro")}</Body>
        <FileInput label={t("updates.file")} onFile={(f) => void onFile(f)} testID="update-file" />
        {sending === undefined ? null : (
          <Body>{t("backup.sending", { sent: sending.sent, total: sending.total })}</Body>
        )}
        {uploadFailure === undefined ? null : <Failure outcome={uploadFailure} />}
        {upload.outcome === undefined ? null : upload.outcome.ok ? (
          <Done text={t("updates.uploaded", { version: upload.outcome.body.version })} />
        ) : (
          <Failure outcome={upload.outcome} />
        )}
      </Section>
    </>
  );
}
