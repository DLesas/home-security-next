/**
 * Schedules (m2-design.md section 7, "Schedules"; D87, D116, D117): each entry is one action at one
 * local time (switch to a mode, arm or disarm a group or a sensor), on chosen weekdays, every day,
 * or once on a date. Times are the hub's, in its zone (HB31); the next run comes from the hub
 * (`nextMs`), and the app does no calendar arithmetic. A missed entry is shown with why until it
 * next runs ("missed at 22:00: the hub was off", "and 2 earlier").
 */
import {
  localDateText,
  localTimeText,
  type ScheduleObject,
  weekday,
  weekdayList,
} from "@hsn/protocol/app";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { learnConfig } from "../state/live";
import { listOf, type Translate } from "../state/words";
import { byName, ConflictNotice, conflictOf, NotToldYet, useFieldError } from "./editing";
import { formatTime } from "./format";
import { useAction, useHub, useLive } from "./hub-context";
import {
  Body,
  Button,
  CheckList,
  Choice,
  ConfirmButton,
  Done,
  Failure,
  Field,
  Heading,
  Section,
  Toggle,
} from "./parts";
import { cleanName } from "./setup";
import { styles } from "./theme";

type Weekday = (typeof weekday.options)[number];

export interface ScheduleDraft {
  readonly id: number | undefined;
  readonly revision: number;
  readonly name: string;
  readonly action: ScheduleObject["action"];
  readonly targetKind: "mode" | "group" | "sensor";
  readonly target: number | undefined;
  readonly at: string;
  readonly daysKind: "everyDay" | "weekdays" | "date";
  readonly weekdays: readonly Weekday[];
  readonly date: string;
  readonly enabled: boolean;
}

export const NEW_SCHEDULE: ScheduleDraft = {
  id: undefined,
  revision: 0,
  name: "",
  action: "switchMode",
  targetKind: "mode",
  target: undefined,
  at: "",
  daysKind: "everyDay",
  weekdays: [],
  date: "",
  enabled: true,
};

export function draftOfSchedule(s: ScheduleObject): ScheduleDraft {
  const target = s.target;
  return {
    id: s.id,
    revision: s.revision,
    name: s.name,
    action: s.action,
    targetKind: "mode" in target ? "mode" : "group" in target ? "group" : "sensor",
    target: "mode" in target ? target.mode : "group" in target ? target.group : target.sensor,
    at: s.at,
    daysKind: s.days === "everyDay" ? "everyDay" : "date" in s.days ? "date" : "weekdays",
    weekdays: s.days === "everyDay" || "date" in s.days ? [] : s.days,
    date: s.days !== "everyDay" && "date" in s.days ? s.days.date : "",
    enabled: s.enabled,
  };
}

export type ScheduleFields = Pick<
  ScheduleObject,
  "name" | "action" | "target" | "at" | "days" | "enabled"
>;

/** The body's fields from the form, or which field is not right yet. */
export function scheduleFields(
  draft: ScheduleDraft,
):
  | { readonly ok: true; readonly fields: ScheduleFields }
  | { readonly ok: false; readonly field: "name" | "target" | "at" | "days" } {
  const name = cleanName(draft.name);
  if (name === undefined) return { ok: false, field: "name" };
  const kind =
    draft.action === "switchMode"
      ? "mode"
      : draft.targetKind === "mode"
        ? "group"
        : draft.targetKind;
  if (draft.target === undefined) return { ok: false, field: "target" };
  const target =
    kind === "mode"
      ? { mode: draft.target }
      : kind === "group"
        ? { group: draft.target }
        : { sensor: draft.target };
  if (!localTimeText.safeParse(draft.at).success) return { ok: false, field: "at" };
  let days: ScheduleObject["days"];
  if (draft.daysKind === "everyDay") days = "everyDay";
  else if (draft.daysKind === "date") {
    if (!localDateText.safeParse(draft.date).success) return { ok: false, field: "days" };
    days = { date: draft.date };
  } else {
    const list = weekdayList.safeParse(draft.weekdays);
    if (!list.success) return { ok: false, field: "days" };
    days = list.data;
  }
  return {
    ok: true,
    fields: { name, action: draft.action, target, at: draft.at, days, enabled: draft.enabled },
  };
}

