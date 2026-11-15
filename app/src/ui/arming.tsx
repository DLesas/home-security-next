/**
 * Modes and arming on the home screen (m2-design.md sections 6 and 7): the current mode, a switch
 * to each mode this browser knows, the confirmation for open doors and low batteries (D50, AL12),
 * and "disarm everything I may manage" (D76). The hub decides who may switch (HB5a); the screen
 * offers every switch and shows the hub's answer in words.
 */
import type { ModeObject } from "@hsn/protocol/app";
import { type ComponentRef, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { deviceNames } from "../state/words";
import { secondsLeft } from "./format";
import { useNow } from "./banners";
import { useAction, useLive } from "./hub-context";
import { Body, Button, Failure, Heading, Notice, Section } from "./parts";
import { styles } from "./theme";

const FIXED_ORDER: Readonly<Record<ModeObject["fixed"], number>> = { away: 0, disarmed: 1, no: 2 };

/** What "arm anyway" confirms: exactly what the hub named, open doors and low batteries (D50, AL12). */
export function confirmationFor(asking: {
  readonly openDoors: readonly number[];
  readonly lowBattery: readonly number[];
}): { openDoors: boolean; lowBattery: boolean } {
  return { openDoors: asking.openDoors.length > 0, lowBattery: asking.lowBattery.length > 0 };
}

export function sortedModes(modes: Readonly<Record<number, ModeObject>>): readonly ModeObject[] {
  return Object.values(modes).sort(
    (a, b) =>
      FIXED_ORDER[a.fixed] - FIXED_ORDER[b.fixed] || a.name.localeCompare(b.name) || a.id - b.id,
  );
}

export function ModePanel() {
  const { t, i18n } = useTranslation();
  const mode = useLive((s) => s.mode);
  const modes = useLive((s) => s.modes);
  const devices = useLive((s) => s.devices);
  const sorted = useMemo(() => sortedModes(modes), [modes]);
  const switching = useAction("mode.switch");
  const disarm = useAction("disarm");
  const [asking, setAsking] = useState<
    { mode: number; openDoors: readonly number[]; lowBattery: readonly number[] } | undefined
  >();
  const confirmRef = useRef<ComponentRef<typeof View>>(null);
  const names = (ids: readonly number[]) => deviceNames(t, i18n.language, { devices }, ids);

  const current =
    mode?.mode === null || mode === null
      ? t("home.noMode")
      : (modes[mode.mode]?.name ?? t("home.unknownMode"));
  const switchTo = async (id: number, confirm?: { openDoors: boolean; lowBattery: boolean }) => {
    setAsking(undefined);
    disarm.clear();
    const outcome = await switching.run(
      confirm === undefined ? { mode: id } : { mode: id, confirm },
    );
    if (!outcome.ok && "error" in outcome && outcome.error.code === "needsConfirmation") {
      setAsking({ mode: id, ...outcome.error.detail });
      setTimeout(() => confirmRef.current?.focus(), 0);
    }
  };
  const result = switching.outcome;

  return (
    <Section label={t("home.mode")}>
      <Heading level={2}>{t("home.mode")}</Heading>
      <Text style={styles.body} testID="current-mode">
        {mode?.modified === true
          ? t("home.currentChanged", { mode: current })
          : t("home.current", { mode: current })}
      </Text>
      {sorted.length === 0 ? (
        <Body muted>{t("home.modesUnknown")}</Body>
      ) : (
        <View style={styles.row}>
          {sorted.map((m) => (
            <Button
              key={m.id}
              label={t("home.switchTo", { mode: m.name })}
              busy={switching.busy}
              testID={`switch-${String(m.id)}`}
              onPress={() => void switchTo(m.id)}
            />
          ))}
        </View>
      )}
      {asking === undefined ? null : (
        <View
          ref={confirmRef}
          role="alertdialog"
          aria-label={t("confirm.title")}
          tabIndex={-1}
          style={[styles.notice, styles.noticeWarning]}
          testID="confirm"
        >
          <Heading level={3}>{t("confirm.title")}</Heading>
          {asking.openDoors.length > 0 ? (
            <Body>{t("confirm.openDoors", { sensors: names(asking.openDoors) })}</Body>
          ) : null}
          {asking.lowBattery.length > 0 ? (
            <Body>{t("confirm.lowBattery", { sensors: names(asking.lowBattery) })}</Body>
          ) : null}
          <View style={styles.row}>
            <Button
              label={t("confirm.armAnyway")}
              testID="confirm-arm"
              onPress={() => void switchTo(asking.mode, confirmationFor(asking))}
            />
            <Button
              kind="quiet"
              label={t("confirm.cancel")}
              onPress={() => {
                setAsking(undefined);
                switching.clear();
              }}
            />
          </View>
        </View>
      )}
      {result === undefined || asking !== undefined ? null : result.ok ? (
        <Notice kind="ok" live="polite" testID="switch-result">
          <Text style={styles.body}>
            {t("home.switched", {
              armed: result.body.armed.length === 0 ? t("common.none") : names(result.body.armed),
              disarmed:
                result.body.disarmed.length === 0 ? t("common.none") : names(result.body.disarmed),
            })}
          </Text>
          {result.body.waiting.length > 0 ? (
            <Text style={styles.body}>
              {t("home.waiting", {
                count: result.body.waiting.length,
                sensors: names(result.body.waiting),
              })}
            </Text>
          ) : null}
          {result.body.lowBattery.length > 0 ? (
            <Text style={styles.body}>
              {t("home.lowBatteryArmed", { sensors: names(result.body.lowBattery) })}
            </Text>
          ) : null}
        </Notice>
      ) : (
        <Failure outcome={result} />
      )}
      <View style={styles.row}>
        <Button
          kind="quiet"
          label={t("home.disarmMine")}
          busy={disarm.busy}
          testID="disarm-mine"
          onPress={() => {
            switching.clear();
            void disarm.run({ target: "mine" });
          }}
        />
      </View>
      {disarm.outcome === undefined ? null : disarm.outcome.ok ? (
        <Notice kind="ok" live="polite" testID="disarm-mine-result">
          <Text style={styles.body}>
            {disarm.outcome.body.disarmed.length === 0
              ? t("home.nothingDisarmed")
              : t("home.disarmed", { sensors: names(disarm.outcome.body.disarmed) })}
          </Text>
          {disarm.outcome.body.alarmContinues === undefined ? null : (
            <Text style={styles.body}>
              {t("banner.alarmContinues", {
                sensors: names(disarm.outcome.body.alarmContinues.triggers),
              })}
            </Text>
          )}
        </Notice>
      ) : (
        <Failure outcome={disarm.outcome} />
      )}
    </Section>
  );
}

/** Each sensor's arming and door, in words; its countdown when one runs. */
export function SensorPanel() {
  const { t } = useTranslation();
  const sensors = useLive((s) => s.sensors);
  const devices = useLive((s) => s.devices);
  const countdowns = useLive((s) => s.countdowns);
  const now = useNow(1000);
  const list = useMemo(() => Object.values(sensors).sort((a, b) => a.id - b.id), [sensors]);
  return (
    <Section label={t("home.sensors")}>
      <Heading level={2}>{t("home.sensors")}</Heading>
      {list.length === 0 ? (
        <Body muted>{t("home.noSensors")}</Body>
      ) : (
        <View role="list">
          {list.map((sensor) => {
            const countdown = countdowns[sensor.id];
            return (
              <View
                key={sensor.id}
                role="listitem"
                style={styles.item}
                testID={`sensor-${String(sensor.id)}`}
              >
                <Heading level={3}>
                  {devices[sensor.id]?.name ?? t("common.deviceNumber", { id: sensor.id })}
                </Heading>
                <Text style={styles.body}>
                  {t(`arm.${sensor.arm}`)} · {t(`door.${sensor.door}`)}
                </Text>
                {countdown === undefined ? null : (
                  <Text style={styles.body}>
                    {t("home.countdown", { count: secondsLeft(countdown, now) })}
                  </Text>
                )}
              </View>
            );
          })}
        </View>
      )}
    </Section>
  );
}
