/**
 * The question asked before an action leaves groups with none of their own sirens (D144;
 * docs/app-design.md, "Which sirens sound"): one dialog for the action, naming each group affected
 * and saying that every siren will then sound for them; its confirming button says what happens,
 * and cancelling changes nothing.
 */
import type { GroupObject } from "@hsn/protocol/app";
import { type ComponentRef, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { View } from "react-native";
import { listOf } from "../state/words";
import { Actions, Body, Button, Dialog } from "./parts";

export function SirenDialog({
  title,
  groups,
  confirm,
  onConfirm,
  onCancel,
  busy = false,
}: {
  readonly title: string;
  readonly groups: readonly GroupObject[];
  /** What the confirming button does, in words ("Remove the siren"). */
  readonly confirm: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly busy?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const ref = useRef<ComponentRef<typeof View>>(null);
  // Reached by focus when it appears, as every question in the app is.
  useEffect(() => {
    setTimeout(() => ref.current?.focus(), 0);
  }, []);
  return (
    <Dialog title={title} ref={ref} testID="siren-dialog">
      <Body>
        {t("sirens.everyWillSound", {
          count: groups.length,
          groups: listOf(
            groups.map((g) => g.name),
            i18n.language,
          ),
        })}
      </Body>
      <Actions>
        <Button
          kind="danger"
          label={confirm}
          busy={busy}
          onPress={onConfirm}
          testID="siren-dialog-confirm"
        />
        <Button
          kind="quiet"
          label={t("editing.cancel")}
          onPress={onCancel}
          testID="siren-dialog-cancel"
        />
      </Actions>
    </Dialog>
  );
}
