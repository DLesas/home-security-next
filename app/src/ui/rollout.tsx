/** The device rollout on Updates, using the shared hub client's version 2 channel. */
import type { AppOpReplyV2, RolloutDeviceObject, RolloutObject } from "@hsn/protocol/app";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { Version2Channel } from "../hub/client";
import { rolloutView, type RolloutCommand } from "../state/rollout";
import { deviceName } from "../state/words";
import { formatTime } from "./format";
import { useHub, useLive } from "./hub-context";
import {
  Actions,
  Body,
  Button,
  ConfirmButton,
  Done,
  Heading,
  List,
  ListRow,
  Notice,
  NoticeText,
  Section,
} from "./parts";
import { pauseWords, rolloutFailureWords } from "./rollout-words";

type Status = AppOpReplyV2<"rollout.status">;
type FirmwareImages = AppOpReplyV2<"firmware.list">["images"];
type FirmwareOffers = AppOpReplyV2<"firmware.offers">["offers"];
type Run = (command: RolloutCommand) => void;

/** Mounts the rollout only for a linked session that can send version 2 requests. */
export function RolloutSection() {
  const client = useHub().v2;
  const session = useLive((s) => s.session);
  if (client === undefined || session === null) return null;
  return <RolloutPanel key={`${session.hub}/${session.client}`} client={client} />;
}

/** Shows the latest accepted status and the commands available for its stage. */
function RolloutPanel({ client }: { readonly client: Version2Channel }) {
  const { t, i18n } = useTranslation();
  const hub = useHub();
  const model = useMemo(() => rolloutView(hub, client), [hub, client]);
  const view = useStore(model.store);
  const devices = useLive((s) => s.devices);
  useEffect(() => model.watch(), [model]);
  const { status, images, offers, pending, outcome, readFailure } = view;
  const readNotice =
    readFailure === undefined ? null : (
      <Notice kind="warning">
        <NoticeText kind="warning">
          {rolloutFailureWords(t, i18n.language, { devices }, readFailure)}
        </NoticeText>
      </Notice>
    );
  if (status === undefined) return readNotice;
  const rollout = status.rollout;
  const active = rollout !== null && rollout.stage !== "done" && rollout.stage !== "cancelled";
  const busy = pending !== undefined;
  /** Starts the request from a press and lets the model present its outcome. */
  const run: Run = (command) => {
    void model.run(command);
  };
  return (
    <Section label={t("rollout.title")}>
      <Heading level={2}>{t("rollout.title")}</Heading>
      {rollout === null ? (
        <Body>{t("rollout.none")}</Body>
      ) : (
        <RolloutStatus rollout={rollout} lines={status.devices} busy={busy} run={run} />
      )}
      {active ? (
        <RolloutActions key={rollout.id} rollout={rollout} busy={busy} run={run} />
      ) : (
        <Releases images={images ?? []} offers={offers ?? []} busy={busy} run={run} />
      )}
      {outcome === undefined ? null : outcome.failure === undefined ? (
        <Done text={t(`rollout.outcome.${outcome.op.replace(".", "_")}`)} />
      ) : (
        <Notice kind="warning" live="polite">
          <NoticeText kind="warning">
            {rolloutFailureWords(t, i18n.language, { devices }, outcome.failure)}
          </NoticeText>
        </Notice>
      )}
      {readNotice}
    </Section>
  );
}

/** Describes the stage, adding the soak deadline, remaining-device count or pause reason. */
function RolloutStatus({
  rollout,
  lines,
  busy,
  run,
}: {
  readonly rollout: RolloutObject;
  readonly lines: Status["devices"];
  readonly busy: boolean;
  readonly run: Run;
}) {
  const { t, i18n } = useTranslation();
  const devices = useLive((s) => s.devices);
  const info = useLive((s) => s.hub);
  const pilots = new Set(rollout.pilots);
  const remaining = lines.filter((line) => !pilots.has(line.device) && line.state !== "cancelled");
  const confirmed = remaining.filter((line) => line.state === "confirmed").length;
  return (
    <>
      <Heading level={3}>{t("rollout.version", { version: rollout.version })}</Heading>
      <Body>{t(`rollout.stage.${rollout.stage}`)}</Body>
      {rollout.stage === "soak" && rollout.soakUntilMs !== null ? (
        <Body>
          {t("rollout.soakUntil", {
            time: formatTime(t, i18n.language, info, rollout.soakUntilMs),
          })}
        </Body>
      ) : null}
      {rollout.stage === "rest" ? (
        <Body>{t("rollout.progress", { done: confirmed, total: remaining.length })}</Body>
      ) : null}
      {rollout.stage === "paused" ? (
        <Notice kind="warning">
          <NoticeText kind="warning">{pauseWords(t, { devices }, rollout.paused)}</NoticeText>
        </Notice>
      ) : null}
      {lines.length === 0 ? null : (
        <List label={t("rollout.devices")}>
          {lines.map((line) => (
            <RolloutLine
              key={`${rollout.id}/${line.device}`}
              line={line}
              rollout={rollout}
              name={deviceName(t, { devices }, line.device)}
              sensor={devices[line.device]?.role === "sensor"}
              busy={busy}
              run={run}
            />
          ))}
        </List>
      )}
    </>
  );
}

