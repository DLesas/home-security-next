/** Downloads a relay offer into the hub's existing update staging flow. */
import { OFFER_AND_ROLLOUT_REFUSALS } from "@hsn/protocol/app";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { decodeJson } from "../hub/codec";
import { type HubOutcome, phoneRequest } from "../pairing/hub";
import type { LiveState } from "../state/live";
import { type Action, useHub, useLive } from "./hub-context";
import { Actions, Body, Button, Done, Heading, Notice, NoticeText, Section } from "./parts";
import { deniedSettings, VersionTwoFailure, useVersionTwoRead } from "./version-two";

type FetchFailure = Extract<HubOutcome<"update.fetch">, { ok: false }>;
interface Run {
  readonly version: string;
  readonly session: LiveState["session"];
}
type Download =
  | { readonly run: Run; readonly kind: "downloading" | "ready" | "replaced" | "cancelled" }
  | { readonly run: Run; readonly kind: "refused"; readonly outcome: FetchFailure }
  | { readonly run: Run; readonly kind: "failed"; readonly reason: string };

const encoder = new TextEncoder();
const fileRefusals: ReadonlyMap<string, string> = new Map([
  ["badFile", "errors.invalid.badFile"],
  ["badSignature", "errors.invalid.badSignature"],
  ["wrongSystem", "errors.invalid.wrongSystem"],
  ["notNewer", "errors.invalid.notNewer"],
  ["full", "errors.invalid.full"],
  ["tooLarge", "updates.offer.tooLarge"],
  ["unreachable", "updates.offer.unreachable"],
]);

/** Reads the version and reason from the hub's record detail for a refused fetch. */
function fetchedRefusal(detail: unknown) {
  if (typeof detail !== "string") return undefined;
  const value = decodeJson(encoder.encode(detail))?.value;
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !("reason" in value) ||
    typeof value.reason !== "string"
  )
    return undefined;
  return { version: value.version, reason: value.reason };
}

/** Keeps this screen's download with the session that requested it. */
export function useOfferedUpdate(
  staged: string | null | undefined,
  cancel: Action<"update.cancel">,
) {
  const hub = useHub();
  const channel = hub.v2;
  const session = useLive((s) => s.session);
  const status = useVersionTwoRead(channel, "update.offers", {});
  const [last, setLast] = useState<Download>();
  const read = status.data;
  const offer = read?.ok === true ? read.value.offer : undefined;
  let download = last?.run.session === session ? last : undefined;

  useEffect(
    () =>
      channel === undefined
        ? undefined
        : hub.onEvent((event) => {
            if (event.ev !== "hub" || event.body.what !== "updateRefused") return;
            const refusal = fetchedRefusal(event.body.detail.reason);
            if (refusal === undefined) return;
            setLast((pending) =>
              pending?.kind === "downloading" &&
              pending.run.session === session &&
              pending.run.version === refusal.version
                ? { run: pending.run, kind: "failed", reason: refusal.reason }
                : pending,
            );
          }),
    [channel, hub, session],
  );

  if (download?.kind === "downloading" && download.run.version === staged) {
    download = { run: download.run, kind: "ready" };
    setLast(download);
  } else if (
    download?.kind === "failed" &&
    !fileRefusals.has(download.reason) &&
    offer != null &&
    offer.version.localeCompare(download.run.version, "en", { numeric: true }) > 0
  ) {
    download = { run: download.run, kind: "replaced" };
    setLast(download);
  }

  const allowed = channel !== undefined && read !== undefined && !deniedSettings(read);
  const downloading = allowed && download?.kind === "downloading";

  /** Requests the displayed version once and keeps request refusals with that download. */
  async function fetchOffer() {
    if (channel === undefined || offer == null || downloading || cancel.busy) return;
    const run: Run = { version: offer.version, session };
    cancel.clear();
    setLast({ run, kind: "downloading" });
    const outcome = await phoneRequest(channel, "update.fetch", { version: run.version });
    if (!outcome.ok) {
      setLast((pending) =>
        pending?.kind === "downloading" && pending.run === run
          ? { run, kind: "refused", outcome }
          : pending,
      );
      void status.refetch();
    }
  }

  /** Uses the same cancellation as the existing staged update. */
  async function cancelUpdate() {
    const run = allowed && download?.kind === "downloading" ? download.run : undefined;
    const outcome = await cancel.run({});
    if (outcome.ok && run !== undefined) {
      setLast((pending) => (pending?.run === run ? { run, kind: "cancelled" } : pending));
    }
    return outcome;
  }

  return {
    allowed,
    read,
    offer,
    staged,
    download,
    downloading,
    downloadBusy: downloading || cancel.busy,
    fetchOffer,
    cancelUpdate,
    cancelledDownload: download?.kind === "cancelled",
  };
}

/** Shows the newest offer, with the current download and its outcome. */
export function OfferedUpdate({
  update,
}: {
  readonly update: ReturnType<typeof useOfferedUpdate>;
}) {
  const { t, i18n } = useTranslation();
  const { allowed, read, offer, staged, download, downloadBusy, fetchOffer } = update;
  if (!allowed || read === undefined) return null;
  const size = offer == null ? undefined : new Intl.NumberFormat(i18n.language).format(offer.bytes);
  return (
    <Section label={t("updates.offer.title")}>
      <Heading level={2}>{t("updates.offer.title")}</Heading>
      {!read.ok ? (
        <VersionTwoFailure outcome={read} />
      ) : offer == null ? (
        <Body>{t("updates.offer.none")}</Body>
      ) : (
        <>
          <Body>
            {t("updates.offer.release", { version: offer.version, count: offer.bytes, size })}
          </Body>
          {staged === offer.version ? null : (
            <Actions>
              <Button
                label={t("updates.offer.download")}
                busy={downloadBusy}
                onPress={() => void fetchOffer()}
              />
            </Actions>
          )}
        </>
      )}
      {download === undefined ? null : <DownloadOutcome download={download} />}
    </Section>
  );
}

/** Describes each known step of the fetch using the hub's outcome where available. */
function DownloadOutcome({ download }: { readonly download: Download }) {
  const { t } = useTranslation();
  const version = download.run.version;
  switch (download.kind) {
    case "downloading":
      return (
        <Notice kind="info" live="polite">
          <Body>{t("updates.offer.downloading", { version })}</Body>
        </Notice>
      );
    case "ready":
      return <Done text={t("updates.offer.downloaded", { version })} />;
    case "replaced":
      return (
        <Notice kind="info" live="polite">
          <Body>{t("updates.offer.replaced", { version })}</Body>
        </Notice>
      );
    case "cancelled":
      return <Done text={t("updates.offer.cancelled")} />;
    case "failed":
      return (
        <Notice kind="danger" live="polite">
          <NoticeText kind="danger">
            {t("updates.offer.failed", {
              version,
              reason: t(fileRefusals.get(download.reason) ?? "updates.offer.unknown"),
            })}
          </NoticeText>
        </Notice>
      );
    case "refused": {
      const { outcome } = download;
      const refusal = OFFER_AND_ROLLOUT_REFUSALS.notOffered.detail;
      const notOffered =
        "error" in outcome &&
        outcome.error.code === "invalid" &&
        outcome.error.detail.field === refusal.field &&
        outcome.error.detail.reason === refusal.reason;
      return (
        <VersionTwoFailure
          outcome={outcome}
          {...(notOffered ? { text: t("updates.offer.notOffered") } : {})}
        />
      );
    }
  }
}
