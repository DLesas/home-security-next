/**
 * Site settings and the site move (m2-design.md section 6; HD 8 and 9; D115, HB24): the countdown
 * and the automatic stop; the channel and rate, which are fixed once a device is paired (then a
 * site move changes them, device by device, which the screen follows by its `site` events); the
 * Wi-Fi details (only on the hub computer); retention, shown. *Manage system* for every change,
 * which the hub checks. On a phone, first, which path its session takes (m3-design.md section 6).
 */
import { RETENTION_DAYS, type SnapshotObject } from "@hsn/protocol/app";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type StoreApi, useStore } from "zustand";
import type { ReachState } from "../hub/phone-client";
import { useAction, useLive } from "./hub-context";
import { numberOrKeep } from "./device-detail";
import {
  Actions,
  Body,
  Button,
  Choice,
  ConfirmButton,
  Done,
  Failure,
  Field,
  Heading,
  Section,
} from "./parts";
import { usePhone } from "./phone-parts";
import { WifiStep } from "./setup";

const CHANNELS = [0, 1, 2] as const;
const RATES = [0, 1, 2, 3, 4, 5] as const;

function Timings({ site }: { readonly site: SnapshotObject["site"] }) {
  const { t } = useTranslation();
  const set = useAction("site.set");
  const [countdown, setCountdown] = useState("");
  const [autoStop, setAutoStop] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <Section label={t("site.timingsTitle")}>
      <Heading level={2}>{t("site.timingsTitle")}</Heading>
      <Body>{t("site.timingsNow", { countdown: site.countdownS, autoStop: site.autoStopS })}</Body>
      <Body muted>{t("deviceDetail.keepEmpty")}</Body>
      <Field
        label={t("site.countdown")}
        hint={t("site.countdownHint")}
        value={countdown}
        onChange={setCountdown}
        testID="site-countdown"
      />
      <Field
        label={t("site.autoStop")}
        hint={t("site.autoStopHint")}
        value={autoStop}
        onChange={setAutoStop}
        testID="site-autostop"
      />
      {bad ? <Body>{t("deviceDetail.badSetting")}</Body> : null}
      <Actions>
        <Button
          label={t("site.saveTimings")}
          busy={set.busy}
          onPress={() => {
            const c = numberOrKeep(countdown);
            const a = numberOrKeep(autoStop);
            const ok =
              c !== null &&
              c !== "learn" &&
              a !== null &&
              a !== "learn" &&
              (c !== undefined || a !== undefined);
            setBad(!ok);
            if (ok)
              void set.run({
                ...(c === undefined ? {} : { countdown: c }),
                ...(a === undefined ? {} : { autoStop: a }),
              });
          }}
        />
      </Actions>
      {set.outcome === undefined ? null : set.outcome.ok ? (
        <Done text={t("editing.saved")} />
      ) : (
        <Failure outcome={set.outcome} />
      )}
    </Section>
  );
}

function Radio({ site }: { readonly site: SnapshotObject["site"] }) {
  const { t } = useTranslation();
  const set = useAction("site.set");
  return (
    <Section label={t("setup.site.title")}>
      <Heading level={2}>{t("site.radioTitle")}</Heading>
      <Body muted>{t("site.radioFixed")}</Body>
      <Choice
        label={t("site.channel")}
        value={site.channel ?? undefined}
        onChange={(channel) => void set.run({ channel })}
        options={CHANNELS.map((c) => ({
          value: c,
          label: t(`setup.site.channelValue.${String(c)}`),
        }))}
      />
      <Choice
        label={t("setup.site.rateLabel")}
        value={site.rate}
        onChange={(rate) => void set.run({ rate })}
        options={RATES.map((n) => ({ value: n, label: t("setup.site.rate", { n }) }))}
      />
      {set.outcome === undefined ? null : set.outcome.ok ? (
        <Done text={t("editing.saved")} />
      ) : (
        <Failure outcome={set.outcome} />
      )}
    </Section>
  );
}

const STAGE_KEYS = {
  announcing: "site.stage.announcing",
  switched: "site.stage.switched",
  done: "site.stage.done",
  cancelled: "site.stage.cancelled",
} as const;

