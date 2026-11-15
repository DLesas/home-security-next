/**
 * What the configuration screens share (m2-design.md sections 5 and 6): a refusal naming one
 * field is said under that field; a `conflict` says someone changed the object meanwhile and
 * offers the object as it now is (the reply carries it); names are trimmed and in NFC before they
 * are sent, and the hub refuses what it refuses.
 */
import type { AppError } from "@hsn/protocol/app";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { LocalFault } from "../hub/faults";
import { INVALID_KEYS } from "../state/words";
import { Button, Notice } from "./parts";
import { styles } from "./theme";

type Failed =
  | { readonly ok: false; readonly error: AppError }
  | { readonly ok: false; readonly local: LocalFault };
type Outcome = { readonly ok: true } | Failed;

/** The words for a refusal of `field` (the body's dotted path), when the outcome is one. */
export function useFieldError(outcome: Outcome | undefined, field: string): string | undefined {
  const { t } = useTranslation();
  if (outcome === undefined || outcome.ok || !("error" in outcome)) return undefined;
  const error = outcome.error;
  if (error.code !== "invalid" || error.detail.field !== field) return undefined;
  return t(INVALID_KEYS[error.detail.reason]);
}

/** A `conflict`'s object, when the outcome is one. */
export function conflictOf(
  outcome: Outcome | undefined,
): Extract<AppError, { code: "conflict" }>["detail"] | undefined {
  if (outcome === undefined || outcome.ok || !("error" in outcome)) return undefined;
  return outcome.error.code === "conflict" ? outcome.error.detail : undefined;
}

/** Someone changed it meanwhile: the change lost to theirs, and the current version on offer. */
export function ConflictNotice({ onUseCurrent }: { readonly onUseCurrent: () => void }) {
  const { t } = useTranslation();
  return (
    <Notice kind="warning" live="polite" testID="conflict">
      <Text style={styles.body}>{t("editing.conflict")}</Text>
      <View style={styles.row}>
        <Button
          kind="quiet"
          label={t("editing.useCurrent")}
          onPress={onUseCurrent}
          testID="use-current"
        />
      </View>
    </Notice>
  );
}

/** Sorted by name, then id, for lists that read the same everywhere. */
export function byName<T extends { readonly name: string; readonly id: number }>(
  items: readonly T[],
): readonly T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

/** Said when there are none yet. */
export function NotToldYet({ what }: { readonly what: "groups" | "modes" | "schedules" }) {
  const { t } = useTranslation();
  return (
    <Notice kind="info" testID={`not-told-${what}`}>
      <Text style={styles.body}>{t(`editing.notToldYet.${what}`)}</Text>
    </Notice>
  );
}