const DAY_KEYS: Readonly<Record<Weekday, string>> = {
  mon: "days.mon",
  tue: "days.tue",
  wed: "days.wed",
  thu: "days.thu",
  fri: "days.fri",
  sat: "days.sat",
  sun: "days.sun",
};

export function daysWords(t: Translate, language: string, days: ScheduleObject["days"]): string {
  if (days === "everyDay") return t("schedules.everyDay");
  if ("date" in days) {
    const date = new Intl.DateTimeFormat(language, { dateStyle: "long", timeZone: "UTC" }).format(
      Date.parse(`${days.date}T00:00:00Z`),
    );
    return t("schedules.onceOn", { date });
  }
  const ordered = weekday.options.filter((d) => days.includes(d));
  return t("schedules.onDays", {
    days: listOf(
      ordered.map((d) => t(DAY_KEYS[d])),
      language,
    ),
  });
}

const MISSED_KEYS = {
  hubOff: "schedules.missedWhy.hubOff",
  clockNotSet: "schedules.missedWhy.clockNotSet",
  clockStepped: "schedules.missedWhy.clockStepped",
} as const;

function ScheduleEditor({
  draft,
  onDone,
}: {
  readonly draft: ScheduleDraft;
  readonly onDone: (saved: boolean) => void;
}) {
  const { t } = useTranslation();
  const hub = useHub();
  const modes = useLive((s) => s.modes);
  const groups = useLive((s) => s.groups);
  const devices = useLive((s) => s.devices);
  const [form, setForm] = useState(draft);
  const [wrong, setWrong] = useState<string | undefined>();
  const create = useAction("schedule.create");
  const update = useAction("schedule.update");
  const outcome = form.id === undefined ? create.outcome : update.outcome;
  const nameError = useFieldError(outcome, "name");
  const conflict = conflictOf(outcome);
  const targetKind =
    form.action === "switchMode" ? "mode" : form.targetKind === "mode" ? "group" : form.targetKind;
  const targets = useMemo(() => {
    if (targetKind === "mode") return byName(Object.values(modes));
    if (targetKind === "group") return byName(Object.values(groups));
    return byName(Object.values(devices).filter((d) => d.role === "sensor"));
  }, [targetKind, modes, groups, devices]);
  const save = async () => {
    const built = scheduleFields(form);
    setWrong(built.ok ? undefined : built.field);
    if (!built.ok) return;
    const result =
      form.id === undefined
        ? await create.run(built.fields)
        : await update.run({ schedule: form.id, ...built.fields, ifRevision: form.revision });
    if (result.ok) {
      hub.live.setState(learnConfig(hub.live.getState(), { schedules: [result.body] }), true);
      onDone(true);
    }
  };
  const set = (change: Partial<ScheduleDraft>) => {
    setForm({ ...form, ...change });
  };
  const title =
    form.id === undefined ? t("schedules.new") : t("schedules.editing", { name: draft.name });
  return (
    <Section label={title}>
      <Heading level={2}>{title}</Heading>
      <Field
        label={t("schedules.name")}
        value={form.name}
        onChange={(name) => {
          set({ name });
        }}
        testID="schedule-name"
        {...(wrong === "name"
          ? { error: t("editing.badName") }
          : nameError === undefined
            ? {}
            : { error: nameError })}
      />
      <Choice
        label={t("schedules.action")}
        value={form.action}
        onChange={(action) => {
          set({
            action,
            target: undefined,
            targetKind: action === "switchMode" ? "mode" : "group",
          });
        }}
        options={[
          { value: "switchMode", label: t("schedules.actions.switchMode") },
          { value: "arm", label: t("schedules.actions.arm") },
          { value: "disarm", label: t("schedules.actions.disarm") },
        ]}
      />
      {form.action === "switchMode" ? null : (
        <Choice
          label={t("schedules.targetKind")}
          value={targetKind}
          onChange={(kind) => {
            set({ targetKind: kind, target: undefined });
          }}
          options={[
            { value: "group", label: t("schedules.aGroup") },
            { value: "sensor", label: t("schedules.aSensor") },
          ]}
        />
      )}
      {targets.length === 0 ? (
        <Body muted>{t(`schedules.noTargets.${targetKind}`)}</Body>
      ) : (
        <Choice
          label={t(`schedules.target.${targetKind}`)}
          value={form.target}
          onChange={(target) => {
            set({ target });
          }}
          options={targets.map((x) => ({ value: x.id, label: x.name }))}
        />
      )}
      {wrong === "target" ? <Text style={styles.body}>{t("schedules.chooseTarget")}</Text> : null}
      <Field
        label={t("schedules.at")}
        hint={t("schedules.atHint")}
        value={form.at}
        onChange={(at) => {
          set({ at: at.trim() });
        }}
        testID="schedule-at"
        {...(wrong === "at" ? { error: t("schedules.badTime") } : {})}
      />
      <Choice
        label={t("schedules.days")}
        value={form.daysKind}
        onChange={(daysKind) => {
          set({ daysKind });
        }}
        options={[
          { value: "everyDay", label: t("schedules.everyDay") },
          { value: "weekdays", label: t("schedules.chosenDays") },
          { value: "date", label: t("schedules.once") },
        ]}
      />
      {form.daysKind === "weekdays" ? (
        <CheckList
          label={t("schedules.whichDays")}
          values={form.weekdays}
          onChange={(weekdays) => {
            set({ weekdays });
          }}
          options={weekday.options.map((d) => ({ value: d, label: t(DAY_KEYS[d]) }))}
        />
      ) : null}
      {form.daysKind === "date" ? (
        <Field
          label={t("schedules.date")}
          hint={t("schedules.dateHint")}
          value={form.date}
          onChange={(date) => {
            set({ date: date.trim() });
          }}
          testID="schedule-date"
        />
      ) : null}
      {wrong === "days" ? (
        <Text style={styles.body}>
          {t(form.daysKind === "date" ? "schedules.badDate" : "schedules.chooseDays")}
        </Text>
      ) : null}
      <Toggle
        label={t("schedules.enabled")}
        value={form.enabled}
        onChange={(enabled) => {
          set({ enabled });
        }}
      />
      <View style={styles.row}>
        <Button
          label={t("editing.save")}
          busy={create.busy || update.busy}
          onPress={() => void save()}
          testID="schedule-save"
        />
        <Button
          kind="quiet"
          label={t("editing.cancel")}
          onPress={() => {
            onDone(false);
          }}
        />
      </View>
      {conflict !== undefined && "action" in conflict.object ? (
        <ConflictNotice
          onUseCurrent={() => {
            if ("action" in conflict.object) setForm(draftOfSchedule(conflict.object));
            update.clear();
          }}
        />
      ) : outcome !== undefined && !outcome.ok && nameError === undefined ? (
        <Failure outcome={outcome} />
      ) : null}
    </Section>
  );
}