function SiteMove() {
  const { t } = useTranslation();
  const move = useLive((s) => s.siteMove);
  const change = useAction("site.change");
  const [channel, setChannel] = useState<number | undefined>();
  const [rate, setRate] = useState<number | undefined>();
  const running = move !== null && (move.stage === "announcing" || move.stage === "switched");
  return (
    <Section label={t("site.moveTitle")}>
      <Heading level={2}>{t("site.moveTitle")}</Heading>
      <Body>{t("site.moveIntro")}</Body>
      {move === null ? (
        <Body muted>{t("site.noMove")}</Body>
      ) : (
        <Body testID="site-move-stage">
          {`${t(STAGE_KEYS[move.stage])} ${t("site.confirmed", { confirmed: move.confirmed, total: move.total })}`}
        </Body>
      )}
      {running ? (
        <Actions>
          <Button
            kind="quiet"
            label={t("site.cancelMove")}
            busy={change.busy}
            onPress={() => void change.run("cancel")}
          />
          <ConfirmButton
            label={t("site.forceMove")}
            question={t("site.forceQuestion", { left: move.total - move.confirmed })}
            yes={t("site.yesForce")}
            no={t("editing.no")}
            onConfirm={() => void change.run({ force: { yes: true } })}
          />
        </Actions>
      ) : (
        <>
          <Choice
            label={t("site.newChannel")}
            value={channel}
            onChange={setChannel}
            options={CHANNELS.map((c) => ({
              value: c,
              label: t(`setup.site.channelValue.${String(c)}`),
            }))}
          />
          <Choice
            label={t("site.newRate")}
            value={rate}
            onChange={setRate}
            options={RATES.map((n) => ({ value: n, label: t("setup.site.rate", { n }) }))}
          />
          <Actions>
            <Button
              label={t("site.startMove")}
              busy={change.busy}
              disabled={channel === undefined && rate === undefined}
              onPress={() =>
                void change.run({
                  start: {
                    ...(channel === undefined ? {} : { channel }),
                    ...(rate === undefined ? {} : { rate }),
                  },
                })
              }
              testID="site-move-start"
            />
          </Actions>
        </>
      )}
      {change.outcome !== undefined && !change.outcome.ok ? (
        <Failure outcome={change.outcome} />
      ) : null}
    </Section>
  );
}

/** How long history is kept (HB24), within `RETENTION_DAYS`; the size guard still trims by size. */
function Retention({ site }: { readonly site: SnapshotObject["site"] }) {
  const { t } = useTranslation();
  const set = useAction("site.set");
  const [routine, setRoutine] = useState("");
  const [events, setEvents] = useState("");
  const [bad, setBad] = useState(false);
  const inRange = (
    value: number | "learn" | undefined | null,
    range: { readonly min: number; readonly max: number },
  ) =>
    value === undefined || (typeof value === "number" && value >= range.min && value <= range.max);
  return (
    <Section label={t("site.retentionTitle")}>
      <Heading level={2}>{t("site.retentionTitle")}</Heading>
      <Body>
        {t("site.retention", {
          routine: site.retentionRoutineDays,
          events: site.retentionEventDays,
        })}
      </Body>
      <Body muted>{t("site.retentionGuard")}</Body>
      <Field
        label={t("site.routineDays")}
        hint={t("site.daysHint", RETENTION_DAYS.routine)}
        value={routine}
        onChange={setRoutine}
        testID="site-routine-days"
      />
      <Field
        label={t("site.eventDays")}
        hint={t("site.daysHint", RETENTION_DAYS.event)}
        value={events}
        onChange={setEvents}
        testID="site-event-days"
      />
      {bad ? <Body>{t("deviceDetail.badSetting")}</Body> : null}
      <Actions>
        <Button
          label={t("site.saveRetention")}
          busy={set.busy}
          onPress={() => {
            const r = numberOrKeep(routine);
            const e = numberOrKeep(events);
            const ok =
              inRange(r, RETENTION_DAYS.routine) &&
              inRange(e, RETENTION_DAYS.event) &&
              (r !== undefined || e !== undefined);
            setBad(!ok);
            if (ok && r !== "learn" && e !== "learn" && r !== null && e !== null)
              void set.run({
                ...(r === undefined ? {} : { retentionRoutineDays: r }),
                ...(e === undefined ? {} : { retentionEventDays: e }),
              });
          }}
        />
      </Actions>
      {set.outcome === undefined ? null : set.outcome.ok ? (
        <Done text={t("editing.saved")} />
      ) : (
        <Failure outcome={set.outcome} />
      )}
    </Section>
  );
}

const PATH_KEYS = {
  home: "site.path.home",
  relay: "site.path.relay",
  notConnected: "site.path.notConnected",
  busy: "site.path.busy",
} as const;

/**
 * The phone's path, under This home and never on Home (m3-design.md section 6): at home or
 * through the relay while a session is open; else what the relay's last close said, if anything.
 */
export function pathSaid(reach: ReachState): keyof typeof PATH_KEYS | null {
  return reach.path ?? reach.relayClosed;
}

function PathInUse() {
  const phone = usePhone();
  return phone === undefined ? null : <PathLine reach={phone.reach} />;
}

function PathLine({ reach }: { readonly reach: StoreApi<ReachState> }) {
  const { t } = useTranslation();
  const said = useStore(reach, pathSaid);
  return said === null ? null : <Body testID="site-path">{t(PATH_KEYS[said])}</Body>;
}

export function SiteScreen() {
  const { t } = useTranslation();
  const site = useLive((s) => s.site);
  if (site === null)
    return (
      <>
        <PathInUse />
        <Body muted>{t("connection.connecting")}</Body>
      </>
    );
  return (
    <>
      <PathInUse />
      <Timings site={site} />
      <Radio site={site} />
      <SiteMove />
      <WifiStep />
      <Retention site={site} />
    </>
  );
}
