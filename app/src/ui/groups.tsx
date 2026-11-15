/**
 * Groups (m2-design.md section 7, "Modes, groups and arming"): a set of sensors and a choice of
 * sirens, every siren by default (AL2a); a sensor may be in several. Made, changed and deleted by
 * *manage system*, which the hub checks; a change carries the revision it was made from, and a
 * `conflict` shows the group as it now is. Arming a group adds to what is armed; disarming it
 * disarms its sensors (D74). Deleting one named by schedules is refused, naming them.
 */
import type { GroupObject } from "@hsn/protocol/app";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { learnConfig } from "../state/live";
import { listOf } from "../state/words";
import { cleanName } from "./setup";
import { byName, ConflictNotice, conflictOf, NotToldYet, useFieldError } from "./editing";
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
} from "./parts";
import { styles } from "./theme";

interface Draft {
  readonly id: number | undefined;
  readonly revision: number;
  readonly name: string;
  readonly sensors: readonly number[];
  readonly sirens: "all" | readonly number[];
}

const NEW: Draft = { id: undefined, revision: 0, name: "", sensors: [], sirens: "all" };

function draftOf(group: GroupObject): Draft {
  return {
    id: group.id,
    revision: group.revision,
    name: group.name,
    sensors: group.sensors,
    sirens: group.sirens,
  };
}

/** "Every siren", or a list with one at least: an empty list is refused (section 7). */
export function hasSirens(sirens: "all" | readonly number[]): boolean {
  return sirens === "all" || sirens.length > 0;
}

function useDevicesOf(role: "sensor" | "siren") {
  const devices = useLive((s) => s.devices);
  return useMemo(
    () => byName(Object.values(devices).filter((d) => d.role === role)),
    [devices, role],
  );
}

function GroupEditor({
  draft,
  onDone,
}: {
  readonly draft: Draft;
  readonly onDone: (saved: boolean) => void;
}) {
  const { t } = useTranslation();
  const hub = useHub();
  const [form, setForm] = useState(draft);
  const [badName, setBadName] = useState(false);
  const [noSiren, setNoSiren] = useState(false);
  const create = useAction("group.create");
  const update = useAction("group.update");
  const sensors = useDevicesOf("sensor");
  const sirens = useDevicesOf("siren");
  const outcome = form.id === undefined ? create.outcome : update.outcome;
  const nameError = useFieldError(outcome, "name");
  const sirensError = useFieldError(outcome, "sirens");
  const conflict = conflictOf(outcome);
  const save = async () => {
    const name = cleanName(form.name);
    setBadName(name === undefined);
    // A chosen list needs one siren at least; the hub refuses an empty one too (section 7).
    const empty = !hasSirens(form.sirens);
    setNoSiren(empty);
    if (name === undefined || empty) return;
    const fields = { name, sensors: form.sensors, sirens: form.sirens };
    const result =
      form.id === undefined
        ? await create.run(fields)
        : await update.run({ group: form.id, ...fields, ifRevision: form.revision });
    if (result.ok) {
      hub.live.setState(learnConfig(hub.live.getState(), { groups: [result.body] }), true);
      onDone(true);
    }
  };
  const title = form.id === undefined ? t("groups.new") : t("groups.editing", { name: draft.name });
  return (
    <Section label={title}>
      <Heading level={2}>{title}</Heading>
      <Field
        label={t("groups.name")}
        value={form.name}
        onChange={(name) => {
          setForm({ ...form, name });
        }}
        testID="group-name"
        {...(badName
          ? { error: t("editing.badName") }
          : nameError === undefined
            ? {}
            : { error: nameError })}
      />
      <CheckList
        label={t("groups.sensors")}
        values={form.sensors}
        onChange={(values) => {
          setForm({ ...form, sensors: values });
        }}
        options={sensors.map((d) => ({ value: d.id, label: d.name }))}
      />
      <Choice
        label={t("groups.sirens")}
        value={form.sirens === "all" ? "all" : "chosen"}
        onChange={(choice) => {
          setForm({ ...form, sirens: choice === "all" ? "all" : [] });
        }}
        options={[
          { value: "all", label: t("groups.allSirens") },
          { value: "chosen", label: t("groups.chosenSirens") },
        ]}
      />
      {form.sirens === "all" ? null : (
        <CheckList
          label={t("groups.whichSirens")}
          values={form.sirens}
          onChange={(values) => {
            setForm({ ...form, sirens: values });
          }}
          options={sirens.map((d) => ({ value: d.id, label: d.name }))}
        />
      )}
      {noSiren || sirensError !== undefined ? (
        <Text style={styles.body} testID="group-no-siren">
          {t("groups.atLeastOneSiren")}
        </Text>
      ) : null}
      <View style={styles.row}>
        <Button
          label={t("editing.save")}
          busy={create.busy || update.busy}
          onPress={() => void save()}
          testID="group-save"
        />
        <Button
          kind="quiet"
          label={t("editing.cancel")}
          onPress={() => {
            onDone(false);
          }}
        />
      </View>
      {conflict !== undefined && "sensors" in conflict.object ? (
        <ConflictNotice
          onUseCurrent={() => {
            if ("sensors" in conflict.object) setForm(draftOf(conflict.object));
            update.clear();
          }}
        />
      ) : outcome !== undefined &&
        !outcome.ok &&
        nameError === undefined &&
        sirensError === undefined ? (
        <Failure outcome={outcome} />
      ) : null}
    </Section>
  );
}