function ScheduleItem({
  schedule,
  onEdit,
}: {
  readonly schedule: ScheduleObject;
  readonly onEdit: () => void;
}) {
  const { t, i18n } = useTranslation();
  const live = useHub().live;
  const info = useLive((s) => s.hub);
  const modes = useLive((s) => s.modes);
  const groups = useLive((s) => s.groups);
  const devices = useLive((s) => s.devices);
  const remove = useAction("schedule.delete");
  const target = schedule.target;
  const targetName =
    "mode" in target
      ? (modes[target.mode]?.name ?? t("common.modeNumber", { id: target.mode }))
      : "group" in target
        ? (groups[target.group]?.name ?? t("common.groupNumber", { id: target.group }))
        : (devices[target.sensor]?.name ?? t("common.deviceNumber", { id: target.sensor }));
  const action = t(`schedules.does.${schedule.action}`, { target: targetName, at: schedule.at });
  const missed = schedule.missed;
  return (
    <View role="listitem" style={styles.item} testID={`schedule-${String(schedule.id)}`}>
      <Heading level={2}>{schedule.name}</Heading>
      <Text style={styles.body}>{`${action} · ${daysWords(t, i18n.language, schedule.days)}`}</Text>
      <Text style={styles.body}>
        {!schedule.enabled
          ? t("schedules.off")
          : schedule.nextMs === null
            ? t("schedules.noNext")
            : t("schedules.next", { time: formatTime(t, i18n.language, info, schedule.nextMs) })}
      </Text>
      {missed === null ? null : (
        <Text style={styles.body} testID={`schedule-missed-${String(schedule.id)}`}>
          {t("schedules.missed", {
            time: formatTime(t, i18n.language, info, missed.dueMs),
            why: t(MISSED_KEYS[missed.why]),
          })}
          {missed.count > 1 ? ` ${t("schedules.missedEarlier", { count: missed.count - 1 })}` : ""}
        </Text>
      )}
      <View style={styles.row}>
        <Button kind="quiet" label={t("editing.edit", { name: schedule.name })} onPress={onEdit} />
        <ConfirmButton
          label={t("editing.delete", { name: schedule.name })}
          question={t("schedules.deleteQuestion", { name: schedule.name })}
          yes={t("editing.yesDelete")}
          no={t("editing.no")}
          busy={remove.busy}
          onConfirm={() =>
            void remove
              .run({ schedule: schedule.id, ifRevision: schedule.revision })
              .then((result) => {
                if (result.ok)
                  live.setState(
                    learnConfig(live.getState(), {
                      deleted: { kind: "schedule", id: schedule.id },
                    }),
                    true,
                  );
              })
          }
        />
      </View>
      {remove.outcome !== undefined && !remove.outcome.ok ? (
        <Failure outcome={remove.outcome} />
      ) : null}
    </View>
  );
}

