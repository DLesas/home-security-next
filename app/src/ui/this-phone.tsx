/**
 * This phone, under Settings on a phone (m3-design.md section 6): its homes and the app lock.
 *
 * - **Homes**: each home with its name on this phone, "In use" beside the chosen one; switching
 *   to another (its session in place of the chosen one's); renaming, on this phone only;
 *   "Remove this home from this phone", asked twice, with what it did or why it did not in words
 *   (`homes.ts` holds the rules). "Link another home" starts the phone's link pages
 *   (`phone-link.tsx`, at `/link-home`); once linked, the phone comes back here (`afterLinking`).
 *
 * A browser has neither: the page says where they are.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { LinkView } from "../hub/client";
import { type Home, type Homes, type RemoveFault, type RenameFault } from "./homes";
import {
  Actions,
  Body,
  Button,
  ConfirmButton,
  Done,
  Failure,
  Field,
  Heading,
  List,
  ListRow,
  Notice,
  NoticeText,
  Section,
  Stack,
} from "./parts";
import { usePhone } from "./phone-parts";

/** Where the phone goes once "Link another home" has linked: back to This phone; else nowhere. */
export function afterLinking(
  before: LinkView["kind"],
  now: LinkView["kind"],
  path: string,
): string | null {
  return path === "/link-home" && before !== "linked" && now === "linked" ? "/this-phone" : null;
}

/** The words for a removal that did not happen; `client`'s are the hub's refusal (`Failure`). */
export function removeFaultKey(fault: RemoveFault): string | null {
  switch (fault.step) {
    case "reach":
      return "homes.notReached";
    case "push":
      return "homes.pushRefused";
    case "storage":
      return "homes.storage";
    case "client":
      return null;
  }
}

/** Shows the homes on this phone under the Settings page title. */
export function ThisPhoneScreen({ onLinkAnother }: { readonly onLinkAnother: () => void }) {
  const { t } = useTranslation();
  const phone = usePhone();
  if (phone === undefined) return <Body>{t("thisPhone.phoneOnly")}</Body>;
  return <HomesSection homes={phone.homes} onLinkAnother={onLinkAnother} />;
}

/** Lists existing homes and opens the phone’s link flow. */
function HomesSection({
  homes,
  onLinkAnother,
}: {
  readonly homes: Homes;
  readonly onLinkAnother: () => void;
}) {
  const { t } = useTranslation();
  const state = useStore(homes.store);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    void homes.refresh();
  }, [homes]);
  return (
    <Section label={t("homes.title")}>
      <Heading level={2}>{t("homes.title")}</Heading>
      {said === null ? null : <Done text={said} testID="home-removed" />}
      {state.homes.length === 0 ? null : (
        <List label={t("homes.title")}>
          {state.homes.map((home) => (
            <HomeItem
              key={home.identity}
              home={home}
              homes={homes}
              chosen={state.chosen === home.identity}
              busy={state.removing !== null || state.switching}
              removing={state.removing === home.identity}
              onRemoved={setSaid}
            />
          ))}
        </List>
      )}
      <Actions>
        <Button
          kind="quiet"
          label={t("homes.link")}
          disabled={state.removing !== null || state.switching}
          onPress={onLinkAnother}
          testID="link-home"
        />
      </Actions>
    </Section>
  );
}

/** Edits a local name, selects a home or confirms its removal. */
function HomeItem({
  home,
  homes,
  chosen,
  busy,
  removing,
  onRemoved,
}: {
  readonly home: Home;
  readonly homes: Homes;
  readonly chosen: boolean;
  /** A removal runs, of this home or another. */
  readonly busy: boolean;
  readonly removing: boolean;
  /** Said by the list, which outlives this row. */
  readonly onRemoved: (said: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState<string | undefined>();
  const [renamed, setRenamed] = useState<RenameFault | "saved" | null>(null);
  const [switchFailed, setSwitchFailed] = useState(false);
  const [fault, setFault] = useState<RemoveFault | null>(null);
  const faultKey = fault === null ? null : removeFaultKey(fault);
  return (
    <ListRow
      name={home.name}
      testID={`home-${home.identity}`}
      {...(chosen ? { state: t("homes.inUse") } : {})}
    >
      {name === undefined ? (
        <Actions>
          {chosen ? null : (
            <Button
              kind="quiet"
              label={t("homes.choose", { name: home.name })}
              disabled={busy}
              testID={`choose-${home.identity}`}
              onPress={() => {
                setSwitchFailed(false);
                void homes.choose(home.identity).then((result) => {
                  setSwitchFailed(!result.ok);
                });
              }}
            />
          )}
          <Button
            kind="quiet"
            label={t("homes.rename", { name: home.name })}
            disabled={busy}
            testID={`rename-${home.identity}`}
            onPress={() => {
              setRenamed(null);
              setName(home.name);
            }}
          />
        </Actions>
      ) : (
        <Stack>
          <Field
            label={t("homes.nameLabel")}
            hint={t("homes.nameHint")}
            value={name}
            onChange={setName}
            testID={`home-name-${home.identity}`}
            {...(renamed === "badName" ? { error: t("editing.badName") } : {})}
          />
          <Actions>
            <Button
              label={t("editing.save")}
              testID={`save-${home.identity}`}
              onPress={() =>
                void homes.rename(home.identity, name).then((outcome) => {
                  setRenamed(outcome.ok ? "saved" : outcome.fault);
                  if (outcome.ok) setName(undefined);
                })
              }
            />
            <Button
              kind="quiet"
              label={t("editing.cancel")}
              onPress={() => {
                setRenamed(null);
                setName(undefined);
              }}
            />
          </Actions>
        </Stack>
      )}
      {renamed === "saved" ? <Done text={t("editing.saved")} /> : null}
      {renamed === "storage" || switchFailed ? (
        <Notice kind="danger" live="polite">
          <NoticeText kind="danger">{t("homes.storage")}</NoticeText>
        </Notice>
      ) : null}
      {busy && !removing ? null : (
        <Actions>
          <ConfirmButton
            label={t("homes.remove")}
            question={t("homes.removeQuestion", { name: home.name })}
            yes={t("homes.yesRemove", { name: home.name })}
            no={t("editing.no")}
            busy={removing}
            testID={`remove-${home.identity}`}
            onConfirm={() => {
              setFault(null);
              void homes.remove(home.identity).then((outcome) => {
                if (outcome.ok) onRemoved(t("homes.removed", { name: home.name }));
                else setFault(outcome.fault);
              });
            }}
          />
        </Actions>
      )}
      {fault === null ? null : fault.step === "client" ? (
        <Failure outcome={fault.failure} testID={`remove-failed-${home.identity}`} />
      ) : (
        <Notice kind="danger" live="polite" testID={`remove-failed-${home.identity}`}>
          <NoticeText kind="danger">
            {t(faultKey ?? "homes.storage", { name: home.name })}
          </NoticeText>
        </Notice>
      )}
    </ListRow>
  );
}