function GroupItem({
  group,
  onEdit,
}: {
  readonly group: GroupObject;
  readonly onEdit: () => void;
}) {
  const { t, i18n } = useTranslation();
  const hub = useHub();
  const devices = useLive((s) => s.devices);
  const schedules = useLive((s) => s.schedules);
  const remove = useAction("group.delete");
  const names = (ids: readonly number[]) =>
    listOf(
      ids.map((id) => devices[id]?.name ?? t("common.deviceNumber", { id })),
      i18n.language,
    );
  const inUse =
    remove.outcome !== undefined &&
    !remove.outcome.ok &&
    "error" in remove.outcome &&
    remove.outcome.error.code === "invalid"
      ? remove.outcome.error.detail.refs
      : undefined;
  return (
    <View role="listitem" style={styles.item} testID={`group-${String(group.id)}`}>
      <Heading level={2}>{group.name}</Heading>
      <Text style={styles.body}>
        {group.sensors.length === 0
          ? t("groups.noSensors")
          : t("groups.sensorsAre", { sensors: names(group.sensors) })}
      </Text>
      <Text style={styles.body}>
        {group.sirens === "all"
          ? t("groups.soundsAll")
          : t("groups.soundsThese", {
              sirens: group.sirens.length === 0 ? t("common.none") : names(group.sirens),
            })}
      </Text>
      <View style={styles.row}>
        <Button kind="quiet" label={t("editing.edit", { name: group.name })} onPress={onEdit} />
        <ConfirmButton
          label={t("editing.delete", { name: group.name })}
          question={t("groups.deleteQuestion", { name: group.name })}
          yes={t("editing.yesDelete")}
          no={t("editing.no")}
          busy={remove.busy}
          onConfirm={() =>
            void remove.run({ group: group.id, ifRevision: group.revision }).then((result) => {
              if (result.ok)
                hub.live.setState(
                  learnConfig(hub.live.getState(), { deleted: { kind: "group", id: group.id } }),
                  true,
                );
            })
          }
        />
      </View>
      {remove.outcome !== undefined && !remove.outcome.ok ? (
        <Failure outcome={remove.outcome} />
      ) : null}
      {inUse === undefined ? null : (
        <Body>
          {t("editing.usedBy", {
            schedules: listOf(
              inUse.map((id) => schedules[id]?.name ?? t("common.scheduleNumber", { id })),
              i18n.language,
            ),
          })}
        </Body>
      )}
    </View>
  );
}

export function GroupsScreen() {
  const { t } = useTranslation();
  const groups = useLive((s) => s.groups);
  const list = useMemo(() => byName(Object.values(groups)), [groups]);
  const [draft, setDraft] = useState<Draft | undefined>();
  const [saved, setSaved] = useState(false);
  return (
    <>
      <Body>{t("groups.intro")}</Body>
      {list.length === 0 ? <NotToldYet what="groups" /> : null}
      {saved ? <Done text={t("editing.saved")} /> : null}
      {list.length === 0 ? null : (
        <View role="list">
          {list.map((group) => (
            <GroupItem
              key={group.id}
              group={group}
              onEdit={() => {
                setSaved(false);
                setDraft(draftOf(group));
              }}
            />
          ))}
        </View>
      )}
      {draft === undefined ? (
        <View style={styles.row}>
          <Button
            label={t("groups.add")}
            onPress={() => {
              setSaved(false);
              setDraft(NEW);
            }}
            testID="group-add"
          />
        </View>
      ) : (
        <GroupEditor
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
