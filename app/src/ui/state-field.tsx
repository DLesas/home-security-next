/**
 * The home screen's state field (docs/app-design.md "The one bold thing"; m2-design.md sections 6
 * and 7): the state of the house in one sentence, set large, one line of detail, and the switches.
 *
 * - **Day** (nothing armed): `sage`, dark text. **Night** (anything armed): `spruce`, pale text, the
 *   armed mark in `lamp`. The alarm and a countdown are `AlarmField` (red, or night with the time).
 * - Every mode this browser knows is offered (but the one already on, unchanged): the hub decides
 *   who may switch (HB5a) and the result is said in words, with the confirmation for open doors and
 *   low batteries (D50, AL12). "Disarm what I manage" is `disarm mine` (D76).
 */
import type { ModeObject } from "@hsn/protocol/app";
import { type ComponentRef, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { LiveState } from "../state/live";
import { deviceNames } from "../state/words";
import {
  AlarmField,
  DisarmOutcome,
  FieldSurface,
  LOOK,
  type Look,
  useAlarmRunning,
} from "./banners";
import { type Action, useAction, useLive } from "./hub-context";
import { Actions, Body, Button, Dialog, Failure, Notice, NoticeText, Stack } from "./parts";

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

type Facts = Pick<LiveState, "sensors" | "mode" | "modes">;

/**
 * Day or night, and the sentence's key. Night is anything armed, named by its mode when the mode
 * is Away ("Arm away" leads to "Armed, away") or one of the household's own. Away with no doors
 * yet to arm is night too: the person chose it. But Away with doors, all disarmed (a Disarm that
 * left the mode as it was), is day: the doors say what the house is.
 */
export function houseState(facts: Facts): {
  readonly look: Exclude<Look, "alarm">;
  readonly sentence: string;
  readonly mode?: string;
} {
  const id = facts.mode?.mode;
  const current = id === null || id === undefined ? undefined : facts.modes[id];
  const sensors = Object.values(facts.sensors);
  const armed = sensors.some((s) => s.arm !== "disarmed");
  if (current?.fixed === "away" && (armed || sensors.length === 0))
    return { look: "night", sentence: "field.armedAway" };
  if (!armed) return { look: "day", sentence: "field.disarmed" };
  if (current?.fixed === "no")
    return { look: "night", sentence: "field.armedMode", mode: current.name };
  return { look: "night", sentence: "field.armed" };
}

/** The one line under the sentence: open doors first, then doors not known, then waiting ones. */
function useDetail(): string {
  const { t, i18n } = useTranslation();
  const sensors = useLive((s) => s.sensors);
  const devices = useLive((s) => s.devices);
  const mode = useLive((s) => s.mode);
  const list = Object.values(sensors);
  const named = (ids: readonly number[]) => deviceNames(t, i18n.language, { devices }, ids);
  if (list.length === 0) return t("field.noDoors");
  const open = list.filter((s) => s.door === "open").map((s) => s.id);
  if (open.length > 0) return t("field.open", { count: open.length, doors: named(open) });
  const unknown = list.filter((s) => s.door === "unknown").map((s) => s.id);
  if (unknown.length > 0) return t("field.unknown", { doors: named(unknown) });
  const waiting = list.filter((s) => s.arm === "waitsForDoorToClose").map((s) => s.id);
  if (waiting.length > 0)
    return t("field.waiting", { count: waiting.length, doors: named(waiting) });
  if (mode?.modified === true) return t("field.changed");
  return t("field.allClosed");
}

/** The field, and under it what the last disarm did (it outlives the alarm it ended). */
export function StateField() {
  const disarm = useAction("disarm");
  const running = useAlarmRunning();
  const { clear } = disarm;
  // A new alarm or countdown makes the last disarm's result old news.
  useEffect(() => {
    if (running) clear();
  }, [running, clear]);
  return (
    <View testID="state-field" className="gap-6">
      {running ? <AlarmField large disarm={disarm} /> : <QuietField disarm={disarm} />}
      {disarm.outcome === undefined ? null : <DisarmOutcome outcome={disarm.outcome} />}
    </View>
  );
}

function QuietField({ disarm }: { readonly disarm: Action<"disarm"> }) {
  const { t, i18n } = useTranslation();
  const sensors = useLive((s) => s.sensors);
  const mode = useLive((s) => s.mode);
  const modes = useLive((s) => s.modes);
  const devices = useLive((s) => s.devices);
  const sorted = useMemo(() => sortedModes(modes), [modes]);
  const switching = useAction("mode.switch");
  const [asking, setAsking] = useState<
    { mode: number; openDoors: readonly number[]; lowBattery: readonly number[] } | undefined
  >();
  const [switchedTo, setSwitchedTo] = useState<number | undefined>();
  const confirmRef = useRef<ComponentRef<typeof View>>(null);
  const names = (ids: readonly number[]) => deviceNames(t, i18n.language, { devices }, ids);
  const state = houseState({ sensors, mode, modes });
  const detail = useDetail();
  const look = LOOK[state.look];

  const switchTo = async (id: number, confirm?: { openDoors: boolean; lowBattery: boolean }) => {
    setAsking(undefined);
    setSwitchedTo(id);
    disarm.clear();
    const outcome = await switching.run(
      confirm === undefined ? { mode: id } : { mode: id, confirm },
    );
    if (!outcome.ok && "error" in outcome && outcome.error.code === "needsConfirmation") {
      setAsking({ mode: id, ...outcome.error.detail });
      setTimeout(() => confirmRef.current?.focus(), 0);
    }
  };
  // The mode already on, unchanged, is not offered again.
  const offered = sorted.filter((m) => !(mode?.mode === m.id && !mode.modified));
  // The first button is the one most often wanted: Arm away by day, Disarm by night.
  const first = state.look === "day" ? "away" : "disarmed";
  const ordered = [
    ...offered.filter((m) => m.fixed === first),
    ...offered.filter((m) => m.fixed !== first),
  ];
  const labelOf = (m: ModeObject) =>
    m.fixed === "away"
      ? t("field.armAway")
      : m.fixed === "disarmed"
        ? t("field.disarm")
        : t("field.switchTo", { mode: m.name });
  const result = switching.outcome;

  return (
    <>
      <FieldSurface look={state.look}>
        <View className="gap-3">
          {state.look === "night" ? <View aria-hidden className="h-1 w-12 bg-lamp" /> : null}
          <Text
            role="heading"
            aria-level={1}
            testID="current-mode"
            className={`font-heavy text-state md:text-state-wide ${look.text}`}
          >
            {t(state.sentence, state.mode === undefined ? {} : { mode: state.mode })}
          </Text>
          <Text className={`max-w-line font-text text-body ${look.text}`}>{detail}</Text>
        </View>
        <View className="gap-3 md:flex-row md:flex-wrap">
          {sorted.length === 0 ? (
            <Text className={`max-w-line font-text text-body ${look.text}`}>
              {t("field.modesUnknown")}
            </Text>
          ) : (
            ordered.map((m, i) => (
              <Button
                key={m.id}
                kind={i === 0 && m.fixed === first ? look.main : look.quiet}
                wide
                label={labelOf(m)}
                busy={switching.busy}
                testID={`switch-${String(m.id)}`}
                onPress={() => void switchTo(m.id)}
              />
            ))
          )}
          {state.look === "night" ? (
            <Button
              kind={look.quiet}
              wide
              label={t("field.disarmMine")}
              busy={disarm.busy}
              testID="disarm-mine"
              onPress={() => {
                switching.clear();
                void disarm.run({ target: "mine" });
              }}
            />
          ) : null}
        </View>
      </FieldSurface>
      {asking === undefined && result === undefined ? null : (
        <Stack>
          {asking === undefined ? null : (
            <Dialog title={t("confirm.title")} ref={confirmRef} testID="confirm">
              {asking.openDoors.length > 0 ? (
                <Body>{t("confirm.openDoors", { sensors: names(asking.openDoors) })}</Body>
              ) : null}
              {asking.lowBattery.length > 0 ? (
                <Body>{t("confirm.lowBattery", { sensors: names(asking.lowBattery) })}</Body>
              ) : null}
              <Actions>
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
              </Actions>
            </Dialog>
          )}
          {result === undefined || asking !== undefined ? null : result.ok ? (
            <Notice kind="ok" live="polite" testID="switch-result">
              {/* Only what happened: an empty list is left out. */}
              <NoticeText kind="ok">
                {t("home.switchedTo", {
                  mode:
                    switchedTo === undefined
                      ? t("common.unknown")
                      : (modes[switchedTo]?.name ?? t("common.modeNumber", { id: switchedTo })),
                })}
              </NoticeText>
              {result.body.armed.length === 0 ? null : (
                <NoticeText kind="ok">
                  {t("home.armedNow", { sensors: names(result.body.armed) })}
                </NoticeText>
              )}
              {result.body.disarmed.length === 0 ? null : (
                <NoticeText kind="ok">
                  {t("home.disarmedNow", { sensors: names(result.body.disarmed) })}
                </NoticeText>
              )}
              {result.body.waiting.length > 0 ? (
                <NoticeText kind="ok">
                  {t("home.waiting", {
                    count: result.body.waiting.length,
                    sensors: names(result.body.waiting),
                  })}
                </NoticeText>
              ) : null}
              {result.body.lowBattery.length > 0 ? (
                <NoticeText kind="ok">
                  {t("home.lowBatteryArmed", { sensors: names(result.body.lowBattery) })}
                </NoticeText>
              ) : null}
            </Notice>
          ) : (
            <Failure outcome={result} />
          )}
        </Stack>
      )}
    </>
  );
}
