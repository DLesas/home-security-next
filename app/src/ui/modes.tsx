/**
 * Modes (m2-design.md section 7; D90): a set of groups. Away (every sensor) and Disarmed (none)
 * are fixed and cannot be changed or deleted; the others are made by *manage system*, which the hub
 * checks. Switching is on the home screen. Deleting the current mode is allowed (the house is
 * then in no mode); deleting one a schedule names is refused, naming the schedules.
 */
import type { ModeObject } from "@hsn/protocol/app";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { learnConfig } from "../state/live";
import { listOf } from "../state/words";
import { sortedModes } from "./arming";
import { byName, ConflictNotice, conflictOf, NotToldYet, useFieldError } from "./editing";
import { useAction, useHub, useLive } from "./hub-context";
import {
  Body,
  Button,
  CheckList,
  ConfirmButton,
  Done,
  Failure,
  Field,
  Heading,
  Section,
} from "./parts";
import { cleanName } from "./setup";
import { styles } from "./theme";

interface Draft {
  readonly id: number | undefined;
  readonly revision: number;
  readonly name: string;
  readonly groups: readonly number[];
}

const NEW: Draft = { id: undefined, revision: 0, name: "", groups: [] };

function draftOf(mode: ModeObject): Draft {
  return { id: mode.id, revision: mode.revision, name: mode.name, groups: mode.groups };
}

function ModeEditor({
  draft,
  onDone,
}: {
  readonly draft: Draft;
  readonly onDone: (saved: boolean) => void;
}) {
  const { t } = useTranslation();
  const hub = useHub();
  const allGroups = useLive((s) => s.groups);
  const groups = useMemo(() => byName(Object.values(allGroups)), [allGroups]);
  const [form, setForm] = useState(draft);
  const [badName, setBadName] = useState(false);
  const create = useAction("mode.create");
  const update = useAction("mode.update");
  const outcome = form.id === undefined ? create.outcome : update.outcome;
  const nameError = useFieldError(outcome, "name");
  const conflict = conflictOf(outcome);
  const save = async () => {
    const name = cleanName(form.name);
    setBadName(name === undefined);
    if (name === undefined) return;
    const result =
      form.id === undefined
        ? await create.run({ name, groups: form.groups })
        : await update.run({ mode: form.id, name, groups: form.groups, ifRevision: form.revision });
    if (result.ok) {
      hub.live.setState(learnConfig(hub.live.getState(), { modes: [result.body] }), true);
      onDone(true);
    }
  };
  const title = form.id === undefined ? t("modes.new") : t("modes.editing", { name: draft.name });
  return (
    <Section label={title}>
      <Heading level={2}>{title}</Heading>
      <Field
        label={t("modes.name")}
        value={form.name}
        onChange={(name) => {
          setForm({ ...form, name });
        }}
        testID="mode-name"
        {...(badName
          ? { error: t("editing.badName") }
          : nameError === undefined
            ? {}
            : { error: nameError })}
      />
      {groups.length === 0 ? (
        <Body muted>{t("modes.noGroups")}</Body>
      ) : (
        <CheckList
          label={t("modes.groups")}
          values={form.groups}
          onChange={(values) => {
            setForm({ ...form, groups: values });
          }}
          options={groups.map((g) => ({ value: g.id, label: g.name }))}
        />
      )}
      <View style={styles.row}>
        <Button
          label={t("editing.save")}
          busy={create.busy || update.busy}
          onPress={() => void save()}
          testID="mode-save"
        />
        <Button
          kind="quiet"
          label={t("editing.cancel")}
          onPress={() => {
            onDone(false);
          }}
        />
      </View>
      {conflict !== undefined && "fixed" in conflict.object ? (
        <ConflictNotice
          onUseCurrent={() => {
            if ("fixed" in conflict.object) setForm(draftOf(conflict.object));
            update.clear();
          }}
        />
      ) : outcome !== undefined && !outcome.ok && nameError === undefined ? (
        <Failure outcome={outcome} />
      ) : null}
    </Section>
  );
}

