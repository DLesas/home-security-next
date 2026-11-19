/**
 * Asking for a permission (docs/app-design.md, "On a phone", rule 7): never at start; at the
 * moment it is needed, a page says in one sentence what the phone will ask and why, with one
 * button that names it ("Allow the camera"), and the system's question follows. If the answer is
 * no, the page says what will not work, offers "Open settings", and the way that needs no
 * permission where there is one ("Type the code instead"). The sentence is the one the system's
 * own question uses (`app.config.ts` reads it from the same key).
 */
import { useTranslation } from "react-i18next";
import { Actions, Body, Button, Stack } from "./parts";

/** Another way, needing no permission: a label and what it does. */
export interface Instead {
  readonly label: string;
  readonly onPress: () => void;
}

/** Before the system's question: why, and one button that names it. */
export function PermissionAsk({
  sentence,
  allow,
  onAllow,
  testID,
}: {
  readonly sentence: string;
  readonly allow: string;
  readonly onAllow: () => void;
  readonly testID?: string;
}) {
  return (
    <Stack>
      <Body {...(testID === undefined ? {} : { testID })}>{sentence}</Body>
      <Actions>
        <Button label={allow} onPress={onAllow} testID="permission-allow" />
      </Actions>
    </Stack>
  );
}

/** After a no: what will not work, "Open settings", and the other way where there is one. */
export function PermissionRefused({
  sentence,
  onOpenSettings,
  instead,
  testID,
}: {
  readonly sentence: string;
  readonly onOpenSettings: () => void;
  readonly instead?: Instead;
  readonly testID?: string;
}) {
  const { t } = useTranslation();
  return (
    <Stack>
      <Body {...(testID === undefined ? {} : { testID })}>{sentence}</Body>
      <Actions>
        <Button
          label={t("permissionPage.openSettings")}
          onPress={onOpenSettings}
          testID="permission-settings"
        />
        {instead === undefined ? null : (
          <Button kind="quiet" label={instead.label} onPress={instead.onPress} testID="instead" />
        )}
      </Actions>
    </Stack>
  );
}
