/**
 * People, permissions and the user-management switch (m2-design.md section 7; D13, D33, AP7).
 * While user management is off every person may do everything, and the permission screens are
 * hidden (D13); switching it on keeps everyone's permissions until someone changes them. Per
 * device: *manage* (which includes *view* ‡) and *view history*; globally *manage users* and
 * *manage system*. A person made while it is on has no access yet. The hub refuses taking *manage
 * users* from the last person who has it; the screen asks and shows.
 */
import type { ClientObject, PersonObject } from "@hsn/protocol/app";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ClientItem } from "./clients";
import { byName, ConflictNotice, conflictOf, useFieldError } from "./editing";
import { useAction, useLive, useRead } from "./hub-context";
import {
  Body,
  Button,
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

interface Grants {
  readonly devices: readonly {
    readonly device: number;
    readonly manage: boolean;
    readonly view: boolean;
  }[];
  readonly manageUsers: boolean;
  readonly manageSystem: boolean;
}

/** One device's permission changed; manage includes view ‡, so turning view off turns manage off. */
export function grant(
  grants: Grants,
  device: number,
  change: { readonly manage?: boolean; readonly view?: boolean },
): Grants {
  const old = grants.devices.find((d) => d.device === device) ?? {
    device,
    manage: false,
    view: false,
  };
  let manage = change.manage ?? old.manage;
  let view = change.view ?? old.view;
  if (change.manage === true) view = true;
  if (change.view === false) manage = false;
  const others = grants.devices.filter((d) => d.device !== device);
  return {
    ...grants,
    devices: [...others, { device, manage, view }].sort((a, b) => a.device - b.device),
  };
}

export function hasNoAccess(person: PersonObject): boolean {
  return (
    !person.manageUsers && !person.manageSystem && person.devices.every((d) => !d.manage && !d.view)
  );
}

function Permissions({ person }: { readonly person: PersonObject }) {
  const { t } = useTranslation();
  const devices = useLive((s) => s.devices);
  const list = useMemo(
    () => byName(Object.values(devices).filter((d) => d.role === "sensor")),
    [devices],
  );
  const [grants, setGrants] = useState<Grants>(person);
  const [revision, setRevision] = useState(person.revision);
  const set = useAction("permissions.set");
  const conflict = conflictOf(set.outcome);
  return (
    <View
      role="group"
      aria-label={t("people.permissionsOf", { name: person.name })}
      style={{ gap: 4 }}
    >
      <Heading level={3}>{t("people.permissionsOf", { name: person.name })}</Heading>
      <Toggle
        label={t("people.manageUsers")}
        value={grants.manageUsers}
        onChange={(v) => {
          setGrants({ ...grants, manageUsers: v });
        }}
      />
      <Toggle
        label={t("people.manageSystem")}
        value={grants.manageSystem}
        onChange={(v) => {
          setGrants({ ...grants, manageSystem: v });
        }}
      />
      {list.map((d) => {
        const g = grants.devices.find((x) => x.device === d.id);
        return (
          <View key={d.id} style={styles.row}>
            <Text style={[styles.body, { minWidth: 140 }]}>{d.name}</Text>
            <Toggle
              label={t("people.manageDevice", { name: d.name })}
              value={g?.manage === true}
              onChange={(v) => {
                setGrants(grant(grants, d.id, { manage: v }));
              }}
            />
            <Toggle
              label={t("people.viewDevice", { name: d.name })}
              value={g?.view === true}
              onChange={(v) => {
                setGrants(grant(grants, d.id, { view: v }));
              }}
            />
          </View>
        );
      })}
      <View style={styles.row}>
        <Button
          label={t("people.savePermissions", { name: person.name })}
          busy={set.busy}
          onPress={() => void set.run({ person: person.id, ...grants, ifRevision: revision })}
        />
      </View>
      {conflict !== undefined && "manageUsers" in conflict.object ? (
        <ConflictNotice
          onUseCurrent={() => {
            if ("manageUsers" in conflict.object) {
              setGrants(conflict.object);
              setRevision(conflict.object.revision);
            }
            set.clear();
          }}
        />
      ) : set.outcome === undefined ? null : set.outcome.ok ? (
        <Done text={t("editing.saved")} />
      ) : (
        <Failure outcome={set.outcome} />
      )}
    </View>
  );
}

export function PersonItem({
  person,
  clients,
  managing,
}: {
  readonly person: PersonObject;
  readonly clients: readonly ClientObject[];
  readonly managing: boolean;
}) {
  const { t } = useTranslation();
  const rename = useAction("person.rename");
  const remove = useAction("person.remove");
  const [name, setName] = useState<string | undefined>();
  const [badName, setBadName] = useState(false);
  const nameError = useFieldError(rename.outcome, "name");
  const own = clients.filter((c) => c.person === person.id);
  return (
    <View role="listitem" style={styles.item} testID={`person-${String(person.id)}`}>
      <Heading level={2}>{person.name}</Heading>
      {managing && hasNoAccess(person) ? <Body>{t("people.noAccess")}</Body> : null}
      {name === undefined ? (
        <View style={styles.row}>
          <Button
            kind="quiet"
            label={t("people.rename", { name: person.name })}
            onPress={() => {
              setName(person.name);
            }}
          />
          <ConfirmButton
            label={t("people.remove", { name: person.name })}
            question={t("people.removeQuestion", { name: person.name })}
            yes={t("people.yesRemove")}
            no={t("editing.no")}
            busy={remove.busy}
            onConfirm={() => void remove.run({ person: person.id, ifRevision: person.revision })}
          />
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          <Field
            label={t("people.name")}
            value={name}
            onChange={setName}
            {...(badName
              ? { error: t("editing.badName") }
              : nameError === undefined
                ? {}
                : { error: nameError })}
          />
          <View style={styles.row}>
            <Button
              label={t("editing.save")}
              busy={rename.busy}
              onPress={() => {
                const clean = cleanName(name);
                setBadName(clean === undefined);
                if (clean !== undefined)
                  void rename
                    .run({ person: person.id, name: clean, ifRevision: person.revision })
                    .then((o) => {
                      if (o.ok) setName(undefined);
                    });
              }}
            />
            <Button
              kind="quiet"
              label={t("editing.cancel")}
              onPress={() => {
                setName(undefined);
              }}
            />
          </View>
        </View>
      )}
      {rename.outcome !== undefined && !rename.outcome.ok && nameError === undefined ? (
        <Failure outcome={rename.outcome} />
      ) : null}
      {remove.outcome !== undefined && !remove.outcome.ok ? (
        <Failure outcome={remove.outcome} />
      ) : null}
      {managing ? <Permissions key={person.revision} person={person} /> : null}
      <Heading level={3}>{t("people.devicesOf", { name: person.name })}</Heading>
      {own.length === 0 ? <Body muted>{t("people.noClients")}</Body> : null}
      <View role="list">
        {own.map((c) => (
          <ClientItem key={c.id} client={c} all={clients} />
        ))}
      </View>
    </View>
  );
}

function AddPerson() {
  const { t } = useTranslation();
  const create = useAction("person.create");
  const [name, setName] = useState("");
  const [bad, setBad] = useState(false);
  const nameError = useFieldError(create.outcome, "name");
  return (
    <Section label={t("people.add")}>
      <Heading level={2}>{t("people.add")}</Heading>
      <Field
        label={t("people.name")}
        value={name}
        onChange={setName}
        {...(bad
          ? { error: t("editing.badName") }
          : nameError === undefined
            ? {}
            : { error: nameError })}
      />
      <View style={styles.row}>
        <Button
          label={t("people.addButton")}
          busy={create.busy}
          onPress={() => {
            const clean = cleanName(name);
            setBad(clean === undefined);
            if (clean !== undefined)
              void create.run({ name: clean }).then((o) => {
                if (o.ok) setName("");
              });
          }}
        />
      </View>
      {create.outcome === undefined ? null : create.outcome.ok ? (
        <Done text={t("people.added", { name: create.outcome.body.name })} />
      ) : nameError === undefined ? (
        <Failure outcome={create.outcome} />
      ) : null}
    </Section>
  );
}

export function PeopleScreen() {
  const { t } = useTranslation();
  const list = useRead("people.list", {}, "people");
  const toggle = useAction("userManagement.set");
  const data = list.data?.ok === true ? list.data.body : undefined;
  const people = useMemo(() => byName(data?.people ?? []), [data]);
  const console = useMemo(() => (data?.clients ?? []).filter((c) => c.person === null), [data]);
  return (
    <>
      {list.data !== undefined && !list.data.ok ? <Failure outcome={list.data} /> : null}
      {data === undefined ? null : (
        <Section label={t("people.userManagement")}>
          <Heading level={2}>{t("people.userManagement")}</Heading>
          <Body>
            {t(data.userManagement ? "people.userManagementOn" : "people.userManagementOff")}
          </Body>
          <Toggle
            label={t("people.userManagementSwitch")}
            value={data.userManagement}
            testID="user-management"
            onChange={(on) => void toggle.run({ on })}
          />
          {toggle.outcome !== undefined && !toggle.outcome.ok ? (
            <Failure outcome={toggle.outcome} />
          ) : null}
        </Section>
      )}
      <View role="list">
        {people.map((p) => (
          <PersonItem
            key={p.id}
            person={p}
            clients={data?.clients ?? []}
            managing={data?.userManagement === true}
          />
        ))}
      </View>
      {console.length === 0 ? null : (
        <Section label={t("people.console")}>
          <Heading level={2}>{t("people.console")}</Heading>
          <View role="list">
            {console.map((c) => (
              <ClientItem key={c.id} client={c} all={data?.clients ?? []} />
            ))}
          </View>
        </Section>
      )}
      <AddPerson />
    </>
  );
}
