/**
 * What sits over every screen (m2-design.md sections 7 and 8): the countdown and alarm banner with
 * Disarm, and the notice that the app is out of touch with the hub.
 *
 * - The alarm or a countdown is **announced at once** to screen readers (an assertive live region);
 *   the time left **politely**, every few seconds, while the visible count goes every second.
 * - Disarm is always offered: it is `disarm mine`, which needs no permission (D76); the hub decides
 *   what it disarms, and the banner says what it did and which triggers remain (D95).
 * - A web page is no substitute for push: a closed tab hears nothing (section 13).
 */
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { deviceNames, waitingWords } from "../state/words";
import { secondsLeft } from "./format";
import { useAction, useHub, useLive } from "./hub-context";
import { Button, Failure, Notice } from "./parts";
import { styles } from "./theme";

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

/** How often the time left is said to a screen reader ‡. */
const SPOKEN_EVERY_S = 5;

export function AlarmBanner() {
  const { t, i18n } = useTranslation();
  const alarm = useLive((s) => s.alarm);
  const countdowns = useLive((s) => s.countdowns);
  const devices = useLive((s) => s.devices);
  const disarm = useAction("disarm");
  const now = useNow(1000);
  const counting = useMemo(
    () =>
      Object.entries(countdowns).map(([id, c]) => ({ id: Number(id), left: secondsLeft(c, now) })),
    [countdowns, now],
  );
  if (alarm === null && counting.length === 0) {
    return disarm.outcome?.ok === true ? <DisarmResult outcome={disarm.outcome.body} /> : null;
  }
  const left = Math.min(...counting.map((c) => c.left));
  const spoken = Math.ceil(left / SPOKEN_EVERY_S) * SPOKEN_EVERY_S;
  const headline =
    alarm !== null
      ? t("banner.alarm", { sensors: deviceNames(t, i18n.language, { devices }, alarm.triggers) })
      : t("banner.countdown", {
          sensors: deviceNames(
            t,
            i18n.language,
            { devices },
            counting.map((c) => c.id),
          ),
        });
  return (
    <View style={styles.banner} role="region" aria-label={headline} testID="alarm-banner">
      <View role="alert" aria-live="assertive">
        <Text style={styles.bannerText}>{headline}</Text>
      </View>
      {alarm !== null && alarm.sirens.length > 0 ? (
        <Text style={styles.bannerText}>
          {t("banner.alarmSirens", {
            sirens: deviceNames(t, i18n.language, { devices }, alarm.sirens),
          })}
        </Text>
      ) : null}
      {alarm === null ? (
        <>
          <Text style={styles.bannerText} aria-hidden testID="countdown-left">
            {t("home.countdown", { count: left })}
          </Text>
          <View
            role="status"
            aria-live="polite"
            style={{ position: "absolute", width: 1, height: 1, overflow: "hidden" }}
          >
            <Text>{t("home.countdown", { count: spoken })}</Text>
          </View>
        </>
      ) : null}
      <View style={styles.row}>
        <Button
          kind="quiet"
          label={t("banner.disarm")}
          busy={disarm.busy}
          testID="banner-disarm"
          onPress={() => {
            void disarm.run({ target: "mine" });
          }}
        />
      </View>
      {disarm.outcome === undefined ? null : disarm.outcome.ok ? (
        <DisarmResult outcome={disarm.outcome.body} />
      ) : (
        <Failure outcome={disarm.outcome} />
      )}
    </View>
  );
}

function DisarmResult({
  outcome,
}: {
  readonly outcome: {
    readonly alarmEnded: boolean;
    readonly alarmContinues?: { readonly triggers: readonly number[] } | undefined;
  };
}) {
  const { t, i18n } = useTranslation();
  const devices = useLive((s) => s.devices);
  const text =
    outcome.alarmContinues !== undefined
      ? t("banner.alarmContinues", {
          sensors: deviceNames(t, i18n.language, { devices }, outcome.alarmContinues.triggers),
        })
      : outcome.alarmEnded
        ? t("banner.alarmEnded")
        : t("banner.disarmed");
  return (
    <Notice
      kind={outcome.alarmContinues === undefined ? "ok" : "warning"}
      live="polite"
      testID="disarm-result"
    >
      <Text style={styles.body}>{text}</Text>
    </Notice>
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
        <Text style={styles.h3}>{t("connection.outOfTouch")}</Text>
        <Text style={styles.body}>{waitingWords(t, connection)}</Text>
        {connection.mayBeRemoved ? (
          <>
            <Text style={styles.body}>{t("connection.mayBeRemoved")}</Text>
            <View style={styles.row}>
              <Button
                kind="quiet"
                label={t("link.linkAgain")}
                testID="may-be-removed-link-again"
                onPress={() => void hub.forget()}
              />
            </View>
          </>
        ) : null}
      </Notice>
    );
  }
  if (connection.kind === "connecting" || connection.kind === "loading") {
    return (
      <Notice kind="info" live="polite" testID="connection-notice">
        <Text style={styles.body}>
          {t(connection.kind === "loading" ? "connection.loading" : "connection.connecting")}
        </Text>
      </Notice>
    );
  }
  return null;
}
