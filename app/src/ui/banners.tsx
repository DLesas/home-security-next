/**
 * The alarm and the countdown, and the notice that the app is out of touch with the hub
 * (m2-design.md sections 7 and 8; docs/app-design.md "The one bold thing").
 *
 * - The alarm fills its field with `signal`; a countdown is night (`spruce`), its time in `lamp`.
 *   On the home screen they are the state field itself; over every other screen, a band at the top.
 * - The alarm or a countdown is **announced at once** to screen readers (an assertive live region);
 *   the time left **politely**, every few seconds, while the visible count goes every second.
 * - Disarm is always offered: it is `disarm mine`, which needs no permission (D76); the hub decides
 *   what it disarms, and the result says what it did and which triggers remain (D95).
 * - A web page is no substitute for push: a closed tab hears nothing (section 13).
 */
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { Text } from "./text";
import { useTranslation } from "react-i18next";
import type { CountdownView, LiveState } from "../state/live";
import { deviceNames, waitingWords } from "../state/words";
import { announce } from "../platform/announce";
import { secondsLeft } from "./format";
import { HubNotices } from "./hub-notices";
import { PhoneNotices } from "./phone-notices";
import { CriticalNotices } from "./notifications";
import { type Action, useAction, useHub, useLive } from "./hub-context";
import { Actions, Button, type ButtonKind, Failure, Notice, NoticeText, Spoken } from "./parts";

/** The clock, every `everyMs`, for counting down. */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => {
      setNow(Date.now());
    }, everyMs);
    return () => {
      clearInterval(handle);
    };
  }, [everyMs]);
  return now;
}

/**
 * The countdowns that are running: a disarmed sensor's countdown is over, whether or not the hub
 * has said so yet (its "countdown ended" event may come after the arming event, or not at all).
 */
export function runningCountdowns(
  state: Pick<LiveState, "countdowns" | "sensors">,
): readonly (readonly [number, CountdownView])[] {
  return Object.entries(state.countdowns)
    .map(([id, c]) => [Number(id), c] as const)
    .filter(([id]) => state.sensors[id]?.arm !== "disarmed");
}

/** Whether the alarm sounds or a countdown runs. */
export function useAlarmRunning(): boolean {
  return useLive((s) => s.alarm !== null || runningCountdowns(s).length > 0);
}

/** The alarm or countdown last announced, so moving between screens does not say it again. */
let announced = "";

/**
 * Says an alarm or a countdown at once when it starts (docs/app-design.md, "On a phone", rule 6):
 * the live region where the platform reads it, an announcement on iOS (`platform/announce`).
 * `key` names the run (when the alarm started, or which countdowns), so each is said once.
 */
export function announceOnce(
  key: string,
  text: string,
  say: (text: string) => void = announce,
): boolean {
  if (key === announced) return false;
  announced = key;
  say(text);
  return true;
}

/** How often the time left is said to a screen reader ‡. */
const SPOKEN_EVERY_S = 5;

export type Look = "day" | "night" | "alarm";

/** The state field's three looks: its surface, its text, and its buttons. */
export const LOOK: Readonly<
  Record<
    Look,
    {
      readonly box: string;
      readonly text: string;
      readonly main: ButtonKind;
      readonly quiet: ButtonKind;
    }
  >
> = {
  day: { box: "bg-sage", text: "text-ink", main: "main", quiet: "quiet" },
  night: { box: "bg-spruce", text: "text-limewash", main: "night", quiet: "nightQuiet" },
  alarm: { box: "bg-signal", text: "text-limewash", main: "night", quiet: "nightQuiet" },
};

/**
 * The field's surface. Edge to edge and square on a phone, 24 px corners from 768 px; the colour
 * fades over 400 ms between looks, at once with reduced motion (the app's one motion).
 */
export function FieldSurface({
  look,
  children,
}: {
  readonly look: Look;
  readonly children: ReactNode;
}) {
  return (
    <View
      testID="field-surface"
      className={`-mx-6 gap-8 px-6 py-12 md:mx-0 transition-colors duration-400 motion-reduce:transition-none md:rounded-field md:px-12 ${LOOK[look].box}`}
    >
      {children}
    </View>
  );
}

/**
 * The alarm or the countdown, with Disarm: the state field on home (`large`), a band elsewhere.
 * Nothing when neither runs. The caller holds the disarm and says its result (`DisarmOutcome`).
 */
