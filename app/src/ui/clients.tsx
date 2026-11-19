/**
 * A person's linked devices (m2-design.md section 7; D61): kind, name, when last seen, which device
 * linked it; renaming; removing. Removing a device lists the devices it linked in the last 30 days
 * ‡, each removed with it unless unticked: the request names the ones left ticked (`also`), so a
 * device linked after the list was shown is never removed unseen. The hub checks who may.
 */
import type { ClientObject } from "@hsn/protocol/app";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { formatTime } from "./format";
import { HERE } from "./words-here";
import { useAction, useLive } from "./hub-context";
import {
  Actions,
  Body,
  Button,
  ConfirmButton,
  Done,
  Facts,
  Failure,
  Field,
  Heading,
  ListItem,
  Stack,
  Toggle,
} from "./parts";
import { cleanName } from "./setup";

/** The removal's list: devices this one linked within the last 30 days ‡. */
export const LINKED_WITHIN_MS = 30 * 24 * 3_600_000;

export function linkedBy(
  clients: readonly ClientObject[],
  client: number,
  nowMs: number,
): readonly ClientObject[] {
  return clients.filter((c) => c.linkedBy === client && nowMs - c.createdMs <= LINKED_WITHIN_MS);
}

export function ClientItem({
  client,
  all,
  onRemoved,
}: {
  readonly client: ClientObject;
  readonly all: readonly ClientObject[];
  /** Said by the list, which outlives this row: the row goes when the hub removes it. */
  readonly onRemoved: (said: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const info = useLive((s) => s.hub);
  const self = useLive((s) => s.session?.client === client.id);
  const rename = useAction("client.rename");
  const remove = useAction("client.remove");
  const [name, setName] = useState<string | undefined>();
  const [badName, setBadName] = useState(false);
  const linked = useMemo(() => linkedBy(all, client.id, Date.now()), [all, client.id]);
  const [also, setAlso] = useState<readonly number[] | undefined>();
  const ticked = also ?? linked.map((c) => c.id);
  const by =
    client.linkedBy === null
      ? undefined
      : (all.find((c) => c.id === client.linkedBy)?.name ??
        t("common.clientNumber", { id: client.linkedBy }));
  return (
    <ListItem testID={`client-${String(client.id)}`}>
      <Heading level={3}>
        {self ? t("people.thisBrowser", { ...HERE, name: client.name }) : client.name}
      </Heading>
      <Facts
        items={[
          t(`people.clientKind.${client.kind}`),
          client.lastSeenMs === null
            ? t("devices.neverSeen")
            : t("devices.lastSeen", {
                time: formatTime(t, i18n.language, info, client.lastSeenMs),
              }),
          by === undefined ? undefined : t("people.linkedBy", { name: by }),
        ]}
      />
      {name === undefined ? (
        <Actions>
          <Button
            kind="quiet"
            label={t("people.renameClient", { name: client.name })}
            onPress={() => {
              setName(client.name);
            }}
          />
        </Actions>
      ) : (
        <Stack>
          <Field
            label={t("people.clientName")}
            value={name}
            onChange={setName}
            {...(badName ? { error: t("editing.badName") } : {})}
          />
          <Actions>
            <Button
              label={t("editing.save")}
              busy={rename.busy}
              onPress={() => {
                const clean = cleanName(name);
                setBadName(clean === undefined);
                if (clean !== undefined)
                  void rename.run({ client: client.id, name: clean }).then((o) => {
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
          </Actions>
        </Stack>
      )}
      {rename.outcome === undefined ? null : rename.outcome.ok ? (
        <Done text={t("editing.saved")} />
      ) : (
        <Failure outcome={rename.outcome} />
      )}
      {linked.length === 0 ? null : (
        <View
          role="group"
          aria-label={t("people.alsoTitle", { name: client.name })}
          className="gap-1"
        >
          <Body>{t("people.alsoTitle", { name: client.name })}</Body>
          {linked.map((c) => (
            <Toggle
              key={c.id}
              label={t("people.alsoRemove", { name: c.name })}
              value={ticked.includes(c.id)}
              onChange={(on) => {
                setAlso(on ? [...ticked, c.id] : ticked.filter((id) => id !== c.id));
              }}
            />
          ))}
        </View>
      )}
      <Actions>
        <ConfirmButton
          label={t("people.removeClient", { name: client.name })}
          question={
            self
              ? t("people.removeSelfQuestion")
              : t("people.removeClientQuestion", { name: client.name, count: ticked.length })
          }
          yes={t("people.yesRemove")}
          no={t("editing.no")}
          busy={remove.busy}
          testID={`remove-client-${String(client.id)}`}
          onConfirm={() =>
            void remove.run({ client: client.id, also: ticked }).then((o) => {
              if (o.ok) onRemoved(t("people.clientRemoved", { name: client.name }));
            })
          }
        />
      </Actions>
      {remove.outcome === undefined || remove.outcome.ok ? null : (
        <Failure outcome={remove.outcome} />
      )}
    </ListItem>
  );
}