/** Names a device and gives its update state, progress, hold and refusal as applicable. */
function RolloutLine({
  line,
  rollout,
  name,
  sensor,
  busy,
  run,
}: {
  readonly line: RolloutDeviceObject;
  readonly rollout: RolloutObject;
  readonly name: string;
  readonly sensor: boolean;
  readonly busy: boolean;
  readonly run: Run;
}) {
  const { t } = useTranslation();
  const held = line.forceAvailable
    ? t("rollout.forceExplanation")
    : line.held === null
      ? undefined
      : t(`rollout.held.${line.held}`);
  const primaryHold = line.state === "planned" || line.state === "offered";
  const percent = line.of === 0 ? 0 : Math.min(100, Math.floor((line.bytes / line.of) * 100));
  const main =
    (primaryHold ? held : undefined) ??
    t(`rollout.device.${line.state}`, { percent, version: rollout.version });
  return (
    <ListRow name={name} state={main}>
      {line.state === "fetching" && sensor ? <Body>{t("rollout.watching")}</Body> : null}
      {held !== undefined && !primaryHold ? <Body>{held}</Body> : null}
      {line.lastReason !== null && (line.state === "refused" || line.state === "rolledBack") ? (
        <Body>{t(`rollout.reason.${line.lastReason}`)}</Body>
      ) : null}
      {line.forceAvailable ? (
        <ConfirmButton
          label={t("rollout.force")}
          question={t("rollout.forceQuestion")}
          yes={t("rollout.confirmForce")}
          no={t("rollout.declineForce")}
          busy={busy}
          onConfirm={() => {
            run({
              op: "rollout.resume",
              body: { rollout: rollout.id, device: line.device, force: true },
            });
          }}
        />
      ) : null}
    </ListRow>
  );
}

/** Lets a manager pause or resume, or confirm ending this rollout. */
function RolloutActions({
  rollout,
  busy,
  run,
}: {
  readonly rollout: RolloutObject;
  readonly busy: boolean;
  readonly run: Run;
}) {
  const { t } = useTranslation();
  const body = { rollout: rollout.id };
  const paused = rollout.stage === "paused";
  return (
    <Actions>
      <Button
        kind={paused ? "main" : "quiet"}
        label={t(paused ? "rollout.resume" : "rollout.pause")}
        busy={busy}
        onPress={() => {
          run({ op: paused ? "rollout.resume" : "rollout.pause", body });
        }}
      />
      <ConfirmButton
        label={t("rollout.cancel")}
        question={t("rollout.cancelQuestion")}
        yes={t("rollout.confirmCancel")}
        no={t("editing.no")}
        busy={busy}
        onConfirm={() => {
          run({ op: "rollout.cancel", body });
        }}
      />
    </Actions>
  );
}

/** Shows what can be approved, and lets the person download a release offered by the hub. */
function Releases({
  images,
  offers,
  busy,
  run,
}: {
  readonly images: FirmwareImages;
  readonly offers: FirmwareOffers;
  readonly busy: boolean;
  readonly run: Run;
}) {
  const { t, i18n } = useTranslation();
  const unstaged = offers.filter(
    (offer) =>
      !images.some((image) => image.kind === "official" && image.version === offer.version),
  );
  if (images.length === 0 && unstaged.length === 0) return null;
  const numbers = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  return (
    <>
      <Heading level={3}>{t("rollout.awaiting")}</Heading>
      <List>
        {images.map((image) => (
          <ListRow
            key={image.id}
            name={t("rollout.version", { version: image.version })}
            {...(image.kind === "ownBuild" ? { state: t("rollout.ownBuild") } : {})}
          >
            <ConfirmButton
              label={t("rollout.start")}
              question={t("rollout.startQuestion", { version: image.version })}
              yes={t("rollout.confirmStart")}
              no={t("rollout.declineStart")}
              busy={busy}
              onConfirm={() => {
                run({ op: "rollout.start", body: { image: image.id } });
              }}
            />
          </ListRow>
        ))}
        {unstaged.map((offer) => (
          <ListRow
            key={offer.version}
            name={t("rollout.version", { version: offer.version })}
            state={t("rollout.offerSize", { size: numbers.format(offer.bytes / 1_000_000) })}
          >
            <Button
              kind="quiet"
              label={t("rollout.download")}
              busy={busy}
              onPress={() => {
                run({ op: "firmware.fetch", body: { version: offer.version } });
              }}
            />
          </ListRow>
        ))}
      </List>
    </>
  );
}