export function AlarmField({
  large,
  disarm,
  above,
}: {
  readonly large: boolean;
  readonly disarm: Action<"disarm">;
  /** Above the sentence, outside what is announced: the chosen home's name on a phone's Home. */
  readonly above?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const alarm = useLive((s) => s.alarm);
  const countdowns = useLive((s) => s.countdowns);
  const sensors = useLive((s) => s.sensors);
  const devices = useLive((s) => s.devices);
  const now = useNow(1000);
  const counting = useMemo(
    () =>
      runningCountdowns({ countdowns, sensors }).map(([id, c]) => ({
        id,
        left: secondsLeft(c, now),
      })),
    [countdowns, sensors, now],
  );
  const running = alarm !== null || counting.length > 0;
  // The sentence is one word; what set it off follows as detail, so no typed name breaks it.
  const headline = t(alarm !== null ? "banner.alarm" : "banner.countdown");
  const cause =
    alarm !== null
      ? t("banner.alarmBy", { sensors: deviceNames(t, i18n.language, { devices }, alarm.triggers) })
      : t("banner.countdownBy", {
          sensors: deviceNames(
            t,
            i18n.language,
            { devices },
            counting.map((c) => c.id),
          ),
        });
  const runKey =
    alarm !== null
      ? `alarm:${String(alarm.startedMs)}`
      : `countdown:${counting.map((c) => c.id).join()}`;
  useEffect(() => {
    if (running) announceOnce(runKey, `${headline}. ${cause}`);
  }, [running, runKey, headline, cause]);
  if (!running) return null;
  const look: Look = alarm === null ? "night" : "alarm";
  const left = Math.min(...counting.map((c) => c.left));
  const spoken = Math.ceil(left / SPOKEN_EVERY_S) * SPOKEN_EVERY_S;
  const text = LOOK[look].text;
  return (
    <View role="region" aria-label={headline} {...(large ? {} : { testID: "alarm-banner" })}>
      <FieldSurface look={look}>
        <View className="gap-3">
          {above}
          <View role="alert" aria-live="assertive" className="gap-3">
            <Text
              {...(large ? { role: "heading", "aria-level": 1 } : {})}
              className={`font-heavy ${large ? "text-state md:text-state-wide" : "text-section"} ${text}`}
            >
              {headline}
            </Text>
            <Text className={`max-w-line font-text text-body ${text}`}>{cause}</Text>
            {alarm !== null && alarm.sirens.length > 0 ? (
              <Text className={`max-w-line font-text text-body ${text}`}>
                {t("banner.alarmSirens", {
                  sirens: deviceNames(t, i18n.language, { devices }, alarm.sirens),
                })}
              </Text>
            ) : null}
          </View>
        </View>
        {alarm === null ? (
          <>
            <Text aria-hidden testID="countdown-left" className="font-heavy text-section text-lamp">
              {t("home.countdown", { count: left })}
            </Text>
            <Spoken>{t("home.countdown", { count: spoken })}</Spoken>
          </>
        ) : null}
        <Button
          kind={LOOK[look].main}
          wide
          label={t("banner.disarm")}
          busy={disarm.busy}
          testID="banner-disarm"
          onPress={() => {
            void disarm.run({ target: "mine" });
          }}
        />
      </FieldSurface>
    </View>
  );
}

/** Over every screen but home (which shows it as its state field), with Disarm's result. */
export function AlarmBanner() {
  const disarm = useAction("disarm");
  const running = useAlarmRunning();
  if (!running && disarm.outcome === undefined) return null;
  return (
    <View className="gap-6">
      <AlarmField large={false} disarm={disarm} />
      <DisarmOutcome outcome={disarm.outcome} />
    </View>
  );
}

/**
 * What a disarm did, said politely (D95): the alarm stopped, or which triggers go on that this
 * person cannot disarm; else what was disarmed, or that nothing needed it.
 */
export function DisarmOutcome({ outcome }: { readonly outcome: Action<"disarm">["outcome"] }) {
  const { t, i18n } = useTranslation();
  const devices = useLive((s) => s.devices);
  if (outcome === undefined) return null;
  if (!outcome.ok) return <Failure outcome={outcome} />;
  const names = (ids: readonly number[]) => deviceNames(t, i18n.language, { devices }, ids);
  const body = outcome.body;
  const text =
    body.alarmContinues !== undefined
      ? t("banner.alarmContinues", { sensors: names(body.alarmContinues.triggers) })
      : body.alarmEnded
        ? t("banner.alarmEnded")
        : body.disarmed.length === 0
          ? t("home.nothingDisarmed")
          : t("home.disarmed", { sensors: names(body.disarmed) });
  const kind = body.alarmContinues === undefined ? "ok" : "warning";
  return (
    <Notice kind={kind} live="polite" testID="disarm-result">
      <NoticeText kind={kind}>{text}</NoticeText>
    </Notice>
  );
}

/** The notices every screen shows: critical ones, the hub's, the phone's own, and the connection's. */
export function ShellNotices() {
  return (
    <>
      <CriticalNotices />
      <HubNotices />
      <PhoneNotices />
      <ConnectionNotice />
    </>
  );
}

/** Out of touch with the hub: said once, politely, with why and when it tries again. */
export function ConnectionNotice() {
  const { t } = useTranslation();
  const hub = useHub();
  const connection = useLive((s) => s.connection);
  if (connection.kind === "open") return null;
  if (connection.kind === "waiting") {
    return (
      <Notice kind="warning" live="polite" testID="connection-notice">
        <NoticeText kind="warning">{t("connection.outOfTouch")}</NoticeText>
        <NoticeText kind="warning">{waitingWords(t, connection)}</NoticeText>
        {connection.mayBeRemoved ? (
          <>
            <NoticeText kind="warning">{t("connection.mayBeRemoved")}</NoticeText>
            <Actions>
              <Button
                kind="quiet"
                label={t("link.linkAgain")}
                testID="may-be-removed-link-again"
                onPress={() => void hub.forget()}
              />
            </Actions>
          </>
        ) : null}
      </Notice>
    );
  }
  if (connection.kind === "connecting" || connection.kind === "loading") {
    return (
      <Notice kind="info" live="polite" testID="connection-notice">
        <NoticeText kind="info">
          {t(connection.kind === "loading" ? "connection.loading" : "connection.connecting")}
        </NoticeText>
      </Notice>
    );
  }
  return null;
}
