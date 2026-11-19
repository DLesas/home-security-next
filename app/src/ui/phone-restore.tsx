/**
 * Restoring a hub from the phone (m3-design.md section 4, "Restoring from the phone"): Settings,
 * "Restore a hub" (shown when the phone holds any backup key), opens the camera screen; a restore
 * code scanned on the link camera comes here too. The restore client (`PhoneRestorer`, P2's
 * `restoreHub`) reads the new hub's offer (`RestoreOffer`) and looks for the backup key of that hub
 * and epoch:
 *
 * - without it: "This phone does not hold the key for that backup. Use a phone that was linked to
 *   that home on <date>.";
 * - with it: "Restoring <home> from the backup of 3 March", and the key is sent; the console has
 *   already asked whether to go on (D122), so the phone does not ask again;
 * - then restored, or the failure in words: M2 9's for `RestoreResult`'s reasons, the link
 *   screen's for the handshake's.
 *
 * A phone linked after the backup was made is not in the file (step 5): the restored hub refuses
 * its sessions, which the connection's own notice says ("may have been removed", with "Link this
 * phone again").
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { readCode, type RestoreCode } from "../hub/finder";
import type { RestoreFailure } from "../hub/restore";
import { RESTORE_RESULT_KEYS } from "./backup";
import { Actions, Body, Button, Done, Notice, NoticeText, Page } from "./parts";
import { type OfferedRestore, type PhoneParts, usePhone } from "./phone-parts";
import { codeNotice } from "./phone-words";
import { ScanScreen } from "./scan";

export type RestoreStep =
  | { readonly kind: "scan" }
  | { readonly kind: "checking" }
  | { readonly kind: "restoring"; readonly offered: OfferedRestore }
  | { readonly kind: "done"; readonly offered: OfferedRestore }
  | { readonly kind: "noKey"; readonly madeMs: number }
  | { readonly kind: "failed"; readonly fault: Exclude<RestoreFailure, "noKey"> };

/** The words for a restore that stopped: M2 9's for `RestoreResult`'s reasons, this page's for the rest. */
export function restoreFaultKey(fault: Exclude<RestoreFailure, "noKey">): string {
  switch (fault) {
    case "wrongKey":
    case "badFile":
    case "expired":
    case "busy":
      return RESTORE_RESULT_KEYS[fault];
    default:
      return `phoneRestore.fault.${fault}`;
  }
}

/** The page a restore's outcome leads to. */
export function stepAfter(
  outcome: Awaited<ReturnType<PhoneParts["restorer"]["run"]>>,
  offered: OfferedRestore | undefined,
): RestoreStep {
  if (outcome.ok) return offered === undefined ? { kind: "checking" } : { kind: "done", offered };
  if (outcome.fault === "noKey")
    return { kind: "noKey", madeMs: outcome.offer?.madeMs ?? offered?.offer.madeMs ?? 0 };
  return { kind: "failed", fault: outcome.fault };
}

/** A day and month in the person's language: "3 March". */
export function dayAndMonth(language: string, ms: number): string {
  return new Intl.DateTimeFormat(language, { day: "numeric", month: "long" }).format(ms);
}

export function PhoneRestore({
  code,
  initial,
}: {
  readonly code: RestoreCode | null;
  /** Where to start, for a page that already knows (tests). */
  readonly initial?: RestoreStep;
}) {
  const phone = usePhone();
  const { t } = useTranslation();
  if (phone === undefined) {
    return (
      <Page title={t("phoneRestore.title")}>
        <Body>{t("phoneRestore.phoneOnly")}</Body>
      </Page>
    );
  }
  return <Restore phone={phone} code={code} {...(initial === undefined ? {} : { initial })} />;
}

function Restore({
  phone,
  code,
  initial,
}: {
  readonly phone: PhoneParts;
  readonly code: RestoreCode | null;
  readonly initial?: RestoreStep;
}) {
  const { t, i18n } = useTranslation();
  const [step, setStep] = useState<RestoreStep>(
    initial ?? (code === null ? { kind: "scan" } : { kind: "checking" }),
  );
  const [running, setRunning] = useState<RestoreCode | null>(initial === undefined ? code : null);

  useEffect(() => {
    if (running === null) return;
    let live = true;
    let offered: OfferedRestore | undefined;
    void phone.restorer
      .run(running, (made) => {
        offered = made;
        if (live) setStep({ kind: "restoring", offered: made });
      })
      .then((outcome) => {
        if (live) setStep(stepAfter(outcome, offered));
      });
    return () => {
      live = false;
    };
  }, [running, phone]);

  if (step.kind === "scan") {
    return (
      <ScanScreen
        scanner={phone.scanner}
        point={t("scan.pointRestore")}
        onOpenSettings={phone.openSettings}
        onCode={(text) => {
          const read = readCode(text);
          if (read.ok && read.value.kind === "restore") {
            setStep({ kind: "checking" });
            setRunning(read.value.restore);
            return null;
          }
          return read.ok ? t("phoneRestore.notRestoreCode") : t(codeNotice(read.fault));
        }}
      />
    );
  }

  const again = (
    <Actions>
      <Button
        kind="quiet"
        label={t("phoneRestore.scanAgain")}
        onPress={() => {
          setRunning(null);
          setStep({ kind: "scan" });
        }}
        testID="restore-scan-again"
      />
    </Actions>
  );
  const home = (offered: OfferedRestore) => offered.homeName ?? t("phoneRestore.thatHome");
  const date = (ms: number) => dayAndMonth(i18n.language, ms);

  return (
    <Page title={t("phoneRestore.title")}>
      {step.kind === "checking" ? (
        <Notice kind="info" live="polite" testID="restore-status">
          <NoticeText kind="info">{t("phoneRestore.checking")}</NoticeText>
        </Notice>
      ) : step.kind === "restoring" ? (
        <Notice kind="info" live="polite" testID="restore-status">
          <NoticeText kind="info">
            {t("phoneRestore.restoring", {
              home: home(step.offered),
              date: date(step.offered.offer.madeMs),
            })}
          </NoticeText>
        </Notice>
      ) : step.kind === "done" ? (
        <Done text={t("phoneRestore.done", { home: home(step.offered) })} testID="restore-status" />
      ) : step.kind === "noKey" ? (
        <>
          <Notice kind="warning" live="polite" testID="restore-status">
            <NoticeText kind="warning">
              {step.madeMs === 0
                ? t("phoneRestore.fault.noKey")
                : t("phoneRestore.noKey", { date: date(step.madeMs) })}
            </NoticeText>
          </Notice>
          {again}
        </>
      ) : (
        <>
          <Notice kind="danger" live="polite" testID="restore-status">
            <NoticeText kind="danger">{t(restoreFaultKey(step.fault))}</NoticeText>
          </Notice>
          {again}
        </>
      )}
    </Page>
  );
}