export function SchedulesScreen() {
  const { t } = useTranslation();
  const schedules = useLive((s) => s.schedules);
  const info = useLive((s) => s.hub);
  const list = useMemo(() => byName(Object.values(schedules)), [schedules]);
  const [draft, setDraft] = useState<ScheduleDraft | undefined>();
  const [saved, setSaved] = useState(false);
  return (
    <>
      <Body>{t("schedules.intro", { zone: info?.timeZone ?? t("common.unknown") })}</Body>
      {info !== null && !info.clockTrusted ? <Body>{t("schedules.clockWaits")}</Body> : null}
      {list.length === 0 ? <NotToldYet what="schedules" /> : null}
      {saved ? <Done text={t("editing.saved")} /> : null}
      {list.length === 0 ? null : (
        <View role="list">
          {list.map((s) => (
            <ScheduleItem
              key={s.id}
              schedule={s}
              onEdit={() => {
                setSaved(false);
                setDraft(draftOfSchedule(s));
              }}
            />
          ))}
        </View>
      )}
      {draft === undefined ? (
        <View style={styles.row}>
          <Button
            label={t("schedules.add")}
            onPress={() => {
              setSaved(false);
              setDraft(NEW_SCHEDULE);
            }}
            testID="schedule-add"
          />
        </View>
      ) : (
        <ScheduleEditor
          key={draft.id ?? 0}
          draft={draft}
          onDone={(done) => {
            setDraft(undefined);
            setSaved(done);
          }}
        />
      )}
    </>
  );
}