function ModeItem({ mode, onEdit }: { readonly mode: ModeObject; readonly onEdit: () => void }) {
  const { t, i18n } = useTranslation();
  const hub = useHub();
  const groups = useLive((s) => s.groups);
  const schedules = useLive((s) => s.schedules);
  const current = useLive((s) => s.mode?.mode === mode.id);
  const remove = useAction("mode.delete");
  const what =
    mode.fixed === "away"
      ? t("modes.awayArms")
      : mode.fixed === "disarmed"
        ? t("modes.disarmedArms")
        : mode.groups.length === 0
          ? t("modes.armsNothing")
          : t("modes.armsGroups", {
              groups: listOf(
                mode.groups.map((id) => groups[id]?.name ?? t("common.groupNumber", { id })),
                i18n.language,
              ),
            });
  const refs =
    remove.outcome !== undefined &&
    !remove.outcome.ok &&
    "error" in remove.outcome &&
    remove.outcome.error.code === "invalid"
      ? remove.outcome.error.detail.refs
      : undefined;
  return (
    <View role="listitem" style={styles.item} testID={`mode-${String(mode.id)}`}>
      <Heading level={2}>{mode.name}</Heading>
      <Text style={styles.body}>{what}</Text>
      {current ? <Text style={styles.body}>{t("modes.current")}</Text> : null}
      {mode.fixed === "no" ? (
        <View style={styles.row}>
          <Button kind="quiet" label={t("editing.edit", { name: mode.name })} onPress={onEdit} />
          <ConfirmButton
            label={t("editing.delete", { name: mode.name })}
            question={
              current
                ? t("modes.deleteCurrentQuestion", { name: mode.name })
                : t("modes.deleteQuestion", { name: mode.name })
            }
            yes={t("editing.yesDelete")}
            no={t("editing.no")}
            busy={remove.busy}
            onConfirm={() =>
              void remove.run({ mode: mode.id, ifRevision: mode.revision }).then((result) => {
                if (result.ok)
                  hub.live.setState(
                    learnConfig(hub.live.getState(), { deleted: { kind: "mode", id: mode.id } }),
                    true,
                  );
              })
            }
          />
        </View>
      ) : (
        <Body muted>{t("modes.fixed")}</Body>
      )}
      {remove.outcome !== undefined && !remove.outcome.ok ? (
        <Failure outcome={remove.outcome} />
      ) : null}
      {refs === undefined ? null : (
        <Body>
          {t("editing.usedBy", {
            schedules: listOf(
              refs.map((id) => schedules[id]?.name ?? t("common.scheduleNumber", { id })),
              i18n.language,
            ),
          })}
        </Body>
      )}
    </View>
  );
}

export function ModesScreen() {
  const { t } = useTranslation();
  const modes = useLive((s) => s.modes);
  const list = useMemo(() => sortedModes(modes), [modes]);
  const [draft, setDraft] = useState<Draft | undefined>();
  const [saved, setSaved] = useState(false);
  return (
    <>
      <Body>{t("modes.intro")}</Body>
      {list.length === 0 ? <NotToldYet what="modes" /> : null}
      {saved ? <Done text={t("editing.saved")} /> : null}
      {list.length === 0 ? null : (
        <View role="list">
          {list.map((mode) => (
            <ModeItem
              key={mode.id}
              mode={mode}
              onEdit={() => {
                setSaved(false);
                setDraft(draftOf(mode));
              }}
            />
          ))}
        </View>
      )}
      {draft === undefined ? (
        <View style={styles.row}>
          <Button
            label={t("modes.add")}
            onPress={() => {
              setSaved(false);
              setDraft(NEW);
            }}
            testID="mode-add"
          />
        </View>
      ) : (
        <ModeEditor
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
